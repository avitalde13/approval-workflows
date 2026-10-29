// Vacation balances and the team calendar.

delete process.env.GOOGLE_CLIENT_ID;
delete process.env.NODE_ENV;
process.env.APP_URL = 'http://localhost:3000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, setupCompany, send } = require('./helpers');
const { businessDays } = require('../src/timeoff');

let app;
test.before(async () => { app = await startApp(); });
test.after(() => app.close());

test('business days skip weekends and can be limited to one year', () => {
  assert.equal(businessDays('2027-07-01', '2027-07-10'), 7); // Thu to Sat
  assert.equal(businessDays('2027-07-03', '2027-07-04'), 0); // a weekend
  assert.equal(businessDays('2026-12-28', '2027-01-08'), 10);
  assert.equal(businessDays('2026-12-28', '2027-01-08', 2027), 6);
});

async function company(name) {
  const co = await setupCompany(app, name);
  const base = `/api/workspaces/${co.ws.id}`;
  await send(co.people.ada, 'PATCH', app.base, `${base}/members/${co.ids.eli}`, { manager_id: co.ids.mo });
  const off = (who, start_date, end_date) => who.post(`${base}/requests`, { type: 'time_off', title: 'Away', start_date, end_date });
  return { ...co, base, off };
}

test('your balance counts approved and waiting days this year', async () => {
  const { people, base, off } = await company('Balance');
  const year = new Date().getUTCFullYear() + 1;
  const a = (await off(people.eli, `${year}-03-01`, `${year}-03-05`)).body; // Mon to Fri
  await people.mo.post(`${base}/requests/${a.id}/decision`, { decision: 'approve' });
  await off(people.eli, `${year}-04-05`, `${year}-04-06`);
  // Balances are for the current year; next year's requests don't count yet.
  const now = (await people.eli.get(`${base}/time-off/balance`)).body;
  assert.deepEqual([now.allowance, now.used, now.waiting, now.left], [12, 0, 0, 12]);

  const thisYear = new Date().getUTCFullYear();
  const b = (await off(people.eli, `${thisYear}-12-21`, `${thisYear}-12-24`)).body;
  const mine = (await people.eli.get(`${base}/time-off/balance`)).body;
  assert.equal(mine.waiting, businessDays(`${thisYear}-12-21`, `${thisYear}-12-24`));
  assert.equal(mine.left, 12 - mine.waiting);
  assert.ok(b.id);
});

test('Admins set allowances; Managers see their team; employees only themselves', async () => {
  const { people, base, ids } = await company('Allowance');
  assert.equal((await send(people.mo, 'PATCH', app.base, `${base}/time-off/allowance/${ids.eli}`, { vacation_days: 30 })).status, 403);
  assert.equal((await send(people.ada, 'PATCH', app.base, `${base}/time-off/allowance/${ids.eli}`, { vacation_days: -1 })).status, 400);
  assert.equal((await send(people.ada, 'PATCH', app.base, `${base}/time-off/allowance/${ids.eli}`, { vacation_days: 20 })).body.allowance, 20);
  assert.equal((await send(people.ada, 'PATCH', app.base, `${base}/settings`, { vacation_days: 15 })).body.vacation_days, 15);

  const team = (await people.mo.get(`${base}/time-off/balances`)).body;
  assert.deepEqual(team.balances.map((b) => [b.name, b.allowance, b.custom]).sort(), [['Eli Employee', 20, true], ['Mo Manager', 15, false]]);
  assert.equal((await people.ada.get(`${base}/time-off/balances`)).body.balances.length, 5);
  assert.equal((await people.eli.get(`${base}/time-off/balances`)).status, 403);
});

test('the calendar shows who is out; titles only for managers and the person themself', async () => {
  const { people, base, off } = await company('Calendar');
  const y = new Date().getUTCFullYear() + 1;
  await off(people.eli, `${y}-05-28`, `${y}-06-02`);
  const june = (await people.fin.get(`${base}/time-off/calendar?month=${y}-06`)).body;
  assert.equal(june.entries.length, 1);
  assert.equal(june.entries[0].name, 'Eli Employee');
  assert.equal(june.entries[0].title, null, 'a colleague sees dates, not reasons');
  assert.equal((await people.mo.get(`${base}/time-off/calendar?month=${y}-06`)).body.entries[0].title, 'Away');
  assert.equal((await people.eli.get(`${base}/time-off/calendar?month=${y}-06`)).body.entries[0].title, 'Away');
  assert.equal((await people.fin.get(`${base}/time-off/calendar?month=${y}-07`)).body.entries.length, 0);
});
