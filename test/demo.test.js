// Live demo: a private sample company per visitor, persona switching, and cleanup.

delete process.env.GOOGLE_CLIENT_ID;
delete process.env.NODE_ENV;
process.env.APP_URL = 'http://localhost:3000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, client, devLogin } = require('./helpers');
const { cleanupDemos } = require('../src/demo');

let app;
test.before(async () => { app = await startApp(); });
test.after(() => app.close());

async function startDemo() {
  const c = client(app.base);
  const res = await c.post('/auth/demo');
  assert.equal(res.status, 200);
  const me = (await c.get('/api/me')).body;
  return { c, me, ws: me.workspaces[0], next: res.body.next };
}

test('starting a demo signs you in as the Admin of a sample company full of requests', async () => {
  const { c, me, ws, next } = await startDemo();
  assert.equal(me.user.name, 'Alex Morgan');
  assert.equal(me.user.is_demo, true);
  assert.equal(ws.name, 'Northwind Studio');
  assert.equal(ws.role, 'admin');
  assert.ok(ws.demo_expires_at);
  assert.equal(next, `/app?ws=${ws.id}`);

  const details = (await c.get(`/api/workspaces/${ws.id}`)).body;
  assert.equal(details.members.length, 6);
  const all = (await c.get(`/api/workspaces/${ws.id}/requests?scope=all`)).body.requests;
  assert.ok(all.length >= 15);
  for (const status of ['approved', 'rejected', 'pending']) assert.ok(all.some((r) => r.status === status), status);
  assert.ok(all.some((r) => r.risk_level === 'high'), 'some request is flagged high risk');
  const toApprove = (await c.get(`/api/workspaces/${ws.id}/requests?scope=to_approve`)).body.requests;
  assert.ok(toApprove.length >= 2, 'the Admin has requests waiting');
});

test('each visitor gets their own copy', async () => {
  const a = await startDemo();
  const b = await startDemo();
  assert.notEqual(a.ws.id, b.ws.id);
  assert.equal((await b.c.get(`/api/workspaces/${a.ws.id}`)).status, 404);
});

test('in a demo you can switch to another person of the same company, and only there', async () => {
  const { c, ws } = await startDemo();
  const other = await startDemo();
  const members = (await c.get(`/api/workspaces/${ws.id}`)).body.members;
  const sam = members.find((m) => m.name === 'Sam Rivera');
  const strangerId = (await other.c.get(`/api/workspaces/${other.ws.id}`)).body.members[1].id;

  assert.equal((await c.post('/auth/demo/switch', { user_id: strangerId })).status, 404);
  assert.equal((await c.post('/auth/demo/switch', { user_id: sam.id })).status, 200);
  const me = (await c.get('/api/me')).body;
  assert.equal(me.user.name, 'Sam Rivera');
  assert.equal(me.workspaces[0].role, 'employee');

  const real = await devLogin(app.base, 'real@acme.com', 'Real Person');
  assert.equal((await real.post('/auth/demo/switch', { user_id: sam.id })).status, 403);
});

test('invitations are off in the demo and nothing is emailed', async () => {
  const { c, ws } = await startDemo();
  const res = await c.post(`/api/workspaces/${ws.id}/invitations`, { email: 'someone@real.com', role: 'employee' });
  assert.equal(res.status, 403);
  const sent = app.mailer.outbox.filter((m) => m.to.endsWith('@demo.greenlight.test'));
  assert.equal(sent.length, 0);
});

test('expired demos are deleted with their people', async () => {
  const { ws } = await startDemo();
  await app.pool.query("UPDATE workspaces SET demo_expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1", [ws.id]);
  assert.ok((await cleanupDemos(app.pool)) >= 1);
  const left = await app.pool.query('SELECT COUNT(*)::int AS n FROM workspaces WHERE id = $1', [ws.id]);
  assert.equal(left.rows[0].n, 0);
  const orphans = await app.pool.query('SELECT COUNT(*)::int AS n FROM users WHERE is_demo = TRUE AND id NOT IN (SELECT user_id FROM memberships)');
  assert.equal(orphans.rows[0].n, 0);
});

test('the demo includes a request sent back for changes and PDF receipts', async () => {
  const { c, ws } = await startDemo();
  const all = (await c.get(`/api/workspaces/${ws.id}/requests?scope=all`)).body.requests;
  assert.ok(all.some((r) => r.status === 'changes_requested'));
  const withReceipt = all.find((r) => r.file_count > 0);
  const detail = (await c.get(`/api/workspaces/${ws.id}/requests/${withReceipt.id}`)).body;
  const res = await fetch(`${app.base}/api/workspaces/${ws.id}/requests/${withReceipt.id}/files/${detail.files[0].id}`,
    { headers: { Cookie: [...c.jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
  const pdf = Buffer.from(await res.arrayBuffer()).toString();
  assert.ok(pdf.startsWith('%PDF-') && pdf.trim().endsWith('%%EOF'));
});

test('no demo request is stuck waiting without an approver', async () => {
  const { ws } = await startDemo();
  const pending = (await app.pool.query("SELECT id FROM requests WHERE workspace_id = $1 AND status = 'pending'", [ws.id])).rows;
  assert.ok(pending.length > 0);
  for (const r of pending) {
    const steps = (await app.pool.query("SELECT 1 FROM request_approvals WHERE request_id = $1 AND status = 'pending'", [r.id])).rows;
    assert.equal(steps.length, 1, `request ${r.id} has a current approver`);
  }
});
