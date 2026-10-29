// Slack notifications through an incoming webhook.

delete process.env.GOOGLE_CLIENT_ID;
delete process.env.NODE_ENV;
process.env.APP_URL = 'http://localhost:3000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, setupCompany, send, client } = require('./helpers');

const HOOK = 'https://hooks.slack.com/services/T000/B000/abcdefXYZ123';
const BAD_HOOK = 'https://hooks.slack.com/services/T000/B000/revoked';
const posts = [];
const fakeFetch = async (url, opts) => {
  if (String(url).startsWith('https://hooks.slack.com/')) {
    posts.push({ url, body: JSON.parse(opts.body) });
    return { ok: url !== BAD_HOOK, status: url === BAD_HOOK ? 404 : 200, text: async () => 'ok' };
  }
  throw new Error(`unexpected fetch ${url}`);
};

let app;
test.before(async () => { app = await startApp({ fetchImpl: fakeFetch }); });
test.after(() => app.close());

test('Admins connect Slack; the URL stays secret; a bad URL is refused', async () => {
  const { ws, people } = await setupCompany(app, 'Slacky');
  const url = `/api/workspaces/${ws.id}/slack`;
  assert.equal((await send(people.mo, 'PUT', app.base, url, { webhook_url: HOOK })).status, 403);
  assert.equal((await send(people.ada, 'PUT', app.base, url, { webhook_url: 'https://evil.example.com/hook' })).status, 400);
  assert.equal((await send(people.ada, 'PUT', app.base, url, { webhook_url: BAD_HOOK })).status, 400, 'test message rejected by Slack');

  const ok = await send(people.ada, 'PUT', app.base, url, { webhook_url: HOOK });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.slack, { connected: true, hint: '…XYZ123', available: true });
  assert.ok(!JSON.stringify(ok.body).includes('T000/B000'), 'the full URL is never sent back');
  assert.match(posts.at(-1).body.text, /Greenlight is connected.*Slacky/);

  assert.equal((await send(people.ada, 'DELETE', app.base, url)).body.slack.connected, false);
});

test('approvals and decisions are posted to the channel, with user text escaped', async () => {
  const co = await setupCompany(app, 'Posts');
  await send(co.people.ada, 'PATCH', app.base, `/api/workspaces/${co.ws.id}/members/${co.ids.eli}`, { manager_id: co.ids.mo });
  await send(co.people.ada, 'PUT', app.base, `/api/workspaces/${co.ws.id}/slack`, { webhook_url: HOOK });
  posts.length = 0;

  const r = (await co.people.eli.post(`/api/workspaces/${co.ws.id}/requests`, { type: 'purchase', title: 'Chairs <b>&</b> desks', amount: 300, vendor: 'IKEA' })).body;
  assert.match(posts[0].body.text, /\*Eli Employee\* needs approval from \*Mo Manager\*: <http:\/\/localhost:3000\/app\?ws=\d+&request=\d+\|Chairs &lt;b&gt;&amp;&lt;\/b&gt; desks> · \$300\.00/);

  await co.people.mo.post(`/api/workspaces/${co.ws.id}/requests/${r.id}/decision`, { decision: 'approve' });
  assert.match(posts.at(-1).body.text, /^✅ .* was approved by \*Mo Manager\*/);
});

test('Slack is off in the demo', async () => {
  const c = client(app.base);
  const next = (await c.post('/auth/demo')).body.next;
  const wsId = Number(next.split('=')[1]);
  const res = await send(c, 'PUT', app.base, `/api/workspaces/${wsId}/slack`, { webhook_url: HOOK });
  assert.equal(res.status, 403);
  assert.equal((await c.get(`/api/workspaces/${wsId}/settings`)).body.slack.available, false);
});
