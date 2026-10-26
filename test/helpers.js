// Test helpers: a fresh in-memory database and app per test file, and a tiny cookie-keeping HTTP client.

const http = require('http');
const { createPool, migrate } = require('../src/db');
const { createApp } = require('../src/app');

async function startApp({ fetchImpl } = {}) {
  const pool = createPool('');
  await migrate(pool);
  const server = http.createServer(createApp({ pool, fetchImpl }));
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${server.address().port}`;
  return { pool, base, close: () => new Promise((resolve) => server.close(resolve)) };
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
