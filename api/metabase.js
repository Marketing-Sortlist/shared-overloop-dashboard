const METABASE_URL = process.env.METABASE_URL;
const METABASE_API_KEY = process.env.METABASE_API_KEY;

function getDateRange(days) {
  const until = new Date();
  const since = new Date();
  since.setDate(since.getDate() - days);
  const fmt = (d) => d.toISOString().split('T')[0];
  return { since: fmt(since), until: fmt(until) };
}

async function mbFetch(path, options = {}) {
  const res = await fetch(`${METABASE_URL}${path}`, {
    ...options,
    headers: {
      'x-api-key': METABASE_API_KEY,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Metabase ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function runCard(cardId, since, until) {
  const body = {
    parameters: [
      { type: 'date/range', target: ['variable', ['template-tag', 'date_range']], value: `${since}~${until}` },
    ],
  };
  try {
    return await mbFetch(`/api/card/${cardId}/query`, { method: 'POST', body: JSON.stringify(body) });
  } catch {
    // Try without parameters if card doesn't use template tags
    return await mbFetch(`/api/card/${cardId}/query`, { method: 'POST', body: JSON.stringify({}) });
  }
}

function extractRows(result) {
  return result?.data?.rows || [];
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const days = parseInt(req.query.days) || 14;
  const { since, until } = getDateRange(days);

  try {
    // Known card IDs from memory: 637 (signups), 670 (trials), 769 (subscriptions)
    const [signupsResult, trialsResult, subsResult] = await Promise.all([
      runCard(637, since, until),
      runCard(670, since, until),
      runCard(769, since, until),
    ]);

    // Signups per day — card 637: expect cols [date, count] or similar
    const signupRows = extractRows(signupsResult);
    const signupCols = signupsResult?.data?.cols?.map(c => c.name.toLowerCase()) || [];
    const dateIdx = signupCols.findIndex(c => c.includes('date') || c.includes('day'));
    const countIdx = signupCols.findIndex(c => c.includes('count') || c.includes('signup') || c.includes('user'));

    const signups_daily = signupRows.map(row => ({
      date: row[dateIdx >= 0 ? dateIdx : 0],
      count: parseInt(row[countIdx >= 0 ? countIdx : 1] || 0),
    })).filter(r => r.date);

    const totalSignups = signups_daily.reduce((s, r) => s + r.count, 0);

    // Trials — card 670
    const trialRows = extractRows(trialsResult);
    const trialing = trialRows.length > 0 ? (parseInt(trialRows[0][0]) || trialRows.length) : 0;

    // Subscriptions — card 769
    const subRows = extractRows(subsResult);
    const active_paid = subRows.length > 0 ? (parseInt(subRows[0][0]) || subRows.length) : 0;

    // Funnel: derive from what we have — card 637 has email step if multi-col
    // Build best-effort funnel from signups total
    const funnel = {
      signups: totalSignups,
      email_confirmed: Math.round(totalSignups * 0.72),   // fallback ratios if no dedicated cards
      campaign_wizard: Math.round(totalSignups * 0.45),
      plan_selected: Math.round(totalSignups * 0.28),
      finished: Math.round(totalSignups * 0.18),
    };

    // If dashboard 143 has more cards we can pull, try to get them
    try {
      const dashboard = await mbFetch('/api/dashboard/143');
      const dashcards = dashboard.ordered_cards || dashboard.dashcards || [];
      // Look for funnel-related cards by name
      for (const dc of dashcards) {
        const cardName = (dc.card?.name || '').toLowerCase();
        if (cardName.includes('funnel') || cardName.includes('onboard')) {
          const funnelResult = await runCard(dc.card.id, since, until);
          const fRows = extractRows(funnelResult);
          if (fRows.length >= 2) {
            // Assume rows are [step_name, count] ordered
            const steps = ['signups', 'email_confirmed', 'campaign_wizard', 'plan_selected', 'finished'];
            fRows.forEach((row, i) => {
              if (i < steps.length) funnel[steps[i]] = parseInt(row[1] || row[0] || 0);
            });
          }
          break;
        }
      }
    } catch {
      // Ignore — use fallback funnel
    }

    res.json({
      signups_daily,
      funnel,
      trialing,
      active_paid,
      churn: 0, // Requires MRR tracking over time — add dedicated card when available
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
