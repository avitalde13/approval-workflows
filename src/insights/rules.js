// Deterministic anomaly checks. These run on every request, with or without AI, and their
// results can never be lowered by the AI layer.
//
// Each flag: { code, severity: 'low' | 'medium' | 'high', message }

const DAY = 24 * 60 * 60 * 1000;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
// "YYYY-MM-DD" from a DATE value (string or Date, depending on the driver).
const toDay = (v) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);
const normalize = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const fmt = (amount, currency) => {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount); } catch { return `${amount} ${currency}`; }
};

async function detectAnomalies(db, request) {
  if (request.type === 'time_off') return detectTimeOff(db, request);
  const flags = [];
  const { workspace_id: ws, requester_id: who, type, amount, currency, vendor, id } = request;

  // Other requests of the same type and currency (excluding this one and cancelled ones).
  const { rows: past } = await db.query(
    `SELECT id, requester_id, title, amount, vendor, created_at, status
       FROM requests
      WHERE workspace_id = $1 AND type = $2 AND currency = $3 AND id <> $4 AND status <> 'cancelled'`,
    [ws, type, currency, id]
  );
  const amounts = (rows) => rows.map((r) => Number(r.amount)).filter((n) => Number.isFinite(n));

  // 1. Unusually high amount: vs. the requester's own history, or vs. the whole workspace.
  const mine = amounts(past.filter((r) => r.requester_id === who));
  const all = amounts(past);
  if (mine.length >= 3 && amount > 3 * median(mine)) {
    flags.push({ code: 'amount_unusual_for_requester', severity: 'medium',
      message: `${fmt(amount, currency)} is more than 3× this person's typical ${type} (${fmt(median(mine), currency)}).` });
  }
  if (all.length >= 10) {
    const sorted = [...all].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(0.95 * (sorted.length - 1))];
    if (amount > p95 * 1.5) {
      flags.push({ code: 'amount_unusual_for_company', severity: 'high',
        message: `${fmt(amount, currency)} is far above what this company usually spends on a ${type} (95% are under ${fmt(p95, currency)}).` });
    }
  }

  // 2. First-time vendor.
  if (vendor) {
    const seen = past.some((r) => r.vendor && normalize(r.vendor) === normalize(vendor));
    if (!seen) flags.push({ code: 'new_vendor', severity: 'medium', message: `First request with vendor "${vendor}" in this workspace.` });
  }

  // 3. Possible duplicate: same person, same amount, similar title, within 30 days.
  const recentSame = past.filter((r) => r.requester_id === who && Number(r.amount) === amount
    && Date.now() - new Date(r.created_at).getTime() < 30 * DAY
    && (normalize(r.title) === normalize(request.title) || (vendor && normalize(r.vendor) === normalize(vendor))));
  if (recentSame.length) {
    flags.push({ code: 'possible_duplicate', severity: 'high',
      message: `Looks like request #${recentSame[0].id} ("${recentSame[0].title}") from the last 30 days: same amount${vendor ? ' and vendor' : ''}.` });
  }

  // 4. Just under an approval threshold (within 5% below a step's minimum amount).
  const { rows: steps } = await db.query(
    'SELECT name, min_amount FROM approval_steps WHERE workspace_id = $1 AND request_type = $2 AND min_amount IS NOT NULL',
    [ws, type]
  );
  for (const s of steps) {
    const t = Number(s.min_amount);
    if (t > 0 && amount < t && amount >= t * 0.95) {
      flags.push({ code: 'just_below_threshold', severity: 'medium',
        message: `${fmt(amount, currency)} is just under the ${fmt(t, currency)} limit that would require ${s.name} approval.` });
    }

    // 5. Split purchases: same person + vendor within 7 days, each below the threshold, together above it.
    if (vendor && t > 0 && amount < t) {
      const recent = past.filter((r) => r.requester_id === who && r.vendor && normalize(r.vendor) === normalize(vendor)
        && Date.now() - new Date(r.created_at).getTime() < 7 * DAY && Number(r.amount) < t);
      const total = recent.reduce((sum, r) => sum + Number(r.amount), amount);
      if (recent.length && total >= t) {
        flags.push({ code: 'possible_split', severity: 'high',
          message: `Together with ${recent.length} other ${vendor} request(s) this week, the total is ${fmt(total, currency)}, above the ${fmt(t, currency)} ${s.name} limit.` });
      }
    }
  }
  return flags;
}

async function detectTimeOff(db, request) {
  const flags = [];
  const start = toDay(request.start_date);
  const end = toDay(request.end_date);
  const days = Math.round((Date.parse(end) - Date.parse(start)) / DAY) + 1;
  if (days > 21) flags.push({ code: 'long_time_off', severity: 'medium', message: `${days} days in a row is longer than usual.` });

  const { rows } = await db.query(
    `SELECT id, start_date, end_date FROM requests
      WHERE workspace_id = $1 AND requester_id = $2 AND type = 'time_off' AND id <> $3 AND status IN ('pending', 'approved')`,
    [request.workspace_id, request.requester_id, request.id]
  );
  const overlap = rows.find((r) => toDay(r.start_date) <= end && toDay(r.end_date) >= start);
  if (overlap) flags.push({ code: 'overlapping_time_off', severity: 'high', message: `Overlaps time off request #${overlap.id}.` });
  return flags;
}

const LEVEL = { low: 0, medium: 1, high: 2 };
const NAME = ['low', 'medium', 'high'];
// The highest severity among flags (plus any extra levels), or 'low'.
function maxRisk(flags, ...levels) {
  return NAME[Math.max(0, ...flags.map((f) => LEVEL[f.severity] ?? 0), ...levels.map((l) => LEVEL[l] ?? 0))];
}

module.exports = { detectAnomalies, maxRisk };
