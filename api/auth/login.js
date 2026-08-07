const crypto = require('crypto');

module.exports = async (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    res.status(500).send('Google OAuth is not configured yet (missing GOOGLE_CLIENT_ID env var).');
    return;
  }

  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const redirectUri = `${proto}://${host}/api/auth/callback`;

  const state = crypto.randomBytes(16).toString('hex');
  const nextParam = req.query.next;
  const next = typeof nextParam === 'string' && nextParam.startsWith('/') ? nextParam : '/';

  const stateCookiePayload = Buffer.from(JSON.stringify({ state, next })).toString('base64url');
  res.setHeader('Set-Cookie', `oauth_state=${stateCookiePayload}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email',
    state,
    prompt: 'select_account',
  });

  res.writeHead(302, { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` });
  res.end();
};
