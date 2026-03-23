const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_ACCOUNT_ID = process.env.META_ACCOUNT_ID;
const API_VERSION = 'v19.0';
const BASE = `https://graph.facebook.com/${API_VERSION}`;

function getDateRange(days) {
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const days = parseInt(req.query.days) || 14;
  const { since, until } = getDateRange(days);

  const token = META_ACCESS_TOKEN;
  const accountId = META_ACCOUNT_ID;
  const fields = 'spend,impressions,clicks,ctr,cpm,cpc,actions,cost_per_action_type';
  const actionAttrWindows = 'action_attribution_windows=["7d_click","1d_view"]';

  try {
    // Account-level insights
    const accountUrl = `${BASE}/${accountId}/insights?fields=${fields}&time_range={"since":"${since}","until":"${until}"}&${actionAttrWindows}&access_token=${token}`;
    const accountData = await fetchJson(accountUrl);
    const acc = accountData.data?.[0] || {};

    const leads = (acc.actions || []).find(a => a.action_type === 'lead')?.value || 0;
    const spend = parseFloat(acc.spend || 0);

    // Campaign-level insights
    const campaignIds = ['120241830238100502', '120242574362070502'];
    const campaignInsights = await Promise.all(campaignIds.map(async (id) => {
      const url = `${BASE}/${id}/insights?fields=campaign_name,${fields}&time_range={"since":"${since}","until":"${until}"}&${actionAttrWindows}&access_token=${token}`;
      const data = await fetchJson(url);
      const d = data.data?.[0] || {};
      const cLeads = (d.actions || []).find(a => a.action_type === 'lead')?.value || 0;
      const cSpend = parseFloat(d.spend || 0);
      return {
        id,
        name: d.campaign_name || id,
        spend: cSpend,
        impressions: parseInt(d.impressions || 0),
        clicks: parseInt(d.clicks || 0),
        ctr: parseFloat(d.ctr || 0),
        cpm: parseFloat(d.cpm || 0),
        cpc: parseFloat(d.cpc || 0),
        leads: parseInt(cLeads),
        cpl: cLeads > 0 ? cSpend / cLeads : 0,
      };
    }));

    // Daily spend
    const dailyUrl = `${BASE}/${accountId}/insights?fields=spend,impressions,clicks,actions&time_range={"since":"${since}","until":"${until}"}&time_increment=1&${actionAttrWindows}&access_token=${token}`;
    const dailyData = await fetchJson(dailyUrl);
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
