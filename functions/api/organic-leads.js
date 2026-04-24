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

  const sql = `
    SELECT
      date_trunc('week', companies.created_at)::date AS week_start,
      COALESCE(sub.status, 'none')                   AS status,
      COUNT(*)                                        AS signups
    FROM companies
    LEFT JOIN subscriptions sub ON sub.company_id = companies.id
    WHERE
      companies.created_at >= '${since}'
      AND companies.created_at < '${until}'::date + INTERVAL '1 day'
      AND COALESCE(substring(companies.signup_url, 'utm_source=([^&]*)'), '') = ''
      AND COALESCE(substring(companies.signup_url, 'gclid=([^&]+)'),  '')    = ''
      AND COALESCE(substring(companies.signup_url, 'wbraid=([^&]+)'), '')    = ''
      AND COALESCE(substring(companies.signup_url, 'gbraid=([^&]+)'), '')    = ''
      AND COALESCE(substring(companies.signup_url, 'fbclid=([^&]+)'), '')    = ''
    GROUP BY 1, 2
    ORDER BY 1, 2
  `;

  try {
    const r = await fetch(`${MB_BASE}/api/dataset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': MB_KEY },
      body: JSON.stringify({ database: DB_ID, type: 'native', native: { query: sql } }),
    });
    const data = await r.json();
    if (data.error) throw new Error(data.error);

    const rows = data.data?.rows || [];

    // Pivot: week → { none, trialing, active, canceled }
    const byWeek = {};
    for (const [week, status, count] of rows) {
      if (!byWeek[week]) byWeek[week] = { date: week, none: 0, trialing: 0, active: 0, canceled: 0 };
      const key = status || 'none';
      byWeek[week][key] = (byWeek[week][key] || 0) + parseInt(count);
    }

    const weekly = Object.values(byWeek).sort((a, b) => a.date.localeCompare(b.date));
    const totals = { none: 0, trialing: 0, active: 0, canceled: 0 };
    for (const w of weekly) {
      for (const k of Object.keys(totals)) totals[k] += w[k] || 0;
    }

    return Response.json({ weekly, totals }, { headers: cors });

  } catch (err) {
    return Response.json({ error: err.message }, { status: 500, headers: cors });
  }
}
