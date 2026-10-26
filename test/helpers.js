// Test helpers: a fresh in-memory database and app per test file, and a tiny cookie-keeping HTTP client.

const http = require('http');
const { createPool, migrate } = require('../src/db');
const { createApp } = require('../src/app');
const { createMailer } = require('../src/email/mailer');

async function startApp({ fetchImpl, mailer = createMailer({ provider: 'console' }, { log: () => {} }) } = {}) {
  const pool = createPool('');
  await migrate(pool);
  const server = http.createServer(createApp({ pool, fetchImpl, mailer }));
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${server.address().port}`;
  return { pool, base, mailer, close: () => new Promise((resolve) => server.close(resolve)) };
}

// Acts like one browser: remembers cookies between requests, never follows redirects.
function client(base) {
  const jar = new Map();
  async function request(method, path, { json, headers = {} } = {}) {
    const res = await fetch(base + path, {
      method,
      redirect: 'manual',
      headers: {
        ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        ...headers,
      },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [name, ...rest] = pair.split('=');
      const value = rest.join('=');
      if (!value || /expires=Thu, 01 Jan 1970/i.test(c)) jar.delete(name);
      else jar.set(name, value);
    }
    const text = await res.text();
    let body = text;
    try { body = JSON.parse(text); } catch {}
    return { status: res.status, body, headers: res.headers };
  }
  return {
    jar,
    get: (path, opts) => request('GET', path, opts),
    post: (path, json = {}, opts = {}) => request('POST', path, { ...opts, json }),
  };
}

async function devLogin(base, email, name) {
  const c = client(base);
  const res = await c.post('/auth/dev-login', { email, name });
  if (res.status !== 200) throw new Error(`dev login failed: ${res.status}`);
  return c;
}

module.exports = { startApp, client, devLogin };

// Builds a small company for approval tests. Everyone joins through real invitations.
//   ada   Admin
//   mo    Manager (Eli's manager)
//   eli   Employee (reports to Mo)
//   fin   Employee (Finance lead, approver in chains)
//   vic   Manager (VP, approver in chains)
async function setupCompany(app, name = 'Acme') {
  const { mailer } = app;
  const ada = await devLogin(app.base, `ada@${name.toLowerCase()}.com`, 'Ada Admin');
  const ws = (await ada.post('/api/workspaces', { name })).body;
  const people = { ada };
  const ids = {};
  for (const [key, role, full] of [['mo', 'manager', 'Mo Manager'], ['eli', 'employee', 'Eli Employee'], ['fin', 'employee', 'Fin Finance'], ['vic', 'manager', 'Vic VP']]) {
    const email = `${key}@${name.toLowerCase()}.com`;
    await ada.post(`/api/workspaces/${ws.id}/invitations`, { email, role });
    const mail = mailer.outbox.find((m) => m.to === email);
    const token = mail.text.match(/\/invite\/([A-Za-z0-9_-]+)/)[1];
    people[key] = await devLogin(app.base, email, full);
    const res = await people[key].post(`/api/invitations/${token}/accept`);
    if (res.status !== 200) throw new Error(`accept failed for ${email}`);
  }
  const members = (await ada.get(`/api/workspaces/${ws.id}`)).body.members;
  for (const m of members) ids[m.email.split('@')[0]] = m.id;
  return { ws, people, ids };
}

// PATCH/DELETE with the client's cookies (the small client only has get/post).
async function send(c, method, base, path, json) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: [...c.jar].map(([k, v]) => `${k}=${v}`).join('; ') },
    body: JSON.stringify(json || {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

module.exports.setupCompany = setupCompany;
module.exports.send = send;
