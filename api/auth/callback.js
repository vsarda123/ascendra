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
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const sessionSecret = process.env.SESSION_SECRET;
  const allowedEmails = (process.env.ALLOWED_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  if (!clientId || !clientSecret || !sessionSecret) {
    res.status(500).send('Google OAuth is not fully configured yet (missing env vars).');
    return;
  }

  const { code, state, error } = req.query;
  if (error) {
    res.status(403).send(`Google sign-in failed: ${error}`);
    return;
  }

  const cookies = parseCookies(req.headers.cookie);
  let expected = null;
  try {
    expected = JSON.parse(Buffer.from(cookies.oauth_state || '', 'base64url').toString('utf8'));
  } catch {
    expected = null;
  }

  if (!expected || expected.state !== state) {
    res.status(403).send('Invalid or expired sign-in attempt. Go back and try signing in again.');
    return;
  }

  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const redirectUri = `${proto}://${host}/api/auth/callback`;

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenResp.ok) {
    res.status(502).send('Could not reach Google to complete sign-in.');
    return;
  }

  const tokenJson = await tokenResp.json();
  const idToken = tokenJson.id_token;
  if (!idToken) {
    res.status(502).send('Google did not return an identity token.');
    return;
  }

  // We fetched this id_token ourselves, server-to-server, using our client
  // secret -- it did not come from the browser, so decoding its payload
  // without re-verifying Google's signature is safe here.
  const payloadSegment = idToken.split('.')[1];
  const claims = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
  const email = (claims.email || '').toLowerCase();

  if (!claims.email_verified || !allowedEmails.includes(email)) {
    res.status(403).send(`${email || 'This Google account'} is not authorized to view this dashboard. Ask for access to be added.`);
    return;
  }

  const exp = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60; // 7 days
  const sessionPayload = Buffer.from(JSON.stringify({ email, exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', sessionSecret).update(sessionPayload).digest('base64url');
  const sessionCookie = `${sessionPayload}.${sig}`;

  const nextPath = expected.next && expected.next.startsWith('/') ? expected.next : '/';

  res.setHeader('Set-Cookie', [
    `session=${sessionCookie}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`,
    `oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
  ]);
  res.writeHead(302, { Location: nextPath });
  res.end();
};
