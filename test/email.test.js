// Email providers and the approval notification templates.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMailer } = require('../src/email/mailer');
const templates = require('../src/email/templates');

test('console provider keeps emails in the outbox, newest first', async () => {
  const mailer = createMailer({ provider: 'console' }, { log: () => {} });
  await mailer.send({ to: 'a@x.com', subject: 'One', text: '1' });
  await mailer.send({ to: 'b@x.com', subject: 'Two', text: '2' });
  assert.deepEqual(mailer.outbox.map((m) => m.subject), ['Two', 'One']);
});

test('Brevo provider sends the right request', async () => {
  let call;
  const mailer = createMailer(
    { provider: 'brevo', from: 'no-reply@acme.com', fromName: 'Greenlight', brevoApiKey: 'xkeysib-test' },
    { fetchImpl: async (url, options) => { call = { url, options }; return Response.json({ messageId: 'm1' }); } }
  );
  await mailer.send({ to: 'ben@acme.com', subject: 'Hi', text: 'Hello', html: '<p>Hello</p>' });
  assert.equal(call.url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(call.options.headers['api-key'], 'xkeysib-test');
  assert.deepEqual(JSON.parse(call.options.body), {
    sender: { name: 'Greenlight', email: 'no-reply@acme.com' },
    to: [{ email: 'ben@acme.com' }], subject: 'Hi', textContent: 'Hello', htmlContent: '<p>Hello</p>',
  });
});

test('Resend provider sends the right request', async () => {
  let call;
  const mailer = createMailer(
    { provider: 'resend', from: 'no-reply@acme.com', fromName: 'AW', resendApiKey: 're_test' },
    { fetchImpl: async (url, options) => { call = { url, options }; return Response.json({ id: 'e1' }); } }
  );
  await mailer.send({ to: 'ben@acme.com', subject: 'Hi', text: 'Hello' });
  assert.equal(call.url, 'https://api.resend.com/emails');
  assert.equal(call.options.headers.Authorization, 'Bearer re_test');
  assert.equal(JSON.parse(call.options.body).from, 'AW <no-reply@acme.com>');
});

test('provider errors are reported', async () => {
  const mailer = createMailer(
    { provider: 'brevo', from: 'x@y.com', brevoApiKey: 'k' },
    { fetchImpl: async () => new Response('bad sender', { status: 400 }) }
  );
  await assert.rejects(mailer.send({ to: 'a@b.com', subject: 's', text: 't' }), /Brevo error 400/);
});

test('approval-needed email', () => {
  const m = templates.approvalNeeded({
    workspaceName: 'Acme', requesterName: 'Ben', requestTitle: 'New laptop', amount: 1899.5, currency: 'USD',
    link: 'https://app.example.com/requests/42',
  });
  assert.equal(m.subject, 'Approval needed: New laptop ($1,899.50)');
  assert.match(m.text, /Ben submitted "New laptop" \(\$1,899\.50\) in Acme/);
  assert.match(m.html, /Review request/);
  assert.match(m.html, /https:\/\/app\.example\.com\/requests\/42/);
});

test('status-changed emails for approved, rejected and next step', () => {
  const base = { workspaceName: 'Acme', requestTitle: 'Team offsite', actorName: 'Dana', link: 'https://x/r/1' };
  assert.equal(templates.requestStatusChanged({ ...base, status: 'approved' }).subject, 'Your request "Team offsite" was approved');
  const rejected = templates.requestStatusChanged({ ...base, status: 'rejected', comment: 'Over budget <b>' });
  assert.equal(rejected.subject, 'Your request "Team offsite" was rejected');
  assert.match(rejected.text, /Comment: Over budget <b>/);
  assert.match(rejected.html, /Over budget &lt;b&gt;/);
  assert.equal(templates.requestStatusChanged({ ...base, status: 'advanced' }).subject, 'Your request "Team offsite" was approved by Dana');
});

test('templates escape user text in HTML', () => {
  const m = templates.invitation({
    workspaceName: '<script>x</script>', inviterName: 'A & B', role: 'employee',
    link: 'https://x/invite/t', expiresAt: new Date('2026-11-02T00:00:00Z'),
  });
  assert.doesNotMatch(m.html, /<script>/);
  assert.match(m.html, /A &amp; B/);
  assert.match(m.text, /expires on November 2, 2026/);
});
