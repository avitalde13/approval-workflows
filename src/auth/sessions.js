// Server-side sessions. The browser holds a random token in an HTTP-only cookie;
// the database stores only its SHA-256 hash, so a database leak doesn't leak live sessions.

const crypto = require('crypto');
const { config } = require('../config');
const { readCookie } = require('./cookies');

const COOKIE = 'sid';
const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');

async function createSession(pool, userId, expiresAt = new Date(Date.now() + config.sessionDays * 24 * 60 * 60 * 1000)) {
  const token = crypto.randomBytes(32).toString('base64url');
  await pool.query('INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)', [hash(token), userId, expiresAt]);
  return { token, expiresAt };
}

function setSessionCookie(req, res, { token, expiresAt }) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure: req.secure,
    sameSite: 'lax', // "lax" so the cookie survives the redirect back from Google
    expires: expiresAt,
    path: '/',
  });
}

// Middleware: sets req.user (or null) and req.sessionId from the session cookie.
function loadSession(pool) {
  return async (req, res, next) => {
    req.user = null;
    const token = readCookie(req, COOKIE);
    if (!token) return next();
    try {
      const { rows } = await pool.query(
        `SELECT s.id AS session_id, u.id, u.email, u.name, u.avatar_url, u.is_demo
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.id = $1 AND s.expires_at > NOW()`,
        [hash(token)]
      );
      if (rows[0]) {
        const { session_id: sessionId, ...user } = rows[0];
        req.user = user;
        req.sessionId = sessionId;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

async function destroySession(pool, req, res) {
  if (req.sessionId) await pool.query('DELETE FROM sessions WHERE id = $1', [req.sessionId]);
  res.clearCookie(COOKIE, { path: '/' });
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
  next();
}

module.exports = { createSession, setSessionCookie, loadSession, destroySession, requireUser };
