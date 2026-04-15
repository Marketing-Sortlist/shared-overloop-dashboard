async function makeToken(password) {
  const data = new TextEncoder().encode(password + ':overloop-dashboard');
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequest(context) {
  const { env, request } = context;

  if (!env.DASHBOARD_PASSWORD) {
    return Response.json({ error: 'DASHBOARD_PASSWORD not configured' }, { status: 500 });
  }

  const cookieHeader = request.headers.get('cookie') || '';
  const cookies = Object.fromEntries(
    cookieHeader.split(';')
      .map(c => c.trim())
      .filter(Boolean)
      .map(c => {
        const idx = c.indexOf('=');
        return [c.slice(0, idx), c.slice(idx + 1)];
      })
  );

  const expected = await makeToken(env.DASHBOARD_PASSWORD);
  if (cookies.dashboard_session === expected) {
    return Response.json({ ok: true });
  }

  return Response.json({ ok: false }, { status: 401 });
}
