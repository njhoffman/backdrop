import { expect } from 'chai';
import { COOKIE, HEADER, createToken, parseCookies, refusal, sameToken, sessionCookie } from '../../src/web/auth.js';

describe('web auth', () => {
  const token = 'secret-token';
  const port = 7737;
  const request = ({ method = 'GET', host = `127.0.0.1:${port}`, cookie, origin, header } = {}) => ({
    method,
    headers: {
      host,
      ...(cookie ? { cookie } : {}),
      ...(origin ? { origin } : {}),
      ...(header ? { [HEADER]: header } : {})
    }
  });
  const url = (path = '/api/state') => new URL(path, 'http://localhost');
  const check = (options, path) => refusal(request(options), url(path), { token, port });
  const withCookie = `${COOKIE}=${token}`;

  it('makes long random tokens and compares them in constant time', () => {
    expect(createToken()).to.match(/^[\w-]{32}$/);
    expect(createToken()).to.not.equal(createToken());
    expect(sameToken(token, token)).to.equal(true);
    expect(sameToken('secret-tokem', token)).to.equal(false);
    expect(sameToken('short', token)).to.equal(false);
    expect(sameToken(undefined, token)).to.equal(false);
  });

  it('reads cookies and writes an HttpOnly, SameSite=Strict one', () => {
    expect(parseCookies('a=1; backdrop_token=x%2By; junk')).to.deep.equal({ a: '1', backdrop_token: 'x+y' });
    expect(parseCookies()).to.deep.equal({});
    expect(sessionCookie('x+y')).to.equal('backdrop_token=x%2By; HttpOnly; SameSite=Strict; Path=/');
  });

  it('lets in the first visit with the token, then only requests with the cookie', () => {
    expect(check({}, `/?token=${token}`)).to.equal(null);
    expect(check({}, '/?token=wrong')).to.include({ status: 401 });
    expect(check({})).to.include({ status: 401 });
    expect(check({ cookie: withCookie })).to.equal(null);
    expect(check({ cookie: `${COOKIE}=wrong` })).to.include({ status: 401 });
  });

  it('needs the page token in a header on changes, which a cookie alone cannot give (CSRF)', () => {
    expect(check({ method: 'POST', cookie: withCookie })).to.include({ status: 403 });
    expect(check({ method: 'POST', cookie: withCookie, header: token })).to.equal(null);
    // A token in the URL does not stand in for the cookie on a change
    expect(check({ method: 'POST', header: token }, `/api/undo?token=${token}`)).to.include({ status: 401 });
  });

  it('answers only to its own host and origin (DNS rebinding, other sites)', () => {
    expect(check({ host: `evil.example:${port}`, cookie: withCookie })).to.include({ status: 403, error: 'Unknown host' });
    expect(check({ host: '127.0.0.1:9999', cookie: withCookie })).to.include({ status: 403 });
    expect(check({ host: `localhost:${port}`, cookie: withCookie })).to.equal(null);
    expect(check({ method: 'POST', cookie: withCookie, header: token, origin: 'http://evil.example' })).to.include({ status: 403 });
    expect(check({ method: 'POST', cookie: withCookie, header: token, origin: `http://localhost:${port}` })).to.equal(null);
  });
});
