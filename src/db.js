// Database pool and migrations.
// With DATABASE_URL: real PostgreSQL. Without it (local development and tests): in-memory pg-mem.

const fs = require('fs');
const path = require('path');
const { config } = require('./config');

function createPool(databaseUrl = config.databaseUrl) {
  if (databaseUrl) {
    const { Pool } = require('pg');
    const local = /localhost|127\.0\.0\.1|\.railway\.internal/.test(databaseUrl);
    return new Pool({ connectionString: databaseUrl, ssl: local ? false : { rejectUnauthorized: false } });
  }
  const { newDb } = require('pg-mem');
  const { Pool } = newDb().adapters.createPg();
  return new Pool();
}

// Applies every migrations/*.sql file not yet recorded in schema_migrations, in name order.
async function migrate(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  const { rows } = await pool.query('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    await pool.query(fs.readFileSync(path.join(dir, file), 'utf8'));
    await pool.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
  }
}

module.exports = { createPool, migrate };
