require('./env').loadEnvFile(); // before config is read
const { config, assertProductionConfig } = require('./config');
const { createPool, migrate } = require('./db');
const { createApp } = require('./app');
const { cleanupDemos } = require('./demo');

async function main() {
  assertProductionConfig();
  if (!config.databaseUrl) console.warn('DATABASE_URL not set: using an in-memory database (data resets on restart).');
  console.log(config.ai.enabled ? `AI classification: on (${config.ai.model})` : 'AI classification: off (set ANTHROPIC_API_KEY to turn it on)');
  if (config.devLoginEnabled) console.warn('Developer login is ON (no GOOGLE_CLIENT_ID). Never use this in production.');
  const pool = createPool();
  await migrate(pool);
  // Expired demo companies are deleted every hour.
  const cleanup = () => cleanupDemos(pool).catch((err) => console.error('Demo cleanup failed:', err.message));
  cleanup();
  setInterval(cleanup, 60 * 60 * 1000).unref();
  createApp({ pool }).listen(config.port, () => console.log(`Greenlight running on ${config.appUrl}`));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
