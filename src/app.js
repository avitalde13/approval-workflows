// Builds the Express app. Kept separate from server.js so tests can create it with their own database.

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { config } = require('./config');
const { loadSession } = require('./auth/sessions');
const { authRoutes } = require('./auth/routes');
const { apiRoutes } = require('./routes/api');
const { invitationRoutes } = require('./routes/invitations');
const { memberRoutes } = require('./routes/members');
const { chainRoutes } = require('./routes/chains');
const { requestRoutes } = require('./routes/requests');
const { auditRoutes } = require('./routes/audit');
const { createClassifier } = require('./insights/ai');
const { createMailer } = require('./email/mailer');
const { escapeHtml } = require('./email/templates');

// Blocks cross-site form posts (CSRF): state-changing requests must be JSON and come from our own origin.
function sameOriginJsonOnly(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  const own = [config.appUrl, `${req.protocol}://${req.get('host')}`];
  if (origin && !own.includes(origin)) return res.status(403).json({ error: 'Cross-site request blocked.' });
  if (!req.is('application/json')) return res.status(415).json({ error: 'Send JSON (Content-Type: application/json).' });
  next();
}

function createApp({
  pool,
  fetchImpl = fetch,
  mailer = createMailer(config.email, { fetchImpl }),
  classifier = config.ai.enabled ? createClassifier({ model: config.ai.model }) : null,
} = {}) {
  const app = express();

  // Background AI work. Tests call app.locals.waitForInsights() to wait for it.
  const pending = new Set();
  const track = (promise) => {
    pending.add(promise);
    promise.finally(() => pending.delete(promise));
    return promise;
  };
  app.locals.waitForInsights = () => Promise.all([...pending]);
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    res.set('X-Frame-Options', 'DENY');
    next();
  });
  app.use(express.json({ limit: '100kb' }));
  app.use(loadSession(pool));

  const stateSecret = config.sessionSecret || crypto.randomBytes(32).toString('hex');
  const invites = invitationRoutes(pool, mailer);
  app.use('/auth', sameOriginJsonOnly, authRoutes(pool, { fetchImpl, stateSecret }), invites.publicRouter);
  app.use('/api/workspaces/:id/invitations', sameOriginJsonOnly, invites.admin);
  app.use('/api/invitations', sameOriginJsonOnly, invites.accept);
  app.use('/api/workspaces/:id/members', sameOriginJsonOnly, memberRoutes(pool));
  app.use('/api/workspaces/:id/approval-chains', sameOriginJsonOnly, chainRoutes(pool));
  app.use('/api/workspaces/:id/requests', sameOriginJsonOnly, requestRoutes(pool, mailer, { classifier, track }));
  app.use('/api/workspaces/:id/audit-log', sameOriginJsonOnly, auditRoutes(pool));
  app.use('/api', sameOriginJsonOnly, apiRoutes(pool));

  const page = (file) => (req, res) => res.sendFile(path.join(__dirname, '..', 'public', file));
  app.get('/', (req, res, next) => (req.user ? res.redirect('/app') : page('index.html')(req, res, next)));
  app.get('/app', (req, res, next) => (req.user ? page('app.html')(req, res, next) : res.redirect('/')));
  app.get('/invite/:token', page('invite.html'));
  app.get('/privacy', page('legal/privacy.html'));
  app.get('/terms', page('legal/terms.html'));

  // Development only: read the emails the app "sent" (EMAIL_PROVIDER=console).
  if (!config.isProduction && mailer.provider === 'console') {
    app.get('/dev/outbox', (req, res) => {
      const items = mailer.outbox
        .map((m) => `<article style="border:1px solid #e5e7eb;border-radius:12px;margin:0 0 16px;overflow:hidden">
          <div style="padding:10px 14px;background:#f6f7fb;font:14px sans-serif"><b>To:</b> ${escapeHtml(m.to)} · <b>Subject:</b> ${escapeHtml(m.subject)} · ${escapeHtml(m.sentAt)}</div>
          <iframe sandbox srcdoc="${escapeHtml(m.html || '')}" style="width:100%;height:340px;border:0"></iframe></article>`)
        .join('');
      res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Dev outbox</title>
        <body style="max-width:760px;margin:24px auto;padding:0 16px;font-family:sans-serif;background:#fff;color:#111827;color-scheme:light"><h1>Dev outbox</h1>
        <p>Emails the app sent in this run (newest first). Nothing was really sent.</p>${items || '<p>No emails yet.</p>'}</body>`);
    });
  }
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });
  return app;
}

module.exports = { createApp };
