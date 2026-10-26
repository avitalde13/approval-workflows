// Milestone 2: inviting people by email and accepting invitations.

delete process.env.GOOGLE_CLIENT_ID;
delete process.env.NODE_ENV;
process.env.APP_URL = 'http://localhost:3000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, client, devLogin } = require('./helpers');

let app;
test.before(async () => { app = await startApp(); });
test.after(() => app.close());

// The invite link from the newest email sent to `to`.
function lastInviteToken(to) {
  const mail = app.mailer.outbox.find((m) => m.to === to);
  assert.ok(mail, `no email to ${to}`);
  const match = mail.text.match(/http:\/\/localhost:3000\/invite\/([A-Za-z0-9_-]+)/);
  assert.ok(match, 'email has no invite link');
  return match[1];
}

async function adminWithWorkspace(email, name = 'Acme') {
  const admin = await devLogin(app.base, email, 'Ada Admin');
  const ws = (await admin.post('/api/workspaces', { name })).body;
  return { admin, ws };
}

test('an Admin invites someone and the email contains a working link', async () => {
  const { admin, ws } = await adminWithWorkspace('ada@acme.com');
  const res = await admin.post(`/api/workspaces/${ws.id}/invitations`, { email: 'Ben@Acme.com', role: 'manager' });
  assert.equal(res.status, 201);
  assert.equal(res.body.email, 'ben@acme.com');
  assert.equal(res.body.role, 'manager');

  const mail = app.mailer.outbox[0];
  assert.equal(mail.to, 'ben@acme.com');
  assert.equal(mail.subject, 'Ada Admin invited you to Acme on Approval Workflows');
  assert.match(mail.text, /as Manager/);
  assert.match(mail.html, /Accept invitation/);

  const list = await admin.get(`/api/workspaces/${ws.id}/invitations`);
  assert.deepEqual(list.body.invitations.map((i) => i.email), ['ben@acme.com']);

  // The link shows the invitation to anyone who has it, even before signing in.
  const token = lastInviteToken('ben@acme.com');
  const info = await client(app.base).get(`/auth/invitations/${token}`);
  assert.equal(info.status, 200);
  assert.equal(info.body.state, 'pending');
  assert.equal(info.body.workspace_name, 'Acme');
  assert.equal(info.body.inviter_name, 'Ada Admin');
});

test('the invitee signs in and accepts, joining with the invited role', async () => {
  const { admin, ws } = await adminWithWorkspace('owner2@acme.com', 'Acme Two');
  await admin.post(`/api/workspaces/${ws.id}/invitations`, { email: 'carol@acme.com', role: 'manager' });
  const token = lastInviteToken('carol@acme.com');

  const carol = await devLogin(app.base, 'carol@acme.com', 'Carol');
  const accepted = await carol.post(`/api/invitations/${token}/accept`);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.workspace_id, ws.id);

  const me = await carol.get('/api/me');
  assert.deepEqual(me.body.workspaces.map((w) => [w.name, w.role]), [['Acme Two', 'manager']]);
  const members = await admin.get(`/api/workspaces/${ws.id}`);
  assert.deepEqual(members.body.members.map((m) => m.email).sort(), ['carol@acme.com', 'owner2@acme.com']);

  // Used invitations disappear from the pending list and can't be used twice.
  assert.equal((await admin.get(`/api/workspaces/${ws.id}/invitations`)).body.invitations.length, 0);
  assert.equal((await carol.post(`/api/invitations/${token}/accept`)).status, 410);
  assert.equal((await client(app.base).get(`/auth/invitations/${token}`)).body.state, 'accepted');
});

test('only the invited email can accept', async () => {
  const { admin, ws } = await adminWithWorkspace('owner3@acme.com');
  await admin.post(`/api/workspaces/${ws.id}/invitations`, { email: 'dan@acme.com' });
  const token = lastInviteToken('dan@acme.com');
  const eve = await devLogin(app.base, 'eve@evil.com');
  const res = await eve.post(`/api/invitations/${token}/accept`);
  assert.equal(res.status, 403);
  assert.match(res.body.error, /dan@acme\.com/);
  assert.equal((await eve.get('/api/me')).body.workspaces.length, 0);
});

test('accepting requires sign-in', async () => {
  const { admin, ws } = await adminWithWorkspace('owner4@acme.com');
  await admin.post(`/api/workspaces/${ws.id}/invitations`, { email: 'fay@acme.com' });
  const res = await client(app.base).post(`/api/invitations/${lastInviteToken('fay@acme.com')}/accept`);
  assert.equal(res.status, 401);
});

test('only Admins can invite; other companies get 404', async () => {
  const { admin, ws } = await adminWithWorkspace('owner5@acme.com');
  await admin.post(`/api/workspaces/${ws.id}/invitations`, { email: 'gil@acme.com', role: 'employee' });
  const gil = await devLogin(app.base, 'gil@acme.com');
  await gil.post(`/api/invitations/${lastInviteToken('gil@acme.com')}/accept`);

  const asEmployee = await gil.post(`/api/workspaces/${ws.id}/invitations`, { email: 'x@acme.com' });
  assert.equal(asEmployee.status, 403);
  assert.equal((await gil.get(`/api/workspaces/${ws.id}/invitations`)).status, 403);

  const outsider = await devLogin(app.base, 'outsider@globex.com');
  assert.equal((await outsider.post(`/api/workspaces/${ws.id}/invitations`, { email: 'y@acme.com' })).status, 404);
});

test('invitation input is validated, and members are not re-invited', async () => {
  const { admin, ws } = await adminWithWorkspace('owner6@acme.com');
  const url = `/api/workspaces/${ws.id}/invitations`;
  assert.equal((await admin.post(url, { email: 'nope' })).status, 400);
  assert.equal((await admin.post(url, { email: 'ok@acme.com', role: 'king' })).status, 400);
  const self = await admin.post(url, { email: 'OWNER6@acme.com' });
  assert.equal(self.status, 409);
});

test('re-inviting replaces the old link; revoking disables it', async () => {
  const { admin, ws } = await adminWithWorkspace('owner7@acme.com');
  const url = `/api/workspaces/${ws.id}/invitations`;
  await admin.post(url, { email: 'hila@acme.com' });
  const first = lastInviteToken('hila@acme.com');
  await admin.post(url, { email: 'hila@acme.com', role: 'manager' });
  const second = lastInviteToken('hila@acme.com');
  assert.notEqual(first, second);
  assert.equal((await client(app.base).get(`/auth/invitations/${first}`)).body.state, 'revoked');

  const pending = (await admin.get(url)).body.invitations;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].role, 'manager');

  const del = await fetch(`${app.base}${url}/${pending[0].id}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', Cookie: [...admin.jar].map(([k, v]) => `${k}=${v}`).join('; ') },
    body: '{}',
  });
  assert.equal(del.status, 200);
  assert.equal((await client(app.base).get(`/auth/invitations/${second}`)).body.state, 'revoked');
  const hila = await devLogin(app.base, 'hila@acme.com');
  assert.equal((await hila.post(`/api/invitations/${second}/accept`)).status, 410);
});

test('expired invitations cannot be used', async () => {
  const { admin, ws } = await adminWithWorkspace('owner8@acme.com');
  await admin.post(`/api/workspaces/${ws.id}/invitations`, { email: 'ido@acme.com' });
  const token = lastInviteToken('ido@acme.com');
  await app.pool.query("UPDATE invitations SET expires_at = NOW() - INTERVAL '1 minute' WHERE email = 'ido@acme.com'");
  assert.equal((await client(app.base).get(`/auth/invitations/${token}`)).body.state, 'expired');
  const ido = await devLogin(app.base, 'ido@acme.com');
  assert.equal((await ido.post(`/api/invitations/${token}/accept`)).status, 410);
});

test('unknown or malformed invitation links return 404', async () => {
  assert.equal((await client(app.base).get('/auth/invitations/abcdefghijklmnopqrstuvwxyz123')).status, 404);
  assert.equal((await client(app.base).get('/auth/invitations/%3Cscript%3E')).status, 404);
});

test('invite tokens are stored hashed', async () => {
  const { admin, ws } = await adminWithWorkspace('owner9@acme.com');
  await admin.post(`/api/workspaces/${ws.id}/invitations`, { email: 'jo@acme.com' });
  const token = lastInviteToken('jo@acme.com');
  const raw = await app.pool.query('SELECT 1 FROM invitations WHERE token_hash = $1', [token]);
  assert.equal(raw.rows.length, 0);
});

test('after signing in, people return to the invite page (and only to local pages)', async () => {
  const c = client(app.base);
  const ok = await c.post('/auth/dev-login', { email: 'kim@acme.com', next: '/invite/abc123' });
  assert.equal(ok.body.next, '/invite/abc123');
  for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)']) {
    const res = await client(app.base).post('/auth/dev-login', { email: 'kim@acme.com', next: bad });
    assert.equal(res.body.next, '/app', `should reject ${bad}`);
  }
});

test('the dev outbox shows sent emails, escaped', async () => {
  const { admin, ws } = await adminWithWorkspace('owner10@acme.com', '<b>Bold & Co</b>');
  await admin.post(`/api/workspaces/${ws.id}/invitations`, { email: 'lee@acme.com' });
  const mail = app.mailer.outbox.find((m) => m.to === 'lee@acme.com');
  assert.match(mail.html, /&lt;b&gt;Bold &amp; Co&lt;\/b&gt;/);
  const page = await client(app.base).get('/dev/outbox');
  assert.equal(page.status, 200);
  assert.match(page.body, /lee@acme\.com/);
});
