async function makeToken(password) {
  const data = new TextEncoder().encode(password + ':overloop-dashboard');
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestPost(context) {
  const { env, request } = context;

  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }

  if (!env.DASHBOARD_PASSWORD) {
    return Response.json({ error: 'DASHBOARD_PASSWORD not configured' }, { status: 500 });
  }

  if (body.password === env.DASHBOARD_PASSWORD) {
    const token = await makeToken(env.DASHBOARD_PASSWORD);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': `dashboard_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`,
      },
    });
  }

  return Response.json({ error: 'Wrong password' }, { status: 401 });
}
