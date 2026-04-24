// functions/api/gsc.js — Cloudflare Pages Function
// Env vars (Cloudflare Pages → Settings → Environment variables):
//   GSC_CLIENT_EMAIL, GSC_PRIVATE_KEY

const SITE_URL = 'sc-domain:overloop.com';

// ── PEM → ArrayBuffer ─────────────────────────────────────────────────────────
function pemToBuffer(pem) {
  const b64 = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// ── Google JWT → Access Token ─────────────────────────────────────────────────
async function getAccessToken(email, rawKey) {
  const pem = rawKey.replace(/\\n/g, '\n');
  const now = Math.floor(Date.now() / 1000);

  const header  = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  const payload = btoa(JSON.stringify({
    iss: email,
    scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  })).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');

  const toSign = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    'pkcs8', pemToBuffer(pem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', key,
    new TextEncoder().encode(toSign)
  );

  const jwt = `${toSign}.${b64url(sig)}`;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const data = await r.json();
  if (!data.access_token) throw new Error('GSC token error: ' + JSON.stringify(data));
  return data.access_token;
}

// ── GSC query ─────────────────────────────────────────────────────────────────
async function queryGSC(token, body) {
  const encoded = encodeURIComponent(SITE_URL);
  const r = await fetch(
    `https://searchconsole.googleapis.com/webmasters/v3/sites/${encoded}/searchAnalytics/query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
  const data = await r.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data.rows || [];
}

// ── Handler ───────────────────────────────────────────────────────────────────
export async function onRequestGet({ request, env }) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 's-maxage=3600' };
  const url  = new URL(request.url);
  const since = url.searchParams.get('since');
  const until = url.searchParams.get('until');

  if (!since || !until) {
    return Response.json({ error: 'since and until required' }, { status: 400, headers: cors });
  }

  try {
    const token = await getAccessToken(env.GSC_CLIENT_EMAIL, env.GSC_PRIVATE_KEY);

    const [daily, queries, pages] = await Promise.all([
      queryGSC(token, { startDate: since, endDate: until, dimensions: ['date'],  rowLimit: 500 }),
      queryGSC(token, { startDate: since, endDate: until, dimensions: ['query'], rowLimit: 50 }),
      queryGSC(token, { startDate: since, endDate: until, dimensions: ['page'],  rowLimit: 50 }),
    ]);

    return Response.json({
      daily:   daily.map(r  => ({ date: r.keys[0],  clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position })),
      queries: queries.map(r => ({ query: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position })),
      pages:   pages.map(r  => ({ page: r.keys[0],  clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position })),
    }, { headers: cors });

  } catch (err) {
    return Response.json({ error: err.message }, { status: 500, headers: cors });
  }
}
