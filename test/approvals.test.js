// Milestone 3: roles, member management, approval chains, requests and the audit log.

delete process.env.GOOGLE_CLIENT_ID;
delete process.env.NODE_ENV;
process.env.APP_URL = 'http://localhost:3000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, devLogin, setupCompany, send } = require('./helpers');

let app;
test.before(async () => { app = await startApp(); });
test.after(() => app.close());

const lastEmailTo = (email) => app.mailer.outbox.find((m) => m.to === email);

// ---------- Members and roles ----------

test('Admins set managers and roles; others cannot', async () => {
  const { ws, people, ids } = await setupCompany(app, 'Roles');
  const url = (id) => `/api/workspaces/${ws.id}/members/${id}`;

  const setMgr = await send(people.ada, 'PATCH', app.base, url(ids.eli), { manager_id: ids.mo });
  assert.equal(setMgr.status, 200);
  assert.equal(setMgr.body.manager_id, ids.mo);

  assert.equal((await send(people.ada, 'PATCH', app.base, url(ids.fin), { role: 'manager' })).body.role, 'manager');
  assert.equal((await send(people.mo, 'PATCH', app.base, url(ids.fin), { role: 'admin' })).status, 403);
  assert.equal((await send(people.eli, 'PATCH', app.base, url(ids.eli), { role: 'admin' })).status, 403);

  // Bad input
  assert.equal((await send(people.ada, 'PATCH', app.base, url(ids.eli), { role: 'owner' })).status, 400);
  assert.equal((await send(people.ada, 'PATCH', app.base, url(ids.eli), { manager_id: ids.eli })).status, 400);
  assert.equal((await send(people.ada, 'PATCH', app.base, url(ids.mo), { manager_id: ids.eli })).status, 400, 'loop: Eli reports to Mo');
  assert.equal((await send(people.ada, 'PATCH', app.base, url(99999), { role: 'employee' })).status, 404);
});

test('a workspace always keeps at least one Admin', async () => {
  const { ws, people, ids } = await setupCompany(app, 'LastAdmin');
  const res = await send(people.ada, 'PATCH', app.base, `/api/workspaces/${ws.id}/members/${ids.ada}`, { role: 'employee' });
  assert.equal(res.status, 400);
  assert.equal((await send(people.ada, 'DELETE', app.base, `/api/workspaces/${ws.id}/members/${ids.ada}`)).status, 400);
  // With a second Admin, the first can step down.
  await send(people.ada, 'PATCH', app.base, `/api/workspaces/${ws.id}/members/${ids.vic}`, { role: 'admin' });
  assert.equal((await send(people.ada, 'PATCH', app.base, `/api/workspaces/${ws.id}/members/${ids.ada}`, { role: 'employee' })).status, 200);
});

test('Admins remove members; removed people lose access', async () => {
  const { ws, people, ids } = await setupCompany(app, 'Remove');
  assert.equal((await send(people.ada, 'DELETE', app.base, `/api/workspaces/${ws.id}/members/${ids.fin}`)).status, 200);
  assert.equal((await people.fin.get(`/api/workspaces/${ws.id}`)).status, 404);
});

// ---------- Approval chains ----------

test('default chain is just the manager; Admins configure Manager → Finance → VP', async () => {
  const { ws, people, ids } = await setupCompany(app, 'Chains');
  const before = (await people.eli.get(`/api/workspaces/${ws.id}/approval-chains`)).body;
  assert.equal(before.purchase.default, true);
  assert.deepEqual(before.purchase.steps.map((s) => s.name), ['Manager']);

  const steps = [
    { name: 'Manager', approver_type: 'manager' },
    { name: 'Finance', approver_type: 'user', approver_user_id: ids.fin },
    { name: 'VP', approver_type: 'user', approver_user_id: ids.vic, min_amount: 5000 },
  ];
  assert.equal((await send(people.mo, 'PUT', app.base, `/api/workspaces/${ws.id}/approval-chains/purchase`, { steps })).status, 403);
  const saved = await send(people.ada, 'PUT', app.base, `/api/workspaces/${ws.id}/approval-chains/purchase`, { steps });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.steps.map((s) => [s.name, s.approver_name, s.min_amount]), [
    ['Manager', null, null], ['Finance', 'Fin Finance', null], ['VP', 'Vic VP', 5000],
  ]);

  const bad = (body) => send(people.ada, 'PUT', app.base, `/api/workspaces/${ws.id}/approval-chains/purchase`, body);
  assert.equal((await bad({ steps: [] })).status, 400);
  assert.equal((await bad({ steps: Array(6).fill({ name: 'X', approver_type: 'manager' }) })).status, 400);
  assert.equal((await bad({ steps: [{ name: 'X', approver_type: 'user', approver_user_id: 99999 }] })).status, 400);
  assert.equal((await bad({ steps: [{ name: 'X', approver_type: 'manager', min_amount: -1 }] })).status, 400);
  const timeOff = await send(people.ada, 'PUT', app.base, `/api/workspaces/${ws.id}/approval-chains/time_off`, { steps: [{ name: 'X', approver_type: 'manager', min_amount: 10 }] });
  assert.equal(timeOff.status, 400);
});

// ---------- Requests ----------

async function companyWithChain(name) {
  const c = await setupCompany(app, name);
  const { ws, people, ids } = c;
  await send(people.ada, 'PATCH', app.base, `/api/workspaces/${ws.id}/members/${ids.eli}`, { manager_id: ids.mo });
  await send(people.ada, 'PUT', app.base, `/api/workspaces/${ws.id}/approval-chains/purchase`, {
    steps: [
      { name: 'Manager', approver_type: 'manager' },
      { name: 'Finance', approver_type: 'user', approver_user_id: ids.fin },
      { name: 'VP', approver_type: 'user', approver_user_id: ids.vic, min_amount: 5000 },
    ],
  });
  return c;
}

test('a large purchase goes Manager → Finance → VP, with emails at every step', async () => {
  const { ws, people, ids } = await companyWithChain('Flow');
  const base = `/api/workspaces/${ws.id}/requests`;
  const created = await people.eli.post(base, { type: 'purchase', title: 'Team laptops', amount: 7200, vendor: 'Dell', description: '3 laptops' });
  assert.equal(created.status, 201);
  const rid = created.body.id;
  assert.deepEqual(created.body.approvals.map((a) => [a.step_name, a.approver_name, a.status]), [
    ['Manager', 'Mo Manager', 'pending'], ['Finance', 'Fin Finance', 'waiting'], ['VP', 'Vic VP', 'waiting'],
  ]);
  assert.equal(lastEmailTo('mo@flow.com').subject, 'Approval needed: Team laptops ($7,200.00)');

  // Only the current approver can decide.
  assert.equal((await people.fin.post(`${base}/${rid}/decision`, { decision: 'approve' })).status, 403);
  assert.equal((await people.eli.post(`${base}/${rid}/decision`, { decision: 'approve' })).status, 403);

  // Mo sees it in "to approve" and approves.
  assert.deepEqual((await people.mo.get(`${base}?scope=to_approve`)).body.requests.map((r) => r.id), [rid]);
  const step1 = await people.mo.post(`${base}/${rid}/decision`, { decision: 'approve', comment: 'Needed' });
  assert.equal(step1.status, 200);
  assert.equal(step1.body.status, 'pending');
  assert.equal(lastEmailTo('fin@flow.com').subject, 'Approval needed: Team laptops ($7,200.00)');
  assert.equal(lastEmailTo('eli@flow.com').subject, 'Your request "Team laptops" was approved by Mo Manager');

  await people.fin.post(`${base}/${rid}/decision`, { decision: 'approve' });
  assert.equal(lastEmailTo('vic@flow.com').subject, 'Approval needed: Team laptops ($7,200.00)');
  const done = await people.vic.post(`${base}/${rid}/decision`, { decision: 'approve' });
  assert.equal(done.body.status, 'approved');
  assert.deepEqual(done.body.approvals.map((a) => a.status), ['approved', 'approved', 'approved']);
  assert.equal(lastEmailTo('eli@flow.com').subject, 'Your request "Team laptops" was approved');

  // Decided requests can't be decided again.
  assert.equal((await people.vic.post(`${base}/${rid}/decision`, { decision: 'reject', comment: 'late' })).status, 409);
});

test('the VP step is skipped below its minimum amount', async () => {
  const { ws, people } = await companyWithChain('Small');
  const base = `/api/workspaces/${ws.id}/requests`;
  const r = (await people.eli.post(base, { type: 'purchase', title: 'Desk lamp', amount: 120, vendor: 'IKEA' })).body;
  assert.deepEqual(r.approvals.map((a) => a.status), ['pending', 'waiting', 'skipped']);
  await people.mo.post(`${base}/${r.id}/decision`, { decision: 'approve' });
  const done = await people.fin.post(`${base}/${r.id}/decision`, { decision: 'approve' });
  assert.equal(done.body.status, 'approved');
});

test('rejecting needs a reason, stops the chain and tells the requester', async () => {
  const { ws, people } = await companyWithChain('Reject');
  const base = `/api/workspaces/${ws.id}/requests`;
  const r = (await people.eli.post(base, { type: 'purchase', title: 'Gaming chair', amount: 900, vendor: 'Secretlab' })).body;
  assert.equal((await people.mo.post(`${base}/${r.id}/decision`, { decision: 'reject' })).status, 400);
  const rej = await people.mo.post(`${base}/${r.id}/decision`, { decision: 'reject', comment: 'Not in this quarter budget' });
  assert.equal(rej.body.status, 'rejected');
  assert.deepEqual(rej.body.approvals.map((a) => a.status), ['rejected', 'cancelled', 'skipped']);
  const mail = lastEmailTo('eli@reject.com');
  assert.equal(mail.subject, 'Your request "Gaming chair" was rejected');
  assert.match(mail.text, /Not in this quarter budget/);
});

test('without a manager, the "manager" step goes to an Admin; nobody approves their own request', async () => {
  const { ws, people } = await setupCompany(app, 'Fallback');
  const base = `/api/workspaces/${ws.id}/requests`;
  const fin = (await people.fin.post(base, { type: 'expense', title: 'Taxi to client', amount: 45 })).body;
  assert.equal(fin.approvals[0].approver_name, 'Ada Admin');
  const ada = (await people.ada.post(base, { type: 'expense', title: 'Conference ticket', amount: 300 })).body;
  assert.notEqual(ada.approvals[0].approver_name, 'Ada Admin');
});

test('time off requests use dates and their own chain', async () => {
  const { ws, people, ids } = await companyWithChain('Leave');
  const base = `/api/workspaces/${ws.id}/requests`;
  const bad = await people.eli.post(base, { type: 'time_off', title: 'Vacation', start_date: '2026-12-10', end_date: '2026-12-01' });
  assert.equal(bad.status, 400);
  const ok = await people.eli.post(base, { type: 'time_off', title: 'Winter vacation', start_date: '2026-12-21', end_date: '2026-12-31' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.start_date, '2026-12-21');
  assert.equal(ok.body.amount, null);
  assert.deepEqual(ok.body.approvals.map((a) => a.approver_id), [ids.mo]);
});

test('request input is validated', async () => {
  const { ws, people } = await setupCompany(app, 'Valid');
  const base = `/api/workspaces/${ws.id}/requests`;
  for (const body of [
    { type: 'bribe', title: 'Hmm', amount: 1 },
    { type: 'purchase', title: 'X', amount: 10, vendor: 'V' },
    { type: 'purchase', title: 'No vendor', amount: 10 },
    { type: 'expense', title: 'Free money', amount: -5 },
    { type: 'expense', title: 'Bad currency', amount: 5, currency: 'DOLLARS' },
  ]) {
    assert.equal((await people.eli.post(base, body)).status, 400, JSON.stringify(body));
  }
});

test('who can see what: requester, approvers, the manager, Admins', async () => {
  const { ws, people } = await companyWithChain('Visibility');
  const base = `/api/workspaces/${ws.id}/requests`;
  const r = (await people.eli.post(base, { type: 'expense', title: 'Client dinner', amount: 210 })).body;
  for (const who of ['eli', 'mo', 'ada']) assert.equal((await people[who].get(`${base}/${r.id}`)).status, 200, who);
  assert.equal((await people.fin.get(`${base}/${r.id}`)).status, 404, 'Fin is not in the expense chain');
  assert.equal((await people.vic.get(`${base}/${r.id}`)).status, 404);

  assert.deepEqual((await people.mo.get(`${base}?scope=team`)).body.requests.map((x) => x.id), [r.id]);
  assert.equal((await people.eli.get(`${base}?scope=team`)).status, 403);
  assert.equal((await people.mo.get(`${base}?scope=all`)).status, 403);
  assert.equal((await people.ada.get(`${base}?scope=all`)).body.requests.length, 1);

  const outsider = await devLogin(app.base, 'out@other.com');
  assert.equal((await outsider.get(`${base}/${r.id}`)).status, 404);
  assert.equal((await outsider.post(base, { type: 'expense', title: 'Sneaky', amount: 1 })).status, 404);
});

test('the requester can cancel while pending, nobody else', async () => {
  const { ws, people } = await companyWithChain('Cancel');
  const base = `/api/workspaces/${ws.id}/requests`;
  const r = (await people.eli.post(base, { type: 'expense', title: 'Parking', amount: 30 })).body;
  assert.equal((await people.mo.post(`${base}/${r.id}/cancel`)).status, 403);
  assert.equal((await people.eli.post(`${base}/${r.id}/cancel`)).status, 200);
  assert.equal((await people.eli.get(`${base}/${r.id}`)).body.status, 'cancelled');
  assert.equal((await people.mo.post(`${base}/${r.id}/decision`, { decision: 'approve' })).status, 409);
  assert.equal((await people.eli.post(`${base}/${r.id}/cancel`)).status, 409);
});

test('people with waiting approvals cannot be removed until they finish', async () => {
  const { ws, people, ids } = await companyWithChain('Busy');
  await people.eli.post(`/api/workspaces/${ws.id}/requests`, { type: 'expense', title: 'Train ticket', amount: 20 });
  const res = await send(people.ada, 'DELETE', app.base, `/api/workspaces/${ws.id}/members/${ids.mo}`);
  assert.equal(res.status, 409);
});

// ---------- Audit log ----------

test('every action lands in the audit log, readable by Admins only', async () => {
  const { ws, people } = await companyWithChain('Audit');
  const base = `/api/workspaces/${ws.id}/requests`;
  const r = (await people.eli.post(base, { type: 'purchase', title: 'Monitor', amount: 250, vendor: 'LG' })).body;
  await people.mo.post(`${base}/${r.id}/decision`, { decision: 'approve' });
  await people.fin.post(`${base}/${r.id}/decision`, { decision: 'reject', comment: 'Use the spare one' });

  assert.equal((await people.mo.get(`/api/workspaces/${ws.id}/audit-log`)).status, 403);
  const log = (await people.ada.get(`/api/workspaces/${ws.id}/audit-log`)).body.entries;
  const actions = log.map((e) => e.action).reverse();
  for (const a of ['workspace.created', 'invitation.sent', 'member.joined', 'member.manager_changed', 'chain.updated',
    'request.submitted', 'request.step_approved', 'request.rejected']) {
    assert.ok(actions.includes(a), `missing ${a}`);
  }
  const rejected = log.find((e) => e.action === 'request.rejected');
  assert.equal(rejected.actor_name, 'Fin Finance');
  assert.equal(rejected.details.comment, 'Use the spare one');
  assert.equal(rejected.entity_id, r.id);

  // Paging
  const page1 = (await people.ada.get(`/api/workspaces/${ws.id}/audit-log?limit=3`)).body;
  assert.equal(page1.entries.length, 3);
  const page2 = (await people.ada.get(`/api/workspaces/${ws.id}/audit-log?limit=3&before=${page1.next_before}`)).body;
  assert.ok(page2.entries.every((e) => e.id < page1.next_before));
});
