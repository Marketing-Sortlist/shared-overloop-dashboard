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

async function runCard(env, cardId) {
  const res = await fetch(`${env.METABASE_URL}/api/card/${cardId}/query`, {
    method: 'POST',
    headers: { 'x-api-key': env.METABASE_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data?.data?.rows || [];
}

function getDateRange(url) {
  const params = url.searchParams;
  const fmt = (d) => d.toISOString().split('T')[0];
  let since, until;
  if (params.get('since') && params.get('until')) {
    since = params.get('since');
    until = params.get('until');
  } else {
    const days = parseInt(params.get('days')) || 14;
    const u = new Date(); const s = new Date();
    s.setDate(s.getDate() - days);
    since = fmt(s); until = fmt(u);
  }
  const u1 = new Date(until + 'T00:00:00Z');
  u1.setUTCDate(u1.getUTCDate() + 1);
  return { since, until, until1: fmt(u1) };
}

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

const CAMPAIGN_CASE = `LOWER(COALESCE(substring(companies.signup_url, 'utm_campaign=([^&]*)'), ''))`;

// "Ever active" = the contact has been a paying customer at some point.
// The subscriptions table keeps no history (one row per company, updated in place),
// so we combine two signals so an activation is never lost as the status evolves:
//   - status IN ('active','past_due','unpaid'): currently paying OR in dunning.
//     past_due/unpaid only occur AFTER being active, so they still count.
//   - subscribed_at IS NOT NULL (across any of the company's subscription rows):
//     was billed at least once, e.g. active-then-canceled.
// Caveat: an active contact that cancels WITHOUT subscribed_at ever being set
// cannot be recovered from current data (no snapshot history exists).
const EVER_ACTIVE = `
  (sub.status IN ('active','past_due','unpaid')
   OR EXISTS (SELECT 1 FROM subscriptions sx
              WHERE sx.company_id = companies.id
                AND sx.subscribed_at IS NOT NULL))`;

// A cancellation = the contact has requested to cancel (whether it was a trial
// or a paid subscription). Since 2026-06-25 (V2 only), canceling no longer flips
// the status to 'canceled' immediately: the sub keeps status trialing/active with
// cancel_at_period_end=true until the period ends, then becomes 'canceled'. Count
// both states so cancellations are captured at request time. No double-count:
// one subscription row per company, so a contact is in exactly one state.
// PAYWALL: did this contact ever pass the card wall?
//
// PRODUCT CHANGE 2026-08-27: the paywall moved to AFTER onboarding. Until the
// 26th, reaching onboarding_v2_sessions.state='completed' required entering a
// card, so 'completed' was the trial marker. From the 27th a contact can reach
// 'completed' (and the app) with no card and no Stripe subscription.
//
// The durable marker is onboarding_v2_sessions.stripe_checkout_session_id: it
// is set when the contact goes through Stripe checkout and it SURVIVES
// cancellation, unlike subscriptions.stripe_id which is nulled on cancel.
// Verified on 2026-08-28: for every company created since 2026-06-01, having
// state='completed' and having a checkout session matched 1:1 until the 26th,
// so this definition reproduces the old funnel exactly on historical data.
// The extra OR clauses are defence in case the new in-app paywall records the
// subscription without writing a checkout session id.
const PAYWALL = (ob) => `(
  ${ob}.stripe_checkout_session_id IS NOT NULL
  OR sub.stripe_id IS NOT NULL
  OR sub.subscribed_at IS NOT NULL
  OR sub.status IN ('active','past_due','unpaid'))`;

const IS_CANCELED = `(sub.status = 'canceled' OR sub.cancel_at_period_end = true)`;

// Split of IS_CANCELED into never-paid vs was-paying, accounting for the
// 2026-06-25 change: a pending cancel keeps its status (trialing / active)
// with cancel_at_period_end=true instead of flipping to 'canceled'.
const TRIAL_CANCEL = `(
  (sub.status = 'canceled' AND sub.subscribed_at IS NULL)
  OR (sub.status = 'trialing' AND sub.cancel_at_period_end = true))`;
const PAID_CANCEL = `(
  (sub.status = 'canceled' AND sub.subscribed_at IS NOT NULL)
  OR (sub.status IN ('active','past_due','unpaid') AND sub.cancel_at_period_end = true))`;

const STEP_CASE = `
  CASE
    WHEN ${EVER_ACTIVE}                                                                                       THEN 9
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

const INTERNAL_FILTER = `
  AND u.email NOT ILIKE '%sortlist.com%'
  AND u.email NOT ILIKE '%overloop%'
  AND u.email NOT ILIKE '%yourmax%'
  AND companies.name NOT ILIKE '%sortlist%'
  AND companies.name NOT ILIKE '%overloop%'
  AND companies.name NOT ILIKE '%yourmax%'
`;

const V1_ONLY_FILTER = `
  AND NOT EXISTS (SELECT 1 FROM onboarding_v2_sessions WHERE onboarding_v2_sessions.user_id = u.id)
`;

// ── Onboarding cohorts ─────────────────────────────────────────────────────
//
// Onboarding v2.1 = the frontend release of 2026-08-27 14:00, which moved the
// paywall to after onboarding. It is not a new onboarding, it is v2 with that
// release on top, so it lives as a third cohort rather than a third funnel.
const V21_CUTOFF = '2026-08-27 14:00';

// Keyed on the FIRST v2 session, never the latest. A contact who signed up in
// January and reopened onboarding after the cutoff saw v2 the first time round,
// so they belong to v2. Cutting on the latest session dragged 70 such contacts
// into v2.1, some with signups going back to 7 Jan.
const COHORT_CASE = (f) => `
  CASE
    WHEN ${f}.user_id IS NULL                  THEN 'legacy'
    WHEN ${f}.created_at < '${V21_CUTOFF}'     THEN 'v2'
    ELSE                                            'v2.1'
  END`;

const FIRST_SESSION_JOIN = `
  LEFT JOIN LATERAL (
    SELECT * FROM onboarding_v2_sessions WHERE user_id = u.id ORDER BY created_at ASC LIMIT 1
  ) f ON true`;

const DEVICE_CASE = `
  CASE
    WHEN COALESCE(companies.signup_user_agent, '') ~* '(mobile|android|iphone)' THEN 'mobile'
    WHEN COALESCE(companies.signup_user_agent, '') ~* '(ipad|tablet)'           THEN 'tablet'
    WHEN companies.signup_user_agent IS NOT NULL
         AND companies.signup_user_agent <> ''                                 THEN 'desktop'
    ELSE 'unknown'
  END`;

// Legacy benchmark window, deliberately pinned and NOT driven by the date picker.
// Legacy was 100% of signups in Feb and Mar 2026 and 72.7% in Apr; from May on it
// is a residual tail of 7 to 20 a month, so inside a recent window the column is
// noise (n=9) rather than a population. April is included because signup_user_agent
// only starts being populated then: 77.2% of Feb+Mar has no device, so without April
// the device filter would leave the column at 141 of 650 with no way to notice.
const LEGACY_WINDOW = { since: '2026-02-01', until: '2026-05-01' };

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

export async function onRequest(context) {
  const { env, request } = context;
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*' } });
  }

  const granularity = ['day', 'week', 'month'].includes(url.searchParams.get('granularity')) ? url.searchParams.get('granularity') : 'day';
  const { since, until1 } = getDateRange(url);

  try {
    // 1. Signups grouped by period + source
    const dailyRows = await runSQL(env, `
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

    // 1b. Signups grouped by source + utm_campaign (for per-campaign tables)
    let signups_by_campaign = [];
    try {
      const sigCampRows = await runSQL(env, `
        SELECT
          ${SOURCE_CASE} AS source,
          ${CAMPAIGN_CASE} AS campaign,
          COUNT(DISTINCT u.email) AS cnt
        FROM companies
        JOIN LATERAL (
          SELECT * FROM users WHERE users.company_id = companies.id ORDER BY id ASC LIMIT 1
        ) u ON true
        WHERE companies.created_at >= '${since}' AND companies.created_at < '${until1}'
        ${INTERNAL_FILTER}
        GROUP BY 1, 2
        ORDER BY 1, 2
      `);
      signups_by_campaign = sigCampRows.map(([source, campaign, cnt]) => ({
        source,
        campaign,
        signups: parseInt(cnt) || 0,
      }));
    } catch (_) {}

    // 1c. Trials by source + utm_campaign — V1 only (V2 part merged after V2_BASE/V2_STEP are defined)
    const tCampMap = {};
    try {
      const tv1Rows = await runSQL(env, `
        WITH raw AS (
          SELECT
            u.email,
            ${SOURCE_CASE} AS source,
            ${CAMPAIGN_CASE} AS campaign,
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
          ${V1_ONLY_FILTER}
        ),
        deduped AS (
          SELECT DISTINCT ON (email) email, source, campaign, step_num
          FROM raw ORDER BY email, step_num DESC
        )
        SELECT source, campaign, COUNT(*) FILTER (WHERE step_num >= 8) AS trials
        FROM deduped
        GROUP BY source, campaign
        ORDER BY source, campaign
      `);
      for (const [source, campaign, t] of tv1Rows) {
        const key = `${source}|${campaign}`;
        if (!tCampMap[key]) tCampMap[key] = { source, campaign, trials: 0 };
        tCampMap[key].trials += parseInt(t) || 0;
      }
    } catch (_) {}

    // 2. Funnel — one cube by (source, device), same reason as the v2 one below:
    // two separate 1-D breakdowns cannot be intersected.
    const funnelRows = await runSQL(env, `
      WITH raw AS (
        SELECT
          u.email,
          ${SOURCE_CASE} AS source,
          ${DEVICE_CASE} AS device,
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
        ${V1_ONLY_FILTER}
      ),
      deduped AS (
        SELECT DISTINCT ON (email) email, source, device, step_num
        FROM raw ORDER BY email, step_num DESC
      )
      SELECT
        source,
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
      GROUP BY source, device
    `);

    const funnelBySource = {};
    const funnelByDevice = {};
    const funnel_cube = [];
    const totalsFinal = Array(9).fill(0);
    for (const [source, device, ...counts] of funnelRows) {
      const steps = counts.map(Number);
      funnel_cube.push({ source, device, steps });
      if (!funnelBySource[source]) funnelBySource[source] = Array(9).fill(0);
      if (!funnelByDevice[device]) funnelByDevice[device] = Array(9).fill(0);
      steps.forEach((v, i) => {
        funnelBySource[source][i] += v;
        funnelByDevice[device][i] += v;
        totalsFinal[i] += v;
      });
    }

    // 4. Per-period funnel
    let trials_daily = [], activations_daily = [];
    try {
      const periodFunnelRows = await runSQL(env, `
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
          ${V1_ONLY_FILTER}
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

    // 5. Trial behaviour
    let trial_behavior = null;
    try {
      const [tbRows, tbSrcRows] = await Promise.all([
        runSQL(env, `
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
            AND NOT EXISTS (SELECT 1 FROM onboarding_v2_sessions WHERE onboarding_v2_sessions.user_id = u.id)
          ${INTERNAL_FILTER}
        `),
        runSQL(env, `
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
            AND NOT EXISTS (SELECT 1 FROM onboarding_v2_sessions WHERE onboarding_v2_sessions.user_id = u.id)
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

    // 6. Card 769 — all self-service subscriptions
    const subRows = await runCard(env, 769);

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

    // 7. Card 670 — current trials
    const trialRows2 = await runCard(env, 670);
    const trialing   = trialRows2.length;

    // 7c. Trials list — V2 only: all users who completed V2 onboarding (sc.state='completed').
    // Shows current_subscription_status for each, and trial window = sc.updated_at + 14 days.
    let trials_list = [];
    try {
      const trialsListRows = await runSQL(env, `
        SELECT
          companies.name AS company,
          u.email,
          sc.updated_at::date AS trial_started_at,
          (sc.updated_at + INTERVAL '14 days')::date AS trial_end_date,
          COALESCE(sub.status, 'no_subscription') AS status,
          ${SOURCE_CASE} AS source
        FROM companies
        JOIN LATERAL (
          SELECT * FROM users WHERE company_id = companies.id ORDER BY id ASC LIMIT 1
        ) u ON true
        JOIN LATERAL (
          SELECT * FROM onboarding_v2_sessions
          WHERE user_id = u.id AND state = 'completed'
            AND stripe_checkout_session_id IS NOT NULL
          ORDER BY updated_at DESC LIMIT 1
        ) sc ON true
        LEFT JOIN LATERAL (
          SELECT * FROM subscriptions WHERE company_id = companies.id ORDER BY id DESC LIMIT 1
        ) sub ON true
        WHERE u.email NOT ILIKE '%sortlist.com%'
          AND u.email NOT ILIKE '%overloop%'
          AND companies.name NOT ILIKE '%sortlist%'
          AND companies.name NOT ILIKE '%overloop%'
        ORDER BY sc.updated_at ASC
      `);
      trials_list = trialsListRows.map(([company, email, trial_started_at, trial_end_date, status, source]) => ({
        company,
        email,
        trial_started_at: trial_started_at ? String(trial_started_at).slice(0, 10) : null,
        trial_end_date:   trial_end_date   ? String(trial_end_date).slice(0, 10)   : null,
        status,
        source,
      }));
    } catch (_) {}

    // 7b. Avg days signup → active
    let avg_days_signup_to_active = null;
    try {
      const saRows = await runSQL(env, `
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

    // 8. V2 funnel
    const V2_STEP = `
      CASE
        WHEN ${EVER_ACTIVE}                        THEN 9
        WHEN ${PAYWALL('s')}                       THEN 8
        WHEN s.state IN ('completed',
                         'moved_to_stripe')        THEN 7
        WHEN s.state = 'sequence_accepted'         THEN 6
        WHEN s.state = 'channels_accepted'         THEN 5
        WHEN s.state = 'icp_accepted'              THEN 4
        WHEN s.state = 'business_details_accepted' THEN 3
        WHEN s.state = 'domain_provided'           THEN 2
        WHEN s.state = 'email_confirmed'           THEN 1
        ELSE 0
      END
    `;

    // The measurement in force BEFORE the 2026-08-27 14:00 release. Back then,
    // reaching state='completed' required entering a card, so 'completed' WAS the
    // trial marker and 'moved_to_stripe' was the step below it. Kept so the
    // Onboarding v2 tab reads that cohort the way it was read at the time,
    // instead of retro-fitting today's paywall-based definition onto it.
    const V2_STEP_PRE827 = `
      CASE
        WHEN ${EVER_ACTIVE}                        THEN 9
        WHEN s.state = 'completed'                 THEN 8
        WHEN s.state = 'moved_to_stripe'           THEN 7
        WHEN s.state = 'sequence_accepted'         THEN 6
        WHEN s.state = 'channels_accepted'         THEN 5
        WHEN s.state = 'icp_accepted'              THEN 4
        WHEN s.state = 'business_details_accepted' THEN 3
        WHEN s.state = 'domain_provided'           THEN 2
        WHEN s.state = 'email_confirmed'           THEN 1
        ELSE 0
      END
    `;
    const V2_COUNTS_OF = (col, sfx) => [1,2,3,4,5,6,7,8,9]
      .map(n => `COUNT(*) FILTER (WHERE ${col} >= ${n}) AS s${n}${sfx}`).join(',\n      ');
    const V2_COUNTS = V2_COUNTS_OF('step_num', '');
    const V2_BASE = `
      FROM companies
      JOIN LATERAL (
        SELECT * FROM users WHERE users.company_id = companies.id ORDER BY id ASC LIMIT 1
      ) u ON true
      JOIN onboarding_v2_sessions s ON s.user_id = u.id
      ${FIRST_SESSION_JOIN}
      LEFT JOIN LATERAL (
        SELECT * FROM subscriptions WHERE company_id = companies.id ORDER BY id DESC LIMIT 1
      ) sub ON true
      WHERE companies.created_at >= '${since}' AND companies.created_at < '${until1}'
      ${INTERNAL_FILTER}
    `;

    let funnel_v2 = { steps: Array(9).fill(0), total: 0 };
    let funnel_v2_cube = [];
    let funnel_v2_by_source = {};
    let funnel_v2_by_device = {};
    let trials_v2_daily = [], activations_v2_daily = [];
    try {
      // One cube by (cohort, source, device) instead of two independent 1-D
      // breakdowns. Two breakdowns cannot answer "meta AND desktop", which is why
      // picking a device used to wipe the source. Cardinality is ~2x5x4 rows of
      // nine counts, so the client aggregates over whatever is set to "all".
      // Each row carries the funnel under BOTH measurements: `steps` is today's
      // paywall-based definition and `steps_pre827` the one in force before the
      // 27 Aug release. The Onboarding v2 tab reads its cohort the way it was
      // read at the time; the v2.1 tab reads its own the way we read it now.
      const fv2Rows = await runSQL(env, `
        WITH raw AS (
          SELECT u.email,
            ${COHORT_CASE('f')}        AS cohort,
            ${SOURCE_CASE}             AS source,
            ${DEVICE_CASE}             AS device,
            MAX(${V2_STEP})            AS step_num,
            MAX(${V2_STEP_PRE827})     AS step_pre
          ${V2_BASE} GROUP BY u.email, cohort, source, device
        )
        SELECT cohort, source, device,
          ${V2_COUNTS_OF('step_num', '')},
          ${V2_COUNTS_OF('step_pre', 'p')}
        FROM raw GROUP BY cohort, source, device ORDER BY s1 DESC
      `);
      const v2Totals = Array(9).fill(0);
      for (const [cohort, source, device, ...counts] of fv2Rows) {
        const steps        = counts.slice(0, 9).map(Number);
        const steps_pre827 = counts.slice(9, 18).map(Number);
        funnel_v2_cube.push({ cohort, source, device, steps, steps_pre827 });
        steps.forEach((v, i) => { v2Totals[i] += v; });
        if (!funnel_v2_by_source[source]) funnel_v2_by_source[source] = Array(9).fill(0);
        if (!funnel_v2_by_device[device]) funnel_v2_by_device[device] = Array(9).fill(0);
        steps.forEach((v, i) => { funnel_v2_by_source[source][i] += v; funnel_v2_by_device[device][i] += v; });
      }
      funnel_v2 = { steps: v2Totals, total: v2Totals[0] || 0 };
    } catch (e) { funnel_v2 = { steps: Array(9).fill(0), total: 0, _error: e.message }; }

    // V2 per-period trials / activations (same structure as V1 trials_daily / activations_daily)
    let funnel_v2_period = [];
    try {
      const v2PeriodRows = await runSQL(env, `
        WITH raw AS (
          SELECT
            DATE_TRUNC('${granularity}', companies.created_at)::date AS period,
            u.email,
            ${SOURCE_CASE} AS source,
            MAX(${V2_STEP}) AS step_num
          ${V2_BASE} GROUP BY period, u.email, source
        )
        SELECT period::text, source,
          COUNT(*) FILTER (WHERE step_num >= 1) AS signups,
          -- NOTE: the key is still called "stripe" for backwards compatibility with
          -- index.html. Step 7 means "finished the onboarding flow, no card yet".
          -- It holds two populations that never overlap in time: until 2026-08-26
          -- it is moved_to_stripe (stopped AT the Stripe checkout, never entered
          -- the app); from 2026-08-27 it is completed-without-card (inside the
          -- app, paywall not reached yet). Hence the neutral label in the UI.
          COUNT(*) FILTER (WHERE step_num >= 7) AS stripe,
          COUNT(*) FILTER (WHERE step_num >= 8) AS trialing,
          COUNT(*) FILTER (WHERE step_num >= 9) AS active
        FROM raw GROUP BY period, source ORDER BY period
      `);
      const tMap = {}, aMap = {}, periodMap = {};
      for (const [period, source, sg, st, t, a] of v2PeriodRows) {
        const d = String(period).slice(0, 10);
        if (!tMap[d]) tMap[d] = { date: d, count: 0 };
        tMap[d][source] = (tMap[d][source] || 0) + Number(t);
        tMap[d].count += Number(t);
        if (!aMap[d]) aMap[d] = { date: d, count: 0 };
        aMap[d][source] = (aMap[d][source] || 0) + Number(a);
        aMap[d].count += Number(a);
        if (!periodMap[d]) periodMap[d] = { date: d, signups: 0, stripe: 0, trialing: 0, active: 0 };
        periodMap[d].signups  += Number(sg);
        periodMap[d].stripe   += Number(st);
        periodMap[d].trialing += Number(t);
        periodMap[d].active   += Number(a);
      }
      trials_v2_daily      = Object.values(tMap).sort((x, y) => x.date.localeCompare(y.date));
      activations_v2_daily = Object.values(aMap).sort((x, y) => x.date.localeCompare(y.date));
      funnel_v2_period     = Object.values(periodMap).sort((x, y) => x.date.localeCompare(y.date));
    } catch (_) {}

    // 1c (V2 part). Trials by source + utm_campaign — V2 (merged into tCampMap from 1c)
    // Use positional GROUP BY (1,2,3) to avoid PostgreSQL alias-expansion issues
    // when two aliases both reference companies.signup_url.
    try {
      const tv2Rows = await runSQL(env, `
        WITH base AS (
          SELECT
            u.email                                                       AS email,
            ${SOURCE_CASE}                                                AS source,
            ${CAMPAIGN_CASE}                                              AS campaign,
            ${V2_STEP}                                                    AS step_val
          ${V2_BASE}
        ),
        raw AS (
          SELECT email, source, campaign, MAX(step_val) AS step_num
          FROM base
          GROUP BY 1, 2, 3
        )
        SELECT source, campaign, COUNT(*) FILTER (WHERE step_num >= 8) AS trials
        FROM raw GROUP BY 1, 2 ORDER BY 1, 2
      `);
      for (const [source, campaign, t] of tv2Rows) {
        const key = `${source}|${campaign}`;
        if (!tCampMap[key]) tCampMap[key] = { source, campaign, trials: 0 };
        tCampMap[key].trials += parseInt(t) || 0;
      }
    } catch (_) {}
    const trials_by_campaign = Object.values(tCampMap);

    // V1 + V2 per-period cancellations
    let cancellations_daily = [], cancellations_v2_daily = [];
    try {
      const [canV1Rows, canV2Rows] = await Promise.all([
        runSQL(env, `
          SELECT
            DATE_TRUNC('${granularity}', companies.created_at)::date AS period,
            ${SOURCE_CASE} AS source,
            COUNT(DISTINCT u.email) AS cnt
          FROM companies
          LEFT JOIN LATERAL (
            SELECT * FROM subscriptions WHERE subscriptions.company_id = companies.id ORDER BY id DESC LIMIT 1
          ) sub ON true
          JOIN LATERAL (
            SELECT * FROM users WHERE users.company_id = companies.id ORDER BY id ASC LIMIT 1
          ) u ON true
          WHERE companies.created_at >= '${since}' AND companies.created_at < '${until1}'
            AND ${IS_CANCELED}
            ${INTERNAL_FILTER}
            ${V1_ONLY_FILTER}
          GROUP BY 1, 2 ORDER BY 1
        `),
        runSQL(env, `
          SELECT
            DATE_TRUNC('${granularity}', companies.created_at)::date AS period,
            ${SOURCE_CASE} AS source,
            COUNT(DISTINCT u.email) AS cnt
          FROM companies
          JOIN LATERAL (
            SELECT * FROM users WHERE users.company_id = companies.id ORDER BY id ASC LIMIT 1
          ) u ON true
          JOIN onboarding_v2_sessions s ON s.user_id = u.id
          LEFT JOIN LATERAL (
            SELECT * FROM subscriptions WHERE company_id = companies.id ORDER BY id DESC LIMIT 1
          ) sub ON true
          WHERE companies.created_at >= '${since}' AND companies.created_at < '${until1}'
            AND ${IS_CANCELED}
            ${INTERNAL_FILTER}
          GROUP BY 1, 2 ORDER BY 1
        `),
      ]);
      cancellations_daily    = buildPeriodMap(canV1Rows);
      cancellations_v2_daily = buildPeriodMap(canV2Rows);
    } catch (_) {}

    // 8b. Canceled-during-trial stats (all-time, no date filter)
    let canceled_trial_stats = null;
    try {
      const ctRows = await runSQL(env, `
        SELECT
          COUNT(*) FILTER (WHERE ${TRIAL_CANCEL})                                            AS canceled_trial,
          COUNT(*) FILTER (WHERE ${PAID_CANCEL})                                              AS canceled_active,
          COUNT(*) FILTER (WHERE sub.status = 'trialing' AND COALESCE(sub.cancel_at_period_end, false) = false) AS currently_trialing,
          COUNT(*) FILTER (WHERE sub.status = 'active'   AND COALESCE(sub.cancel_at_period_end, false) = false) AS currently_active
        FROM subscriptions sub
        JOIN LATERAL (SELECT * FROM companies WHERE id = sub.company_id LIMIT 1) c ON true
        JOIN LATERAL (SELECT * FROM users WHERE company_id = sub.company_id ORDER BY id ASC LIMIT 1) u ON true
        WHERE u.email NOT ILIKE '%sortlist.com%' AND u.email NOT ILIKE '%overloop%'
          AND c.name NOT ILIKE '%sortlist%'       AND c.name NOT ILIKE '%overloop%'
          AND EXISTS (SELECT 1 FROM onboarding_v2_sessions WHERE company_id = c.id AND user_id = u.id)
      `);
      if (ctRows[0]) {
        const [ct, ca, ctr, cur] = ctRows[0];
        const total = Number(ct) + Number(ca) + Number(ctr) + Number(cur);
        canceled_trial_stats = {
          canceled_trial:      Number(ct),
          canceled_trial_rate: total > 0 ? Math.round(Number(ct) / total * 1000) / 10 : 0,
        };
      }
    } catch (e) { canceled_trial_stats = null; }

    // 8d. V2 trial behaviour (trial_start = onboarding_v2_sessions.updated_at when completed)
    let trial_behavior_v2 = null;
    try {
      const [tbV2Rows, tbV2SrcRows] = await Promise.all([
        runSQL(env, `
          SELECT
            ROUND(AVG(EXTRACT(EPOCH FROM (sc.updated_at - companies.created_at)) / 86400)::numeric, 1)
              AS avg_days_signup_to_trial,
            ROUND(AVG(EXTRACT(EPOCH FROM (sub.subscribed_at - sc.updated_at)) / 86400)
              FILTER (WHERE sub.subscribed_at IS NOT NULL AND sub.status = 'active')::numeric, 1)
              AS avg_days_trial_to_active,
            COUNT(*) FILTER (
              WHERE sc.updated_at IS NOT NULL
                AND NOW() > sc.updated_at + INTERVAL '14 days'
                AND (sub.status IS NULL OR sub.status != 'active')
            ) AS over_14d_not_active,
            COUNT(*) FILTER (
              WHERE sc.updated_at IS NOT NULL
                AND NOW() <= sc.updated_at + INTERVAL '14 days'
                AND (sub.status IS NULL OR sub.status != 'canceled')
                AND COALESCE(sub.cancel_at_period_end, false) = false
            ) AS in_14d_window,
            COUNT(*) FILTER (
              WHERE sc.updated_at IS NOT NULL
                AND NOW() <= sc.updated_at + INTERVAL '14 days'
                AND (sub.status = 'canceled' OR sub.cancel_at_period_end = true)
            ) AS canceled_in_14d_window
          FROM companies
          JOIN LATERAL (
            SELECT * FROM users WHERE company_id = companies.id ORDER BY id ASC LIMIT 1
          ) u ON true
          LEFT JOIN LATERAL (
            SELECT * FROM subscriptions WHERE company_id = companies.id ORDER BY id DESC LIMIT 1
          ) sub ON true
          LEFT JOIN LATERAL (
            SELECT * FROM onboarding_v2_sessions WHERE user_id = u.id AND state = 'completed'
              AND stripe_checkout_session_id IS NOT NULL
            ORDER BY updated_at DESC LIMIT 1
          ) sc ON true
          WHERE companies.created_at >= '${since}' AND companies.created_at < '${until1}'
          ${INTERNAL_FILTER}
        `),
        runSQL(env, `
          SELECT ${SOURCE_CASE} AS source,
            ROUND(AVG(EXTRACT(EPOCH FROM (sc.updated_at - companies.created_at)) / 86400)::numeric, 1)
              AS avg_days_signup_to_trial
          FROM companies
          JOIN LATERAL (
            SELECT * FROM users WHERE company_id = companies.id ORDER BY id ASC LIMIT 1
          ) u ON true
          JOIN LATERAL (
            SELECT * FROM onboarding_v2_sessions WHERE user_id = u.id AND state = 'completed'
              AND stripe_checkout_session_id IS NOT NULL
            ORDER BY updated_at DESC LIMIT 1
          ) sc ON true
          WHERE companies.created_at >= '${since}' AND companies.created_at < '${until1}'
          ${INTERNAL_FILTER}
          GROUP BY 1 ORDER BY 2
        `),
      ]);
      if (tbV2Rows[0]) {
        const [avg_s2t, avg_t2a, over14, in14, canceled_in14] = tbV2Rows[0];
        const avg_signup_to_trial_by_source = {};
        for (const [src, avg] of tbV2SrcRows) avg_signup_to_trial_by_source[src] = avg != null ? Number(avg) : null;
        trial_behavior_v2 = {
          avg_days_signup_to_trial:  avg_s2t != null ? Number(avg_s2t) : null,
          avg_days_trial_to_active:  avg_t2a != null ? Number(avg_t2a) : null,
          over_14d_not_active:       Number(over14) || 0,
          in_14d_window:             Number(in14)   || 0,
          canceled_in_14d_window:    Number(canceled_in14) || 0,
          avg_signup_to_trial_by_source,
        };
      }
    } catch (e) { trial_behavior_v2 = null; }

    // 8c. Compare cube: legacy / v2 / v2.1 by (source, device).
    //
    // Two queries on purpose. v2 and v2.1 follow the date picker; legacy is pinned
    // to LEGACY_WINDOW, because inside a recent window legacy is a residual tail
    // (n=9 in the last 14 days) rather than a comparable population. The header
    // states the window, so the columns not sharing a period is explicit.
    let compare_cube = [];
    let compare = null;
    try {
      const CMP_BASE = (extraWhere, sinceD, untilD) => `
        FROM companies
        JOIN LATERAL (
          SELECT * FROM users WHERE company_id = companies.id ORDER BY id ASC LIMIT 1
        ) u ON true
        LEFT JOIN LATERAL (
          SELECT * FROM subscriptions WHERE company_id = companies.id ORDER BY id DESC LIMIT 1
        ) sub ON true
        LEFT JOIN LATERAL (
          SELECT * FROM onboarding_v2_sessions WHERE user_id = u.id ORDER BY updated_at DESC LIMIT 1
        ) s ON true
        ${FIRST_SESSION_JOIN}
        WHERE companies.created_at >= '${sinceD}' AND companies.created_at < '${untilD}'
        ${INTERNAL_FILTER}
        ${extraWhere}
      `;
      const CMP_COUNTS = (trialingExpr) => `
        COUNT(*)                                            AS signups,
        COUNT(*) FILTER (WHERE ${trialingExpr})             AS trialing,
        COUNT(*) FILTER (WHERE sub.status = 'active')       AS active,
        COUNT(*) FILTER (WHERE ${TRIAL_CANCEL})             AS canceled_trial,
        COUNT(*) FILTER (WHERE ${PAID_CANCEL})              AS canceled_active
      `;

      const [v2Rows, legacyRows] = await Promise.all([
        runSQL(env, `
          SELECT ${COHORT_CASE('f')} AS cohort, ${SOURCE_CASE} AS source, ${DEVICE_CASE} AS device,
                 ${CMP_COUNTS(PAYWALL('s'))}
          ${CMP_BASE('AND f.user_id IS NOT NULL', since, until1)}
          GROUP BY cohort, source, device
        `),
        runSQL(env, `
          SELECT 'legacy' AS cohort, ${SOURCE_CASE} AS source, ${DEVICE_CASE} AS device,
                 ${CMP_COUNTS("sub.status = 'trialing'")}
          ${CMP_BASE('AND f.user_id IS NULL', LEGACY_WINDOW.since, LEGACY_WINDOW.until)}
          GROUP BY cohort, source, device
        `),
      ]);

      for (const [cohort, source, device, sg, tr, ac, ct, ca] of [...legacyRows, ...v2Rows]) {
        compare_cube.push({
          cohort, source, device,
          signups: Number(sg), trialing: Number(tr), active: Number(ac),
          canceled_trial: Number(ct), canceled_active: Number(ca),
        });
      }

      // Back-compat shape for anything still reading mb.compare.
      const sum = (cohorts, key) => compare_cube
        .filter(r => cohorts.includes(r.cohort))
        .reduce((acc, r) => acc + r[key], 0);
      compare = {
        v1_signups: sum(['legacy'], 'signups'),          v2_signups: sum(['v2', 'v2.1'], 'signups'),
        v1_trialing: sum(['legacy'], 'trialing'),        v2_trialing: sum(['v2', 'v2.1'], 'trialing'),
        v1_active: sum(['legacy'], 'active'),            v2_active: sum(['v2', 'v2.1'], 'active'),
        v1_canceled_trial: sum(['legacy'], 'canceled_trial'),
        v1_canceled_active: sum(['legacy'], 'canceled_active'),
        v2_canceled_trial: sum(['v2', 'v2.1'], 'canceled_trial'),
        v2_canceled_active: sum(['v2', 'v2.1'], 'canceled_active'),
      };
    } catch (e) { compare = null; compare_cube = []; }

    // 9. Financial metrics
    const churn_count = churnList.length;
    const churn_rate = (active_paid + churn_count) > 0
      ? Math.round((churn_count / (active_paid + churn_count)) * 1000) / 10
      : 0;
    const arpu = active_paid > 0 ? Math.round((mrr / active_paid) * 100) / 100 : 0;

    const nowMs = Date.now();
    const tenures = churnList
      .filter(r => r.started_at)
      .map(r => (nowMs - new Date(r.started_at).getTime()) / (1000 * 60 * 60 * 24 * 30.44));
    const avg_tenure_months = tenures.length > 0
      ? Math.round((tenures.reduce((s, v) => s + v, 0) / tenures.length) * 10) / 10
      : null;
    const ltv = avg_tenure_months != null && arpu > 0
      ? Math.round(arpu * avg_tenure_months)
      : null;

    return Response.json({
      granularity,
      signups_daily,
      signups_by_campaign,
      trials_by_campaign,
      trials_daily,
      activations_daily,
      funnel: {
        steps: totalsFinal,
        total: totalsFinal[0] || 0,
      },
      funnel_by_source: funnelBySource,
      funnel_by_device: funnelByDevice,
      funnel_cube,
      funnel_v2,
      funnel_v2_by_source,
      funnel_v2_by_device,
      funnel_v2_cube,
      trials_v2_daily,
      activations_v2_daily,
      funnel_v2_period,
      cancellations_daily,
      cancellations_v2_daily,
      trial_behavior_v2,
      canceled_trial_stats,
      compare,
      compare_cube,
      legacy_window: LEGACY_WINDOW,
      v21_cutoff: V21_CUTOFF,
      trial_behavior,
      trialing,
      active_paid,
      churn: churn_count,
      financials: {
        trialing,
        active_paid,
        mrr:    Math.round(mrr),
        churn:  churn_count,
        churn_rate,
        arpu,
        ltv,
        avg_tenure_months,
        avg_days_signup_to_active,
        trial_to_active_rate: (active_paid + trialing) > 0
          ? Math.round((active_paid / (active_paid + trialing)) * 100)
          : 0,
        paying_customers: payingCustomers,
        churn_list:       churnList,
        trials_list,
      },
    }, { headers: { 'Access-Control-Allow-Origin': '*' } });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } });
  }
}
