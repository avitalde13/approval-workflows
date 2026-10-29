// Departments, budgets and currencies.

delete process.env.GOOGLE_CLIENT_ID;
delete process.env.NODE_ENV;
process.env.APP_URL = 'http://localhost:3000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, setupCompany, send } = require('./helpers');

// Exchange-rate service stub: 1 USD = 0.9 EUR.
const fakeFetch = async (url) => {
  if (String(url).startsWith('https://api.frankfurter.dev/')) {
    return { ok: true, json: async () => ({ base: 'USD', rates: { EUR: 0.9, GBP: 0.8, XYZ: 5 } }) };
  }
  throw new Error(`unexpected fetch ${url}`);
};

let app;
test.before(async () => { app = await startApp({ fetchImpl: fakeFetch }); });
test.after(() => app.close());

// Eli (Engineering, reports to Mo) submits; Engineering has a $1,000 quarterly budget.
async function company(name) {
  const co = await setupCompany(app, name);
  const base = `/api/workspaces/${co.ws.id}`;
  const dept = (await co.people.ada.post(`${base}/departments`, { name: 'Engineering', budget_amount: 1000, budget_period: 'quarter' })).body;
  await send(co.people.ada, 'PATCH', app.base, `${base}/members/${co.ids.eli}`, { manager_id: co.ids.mo, department_id: dept.id });
  const submit = (amount, currency = 'USD') => co.people.eli.post(`${base}/requests`, { type: 'expense', title: `Spend ${Math.random()}`, amount, currency, vendor: 'Shop' });
  const flags = async (r) => (await co.people.mo.get(`${base}/requests/${r.id}`)).body.insight.rule_flags.map((f) => f.code);
  return { ...co, base, dept, submit, flags };
}

test('Admins manage departments; others can only look', async () => {
  const { people, base, dept } = await company('Depts');
  assert.equal((await people.mo.post(`${base}/departments`, { name: 'Sales' })).status, 403);
  assert.equal((await people.ada.post(`${base}/departments`, { name: 'engineering' })).status, 409, 'names are unique');
  assert.equal((await people.ada.post(`${base}/departments`, { name: 'Sales', budget_amount: -5 })).status, 400);
  assert.equal((await send(people.ada, 'PATCH', app.base, `${base}/departments/${dept.id}`, { budget_amount: 2000, budget_period: 'month' })).status, 200);
  const list = (await people.eli.get(`${base}/departments`)).body.departments;
  assert.deepEqual(list.map((d) => [d.name, d.budget, d.period]), [['Engineering', 2000, 'month']]);
  const ws = (await people.eli.get(base)).body;
  assert.equal(ws.members.find((m) => m.name === 'Eli Employee').department_id, dept.id);
});

test('requests that take a department near or over budget are flagged', async () => {
  const { submit, flags } = await company('Budget');
  assert.ok(!(await flags((await submit(500)).body)).some((f) => f.includes('budget')));
  assert.ok((await flags((await submit(350)).body)).includes('budget_80'), '850 of 1,000 counting waiting requests');
  assert.ok((await flags((await submit(400)).body)).includes('over_budget'));
});

test('Admins hear when an approval takes a department past 80% of its budget', async () => {
  const { people, base, submit } = await company('Alert');
  const r = (await submit(900)).body;
  await people.mo.post(`${base}/requests/${r.id}/decision`, { decision: 'approve' });
  const bell = (await people.ada.get('/api/notifications')).body.items;
  assert.ok(bell.some((n) => n.kind === 'budget_alert' && /Engineering has used 90%/.test(n.title)));
});

test('exchange rates: by hand or from the ECB; reports convert to the base currency', async () => {
  const { people, base, submit } = await company('Fx');
  assert.equal((await send(people.ada, 'PUT', app.base, `${base}/rates`, { rates: { EUR: -1 } })).status, 400);
  assert.equal((await send(people.mo, 'PUT', app.base, `${base}/rates`, { rates: { EUR: 1.1 } })).status, 403);

  const r = (await submit(100, 'EUR')).body;
  await people.mo.post(`${base}/requests/${r.id}/decision`, { decision: 'approve' });
  let report = (await people.ada.get(`${base}/reports`)).body;
  assert.deepEqual(report.other_currencies, ['EUR'], 'no rate yet: listed separately');

  const set = await send(people.ada, 'PUT', app.base, `${base}/rates`, { rates: { EUR: 1.1 } });
  assert.deepEqual(set.body.rates.map((x) => [x.currency, x.rate, x.source]), [['EUR', 1.1, 'manual']]);
  report = (await people.ada.get(`${base}/reports`)).body;
  assert.equal(report.currency, 'USD');
  assert.equal(report.kpis.approved_total, 110);

  const refreshed = (await people.ada.post(`${base}/rates/refresh`)).body;
  assert.equal(refreshed.refreshed, 2, 'unknown currencies are ignored');
  const eur = refreshed.rates.find((x) => x.currency === 'EUR');
  assert.equal(eur.source, 'ecb');
  assert.ok(Math.abs(eur.rate - 1 / 0.9) < 1e-6);
  assert.deepEqual((await people.eli.get(base)).body.currencies, ['USD', 'EUR', 'GBP']);

  // Changing the base currency starts the rates over.
  const changed = (await send(people.ada, 'PATCH', app.base, `${base}/settings`, { base_currency: 'EUR' })).body;
  assert.equal(changed.base_currency, 'EUR');
  assert.deepEqual(changed.rates, []);
});
