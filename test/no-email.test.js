// Running without an email provider: invitations return their link, and the legal pages are public.

delete process.env.GOOGLE_CLIENT_ID;
delete process.env.NODE_ENV;
process.env.APP_URL = 'http://localhost:3000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, client, devLogin } = require('./helpers');
const { createMailer } = require('../src/email/mailer');

let app;
test.before(async () => { app = await startApp({ mailer: createMailer({ provider: 'none' }) }); });
test.after(() => app.close());

test('without email, the Admin gets the invite link and it works', async () => {
  const admin = await devLogin(app.base, 'ada@acme.com', 'Ada Admin');
  const ws = (await admin.post('/api/workspaces', { name: 'Acme' })).body;
  const res = await admin.post(`/api/workspaces/${ws.id}/invitations`, { email: 'ben@acme.com', role: 'employee' });
  assert.equal(res.status, 201);
  assert.equal(res.body.emailed, false);
  const token = res.body.link.match(/^http:\/\/localhost:3000\/invite\/([A-Za-z0-9_-]+)$/)?.[1];
  assert.ok(token, 'response has an invite link');

  const ben = await devLogin(app.base, 'ben@acme.com', 'Ben');
  const accepted = await ben.post(`/api/invitations/${token}/accept`);
  assert.equal(accepted.status, 200);
});

test('Privacy and Terms pages are public', async () => {
  const anon = client(app.base);
  for (const [path, title] of [['/privacy', 'Privacy Policy'], ['/terms', 'Terms of Service']]) {
    const res = await anon.get(path);
    assert.equal(res.status, 200);
    assert.match(res.body, new RegExp(`<h1>${title}</h1>`));
  }
});
