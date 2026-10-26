// All configuration comes from environment variables (see .env.example).

const isProduction = process.env.NODE_ENV === 'production';

const config = {
  isProduction,
  port: Number(process.env.PORT) || 3000,
  appUrl: (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, ''),
  databaseUrl: process.env.DATABASE_URL || '',
  sessionSecret: process.env.SESSION_SECRET || '',
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  },
  sessionDays: 30,
};

// Developer login is only for local work: never in production, and only when Google isn't set up.
config.devLoginEnabled = !isProduction && !config.google.clientId;

function assertProductionConfig() {
  if (!isProduction) return;
  const missing = [];
  if (!config.databaseUrl) missing.push('DATABASE_URL');
  if (config.sessionSecret.length < 32) missing.push('SESSION_SECRET (at least 32 characters)');
  if (!config.google.clientId) missing.push('GOOGLE_CLIENT_ID');
  if (!config.google.clientSecret) missing.push('GOOGLE_CLIENT_SECRET');
  if (missing.length) throw new Error(`Missing production configuration: ${missing.join(', ')}`);
}

module.exports = { config, assertProductionConfig };
