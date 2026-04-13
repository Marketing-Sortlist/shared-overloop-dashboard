const crypto = require('crypto');

function makeToken(password) {
  return crypto.createHash('sha256').update(password + ':overloop-dashboard').digest('hex');
}

module.exports = function handler(req, res) {
  if (!process.env.DASHBOARD_PASSWORD) {
    return res.status(500).json({ error: 'DASHBOARD_PASSWORD not configured' });
  }

  const cookieHeader = req.headers.cookie || '';
  const cookies = Object.fromEntries(
    cookieHeader.split(';')
      .map(c => c.trim())
      .filter(Boolean)
      .map(c => {
        const idx = c.indexOf('=');
        return [c.slice(0, idx), c.slice(idx + 1)];
      })
  );

  const expected = makeToken(process.env.DASHBOARD_PASSWORD);
  if (cookies.dashboard_session === expected) {
    return res.status(200).json({ ok: true });
  }

  return res.status(401).json({ ok: false });
};
