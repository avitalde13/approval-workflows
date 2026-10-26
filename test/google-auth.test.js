// Google sign-in, with Google's token and profile endpoints replaced by a fake.

process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
process.env.APP_URL = 'http://localhost:3000';
delete process.env.NODE_ENV;

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { startApp, client } = require('./helpers');

// What the fake Google returns for the next sign-in.
let profile;
const calls = [];
async function fakeGoogle(url, options = {}) {
  calls.push({ url, options });
  if (url === 'https://oauth2.googleapis.com/token') {
    const body = new URLSearchParams(options.body.toString());
    if (body.get('code') !== 'good-code') return new Response('{"error":"invalid_grant"}', { status: 400 });
    return Response.json({ access_token: 'fake-access-token', token_type: 'Bearer' });
  }
  if (url === 'https://openidconnect.googleapis.com/v1/userinfo') return Response.json(profile);
  throw new Error(`unexpected URL ${url}`);
}

let app;
test.before(async () => { app = await startApp({ fetchImpl: fakeGoogle }); });
test.after(() => app.close());

async function startSignIn(c) {
  const res = await c.get('/auth/google');
  assert.equal(res.status, 302);
  const url = new URL(res.headers.get('location'));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  return url.searchParams;
}

test('redirects to Google with state and PKCE', async () => {
  const params = await startSignIn(client(app.base));
  assert.equal(params.get('client_id'), process.env.GOOGLE_CLIENT_ID);
  assert.equal(params.get('redirect_uri'), 'http://localhost:3000/auth/google/callback');
  assert.equal(params.get('scope'), 'openid email profile');
  assert.equal(params.get('code_challenge_method'), 'S256');
  assert.ok(params.get('state').length >= 16);
  assert.ok(params.get('code_challenge').length >= 40);
});

test('a successful Google sign-in creates the user and a session', async () => {
  profile = { sub: 'google-123', email: 'Maya@Example.com', email_verified: true, name: 'Maya Cohen', picture: 'https://example.com/m.png' };
  const c = client(app.base);
  const params = await startSignIn(c);
  const cb = await c.get(`/auth/google/callback?code=good-code&state=${params.get('state')}`);
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get('location'), '/app');

  // The PKCE verifier sent to Google must match the challenge from step 1.
  const tokenCall = calls.find((x) => x.url === 'https://oauth2.googleapis.com/token');
  const verifier = new URLSearchParams(tokenCall.options.body.toString()).get('code_verifier');
  assert.equal(crypto.createHash('sha256').update(verifier).digest('base64url'), params.get('code_challenge'));

  const me = await c.get('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, 'maya@example.com');
  assert.equal(me.body.user.name, 'Maya Cohen');
  assert.equal(me.body.user.avatar_url, 'https://example.com/m.png');
});

test('signing in again reuses the same account', async () => {
  profile = { sub: 'google-123', email: 'maya@example.com', email_verified: true, name: 'Maya C.' };
  const c = client(app.base);
  const params = await startSignIn(c);
  await c.get(`/auth/google/callback?code=good-code&state=${params.get('state')}`);
  const { rows } = await app.pool.query("SELECT COUNT(*)::int AS n FROM users WHERE google_sub = 'google-123'");
  assert.equal(rows[0].n, 1);
  assert.equal((await c.get('/api/me')).body.user.name, 'Maya C.');
});

test('a wrong state is rejected (stops forged sign-in links)', async () => {
  const c = client(app.base);
  await startSignIn(c);
  const cb = await c.get('/auth/google/callback?code=good-code&state=forged');
  assert.equal(cb.headers.get('location'), '/?error=state_mismatch');
  assert.equal((await c.get('/api/me')).status, 401);
});

test('a callback without the sign-in cookie is rejected', async () => {
  const cb = await client(app.base).get('/auth/google/callback?code=good-code&state=anything');
  assert.equal(cb.headers.get('location'), '/?error=state_missing');
});

test('unverified Google emails are rejected', async () => {
  profile = { sub: 'google-999', email: 'unverified@example.com', email_verified: false, name: 'X' };
  const c = client(app.base);
  const params = await startSignIn(c);
  const cb = await c.get(`/auth/google/callback?code=good-code&state=${params.get('state')}`);
  assert.equal(cb.headers.get('location'), '/?error=email_not_verified');
});

test('a failed code exchange is handled', async () => {
  const c = client(app.base);
  const params = await startSignIn(c);
  const cb = await c.get(`/auth/google/callback?code=bad-code&state=${params.get('state')}`);
  assert.equal(cb.headers.get('location'), '/?error=token_exchange_failed');
});

test('developer login is off when Google is configured', async () => {
  const res = await client(app.base).post('/auth/dev-login', { email: 'dev@example.com' });
  assert.equal(res.status, 404);
  assert.deepEqual((await client(app.base).get('/auth/config')).body, { google: true, devLogin: false });
});
