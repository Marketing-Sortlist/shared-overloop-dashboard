// Cloudflare KV binding: ANNOTATIONS
// KV key: namespace param (default "all") → JSON array of { date, text, created_at }
// Each chart uses its own namespace so annotations don't cross:
//   "all"          → Performance tab (Cost Per Outcome chart)
//   "onboarding_v2" → Onboarding tab (Conversion Rates Over Time chart)

export async function onRequest(context) {
  const { request, env } = context;
  const kv = env.ANNOTATIONS;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const url = new URL(request.url);
  const rawNs = url.searchParams.get('namespace') || 'all';
  const namespace = /^[a-z0-9_]{1,50}$/.test(rawNs) ? rawNs : 'all';

  async function load() {
    const raw = await kv.get(namespace);
    return raw ? JSON.parse(raw) : [];
  }

  async function save(list) {
    list.sort((a, b) => a.date.localeCompare(b.date));
    await kv.put(namespace, JSON.stringify(list));
  }

  try {
    if (request.method === 'GET') {
      const list = await load();
      return new Response(JSON.stringify({ annotations: list }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (request.method === 'POST') {
      const { date, text } = await request.json();
      if (!date || !text?.trim()) {
        return new Response(JSON.stringify({ error: 'date and text required' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const list = await load();
      const existing = list.findIndex(a => a.date === date);
      const entry = { date, text: text.trim(), created_at: new Date().toISOString() };
      if (existing >= 0) list[existing] = entry;
      else list.push(entry);
      await save(list);
      return new Response(JSON.stringify({ ok: true, annotation: entry }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (request.method === 'DELETE') {
      const { date } = await request.json();
      if (!date) {
        return new Response(JSON.stringify({ error: 'date required' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const list = (await load()).filter(a => a.date !== date);
      await save(list);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}
