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
  inviteDays: 7,
  // AI classification (Milestone 4). On when ANTHROPIC_API_KEY is set or AI_ENABLED=true; AI_ENABLED=false turns it off.
  ai: {
    enabled: process.env.AI_ENABLED === 'true' || (Boolean(process.env.ANTHROPIC_API_KEY) && process.env.AI_ENABLED !== 'false'),
    model: process.env.AI_MODEL || 'claude-opus-5-5',
  },
  email: {
    // "console" (development: emails are printed and kept in /dev/outbox), "brevo", "resend", or "none"
    // (no emails; Admins copy invite links themselves). Production defaults to "none".
    provider: (process.env.EMAIL_PROVIDER || (isProduction ? 'none' : 'console')).toLowerCase(),
    from: process.env.EMAIL_FROM || '',
    fromName: process.env.EMAIL_FROM_NAME || 'Approval Workflows',
    brevoApiKey: process.env.BREVO_API_KEY || '',
    resendApiKey: process.env.RESEND_API_KEY || '',
  },
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
  if (config.email.provider === 'console') missing.push('EMAIL_PROVIDER (brevo, resend or none; console is for development)');
  if (config.email.provider === 'brevo' && !config.email.brevoApiKey) missing.push('BREVO_API_KEY');
  if (config.email.provider === 'resend' && !config.email.resendApiKey) missing.push('RESEND_API_KEY');
  if (['brevo', 'resend'].includes(config.email.provider) && !config.email.from) missing.push('EMAIL_FROM');
  if (missing.length) throw new Error(`Missing production configuration: ${missing.join(', ')}`);
}

module.exports = { config, assertProductionConfig };
