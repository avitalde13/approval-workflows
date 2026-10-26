// Builds the Express app. Kept separate from server.js so tests can create it with their own database.

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { config } = require('./config');
const { loadSession } = require('./auth/sessions');
const { authRoutes } = require('./auth/routes');
const { apiRoutes } = require('./routes/api');

// Blocks cross-site form posts (CSRF): state-changing requests must be JSON and come from our own origin.
function sameOriginJsonOnly(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  const own = [config.appUrl, `${req.protocol}://${req.get('host')}`];
  if (origin && !own.includes(origin)) return res.status(403).json({ error: 'Cross-site request blocked.' });
  if (!req.is('application/json')) return res.status(415).json({ error: 'Send JSON (Content-Type: application/json).' });
  next();
}

function createApp({ pool, fetchImpl = fetch } = {}) {
  const app = express();
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
  app.use('/auth', sameOriginJsonOnly, authRoutes(pool, { fetchImpl, stateSecret }));
  app.use('/api', sameOriginJsonOnly, apiRoutes(pool));

  const page = (file) => (req, res) => res.sendFile(path.join(__dirname, '..', 'public', file));
  app.get('/', (req, res, next) => (req.user ? res.redirect('/app') : page('index.html')(req, res, next)));
  app.get('/app', (req, res, next) => (req.user ? page('app.html')(req, res, next) : res.redirect('/')));
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });
  return app;
}

module.exports = { createApp };
