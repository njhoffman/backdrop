import { randomBytes, timingSafeEqual } from 'crypto';

// Who may use `backdrop web` (docs/specs/web.md, D5). Any local program and any page open in the browser can reach a
// loopback port, so each run has a random token: the URL printed at start carries it once, the server swaps it for an
// HttpOnly, SameSite=Strict cookie, and every request needs that cookie. Changing requests also need the token in a
// header, which only the server's own page knows (it is written into the page), so a form or fetch from another site
// cannot make one (CSRF). Host and Origin must name this server, which stops DNS rebinding.

export const COOKIE = 'backdrop_token';
export const HEADER = 'x-backdrop-token';
const SAFE_METHODS = new Set(['GET', 'HEAD']);

export function createToken() {
  return randomBytes(24).toString('base64url');
}

export function sameToken(given, token) {
  if (typeof given !== 'string' || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    if (name) cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

// The hosts this server answers to: loopback names with its port
export function allowedHosts(port) {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

export function sessionCookie(token) {
  return `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`;
}

// Why a request is refused, or null when it may go on. url is the parsed request URL; a GET carrying ?token= is the
// first visit and is allowed so the server can set the cookie.
export function refusal(request, url, { token, port }) {
  const hosts = allowedHosts(port);
  if (!hosts.has(request.headers.host)) return { status: 403, error: 'Unknown host' };
  const { origin } = request.headers;
  if (origin && !hosts.has(origin.replace(/^http:\/\//, ''))) return { status: 403, error: 'Requests from other sites are refused' };
  if (SAFE_METHODS.has(request.method) && sameToken(url.searchParams.get('token'), token)) return null;
  if (!sameToken(parseCookies(request.headers.cookie)[COOKIE], token)) {
    return { status: 401, error: 'Open the address `backdrop web` printed (it carries this run\'s token)' };
  }
  if (!SAFE_METHODS.has(request.method) && !sameToken(request.headers[HEADER], token)) {
    return { status: 403, error: 'Missing the page token' };
  }
  return null;
}
