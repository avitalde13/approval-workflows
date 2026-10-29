// The bell, reminders and escalation, and out-of-office delegation.

delete process.env.GOOGLE_CLIENT_ID;
delete process.env.NODE_ENV;
process.env.APP_URL = 'http://localhost:3000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, setupCompany, send } = require('./helpers');
const { runReminders } = require('../src/reminders');

let app;
test.before(async () => { app = await startApp(); });
test.after(() => app.close());

const HOUR = 60 * 60 * 1000;
const later = (hours) => new Date(Date.now() + hours * HOUR);
const notifier = () => app.notifier;

// Eli reports to Mo; Mo reports to Vic. Eli submits an expense that waits for Mo.
async function company(name) {
  const co = await setupCompany(app, name);
  const member = (id, body) => send(co.people.ada, 'PATCH', app.base, `/api/workspaces/${co.ws.id}/members/${id}`, body);
  await member(co.ids.eli, { manager_id: co.ids.mo });
  await member(co.ids.mo, { manager_id: co.ids.vic });
  const submit = (who = co.people.eli) => who.post(`/api/workspaces/${co.ws.id}/requests`, { type: 'expense', title: `Taxi ${Math.random()}`, amount: 40, vendor: 'Cab' });
  return { ...co, submit };
}

test('the bell lists new approvals and decisions, and marks them read', async () => {
  const { people, submit } = await company('Bell');
  const r = (await submit()).body;
  const mo = (await people.mo.get('/api/notifications')).body;
  assert.equal(mo.unread, 1);
  assert.equal(mo.items[0].kind, 'approval_needed');
  assert.equal(mo.items[0].request_id, r.id);
  assert.match(mo.items[0].title, /Eli Employee needs your approval/);

  await people.mo.post(`/api/workspaces/${r.workspace_id}/requests/${r.id}/decision`, { decision: 'approve' });
  const eli = (await people.eli.get('/api/notifications')).body;
  assert.match(eli.items[0].title, /approved/);

  await people.mo.post('/api/notifications/read', { ids: [mo.items[0].id] });
  assert.equal((await people.mo.get('/api/notifications')).body.unread, 0);
  // Nobody sees anyone else's notifications.
  assert.ok((await people.fin.get('/api/notifications')).body.items.every((n) => n.request_id !== r.id));
});

test('a slow approver gets one reminder, then the step moves to their manager', async () => {
  const { people, ids, submit } = await company('Remind');
  const r = (await submit()).body;
  assert.deepEqual(await runReminders(app.pool, notifier(), later(1)), { reminded: 0, escalated: 0 });

  assert.deepEqual(await runReminders(app.pool, notifier(), later(49)), { reminded: 1, escalated: 0 });
  assert.deepEqual(await runReminders(app.pool, notifier(), later(50)), { reminded: 0, escalated: 0 }, 'only one reminder');
  assert.match(app.mailer.outbox[0].subject, /^Reminder: approval needed/);

  assert.deepEqual(await runReminders(app.pool, notifier(), later(97)), { reminded: 0, escalated: 1 });
  const detail = (await people.vic.get(`/api/workspaces/${r.workspace_id}/requests/${r.id}`)).body;
  assert.equal(detail.approvals[0].approver_id, ids.vic);
  assert.equal(detail.approvals[0].reassigned_reason, 'escalated');
  assert.equal(detail.can_decide, true);
  // Mo can still see it but no longer decide; it escalates only once.
  assert.equal((await people.mo.get(`/api/workspaces/${r.workspace_id}/requests/${r.id}`)).body.can_decide, false);
  assert.deepEqual(await runReminders(app.pool, notifier(), later(300)), { reminded: 1, escalated: 0 });
});

test('Admins tune or turn off reminders; others cannot', async () => {
  const { ws, people, submit } = await company('Tune');
  const url = `/api/workspaces/${ws.id}/settings`;
  assert.equal((await send(people.mo, 'PATCH', app.base, url, { reminder_hours: 24 })).status, 403);
  assert.equal((await send(people.ada, 'PATCH', app.base, url, { reminder_hours: 24, escalate_hours: 12 })).status, 400);
  const res = await send(people.ada, 'PATCH', app.base, url, { reminder_hours: null, escalate_hours: null });
  assert.equal(res.body.reminder_hours, null);
  assert.equal(res.body.escalate_hours, null);
  await submit();
  assert.deepEqual(await runReminders(app.pool, notifier(), later(1000)), { reminded: 0, escalated: 0 });
});

test('out of office: waiting approvals move to the delegate, and new ones go there too', async () => {
  const { ws, people, ids, submit } = await company('Away');
  const first = (await submit()).body;
  const today = new Date().toISOString().slice(0, 10);
  const nextWeek = new Date(Date.now() + 7 * 24 * HOUR).toISOString().slice(0, 10);

  assert.equal((await send(people.mo, 'PUT', app.base, `/api/workspaces/${ws.id}/away`, { away_until: nextWeek, delegate_id: ids.mo })).status, 400);
  const set = await send(people.mo, 'PUT', app.base, `/api/workspaces/${ws.id}/away`, { away_from: today, away_until: nextWeek, delegate_id: ids.vic });
  assert.equal(set.status, 200);
  assert.equal(set.body.moved, 1);
  const moved = (await people.vic.get(`/api/workspaces/${ws.id}/requests/${first.id}`)).body;
  assert.equal(moved.approvals[0].approver_id, ids.vic);
  assert.equal(moved.approvals[0].reassigned_reason, 'delegated');
  assert.equal(moved.approvals[0].reassigned_from_name, 'Mo Manager');

  const second = (await submit()).body;
  assert.equal(second.approvals[0].approver_id, ids.vic);
  const members = (await people.eli.get(`/api/workspaces/${ws.id}`)).body.members;
  assert.equal(members.find((m) => m.id === ids.mo).away_until, nextWeek);

  // Back in the office: new requests go to Mo again.
  await send(people.mo, 'DELETE', app.base, `/api/workspaces/${ws.id}/away`);
  assert.equal((await submit()).body.approvals[0].approver_id, ids.mo);
});

test('a delegate never approves their own request', async () => {
  const { ws, people, ids, submit } = await company('AwaySelf');
  const nextWeek = new Date(Date.now() + 7 * 24 * HOUR).toISOString().slice(0, 10);
  await send(people.mo, 'PUT', app.base, `/api/workspaces/${ws.id}/away`, { away_until: nextWeek, delegate_id: ids.eli });
  assert.equal((await submit()).body.approvals[0].approver_id, ids.mo);
});
