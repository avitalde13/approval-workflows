// Base currency and exchange rates. Reports and budgets convert every amount to the workspace's base currency.
// Rates are set by an Admin, or fetched from the European Central Bank's daily rates (via frankfurter.dev, no key needed).

const CURRENCIES = ['USD', 'EUR', 'GBP', 'ILS', 'CAD', 'AUD', 'CHF', 'JPY'];
const RATES_URL = 'https://api.frankfurter.dev/v1/latest';

// { base, rates: { EUR: 1.08, ... }, list: [...] } where 1 EUR = 1.08 base.
async function getFx(db, workspaceId) {
  const { rows: [w] } = await db.query('SELECT base_currency FROM workspaces WHERE id = $1', [workspaceId]);
  const base = w?.base_currency || 'USD';
  const { rows } = await db.query('SELECT currency, rate, source, updated_at FROM exchange_rates WHERE workspace_id = $1 ORDER BY currency', [workspaceId]);
  const rates = { [base]: 1 };
  for (const r of rows) if (r.currency !== base) rates[r.currency] = Number(r.rate);
  return { base, rates, list: rows.filter((r) => r.currency !== base).map((r) => ({ ...r, rate: Number(r.rate) })) };
}

// Amount in the base currency, or null when there's no rate for that currency.
function toBase(amount, currency, fx) {
  if (amount == null) return null;
  const rate = fx.rates[currency];
  return rate ? Math.round(amount * rate * 100) / 100 : null;
}

// Fetches today's ECB rates for every supported currency and stores them.
async function refreshRates(db, workspaceId, fetchImpl = fetch) {
  const { base } = await getFx(db, workspaceId);
  const symbols = CURRENCIES.filter((c) => c !== base);
  const res = await fetchImpl(`${RATES_URL}?base=${base}&symbols=${symbols.join(',')}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Exchange rate service error ${res.status}`);
  const data = await res.json();
  let saved = 0;
  for (const [currency, perBase] of Object.entries(data.rates || {})) {
    if (!symbols.includes(currency) || !(Number(perBase) > 0)) continue;
    await setRate(db, workspaceId, currency, 1 / Number(perBase), 'ecb'); // 1 base = perBase currency
    saved++;
  }
  return saved;
}

async function setRate(db, workspaceId, currency, rate, source = 'manual') {
  const rounded = Math.round(rate * 1e8) / 1e8;
  const updated = await db.query('UPDATE exchange_rates SET rate = $1, source = $2, updated_at = NOW() WHERE workspace_id = $3 AND currency = $4',
    [rounded, source, workspaceId, currency]);
  if (!updated.rowCount) {
    await db.query('INSERT INTO exchange_rates (workspace_id, currency, rate, source) VALUES ($1, $2, $3, $4)', [workspaceId, currency, rounded, source]);
  }
}

module.exports = { CURRENCIES, getFx, toBase, refreshRates, setRate };
