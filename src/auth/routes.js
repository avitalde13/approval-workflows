// Sign-in routes: Google OAuth 2.0 (authorization code flow with PKCE), developer login, logout.

const crypto = require('crypto');
const express = require('express');
const { config } = require('../config');
const { readCookie, sign, unsign } = require('./cookies');
const { createSession, setSessionCookie, destroySession } = require('./sessions');

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const OAUTH_COOKIE = 'oauth_state';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const redirectUri = () => `${config.appUrl}/auth/google/callback`;

// Where to go after signing in. Only local paths are allowed, so the link can't send people to another site.
function safeNext(next) {
  return typeof next === 'string' && /^\/(?![\/\\])[\w\-./?=&%]*$/.test(next) && next.length <= 300 ? next : '/app';
}

// Finds the user by Google id, or links an existing account with the same (verified) email, or creates one.
async function upsertGoogleUser(pool, profile) {
  const email = profile.email.toLowerCase();
  const name = (profile.name || email.split('@')[0]).slice(0, 120);
  const avatar = profile.picture || null;
  const bySub = await pool.query('SELECT id FROM users WHERE google_sub = $1', [profile.sub]);
  if (bySub.rows[0]) {
    await pool.query('UPDATE users SET email = $1, name = $2, avatar_url = $3 WHERE id = $4', [email, name, avatar, bySub.rows[0].id]);
    return bySub.rows[0].id;
  }
  const byEmail = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (byEmail.rows[0]) {
    await pool.query('UPDATE users SET google_sub = $1, name = $2, avatar_url = $3 WHERE id = $4', [profile.sub, name, avatar, byEmail.rows[0].id]);
    return byEmail.rows[0].id;
  }
  const created = await pool.query(
    'INSERT INTO users (google_sub, email, name, avatar_url) VALUES ($1, $2, $3, $4) RETURNING id',
    [profile.sub, email, name, avatar]
  );
  return created.rows[0].id;
}

function authRoutes(pool, { fetchImpl = fetch, stateSecret }) {
  const router = express.Router();

  router.get('/config', (req, res) => {
    res.json({ google: Boolean(config.google.clientId), devLogin: config.devLoginEnabled });
  });

  // Step 1: send the user to Google.
  router.get('/google', (req, res) => {
    if (!config.google.clientId) return res.redirect('/?error=google_not_configured');
    const state = crypto.randomBytes(16).toString('base64url');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const next = safeNext(req.query.next);
    const payload = Buffer.from(JSON.stringify({ state, verifier, next, t: Date.now() })).toString('base64url');
    res.cookie(OAUTH_COOKIE, sign(payload, stateSecret), {
      httpOnly: true, secure: req.secure, sameSite: 'lax', maxAge: 10 * 60 * 1000, path: '/auth',
    });
    const params = new URLSearchParams({
      client_id: config.google.clientId,
      redirect_uri: redirectUri(),
      response_type: 'code',
      scope: 'openid email profile',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    res.redirect(`${GOOGLE_AUTH_URL}?${params}`);
  });

  // Step 2: Google sends the user back with a one-time code.
  router.get('/google/callback', async (req, res) => {
    const fail = (reason, detail = '') => {
      console.warn(`Google sign-in failed: ${reason}${detail ? ` (${detail})` : ''}`);
      res.clearCookie(OAUTH_COOKIE, { path: '/auth' });
      res.redirect(`/?error=${encodeURIComponent(reason)}`);
    };
    try {
      if (req.query.error) return fail('google_denied', String(req.query.error).slice(0, 100));
      const raw = unsign(readCookie(req, OAUTH_COOKIE), stateSecret);
      if (!raw) return fail('state_missing');
      const saved = JSON.parse(Buffer.from(raw, 'base64url').toString());
      if (Date.now() - saved.t > 10 * 60 * 1000) return fail('state_expired');
      if (typeof req.query.state !== 'string' || req.query.state !== saved.state) return fail('state_mismatch');
      if (typeof req.query.code !== 'string') return fail('code_missing');

      const tokenRes = await fetchImpl(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: req.query.code,
          client_id: config.google.clientId,
          client_secret: config.google.clientSecret,
          redirect_uri: redirectUri(),
          grant_type: 'authorization_code',
          code_verifier: saved.verifier,
        }),
      });
      if (!tokenRes.ok) {
        // Google's error code only (e.g. invalid_client, redirect_uri_mismatch), never tokens or secrets.
        const body = await tokenRes.json().catch(() => ({}));
        return fail('token_exchange_failed', `${tokenRes.status} ${body.error || ''} ${body.error_description || ''}`.trim().slice(0, 200));
      }
      const { access_token: accessToken } = await tokenRes.json();

      const infoRes = await fetchImpl(GOOGLE_USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!infoRes.ok) return fail('profile_failed', String(infoRes.status));
      const profile = await infoRes.json();
      if (!profile.sub || !profile.email || profile.email_verified !== true) return fail('email_not_verified');

      const userId = await upsertGoogleUser(pool, profile);
      setSessionCookie(req, res, await createSession(pool, userId));
      res.clearCookie(OAUTH_COOKIE, { path: '/auth' });
      res.redirect(safeNext(saved.next));
    } catch (err) {
      console.error('Google sign-in failed:', err);
      fail('server_error');
    }
  });

  // Local development only: sign in as any email, no Google needed.
  router.post('/dev-login', async (req, res, next) => {
    if (!config.devLoginEnabled) return res.status(404).json({ error: 'Not found.' });
    try {
      const email = String(req.body?.email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email.' });
      const name = String(req.body?.name || '').trim().slice(0, 120) || email.split('@')[0];
      const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
      const userId = existing.rows[0]
        ? existing.rows[0].id
        : (await pool.query('INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id', [email, name])).rows[0].id;
      setSessionCookie(req, res, await createSession(pool, userId));
      res.json({ ok: true, next: safeNext(req.body?.next) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', async (req, res, next) => {
    try {
      await destroySession(pool, req, res);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { authRoutes, safeNext };
