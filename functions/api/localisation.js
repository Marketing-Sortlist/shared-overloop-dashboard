const DB_ID = 5;

async function runSQL(env, sql) {
  const res = await fetch(`${env.METABASE_URL}/api/dataset`, {
    method: 'POST',
    headers: { 'x-api-key': env.METABASE_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ database: DB_ID, type: 'native', native: { query: sql } }),
  });
  if (!res.ok) throw new Error(`Dataset API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data?.data?.rows || [];
}

const INTERNAL_FILTER = `
  AND u.email NOT ILIKE '%sortlist.com%'
  AND u.email NOT ILIKE '%overloop%'
  AND companies.name NOT ILIKE '%sortlist%'
  AND companies.name NOT ILIKE '%overloop%'
`;

const V1_ONLY_FILTER = `
  AND NOT EXISTS (SELECT 1 FROM onboarding_v2_sessions WHERE onboarding_v2_sessions.user_id = u.id)
`;

const V1_STEP = `
  CASE
    WHEN u.current_signup_step = 'finished'
         AND sub.status IN ('active','canceled','past_due') THEN 9
    WHEN u.current_signup_step = 'finished'
         AND sub.status = 'trialing'                       THEN 8
    ELSE 0
  END
`;

const V2_STEP = `
  CASE
    WHEN sub.status IN ('active','past_due')
      OR (sub.status = 'canceled' AND sub.subscribed_at IS NOT NULL) THEN 9
    WHEN s.state = 'completed'                                       THEN 8
    ELSE 0
  END
`;

// All-time, excluding last 14 days so immature cohorts don't skew conversion rates
const DATE_FILTER = `companies.created_at < NOW() - INTERVAL '14 days'`;

function buildUnionCTE(extraSelect = '') {
  return `
    v1 AS (
      SELECT
        u.preferred_locale AS lang,
        u.email,
        ${extraSelect}
        ${V1_STEP} AS step_num,
        sub.status,
        sub.subscribed_at
      FROM companies
      LEFT JOIN LATERAL (
        SELECT * FROM subscriptions
        WHERE subscriptions.company_id = companies.id
        ORDER BY id DESC LIMIT 1
      ) sub ON true
      JOIN LATERAL (
        SELECT * FROM users
        WHERE users.company_id = companies.id
        ORDER BY id ASC LIMIT 1
      ) u ON true
      WHERE ${DATE_FILTER}
      ${INTERNAL_FILTER}
      ${V1_ONLY_FILTER}
    ),
    v2 AS (
      SELECT
        u.preferred_locale AS lang,
        u.email,
        ${extraSelect}
        ${V2_STEP} AS step_num,
        sub.status,
        sub.subscribed_at
      FROM companies
      JOIN LATERAL (
        SELECT * FROM users
        WHERE users.company_id = companies.id
        ORDER BY id ASC LIMIT 1
      ) u ON true
      JOIN onboarding_v2_sessions s ON s.user_id = u.id
      LEFT JOIN LATERAL (
        SELECT * FROM subscriptions
        WHERE company_id = companies.id
        ORDER BY id DESC LIMIT 1
      ) sub ON true
      WHERE ${DATE_FILTER}
      ${INTERNAL_FILTER}
    )
  `;
}

export async function onRequest(context) {
  const { env, request } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*' } });
  }

  try {
    const [funnelRows, cohortRows] = await Promise.all([

      // Summary funnel by language (all-time, excl last 14d)
      runSQL(env, `
        WITH ${buildUnionCTE()},
        all_users AS (SELECT * FROM v1 UNION ALL SELECT * FROM v2)
        SELECT
          lang,
          COUNT(DISTINCT email)                                                                   AS signups,
          COUNT(DISTINCT email) FILTER (WHERE step_num >= 8)                                     AS trials,
          COUNT(DISTINCT email) FILTER (WHERE step_num >= 9)                                     AS active,
          COUNT(DISTINCT email) FILTER (WHERE status = 'canceled' AND subscribed_at IS NOT NULL) AS cancel_active
        FROM all_users
        GROUP BY lang
        ORDER BY signups DESC
      `),

      // Monthly cohort by language (aggregated to month, frontend handles quarter)
      runSQL(env, `
        WITH ${buildUnionCTE("DATE_TRUNC('month', companies.created_at)::date AS cohort_month,")},
        all_users AS (SELECT * FROM v1 UNION ALL SELECT * FROM v2)
        SELECT
          cohort_month::text,
          lang,
          COUNT(DISTINCT email)                                                                   AS signups,
          COUNT(DISTINCT email) FILTER (WHERE step_num >= 8)                                     AS trials,
          COUNT(DISTINCT email) FILTER (WHERE step_num >= 9)                                     AS active,
          COUNT(DISTINCT email) FILTER (WHERE status = 'canceled' AND subscribed_at IS NOT NULL) AS cancel_active
        FROM all_users
        GROUP BY 1, 2
        ORDER BY 1, 2
      `),

    ]);

    const funnel_by_language = funnelRows.map(([lang, signups, trials, active, cancel_active]) => ({
      lang,
      signups:       Number(signups),
      trials:        Number(trials),
      active:        Number(active),
      cancel_active: Number(cancel_active),
    }));

    const cohort_by_language = cohortRows.map(([month, lang, signups, trials, active, cancel_active]) => ({
      month:         String(month).slice(0, 7),
      lang,
      signups:       Number(signups),
      trials:        Number(trials),
      active:        Number(active),
      cancel_active: Number(cancel_active),
    }));

    return Response.json(
      { funnel_by_language, cohort_by_language },
      { headers: { 'Access-Control-Allow-Origin': '*' } }
    );

  } catch (err) {
    return Response.json({ error: err.message }, { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } });
  }
}
