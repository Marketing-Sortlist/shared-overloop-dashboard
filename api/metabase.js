const METABASE_URL = process.env.METABASE_URL;
const METABASE_API_KEY = process.env.METABASE_API_KEY;
const DB_ID = 5;

async function runSQL(sql) {
  const res = await fetch(`${METABASE_URL}/api/dataset`, {
    method: 'POST',
    headers: { 'x-api-key': METABASE_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ database: DB_ID, type: 'native', native: { query: sql } }),
  });
  if (!res.ok) throw new Error(`Dataset API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data?.data?.rows || [];
}

async function runCard(cardId) {
  const res = await fetch(`${METABASE_URL}/api/card/${cardId}/query`, {
    method: 'POST',
    headers: { 'x-api-key': METABASE_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data?.data?.rows || [];
}

function getDateRange(req) {
  const fmt = (d) => d.toISOString().split('T')[0];
  let since, until;
  if (req.query.since && req.query.until) {
    since = req.query.since;
    until = req.query.until;
  } else {
    const days = parseInt(req.query.days) || 14;
    const u = new Date(); const s = new Date();
    s.setDate(s.getDate() - days);
    since = fmt(s); until = fmt(u);
  }
  const u1 = new Date(until + 'T00:00:00Z');
  u1.setUTCDate(u1.getUTCDate() + 1);
  return { since, until, until1: fmt(u1) };
}

// Source attribution: facebook→meta, (google OR _gcl_aw)→google, known utm→utm_source value, no utm→organic
const SOURCE_CASE = `
  CASE
    WHEN LOWER(COALESCE(substring(companies.signup_url, 'utm_source=([^&]*)'), '')) = 'facebook' THEN 'meta'
    WHEN LOWER(COALESCE(substring(companies.signup_url, 'utm_source=([^&]*)'), '')) = 'google'
      OR companies.signup_url LIKE '%_gcl_aw%' THEN 'google'
    WHEN COALESCE(substring(companies.signup_url, 'utm_source=([^&]*)'), '') <> ''
      THEN LOWER(substring(companies.signup_url, 'utm_source=([^&]*)'))
    ELSE 'organic'
  END
`;

// Step assignment SQL expression (1–9, higher = further in funnel)
// Fields: u.current_signup_step, u.last_campaign_wizard_step, sub.status
const STEP_CASE = `
  CASE
    WHEN u.current_signup_step = 'finished'
         AND sub.status IN ('active','canceled','past_due')                                                   THEN 9
    WHEN u.current_signup_step = 'finished'
         AND sub.status = 'trialing'                                                                          THEN 8
    WHEN u.current_signup_step IN ('mobile-pitch','campaign-wizard')
         AND u.last_campaign_wizard_step = 'congrats'                                                         THEN 7
    WHEN u.current_signup_step IN ('mobile-pitch','campaign-wizard')
         AND u.last_campaign_wizard_step = 'prospects'                                                        THEN 6
    WHEN u.current_signup_step IN ('mobile-pitch','campaign-wizard')
         AND u.last_campaign_wizard_step IN ('editor','start-template')                                       THEN 5
    WHEN u.current_signup_step IN ('mobile-pitch','campaign-wizard')
         AND u.last_campaign_wizard_step = 'pitch-index'                                                      THEN 4
    WHEN u.current_signup_step IN ('mobile-pitch','campaign-wizard')
         AND u.last_campaign_wizard_step = 'accounts'                                                         THEN 3
    WHEN u.current_signup_step IN ('mobile-pitch','campaign-wizard')
         AND u.last_campaign_wizard_step IS NULL                                                               THEN 2
    WHEN u.current_signup_step = 'email-confirmation'                                                         THEN 1
  END
`;

// Exclude internal Sortlist/Overloop accounts from all queries
const INTERNAL_FILTER = `
  AND u.email NOT ILIKE '%sortlist.com%'
  AND u.email NOT ILIKE '%overloop%'
  AND companies.name NOT ILIKE '%sortlist%'
  AND companies.name NOT ILIKE '%overloop%'
`;

function buildPeriodMap(rows) {
  const map = {};
  for (const [period, source, cnt] of rows) {
    const d = String(period).slice(0, 10);
    if (!map[d]) map[d] = { date: d, count: 0 };
    const n = parseInt(cnt) || 0;
    map[d][source] = (map[d][source] || 0) + n;
    map[d].count += n;
  }
  return Object.values(map).sort((a, b) => a.date.localeCompare(b.date));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const granularity = ['day', 'week', 'month'].includes(req.query.granularity) ? req.query.granularity : 'day';
  const { since, until1 } = getDateRange(req);

  try {
    // ── 1. Signups grouped by period + source ────────────────────────────────
    const dailyRows = await runSQL(`
      SELECT
        DATE_TRUNC('${granularity}', companies.created_at)::date AS period,
        ${SOURCE_CASE} AS source,
        COUNT(DISTINCT u.email) AS cnt
      FROM companies
      JOIN LATERAL (
        SELECT * FROM users WHERE users.company_id = companies.id ORDER BY id ASC LIMIT 1
      ) u ON true
      WHERE companies.created_at >= '${since}' AND companies.created_at < '${until1}'
      ${INTERNAL_FILTER}
      GROUP BY 1, 2
      ORDER BY 1
    `);
    const signups_daily = buildPeriodMap(dailyRows);

    // ── 2. Funnel — cumulative counts by step (1–9), deduplicated by email ───
    const funnelRows = await runSQL(`
      WITH raw AS (
        SELECT
          u.email,
          ${SOURCE_CASE} AS source,
          ${STEP_CASE} AS step_num
        FROM companies
        LEFT JOIN LATERAL (
          SELECT * FROM subscriptions WHERE subscriptions.company_id = companies.id ORDER BY id DESC LIMIT 1
        ) sub ON true
        JOIN LATERAL (
          SELECT * FROM users WHERE users.company_id = companies.id ORDER BY id ASC LIMIT 1
        ) u ON true
        WHERE companies.created_at >= '${since}' AND companies.created_at < '${until1}'
        ${INTERNAL_FILTER}
      ),
      deduped AS (
        SELECT DISTINCT ON (email) email, source, step_num
        FROM raw ORDER BY email, step_num DESC
      )
      SELECT
        source,
        COUNT(*) FILTER (WHERE step_num >= 1) AS s1,
        COUNT(*) FILTER (WHERE step_num >= 2) AS s2,
        COUNT(*) FILTER (WHERE step_num >= 3) AS s3,
        COUNT(*) FILTER (WHERE step_num >= 4) AS s4,
        COUNT(*) FILTER (WHERE step_num >= 5) AS s5,
        COUNT(*) FILTER (WHERE step_num >= 6) AS s6,
        COUNT(*) FILTER (WHERE step_num >= 7) AS s7,
        COUNT(*) FILTER (WHERE step_num >= 8) AS s8,
        COUNT(*) FILTER (WHERE step_num >= 9) AS s9
      FROM deduped
      GROUP BY source
    `);

    const funnelBySource = {};
    const totalsFinal = Array(9).fill(0);
    for (const [source, ...counts] of funnelRows) {
      if (!funnelBySource[source]) funnelBySource[source] = Array(9).fill(0);
      counts.forEach((v, i) => {
        funnelBySource[source][i] += Number(v);
        totalsFinal[i] += Number(v);
      });
    }

    // ── 3. Funnel by device type ──────────────────────────────────────────────
    let funnelByDevice = {};
    try {
      const deviceRows = await runSQL(`
        WITH raw AS (
          SELECT
            u.email,
            CASE
              WHEN COALESCE(companies.signup_user_agent, '') ~* '(mobile|android|iphone)' THEN 'mobile'
              WHEN COALESCE(companies.signup_user_agent, '') ~* '(ipad|tablet)' THEN 'tablet'
              WHEN companies.signup_user_agent IS NOT NULL AND companies.signup_user_agent <> '' THEN 'desktop'
              ELSE 'unknown'
            END AS device,
            ${STEP_CASE} AS step_num
          FROM companies
          LEFT JOIN LATERAL (
            SELECT * FROM subscriptions WHERE subscriptions.company_id = companies.id ORDER BY id DESC LIMIT 1
          ) sub ON true
          JOIN LATERAL (
            SELECT * FROM users WHERE users.company_id = companies.id ORDER BY id ASC LIMIT 1
          ) u ON true
          WHERE companies.created_at >= '${since}' AND companies.created_at < '${until1}'
          ${INTERNAL_FILTER}
        ),
        deduped AS (
          SELECT DISTINCT ON (email) email, device, step_num
          FROM raw ORDER BY email, step_num DESC
        )
        SELECT
          device,
          COUNT(*) FILTER (WHERE step_num >= 1) AS s1,
          COUNT(*) FILTER (WHERE step_num >= 2) AS s2,
          COUNT(*) FILTER (WHERE step_num >= 3) AS s3,
          COUNT(*) FILTER (WHERE step_num >= 4) AS s4,
          COUNT(*) FILTER (WHERE step_num >= 5) AS s5,
          COUNT(*) FILTER (WHERE step_num >= 6) AS s6,
          COUNT(*) FILTER (WHERE step_num >= 7) AS s7,
          COUNT(*) FILTER (WHERE step_num >= 8) AS s8,
          COUNT(*) FILTER (WHERE step_num >= 9) AS s9
        FROM deduped
        GROUP BY device
        ORDER BY s1 DESC
      `);
      for (const [device, ...counts] of deviceRows) {
        funnelByDevice[device] = counts.map(Number);
      }
    } catch (e) { funnelByDevice = { _error: e.message }; }

    // ── 4. Per-period funnel — trials (step≥8) and actives (step≥9) per signup cohort
    // Uses signup date to attribute: "how many users who signed up in week X are now trialing/active?"
    // This ties ad spend for a week to outcomes from that week's cohort — no extra column names needed.
    let trials_daily = [], activations_daily = [];
    try {
      const periodFunnelRows = await runSQL(`
        WITH raw AS (
          SELECT
            DATE_TRUNC('${granularity}', companies.created_at)::date AS period,
            u.email,
            ${SOURCE_CASE} AS source,
            ${STEP_CASE} AS step_num
          FROM companies
          LEFT JOIN LATERAL (
            SELECT * FROM subscriptions WHERE subscriptions.company_id = companies.id ORDER BY id DESC LIMIT 1
          ) sub ON true
          JOIN LATERAL (
            SELECT * FROM users WHERE users.company_id = companies.id ORDER BY id ASC LIMIT 1
          ) u ON true
          WHERE companies.created_at >= '${since}' AND companies.created_at < '${until1}'
          ${INTERNAL_FILTER}
        ),
        deduped AS (
          SELECT DISTINCT ON (period, email) period, email, source, step_num
          FROM raw ORDER BY period, email, step_num DESC
        )
        SELECT
          period::text,
          source,
          COUNT(*) FILTER (WHERE step_num >= 8) AS trialing,
          COUNT(*) FILTER (WHERE step_num >= 9) AS active
        FROM deduped
        GROUP BY period, source
        ORDER BY period
      `);
      const tMap = {}, aMap = {};
      for (const [period, source, t, a] of periodFunnelRows) {
        const d   = String(period).slice(0, 10);
        if (!tMap[d]) tMap[d] = { date: d, count: 0 };
        tMap[d][source] = (tMap[d][source] || 0) + Number(t);
        tMap[d].count += Number(t);
        if (!aMap[d]) aMap[d] = { date: d, count: 0 };
        aMap[d][source] = (aMap[d][source] || 0) + Number(a);
        aMap[d].count += Number(a);
      }
      trials_daily      = Object.values(tMap).sort((x, y) => x.date.localeCompare(y.date));
      activations_daily = Object.values(aMap).sort((x, y) => x.date.localeCompare(y.date));
    } catch (_) { /* trials/activations_daily stay empty */ }

    // ── 5. Trial behaviour — avg conversion times + 14-day trial window stats ─
    // Scoped to the selected signup cohort (companies.created_at in range).
    let trial_behavior = null;
    try {
      const [tbRows, tbSrcRows] = await Promise.all([
        runSQL(`
          SELECT
            ROUND(AVG(EXTRACT(EPOCH FROM (sub.trial_start - companies.created_at)) / 86400)::numeric, 1)
              AS avg_days_signup_to_trial,
            ROUND(AVG(EXTRACT(EPOCH FROM (sub.subscribed_at - sub.trial_start)) / 86400)
              FILTER (WHERE sub.subscribed_at IS NOT NULL AND sub.status = 'active')::numeric, 1)
              AS avg_days_trial_to_active,
            COUNT(*) FILTER (
              WHERE sub.trial_start IS NOT NULL
                AND NOW() > sub.trial_start + INTERVAL '14 days'
                AND sub.status != 'active'
            ) AS over_14d_not_active,
            COUNT(*) FILTER (
              WHERE sub.trial_start IS NOT NULL
                AND NOW() <= sub.trial_start + INTERVAL '14 days'
            ) AS in_14d_window
          FROM companies
          LEFT JOIN LATERAL (
            SELECT * FROM subscriptions WHERE subscriptions.company_id = companies.id ORDER BY id DESC LIMIT 1
          ) sub ON true
          JOIN LATERAL (
            SELECT * FROM users WHERE users.company_id = companies.id ORDER BY id ASC LIMIT 1
          ) u ON true
          WHERE companies.created_at >= '${since}' AND companies.created_at < '${until1}'
          ${INTERNAL_FILTER}
        `),
        runSQL(`
          SELECT
            ${SOURCE_CASE} AS source,
            ROUND(AVG(EXTRACT(EPOCH FROM (sub.trial_start - companies.created_at)) / 86400)::numeric, 1)
              AS avg_days_signup_to_trial
          FROM companies
          LEFT JOIN LATERAL (
            SELECT * FROM subscriptions WHERE subscriptions.company_id = companies.id ORDER BY id DESC LIMIT 1
          ) sub ON true
          JOIN LATERAL (
            SELECT * FROM users WHERE users.company_id = companies.id ORDER BY id ASC LIMIT 1
          ) u ON true
          WHERE companies.created_at >= '${since}' AND companies.created_at < '${until1}'
            AND sub.trial_start IS NOT NULL
          ${INTERNAL_FILTER}
          GROUP BY 1
          ORDER BY 2
        `),
      ]);
      if (tbRows[0]) {
        const [avg_signup_trial, avg_trial_active, over_14d, in_14d] = tbRows[0];
        const avg_signup_to_trial_by_source = {};
        for (const [src, avg] of tbSrcRows) {
          avg_signup_to_trial_by_source[src] = avg != null ? Number(avg) : null;
        }
        trial_behavior = {
          avg_days_signup_to_trial: avg_signup_trial != null ? Number(avg_signup_trial) : null,
          avg_days_trial_to_active: avg_trial_active != null ? Number(avg_trial_active) : null,
          over_14d_not_active: Number(over_14d) || 0,
          in_14d_window: Number(in_14d) || 0,
          avg_signup_to_trial_by_source,
        };
      }
    } catch (_) { /* trial_behavior stays null */ }

    // ── 6. Card 769 — all self-service subscriptions ─────────────────────────
    // Cols: 0:company_id 1:company_name 2:company_created_at 3:user_id 4:user_email
    //       5:subscription_status 6:subscription_started_at 7:current_price
    //       8:unit_amount 9:commitment_months 10:seats 11:mrr 12:total_spent
    //      13:signup_url 14:utm_source
    const subRows = await runCard(769);

    const utmToSource = (utm) => {
      if (!utm) return 'Organic';
      const u = utm.toLowerCase();
      if (u === 'facebook') return 'Meta';
      if (u === 'google') return 'Google Ads';
      return 'Organic';
    };

    const payingCustomers = subRows
      .filter(r => r[5] === 'active')
      .sort((a, b) => (b[6] || '').localeCompare(a[6] || ''))
      .map(r => ({
        company:    r[1],
        email:      r[4],
        started_at: r[6] ? r[6].slice(0, 10) : null,
        plan:       r[7],
        mrr:        parseFloat(r[11]) || 0,
        seats:      r[10],
        source:     utmToSource(r[14]),
      }));

    const churnList = subRows
      .filter(r => r[5] !== 'active' && r[5] !== null && r[5] !== 'waiting_for_creation')
      .sort((a, b) => (b[6] || '').localeCompare(a[6] || ''))
      .map(r => ({
        company:    r[1],
        email:      r[4],
        started_at: r[6] ? r[6].slice(0, 10) : null,
        status:     r[5],
        plan:       r[7],
        mrr:        parseFloat(r[11]) || 0,
        source:     utmToSource(r[14]),
      }));

    const mrr         = payingCustomers.reduce((s, r) => s + r.mrr, 0);
    const active_paid = payingCustomers.length;

    // ── 7. Card 670 — current trials ─────────────────────────────────────────
    const trialRows2 = await runCard(670);
    const trialing   = trialRows2.length;

    // ── 7b. Avg days signup → active (all-time, not date-filtered) ───────────
    let avg_days_signup_to_active = null;
    try {
      const saRows = await runSQL(`
        SELECT ROUND(AVG(EXTRACT(EPOCH FROM (sub.subscribed_at - companies.created_at)) / 86400)::numeric, 1)
        FROM companies
        LEFT JOIN LATERAL (
          SELECT * FROM subscriptions WHERE subscriptions.company_id = companies.id ORDER BY id DESC LIMIT 1
        ) sub ON true
        JOIN LATERAL (
          SELECT * FROM users WHERE users.company_id = companies.id ORDER BY id ASC LIMIT 1
        ) u ON true
        WHERE sub.subscribed_at IS NOT NULL AND sub.status = 'active'
        AND u.email NOT ILIKE '%sortlist.com%'
        AND u.email NOT ILIKE '%overloop%'
        AND companies.name NOT ILIKE '%sortlist%'
        AND companies.name NOT ILIKE '%overloop%'
      `);
      if (saRows[0]?.[0] != null) avg_days_signup_to_active = Number(saRows[0][0]);
    } catch (_) {}

    // ── 8. Financial metrics ──────────────────────────────────────────────────
    const churn_count = churnList.length;
    // Lifetime churn rate: % of all customers who have ever churned
    const churn_rate = (active_paid + churn_count) > 0
      ? Math.round((churn_count / (active_paid + churn_count)) * 1000) / 10
      : 0;
    const arpu = active_paid > 0 ? Math.round((mrr / active_paid) * 100) / 100 : 0;

    // Average tenure of churned customers in months (observed lifespan proxy)
    const nowMs = Date.now();
    const tenures = churnList
      .filter(r => r.started_at)
      .map(r => (nowMs - new Date(r.started_at).getTime()) / (1000 * 60 * 60 * 24 * 30.44));
    const avg_tenure_months = tenures.length > 0
      ? Math.round((tenures.reduce((s, v) => s + v, 0) / tenures.length) * 10) / 10
      : null;
    // LTV = ARPU × avg observed lifespan of churned customers
    const ltv = avg_tenure_months != null && arpu > 0
      ? Math.round(arpu * avg_tenure_months)
      : null;

    res.json({
      granularity,
      signups_daily,
      trials_daily,
      activations_daily,
      funnel: {
        steps: totalsFinal,   // [s1…s9] cumulative counts
        total: totalsFinal[0] || 0,
      },
      funnel_by_source: funnelBySource,
      funnel_by_device: funnelByDevice,
      trial_behavior,
      trialing,
      active_paid,
      churn: churn_count,
      financials: {
        trialing,
        active_paid,
        mrr:    Math.round(mrr),
        churn:  churn_count,
        churn_rate,               // % — lifetime
        arpu,                     // $/month per active customer
        ltv,                      // $ — ARPU × avg churned tenure
        avg_tenure_months,        // months
        avg_days_signup_to_active,// days — all-time avg signup→subscribed_at for active customers
        trial_to_active_rate: (active_paid + trialing) > 0
          ? Math.round((active_paid / (active_paid + trialing)) * 100)
          : 0,
        paying_customers: payingCustomers,
        churn_list:       churnList,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
