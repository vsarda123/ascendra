const crypto = require('crypto');

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

module.exports = async (req, res) => {
  const sessionSecret = process.env.SESSION_SECRET;
  const cookies = parseCookies(req.headers.cookie);
  const raw = cookies.session;

  if (!raw || !sessionSecret) {
    res.status(401).json({ authenticated: false });
    return;
  }

  const [payloadB64, sig] = raw.split('.');
  if (!payloadB64 || !sig) {
    res.status(401).json({ authenticated: false });
    return;
  }

  const expected = crypto.createHmac('sha256', sessionSecret).update(payloadB64).digest('base64url');
  if (expected !== sig) {
    res.status(401).json({ authenticated: false });
    return;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
      res.status(401).json({ authenticated: false });
      return;
    }
    res.status(200).json({ authenticated: true, email: payload.email });
  } catch {
    res.status(401).json({ authenticated: false });
  }
};
