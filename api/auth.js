const crypto = require('crypto');

function makeToken(password) {
  return crypto.createHash('sha256').update(password + ':overloop-dashboard').digest('hex');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  let body = '';
  await new Promise(resolve => { req.on('data', c => body += c); req.on('end', resolve); });

  let password;
  try { ({ password } = JSON.parse(body)); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  if (!process.env.DASHBOARD_PASSWORD) {
    return res.status(500).json({ error: 'DASHBOARD_PASSWORD not configured' });
  }

  if (password === process.env.DASHBOARD_PASSWORD) {
    const token = makeToken(process.env.DASHBOARD_PASSWORD);
    res.setHeader('Set-Cookie', `dashboard_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`);
    return res.status(200).json({ ok: true });
  }

  return res.status(401).json({ error: 'Wrong password' });
};
