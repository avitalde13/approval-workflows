const { config, assertProductionConfig } = require('./config');
const { createPool, migrate } = require('./db');
const { createApp } = require('./app');

async function main() {
  assertProductionConfig();
  if (!config.databaseUrl) console.warn('DATABASE_URL not set: using an in-memory database (data resets on restart).');
  if (config.devLoginEnabled) console.warn('Developer login is ON (no GOOGLE_CLIENT_ID). Never use this in production.');
  const pool = createPool();
  await migrate(pool);
  createApp({ pool }).listen(config.port, () => console.log(`Approval Workflows running on ${config.appUrl}`));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
