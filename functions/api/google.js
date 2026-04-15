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

    const response = await fetch(
      `https://googleads.googleapis.com/v20/customers/${env.GOOGLE_ADS_CUSTOMER_ID}/googleAds:searchStream`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'developer-token': env.GOOGLE_ADS_DEVELOPER_TOKEN,
          'login-customer-id': env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query }),
      }
    );

    const text = await response.text();
    let results;
    try {
      results = JSON.parse(text);
    } catch {
      throw new Error(`Google Ads API returned non-JSON: ${text.slice(0, 300)}`);
    }

    if (!Array.isArray(results)) {
      if (results.error) throw new Error(results.error.message || JSON.stringify(results.error));
      throw new Error(JSON.stringify(results));
    }

    const rows = results.flatMap(r => r.results || []);

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
