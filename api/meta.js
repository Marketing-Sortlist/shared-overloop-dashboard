const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_ACCOUNT_ID = process.env.META_ACCOUNT_ID;
const API_VERSION = 'v19.0';
const BASE = `https://graph.facebook.com/${API_VERSION}`;

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

async function fetchJson(url) {
  const res = await fetch(url);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json;
}

function timeRange(since, until) {
  return encodeURIComponent(JSON.stringify({ since, until }));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { since, until } = getDateRange(req);

  const token = META_ACCESS_TOKEN;
  const accountId = META_ACCOUNT_ID;
  const fields = 'spend,impressions,clicks,ctr,cpm,cpc,actions,cost_per_action_type';
  const attrWindows = 'action_attribution_windows=%5B%227d_click%22%2C%221d_view%22%5D';
  const tr = timeRange(since, until);

  try {
    // Account-level: single aggregated row — most reliable source for total spend
    const accountData = await fetchJson(
      `${BASE}/${accountId}/insights?fields=${fields}&time_range=${tr}&${attrWindows}&access_token=${token}`
    );
    const acc = accountData.data?.[0] || {};
    const leads = (acc.actions || []).find(a => a.action_type === 'lead')?.value || 0;
    const spend = parseFloat(acc.spend || 0);

    // Campaign-level: limit=500 avoids default 25-row pagination
    const campaignData = await fetchJson(
      `${BASE}/${accountId}/insights?fields=campaign_id,campaign_name,${fields}&time_range=${tr}&level=campaign&limit=500&${attrWindows}&access_token=${token}`
    );
    const campaignInsights = (campaignData.data || []).map(d => {
      const cLeads = (d.actions || []).find(a => a.action_type === 'lead')?.value || 0;
      const cSpend = parseFloat(d.spend || 0);
      return {
        id: d.campaign_id,
        name: d.campaign_name || d.campaign_id,
        spend: cSpend,
        impressions: parseInt(d.impressions || 0),
        clicks: parseInt(d.clicks || 0),
        ctr: parseFloat(d.ctr || 0),
        cpm: parseFloat(d.cpm || 0),
        cpc: parseFloat(d.cpc || 0),
        leads: parseInt(cLeads),
        cpl: cLeads > 0 ? cSpend / cLeads : 0,
      };
    });

    // Daily breakdown: limit=500 avoids default 25-row pagination (90-day range = 90 rows max)
    const dailyData = await fetchJson(
      `${BASE}/${accountId}/insights?fields=spend,impressions,clicks,actions&time_range=${tr}&time_increment=1&limit=500&${attrWindows}&access_token=${token}`
    );
    const daily = (dailyData.data || []).map(d => ({
      date: d.date_start,
      spend: parseFloat(d.spend || 0),
      impressions: parseInt(d.impressions || 0),
      clicks: parseInt(d.clicks || 0),
      leads: parseInt((d.actions || []).find(a => a.action_type === 'lead')?.value || 0),
    }));

    res.json({
      account: {
        spend,
        impressions: parseInt(acc.impressions || 0),
        clicks: parseInt(acc.clicks || 0),
        ctr: parseFloat(acc.ctr || 0),
        cpm: parseFloat(acc.cpm || 0),
        cpc: parseFloat(acc.cpc || 0),
        leads: parseInt(leads),
        cpl: leads > 0 ? spend / leads : 0,
      },
      campaigns: campaignInsights,
      daily,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
