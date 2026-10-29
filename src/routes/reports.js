// Spending dashboard and CSV export. Admins see the whole company; Managers see their direct reports and themselves.
//
//   GET /api/workspaces/:id/reports?range=30d|90d|12m|all
//   GET /api/workspaces/:id/reports/export.csv?range=...

const express = require('express');
const { requireUser } = require('../auth/sessions');
const { requireMember } = require('../permissions');

const DAY = 24 * 60 * 60 * 1000;
const RANGES = { '30d': 30, '90d': 90, '12m': 365, all: null };
const MONEY_TYPES = ['purchase', 'expense'];
const CHART_MONTHS = { '30d': 2, '90d': 4, '12m': 12, all: 12 }; // months shown in the monthly chart

// Requests visible to this person for reporting, oldest first.
async function loadRows(pool, req, since) {
  const params = [req.workspaceId];
  let who = '';
  if (req.role !== 'admin') {
    params.push(req.user.id);
    who = ` AND (r.requester_id = $2 OR r.requester_id IN (SELECT user_id FROM memberships WHERE workspace_id = $1 AND manager_id = $2))`;
  }
  let when = '';
  if (since) {
    params.push(since);
    when = ` AND r.created_at >= $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT r.id, r.type, r.title, r.amount, r.currency, r.vendor, r.start_date, r.end_date, r.status, r.created_at, r.decided_at,
            r.requester_id, u.name AS requester_name, u.email AS requester_email, ri.risk_level, ri.category
       FROM requests r JOIN users u ON u.id = r.requester_id LEFT JOIN request_insights ri ON ri.request_id = r.id
      WHERE r.workspace_id = $1${who}${when}
      ORDER BY r.created_at, r.id`,
    params
  );
  return rows.map((r) => ({ ...r, amount: r.amount == null ? null : Number(r.amount) }));
}

const monthKey = (d) => new Date(d).toISOString().slice(0, 7);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
function topBy(rows, key, limit) {
  const totals = new Map();
  for (const r of rows) totals.set(r[key], (totals.get(r[key]) || 0) + r.amount);
  return [...totals].map(([label, total]) => ({ label, total: Math.round(total * 100) / 100 }))
    .sort((a, b) => b.total - a.total).slice(0, limit);
}

// Builds the dashboard from rows. Money is reported in the most-used currency; others are counted separately.
function summarize(rows, { now = new Date(), months = 6 } = {}) {
  const money = rows.filter((r) => MONEY_TYPES.includes(r.type) && r.amount != null);
  const counts = new Map();
  for (const r of money) counts.set(r.currency, (counts.get(r.currency) || 0) + 1);
  const currency = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || 'USD';
  const inCurrency = money.filter((r) => r.currency === currency);
  const approved = inCurrency.filter((r) => r.status === 'approved' && r.decided_at);
  const pending = rows.filter((r) => r.status === 'pending' || r.status === 'changes_requested');
  const decided = rows.filter((r) => ['approved', 'rejected'].includes(r.status) && r.decided_at);
  const thisMonth = monthKey(now);

  // The last `months` calendar months, oldest first, including empty ones.
  const monthly = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = monthKey(d);
    monthly.push({ month: key, total: Math.round(approved.filter((r) => monthKey(r.decided_at) === key).reduce((s, r) => s + r.amount, 0) * 100) / 100 });
  }

  return {
    currency,
    other_currencies: [...counts.keys()].filter((c) => c !== currency),
    kpis: {
      approved_this_month: Math.round(approved.filter((r) => monthKey(r.decided_at) === thisMonth).reduce((s, r) => s + r.amount, 0) * 100) / 100,
      approved_total: Math.round(approved.reduce((s, r) => s + r.amount, 0) * 100) / 100,
      pending_count: pending.length,
      pending_amount: Math.round(pending.filter((r) => r.currency === currency && r.amount != null).reduce((s, r) => s + r.amount, 0) * 100) / 100,
      approval_rate: decided.length ? Math.round((decided.filter((r) => r.status === 'approved').length / decided.length) * 100) : null,
      median_hours_to_decision: decided.length
        ? Math.round(median(decided.map((r) => (new Date(r.decided_at) - new Date(r.created_at)) / 3600000)) * 10) / 10
        : null,
      requests: rows.length,
      high_risk: rows.filter((r) => r.risk_level === 'high').length,
    },
    monthly,
    by_type: MONEY_TYPES.map((type) => ({ label: type, total: Math.round(approved.filter((r) => r.type === type).reduce((s, r) => s + r.amount, 0) * 100) / 100 })),
    top_vendors: topBy(approved.filter((r) => r.vendor), 'vendor', 6),
    top_people: topBy(approved, 'requester_name', 6),
  };
}

// CSV with every field quoted. Cells that a spreadsheet would treat as a formula are prefixed with '.
function toCsv(rows) {
  const cell = (v) => {
    let s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const day = (v) => (v == null ? '' : (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10));
  const header = ['ID', 'Submitted', 'Requester', 'Requester email', 'Type', 'Title', 'Vendor', 'Amount', 'Currency',
    'First day', 'Last day', 'Status', 'Decided', 'Risk', 'Category'];
  const lines = rows.map((r) => [r.id, day(r.created_at), r.requester_name, r.requester_email, r.type, r.title, r.vendor,
    r.amount == null ? '' : r.amount.toFixed(2), r.amount == null ? '' : r.currency, day(r.start_date), day(r.end_date),
    r.status, day(r.decided_at), r.risk_level, r.category].map(cell).join(','));
  return `﻿${[header.map(cell).join(','), ...lines].join('\r\n')}\r\n`; // BOM so Excel reads UTF-8
}

function reportRoutes(pool) {
  const router = express.Router({ mergeParams: true });
  router.use(requireUser, requireMember(pool, 'manager'));

  const since = (req) => {
    const days = RANGES[req.query.range] === undefined ? RANGES['12m'] : RANGES[req.query.range];
    return days ? new Date(Date.now() - days * DAY) : null;
  };

  router.get('/', async (req, res, next) => {
    try {
      const range = RANGES[req.query.range] === undefined ? '12m' : req.query.range;
      const rows = await loadRows(pool, req, since(req));
      res.json({ range, scope: req.role === 'admin' ? 'company' : 'team', ...summarize(rows, { months: CHART_MONTHS[range] }) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/export.csv', async (req, res, next) => {
    try {
      const rows = await loadRows(pool, req, since(req));
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="greenlight-requests-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send(toCsv(rows));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { reportRoutes, summarize, toCsv };
