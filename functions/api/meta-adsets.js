const API_VERSION = 'v19.0';
const BASE = `https://graph.facebook.com/${API_VERSION}`;
const DB_ID = 5;

function getDateRange(url) {
  const params = url.searchParams;
  if (params.get('since') && params.get('until')) {
    return { since: params.get('since'), until: params.get('until') };
  }
  const days = parseInt(params.get('days')) || 14;
  const until = new Date();
  const since = new Date();
  since.setDate(since.getDate() - days);
  const fmt = (d) => d.toISOString().split('T')[0];
  return { since: fmt(since), until: fmt(until) };
}

async function fetchAllPages(initialUrl) {
  let all = [];
  let nextUrl = initialUrl;
  while (nextUrl) {
    const res = await fetch(nextUrl);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    all = all.concat(data.data || []);
    nextUrl = data.paging?.next || null;
  }
  return all;
}

async function queryMetabase(env, query) {
  const res = await fetch(`${env.METABASE_URL}/api/dataset`, {
    method: 'POST',
    headers: { 'x-api-key': env.METABASE_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ database: DB_ID, type: 'native', native: { query } }),
  });
  if (!res.ok) throw new Error(`Metabase ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data?.data?.rows || [];
}

export async function onRequest(context) {
  const { env, request } = context;
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*' } });
  }

  const { since, until } = getDateRange(url);
  const token = env.META_ACCESS_TOKEN;
  const accountId = env.META_ACCOUNT_ID;

  try {
    const tr = encodeURIComponent(JSON.stringify({ since, until }));
    const attrWindows = 'action_attribution_windows=%5B%227d_click%22%2C%221d_view%22%5D';
    const fields = 'adset_id,adset_name,campaign_id,campaign_name,spend,impressions,clicks,ctr,actions';

    const [adsetRows, mbRows] = await Promise.all([
      fetchAllPages(
        `${BASE}/${accountId}/insights?fields=${fields}&time_range=${tr}&level=adset&limit=500&${attrWindows}&access_token=${token}`
      ),
      queryMetabase(env, `
        SELECT
          substring(companies.signup_url, 'utm_term=([^&]*)') AS adset_id,
          COUNT(DISTINCT u.email) AS signups,
          COUNT(DISTINCT u.email) FILTER (WHERE sub.status = 'trialing') AS trialing
        FROM companies
        JOIN LATERAL (SELECT * FROM users WHERE users.company_id = companies.id ORDER BY id ASC LIMIT 1) u ON true
        LEFT JOIN LATERAL (SELECT * FROM subscriptions WHERE subscriptions.company_id = companies.id ORDER BY id DESC LIMIT 1) sub ON true
        WHERE
          companies.created_at >= '${since}'
          AND companies.created_at <= '${until}'
          AND LOWER(COALESCE(substring(companies.signup_url, 'utm_source=([^&]*)'), '')) = 'facebook'
          AND u.email NOT ILIKE '%sortlist.com%'
          AND u.email NOT ILIKE '%overloop%'
          AND companies.name NOT ILIKE '%sortlist%'
          AND companies.name NOT ILIKE '%overloop%'
          AND substring(companies.signup_url, 'utm_term=([^&]*)') IS NOT NULL
        GROUP BY 1
      `),
    ]);

    // mbRows are positional arrays: [adset_id, signups, trialing]
    const mbMap = {};
    for (const row of mbRows) {
      const adsetId = row[0];
      if (adsetId) {
        mbMap[adsetId] = {
          signups: parseInt(row[1] || 0),
          trialing: parseInt(row[2] || 0),
        };
      }
    }

    const campaignMap = {};
    for (const d of adsetRows) {
      const leads = parseInt((d.actions || []).find(a => a.action_type === 'lead')?.value || 0);
      const spend = parseFloat(d.spend || 0);
      const mb = mbMap[d.adset_id] || { signups: 0, trialing: 0 };
      const adset = {
        adset_id: d.adset_id,
        adset_name: d.adset_name,
        campaign_id: d.campaign_id,
        campaign_name: d.campaign_name,
        spend,
        impressions: parseInt(d.impressions || 0),
        clicks: parseInt(d.clicks || 0),
        ctr: parseFloat(d.ctr || 0),
        leads,
        cpl: leads > 0 ? spend / leads : 0,
        signups: mb.signups,
        trialing: mb.trialing,
        cp_trial: mb.trialing > 0 ? spend / mb.trialing : null,
      };

      if (!campaignMap[d.campaign_id]) {
        campaignMap[d.campaign_id] = {
          campaign_id: d.campaign_id,
          campaign_name: d.campaign_name,
          adsets: [],
        };
      }
      campaignMap[d.campaign_id].adsets.push(adset);
    }

    for (const c of Object.values(campaignMap)) {
      c.adsets.sort((a, b) => b.spend - a.spend);
    }

    const campaigns = Object.values(campaignMap).sort((a, b) => {
      const sa = a.adsets.reduce((s, x) => s + x.spend, 0);
      const sb = b.adsets.reduce((s, x) => s + x.spend, 0);
      return sb - sa;
    });

    return Response.json({ campaigns }, { headers: { 'Access-Control-Allow-Origin': '*' } });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } });
  }
}
