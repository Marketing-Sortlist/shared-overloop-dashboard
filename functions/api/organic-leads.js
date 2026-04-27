// functions/api/organic-leads.js — Cloudflare Pages Function
// Env vars: METABASE_URL, METABASE_API_KEY, METABASE_DB_ID (default: 5)

export async function onRequestGet({ request, env }) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 's-maxage=3600' };
  const url   = new URL(request.url);
  const since = url.searchParams.get('since');
  const until = url.searchParams.get('until');

  if (!since || !until) {
    return Response.json({ error: 'since and until required' }, { status: 400, headers: cors });
  }

  const MB_BASE = env.METABASE_URL || 'https://overloop-dashboards.herokuapp.com';
  const MB_KEY  = env.METABASE_API_KEY;
  const DB_ID   = parseInt(env.METABASE_DB_ID || '5');

  const BASE_FROM = `
    FROM companies
    JOIN LATERAL (
      SELECT id, email FROM users WHERE company_id = companies.id ORDER BY id ASC LIMIT 1
    ) u ON true
    LEFT JOIN LATERAL (
      SELECT status, subscribed_at FROM subscriptions WHERE company_id = companies.id ORDER BY id DESC LIMIT 1
    ) sub ON true
    LEFT JOIN LATERAL (
      SELECT state FROM onboarding_v2_sessions WHERE company_id = companies.id AND user_id = u.id LIMIT 1
    ) ob ON true
    WHERE companies.created_at >= '${since}'
      AND companies.created_at < '${until}'::date + INTERVAL '1 day'
      AND COALESCE(substring(companies.signup_url, 'utm_source=([^&]*)'), '') = ''
      AND COALESCE(substring(companies.signup_url, 'gclid=([^&]+)'),  '')    = ''
      AND COALESCE(substring(companies.signup_url, 'wbraid=([^&]+)'), '')    = ''
      AND COALESCE(substring(companies.signup_url, 'gbraid=([^&]+)'), '')    = ''
      AND COALESCE(substring(companies.signup_url, 'fbclid=([^&]+)'), '')    = ''
  `;

  // V1 trialing = no V2 session + sub.status = trialing
  // V2 trialing = ob.state = 'completed' and not yet active/canceled
  const STATUS_CASE = `
    CASE
      WHEN sub.status IN ('active', 'past_due')                                      THEN 'active'
      WHEN sub.status = 'canceled'                                                    THEN 'canceled'
      WHEN ob.state IS NULL AND sub.status = 'trialing'                             THEN 'trialing'
      WHEN ob.state IS NOT NULL AND ob.state = 'completed'
           AND sub.status NOT IN ('active', 'past_due', 'canceled')                 THEN 'trialing'
      ELSE 'not_started'
    END
  `;

  const weeklySql = `
    SELECT
      date_trunc('week', companies.created_at)::date AS week_start,
      ${STATUS_CASE} AS status,
      COUNT(*) AS signups
    ${BASE_FROM}
    GROUP BY 1, 2
    ORDER BY 1, 2
  `;

  // Cascade: trial_started includes any user who genuinely entered trial
  // V1 trial = any subscription status (trialing/active/past_due/canceled = all went through trial)
  // V2 trial = ob.state = 'completed' OR became active OR canceled after paying
  // ever_active = currently active/past_due OR canceled after paying (subscribed_at IS NOT NULL)
  const cascadeSql = `
    SELECT
      COUNT(*) AS total_signups,
      COUNT(*) FILTER (WHERE
        (ob.state IS NULL AND sub.status IN ('trialing', 'active', 'past_due', 'canceled'))
        OR (ob.state IS NOT NULL AND (
          ob.state = 'completed'
          OR sub.status IN ('active', 'past_due')
          OR (sub.status = 'canceled' AND sub.subscribed_at IS NOT NULL)
        ))
      ) AS total_trial,
      COUNT(*) FILTER (WHERE
        sub.status IN ('active', 'past_due')
        OR (sub.status = 'canceled' AND sub.subscribed_at IS NOT NULL)
      ) AS total_ever_active,
      COUNT(*) FILTER (WHERE sub.status = 'canceled') AS total_canceled
    ${BASE_FROM}
  `;

  const runMB = async (sql) => {
    const r = await fetch(`${MB_BASE}/api/dataset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': MB_KEY },
      body: JSON.stringify({ database: DB_ID, type: 'native', native: { query: sql } }),
    });
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    return data.data?.rows || [];
  };

  try {
    const [weeklyRows, cascadeRows] = await Promise.all([runMB(weeklySql), runMB(cascadeSql)]);

    const byWeek = {};
    for (const [week, status, count] of weeklyRows) {
      if (!byWeek[week]) byWeek[week] = { date: week, not_started: 0, trialing: 0, active: 0, canceled: 0 };
      const key = status || 'not_started';
      byWeek[week][key] = (byWeek[week][key] || 0) + parseInt(count);
    }
    const weekly = Object.values(byWeek).sort((a, b) => a.date.localeCompare(b.date));
    const totals = { not_started: 0, trialing: 0, active: 0, canceled: 0 };
    for (const w of weekly) {
      for (const k of Object.keys(totals)) totals[k] += w[k] || 0;
    }

    const [signups, trial, ever_active, canceled] = (cascadeRows[0] || [0, 0, 0, 0]).map(Number);
    const funnel = { signups, trial, ever_active, canceled };

    return Response.json({ weekly, totals, funnel }, { headers: cors });

  } catch (err) {
    return Response.json({ error: err.message }, { status: 500, headers: cors });
  }
}
