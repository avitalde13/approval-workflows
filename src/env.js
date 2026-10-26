// Loads KEY=value lines from a .env file in the project root, if there is one.
// Variables already set in the environment win. Works on every Node version
// (Node's own --env-file-if-exists flag needs Node 22.9+).

const fs = require('fs');
const path = require('path');

function loadEnvFile(file = path.join(__dirname, '..', '.env')) {
  if (process.env.NODE_ENV === 'test' || !fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || line.trim().startsWith('#')) continue;
    const [, key, raw] = match;
    const value = raw.replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

module.exports = { loadEnvFile };
