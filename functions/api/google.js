async function getAccessToken(env) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`OAuth failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Paginated, non-streaming search. searchStream is unreliable on Cloudflare
// Workers (the stream is read empty ~50% of the time → silent 0 spend), so we
// use googleAds:search with pageToken pagination and retry on transient errors.
async function fetchAllRows(env, accessToken, query) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': env.GOOGLE_ADS_DEVELOPER_TOKEN,
    'login-customer-id': env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
    'Content-Type': 'application/json',
  };
  const endpoint = `https://googleads.googleapis.com/v20/customers/${env.GOOGLE_ADS_CUSTOMER_ID}/googleAds:search`;

  const rows = [];
  let pageToken = null;

  do {
    const body = { query };
    if (pageToken) body.pageToken = pageToken;

    let data;
    let lastErr;
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
      const text = await response.text();
      try {
        data = JSON.parse(text);
      } catch {
        lastErr = new Error(`Google Ads API returned non-JSON: ${text.slice(0, 300)}`);
        await sleep(400 * (attempt + 1));
        continue;
      }
      if (data.error) {
        // The query is valid, yet Google's REST endpoint intermittently returns
        // spurious errors (INVALID_ARGUMENT / 500 / 503 / 429) for the identical
        // request, so retry every error a few times before giving up.
        lastErr = new Error(JSON.stringify(data.error));
        await sleep(400 * (attempt + 1));
        continue;
      }
      lastErr = null;
      break;
    }
    if (lastErr) throw lastErr;

    for (const r of (data.results || [])) rows.push(r);
    pageToken = data.nextPageToken || null;
  } while (pageToken);

  return rows;
}

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

export async function onRequest(context) {
  const { env, request } = context;
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*' } });
  }

  const { since, until } = getDateRange(url);

  try {
    const accessToken = await getAccessToken(env);

    const query = `
      SELECT
        campaign.name,
        campaign.id,
        metrics.cost_micros,
        metrics.impressions,
        metrics.clicks,
        metrics.conversions,
        segments.date
      FROM campaign
      WHERE segments.date BETWEEN '${since}' AND '${until}'
      ORDER BY segments.date DESC
    `;

    const rows = await fetchAllRows(env, accessToken, query);

    const campaignMap = {};
    const dailyMap = {};

    for (const row of rows) {
      const name = row.campaign.name;
      const id = row.campaign.id;
      const cost = parseInt(row.metrics.costMicros || 0) / 1e6;
      const impressions = parseInt(row.metrics.impressions || 0);
      const clicks = parseInt(row.metrics.clicks || 0);
      const conversions = parseFloat(row.metrics.conversions || 0);
      const date = row.segments.date;

      if (!campaignMap[id]) {
        campaignMap[id] = { id, name, spend: 0, impressions: 0, clicks: 0, conversions: 0 };
      }
      campaignMap[id].spend += cost;
      campaignMap[id].impressions += impressions;
      campaignMap[id].clicks += clicks;
      campaignMap[id].conversions += conversions;

      if (!dailyMap[date]) {
        dailyMap[date] = { date, spend: 0, clicks: 0, conversions: 0 };
      }
      dailyMap[date].spend += cost;
      dailyMap[date].clicks += clicks;
      dailyMap[date].conversions += conversions;
    }

    const campaigns = Object.values(campaignMap).map(c => ({
      ...c,
      cpc: c.clicks > 0 ? c.spend / c.clicks : 0,
      cpa: c.conversions > 0 ? c.spend / c.conversions : 0,
    }));

    const daily = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));

    const totals = campaigns.reduce((acc, c) => ({
      spend: acc.spend + c.spend,
      clicks: acc.clicks + c.clicks,
      conversions: acc.conversions + c.conversions,
    }), { spend: 0, clicks: 0, conversions: 0 });

    return Response.json({
      account: {
        spend: totals.spend,
        clicks: totals.clicks,
        conversions: totals.conversions,
        cpc: totals.clicks > 0 ? totals.spend / totals.clicks : 0,
        cpa: totals.conversions > 0 ? totals.spend / totals.conversions : 0,
      },
      campaigns,
      daily,
    }, { headers: { 'Access-Control-Allow-Origin': '*' } });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } });
  }
}
