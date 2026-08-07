import { next } from '@vercel/functions';

// Gates every page/asset request behind a valid session cookie. Auth
// endpoints (which issue/verify that cookie) are excluded, or every
// request would redirect-loop through login.
export const config = {
  matcher: ['/((?!api/auth|api/cron|favicon.ico|favicon.png).*)'],
};

function getCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  const match = header.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return atob(str);
}

function b64urlEncodeBytes(bytes) {
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacSign(secret, data) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return b64urlEncodeBytes(new Uint8Array(sig));
}

// Signature format must match api/auth/callback.js exactly (HMAC-SHA256 of
// the base64url payload, base64url-encoded). Node's crypto and Web Crypto
// produce byte-identical HMAC-SHA256 output, so the two runtimes agree.
async function verifySession(cookieValue, secret) {
  if (!cookieValue || !secret) return null;
  const parts = cookieValue.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  const expected = await hmacSign(secret, payloadB64);
  if (expected !== sig) return null;
  try {
    const payload = JSON.parse(b64urlDecode(payloadB64));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (!payload.email) return null;
    return payload;
  } catch {
    return null;
  }
}

export default async function middleware(request) {
  const secret = process.env.SESSION_SECRET;
  const session = await verifySession(getCookie(request, 'session'), secret);

  if (!session) {
    const url = new URL(request.url);
    const loginUrl = new URL('/api/auth/login', url.origin);
    loginUrl.searchParams.set('next', url.pathname + url.search);
    return Response.redirect(loginUrl.toString(), 302);
  }

  return next();
}
