const API_VERSION = 'v19.0';
const BASE = `https://graph.facebook.com/${API_VERSION}`;

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

async function fetchJson(url) {
  const res = await fetch(url);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json;
}

function timeRange(since, until) {
  return encodeURIComponent(JSON.stringify({ since, until }));
}


// ── utm_campaign discovery ─────────────────────────────────────────────────
//
// The Performance table pairs Meta SPEND with Metabase SIGNUPS, and the join key
// is utm_campaign. That mapping used to be a hardcoded list of campaign names in
// index.html, which silently broke on the 31 Aug relaunch: the three live
// campaigns were not in the list, so the table showed ~1,000 EUR of spend against
// zero signups and no CAC. Deriving it from the ads themselves cannot go stale.
//
// Two shapes to read, because only the 2026 relaunch uses url_tags:
//   url_tags: "utm_source=facebook&...&utm_campaign=acq_try_now-usen"
//   the link itself: "https://overloop.com/try-now?...&utm_campaign=conversion_..."
function utmFrom(str) {
  if (!str) return null;
  const m = /[?&]?utm_campaign=([^&\s]+)/i.exec(str);
  return m ? decodeURIComponent(m[1]).toLowerCase() : null;
}

function linksOf(creative) {
  if (!creative) return [];
  const oss = creative.object_story_spec || {};
  const data = oss.link_data || oss.video_data || {};
  return [
    creative.url_tags,
    data.link,
    data.call_to_action?.value?.link,
    ...((creative.asset_feed_spec?.link_urls || []).map(l => l.website_url)),
  ].filter(Boolean);
}

// asset_feed_spec is asked for by its one useful sub-field. object_story_spec is
// NOT: Meta rejects sub-field selection inside it with
// `(#100) Tried accessing nonexisting field (link)`, verified against v19.0 and
// v24.0 on 14 Sep 2026, so it has to come whole. What actually keeps the payload
// down is scoping the call to one campaign, below.
const AD_FIELDS = 'creative{url_tags,object_story_spec,asset_feed_spec{link_urls}}';

async function adsOfCampaign(base, campaignId, token) {
  const out = [];
  let next = `${base}/${campaignId}/ads?fields=${encodeURIComponent(AD_FIELDS)}&limit=100&access_token=${token}`;
  // Meta hands back a complete URL in paging.next, token included. The page cap
  // is a seatbelt against a cursor that never terminates, not a real limit: the
  // busiest campaign here holds ten ads.
  for (let page = 0; next && page < 20; page++) {
    const res = await fetchJson(next);
    out.push(...(res.data || []));
    next = res.paging?.next || null;
  }
  return out;
}

// Asks each spending campaign for its own ads instead of sweeping the account.
// The account holds 293 ads, nearly all of them archived Socialsky ones, and
// pulling every creative in one call is what tipped Meta into the error above.
// Failures are returned, not swallowed: a silent catch here is what made a
// broken lookup indistinguishable from "these ads carry no UTM", and the table
// showed spend against zero signups without anyone noticing.
async function utmByCampaign(base, campaignIds, token) {
  const map = {};
  const failed = [];
  await Promise.all(campaignIds.map(async (id) => {
    try {
      for (const ad of await adsOfCampaign(base, id, token)) {
        for (const str of linksOf(ad.creative)) {
          const utm = utmFrom(str);
          if (!utm) continue;
          (map[id] ||= new Set()).add(utm);
        }
      }
    } catch (err) {
      failed.push({ campaign_id: id, error: String(err?.message || err) });
    }
  }));
  return {
    map: Object.fromEntries(Object.entries(map).map(([k, v]) => [k, [...v]])),
    failed,
  };
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
  const fields = 'spend,impressions,clicks,ctr,cpm,cpc,actions,cost_per_action_type';
  const attrWindows = 'action_attribution_windows=%5B%227d_click%22%2C%221d_view%22%5D';
  const tr = timeRange(since, until);

  try {
    const accountData = await fetchJson(
      `${BASE}/${accountId}/insights?fields=${fields}&time_range=${tr}&${attrWindows}&access_token=${token}`
    );
    const acc = accountData.data?.[0] || {};
    const leads = (acc.actions || []).find(a => a.action_type === 'lead')?.value || 0;
    const spend = parseFloat(acc.spend || 0);

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
        // Meta's OWN attributed lead count, kept for reference only. The number
        // to report is Metabase signups joined on utm_campaign: Meta over-counted
        // by 61% while browser/server deduplication was broken.
        leads_meta_reported: parseInt(cLeads),
        cpl_meta_reported: cLeads > 0 ? cSpend / cLeads : 0,
      };
    });

    const { map: utmMap, failed: utmFailed } = await utmByCampaign(
      BASE, campaignInsights.map(c => c.id), token
    );
    for (const c of campaignInsights) c.utm_campaigns = utmMap[c.id] || [];

    const dailyData = await fetchJson(
      `${BASE}/${accountId}/insights?fields=spend,impressions,clicks,actions&time_range=${tr}&time_increment=1&limit=500&${attrWindows}&access_token=${token}`
    );
    const daily = (dailyData.data || []).map(d => ({
      date: d.date_start,
      spend: parseFloat(d.spend || 0),
      impressions: parseInt(d.impressions || 0),
      clicks: parseInt(d.clicks || 0),
      leads_meta_reported: parseInt((d.actions || []).find(a => a.action_type === 'lead')?.value || 0),
    }));

    return Response.json({
      account: {
        spend,
        impressions: parseInt(acc.impressions || 0),
        clicks: parseInt(acc.clicks || 0),
        ctr: parseFloat(acc.ctr || 0),
        cpm: parseFloat(acc.cpm || 0),
        cpc: parseFloat(acc.cpc || 0),
        leads_meta_reported: parseInt(leads),
        cpl_meta_reported: leads > 0 ? spend / leads : 0,
      },
      campaigns: campaignInsights,
      daily,
      // Empty when every campaign resolved. Non-empty means the UTM lookup
      // itself broke, which is NOT the same as a campaign having no UTM: the
      // table has to say so rather than print zero signups.
      utm_lookup_failed: utmFailed,
    }, { headers: { 'Access-Control-Allow-Origin': '*' } });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } });
  }
}
