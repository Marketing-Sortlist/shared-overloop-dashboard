const DEVELOPER_TOKEN = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
const CUSTOMER_ID = process.env.GOOGLE_ADS_CUSTOMER_ID;
const LOGIN_CUSTOMER_ID = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

async function getAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`OAuth failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

function getDateRange(req) {
  if (req.query.since && req.query.until) {
    return { since: req.query.since, until: req.query.until };
  }
  const days = parseInt(req.query.days) || 14;
  const until = new Date();
  const since = new Date();
  since.setDate(since.getDate() - days);
  const fmt = (d) => d.toISOString().split('T')[0];
  return { since: fmt(since), until: fmt(until) };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { since, until } = getDateRange(req);

  try {
    const accessToken = await getAccessToken();

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
      `https://googleads.googleapis.com/v20/customers/${CUSTOMER_ID}/googleAds:searchStream`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'developer-token': DEVELOPER_TOKEN,
          'login-customer-id': LOGIN_CUSTOMER_ID,
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

    // Flatten all rows from streaming response
    const rows = results.flatMap(r => r.results || []);

    // Aggregate by campaign
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

    res.json({
      account: {
        spend: totals.spend,
        clicks: totals.clicks,
        conversions: totals.conversions,
        cpc: totals.clicks > 0 ? totals.spend / totals.clicks : 0,
        cpa: totals.conversions > 0 ? totals.spend / totals.conversions : 0,
      },
      campaigns,
      daily,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
