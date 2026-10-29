// Spending dashboard and CSV export.

delete process.env.GOOGLE_CLIENT_ID;
delete process.env.NODE_ENV;
process.env.APP_URL = 'http://localhost:3000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, client } = require('./helpers');
const { summarize, toCsv } = require('../src/routes/reports');

let app;
test.before(async () => { app = await startApp(); });
test.after(() => app.close());

async function demoAs(name) {
  const c = client(app.base);
  const next = (await c.post('/auth/demo')).body.next;
  const wsId = Number(next.split('=')[1]);
  if (name) {
    const m = (await c.get(`/api/workspaces/${wsId}`)).body.members.find((x) => x.name === name);
    await c.post('/auth/demo/switch', { user_id: m.id });
  }
  return { c, wsId };
}

test('Admins see company-wide spending: KPIs, months, vendors and people', async () => {
  const { c, wsId } = await demoAs();
  const r = (await c.get(`/api/workspaces/${wsId}/reports?range=12m`)).body;
  assert.equal(r.scope, 'company');
  assert.equal(r.currency, 'USD');
  assert.equal(r.monthly.length, 12);
  assert.ok(r.kpis.approved_total > 10000);
  assert.ok(r.kpis.pending_count >= 4);
  assert.ok(r.kpis.approval_rate > 50 && r.kpis.approval_rate <= 100);
  assert.ok(r.top_vendors.length > 0 && r.top_vendors[0].total >= r.top_vendors.at(-1).total);
  assert.equal(r.monthly.reduce((s, m) => s + m.total, 0).toFixed(2), r.kpis.approved_total.toFixed(2));
});

test('Managers see only their team; employees cannot open reports', async () => {
  const admin = await demoAs();
  const all = (await admin.c.get(`/api/workspaces/${admin.wsId}/reports`)).body;
  const daniel = await demoAs('Daniel Cohen');
  const team = (await daniel.c.get(`/api/workspaces/${daniel.wsId}/reports`)).body;
  assert.equal(team.scope, 'team');
  assert.ok(team.kpis.requests < all.kpis.requests);
  assert.ok(team.top_people.every((p) => ['Daniel Cohen', 'Maya Levi', 'Sam Rivera'].includes(p.label)));
  const sam = await demoAs('Sam Rivera');
  assert.equal((await sam.c.get(`/api/workspaces/${sam.wsId}/reports`)).status, 403);
  assert.equal((await sam.c.get(`/api/workspaces/${sam.wsId}/reports/export.csv`)).status, 403);
});

test('CSV export downloads every request in range', async () => {
  const { c, wsId } = await demoAs();
  const res = await fetch(`${app.base}/api/workspaces/${wsId}/reports/export.csv?range=all`, { headers: { Cookie: [...c.jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="greenlight-requests-/);
  const lines = (await res.text()).trim().split('\r\n');
  assert.match(lines[0], /"ID","Submitted","Requester"/);
  assert.ok(lines.length > 20);
});

test('CSV cells cannot run as spreadsheet formulas', () => {
  const csv = toCsv([{ id: 1, created_at: new Date('2026-01-02'), requester_name: '=HYPERLINK("x")', requester_email: 'a@b.c', type: 'expense',
    title: 'Say "hi"', vendor: '+cmd', amount: 5, currency: 'USD', status: 'approved', decided_at: null }]);
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/);
  assert.match(csv, /"Say ""hi"""/);
  assert.match(csv, /"'\+cmd"/);
});

test('reports use the most common currency and list the others', () => {
  const at = new Date();
  const row = (amount, currency, status = 'approved') => ({ type: 'purchase', amount, currency, status, created_at: at, decided_at: at, requester_name: 'A', vendor: 'V' });
  const r = summarize([row(10, 'EUR'), row(20, 'EUR'), row(500, 'USD')]);
  assert.equal(r.currency, 'EUR');
  assert.deepEqual(r.other_currencies, ['USD']);
  assert.equal(r.kpis.approved_this_month, 30);
});
