// Milestone 1 without Google: developer login, workspaces, isolation, CSRF protection, sessions.

delete process.env.GOOGLE_CLIENT_ID;
delete process.env.NODE_ENV;

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { startApp, client, devLogin } = require('./helpers');

let app;
test.before(async () => { app = await startApp(); });
test.after(() => app.close());

test('API requires sign-in', async () => {
  const res = await client(app.base).get('/api/me');
  assert.equal(res.status, 401);
});

test('signed-out visitors see the sign-in page; /app redirects to it', async () => {
  const c = client(app.base);
  assert.equal((await c.get('/')).status, 200);
  const appRes = await c.get('/app');
  assert.equal(appRes.status, 302);
  assert.equal(appRes.headers.get('location'), '/');
});

test('developer login creates the user and a session', async () => {
  const c = await devLogin(app.base, 'Dana@Acme.com', 'Dana Levi');
  const me = await c.get('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, 'dana@acme.com');
  assert.equal(me.body.user.name, 'Dana Levi');
  assert.deepEqual(me.body.workspaces, []);
  assert.equal((await c.get('/')).headers.get('location'), '/app');
});

test('developer login rejects invalid emails', async () => {
  const res = await client(app.base).post('/auth/dev-login', { email: 'not-an-email' });
  assert.equal(res.status, 400);
});

test('creating a workspace makes the creator its Admin', async () => {
  const c = await devLogin(app.base, 'owner@acme.com', 'Owner');
  const created = await c.post('/api/workspaces', { name: '  Acme   Inc. ' });
  assert.equal(created.status, 201);
  assert.equal(created.body.name, 'Acme Inc.');
  assert.equal(created.body.role, 'admin');
  assert.match(created.body.slug, /^acme-inc-[0-9a-f]{6}$/);

  const me = await c.get('/api/me');
  assert.equal(me.body.workspaces.length, 1);
  assert.equal(me.body.workspaces[0].role, 'admin');

  const ws = await c.get(`/api/workspaces/${created.body.id}`);
  assert.equal(ws.status, 200);
  assert.equal(ws.body.members.length, 1);
  assert.equal(ws.body.members[0].email, 'owner@acme.com');
  assert.equal(ws.body.members[0].role, 'admin');
});

test('workspace names are validated', async () => {
  const c = await devLogin(app.base, 'v@acme.com');
  assert.equal((await c.post('/api/workspaces', { name: 'A' })).status, 400);
  assert.equal((await c.post('/api/workspaces', { name: 'x'.repeat(81) })).status, 400);
  assert.equal((await c.post('/api/workspaces', {})).status, 400);
});

test('a user can belong to several workspaces', async () => {
  const c = await devLogin(app.base, 'multi@example.com');
  await c.post('/api/workspaces', { name: 'First Co' });
  await c.post('/api/workspaces', { name: 'Second Co' });
  const me = await c.get('/api/me');
  assert.deepEqual(me.body.workspaces.map((w) => w.name), ['First Co', 'Second Co']);
});

test("workspaces are isolated: other companies' workspaces return 404", async () => {
  const alice = await devLogin(app.base, 'alice@acme.com');
  const bob = await devLogin(app.base, 'bob@globex.com');
  const acme = await alice.post('/api/workspaces', { name: 'Acme' });
  assert.equal((await bob.get(`/api/workspaces/${acme.body.id}`)).status, 404);
  assert.equal((await bob.get('/api/workspaces/999999')).status, 404);
  assert.equal((await bob.get('/api/workspaces/abc')).status, 404);
  assert.equal((await bob.get('/api/me')).body.workspaces.length, 0);
});

test('cross-site and form-encoded writes are blocked (CSRF)', async () => {
  const c = await devLogin(app.base, 'csrf@acme.com');
  const foreign = await c.post('/api/workspaces', { name: 'Evil' }, { headers: { Origin: 'https://evil.example' } });
  assert.equal(foreign.status, 403);
  const form = await fetch(`${app.base}/api/workspaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: [...c.jar].map(([k, v]) => `${k}=${v}`).join('; ') },
    body: 'name=Evil',
  });
  assert.equal(form.status, 415);
  assert.equal((await c.get('/api/me')).body.workspaces.length, 0);
});

test('sessions are stored hashed and end on logout', async () => {
  const c = await devLogin(app.base, 'logout@acme.com');
  const token = c.jar.get('sid');
  const raw = await app.pool.query('SELECT id FROM sessions WHERE id = $1', [token]);
  assert.equal(raw.rows.length, 0, 'raw token must not be stored');
  const hashed = crypto.createHash('sha256').update(token).digest('hex');
  assert.equal((await app.pool.query('SELECT id FROM sessions WHERE id = $1', [hashed])).rows.length, 1);

  assert.equal((await c.post('/auth/logout')).status, 200);
  assert.equal((await app.pool.query('SELECT id FROM sessions WHERE id = $1', [hashed])).rows.length, 0);
  const again = await fetch(`${app.base}/api/me`, { headers: { Cookie: `sid=${token}` } });
  assert.equal(again.status, 401, 'old cookie must stop working');
});

test('expired sessions are rejected', async () => {
  const c = await devLogin(app.base, 'expired@acme.com');
  await app.pool.query("UPDATE sessions SET expires_at = NOW() - INTERVAL '1 minute'");
  assert.equal((await c.get('/api/me')).status, 401);
});
