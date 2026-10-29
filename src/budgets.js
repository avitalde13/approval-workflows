// Department budgets: how much of this month's / quarter's / year's budget is approved or waiting.

const { getFx, toBase } = require('./currency');

// Start of the current budget period (UTC).
function periodStart(period, now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  if (period === 'month') return new Date(Date.UTC(y, m, 1));
  if (period === 'year') return new Date(Date.UTC(y, 0, 1));
  return new Date(Date.UTC(y, m - (m % 3), 1));
}

// Usage for every department of a workspace (optionally excluding one request, e.g. the one being checked).
async function budgetUsage(db, workspaceId, { now = new Date(), excludeRequestId = null, fx = null } = {}) {
  fx = fx || (await getFx(db, workspaceId));
  const { rows: departments } = await db.query(
    'SELECT id, name, budget_amount, budget_period FROM departments WHERE workspace_id = $1 ORDER BY name', [workspaceId]);
  const { rows: requests } = await db.query(
    `SELECT id, department_id, amount, currency, status, created_at, decided_at FROM requests
      WHERE workspace_id = $1 AND department_id IS NOT NULL AND type IN ('purchase', 'expense')
        AND status IN ('approved', 'pending', 'changes_requested')`, [workspaceId]);
  return departments.map((d) => {
    const start = periodStart(d.budget_period, now);
    let spent = 0;
    let pending = 0;
    for (const r of requests) {
      if (r.department_id !== d.id || r.id === excludeRequestId) continue;
      const amount = toBase(Number(r.amount), r.currency, fx);
      if (amount == null) continue;
      if (r.status === 'approved' && new Date(r.decided_at) >= start) spent += amount;
      else if (r.status !== 'approved') pending += amount;
    }
    const budget = d.budget_amount == null ? null : Number(d.budget_amount);
    return {
      id: d.id, name: d.name, budget, period: d.budget_period, period_start: start.toISOString().slice(0, 10),
      spent: Math.round(spent * 100) / 100, pending: Math.round(pending * 100) / 100,
      used_pct: budget ? Math.round((spent / budget) * 100) : null,
    };
  });
}

// After a request is approved: tell the Admins when its department just passed 80% or 100% of its budget.
async function budgetAlert(db, notifier, requestId) {
  try {
    const { rows: [r] } = await db.query('SELECT id, workspace_id, department_id, amount, currency, title FROM requests WHERE id = $1', [requestId]);
    if (!r?.department_id || r.amount == null) return;
    const fx = await getFx(db, r.workspace_id);
    const dept = (await budgetUsage(db, r.workspace_id, { fx })).find((d) => d.id === r.department_id);
    const amount = toBase(Number(r.amount), r.currency, fx);
    if (!dept?.budget || amount == null) return;
    const before = dept.spent - amount;
    const line = [1, 0.8].find((x) => before < dept.budget * x && dept.spent >= dept.budget * x);
    if (!line) return;
    const admins = await db.query("SELECT user_id FROM memberships WHERE workspace_id = $1 AND role = 'admin'", [r.workspace_id]);
    const title = line === 1
      ? `${dept.name} is over its ${dept.period}ly budget (${dept.used_pct}% used)`
      : `${dept.name} has used ${dept.used_pct}% of its ${dept.period}ly budget`;
    for (const a of admins.rows) {
      await notifier.inApp({ userId: a.user_id, workspaceId: r.workspace_id, requestId: r.id, kind: 'budget_alert', title,
        body: `After approving "${r.title}".` });
    }
    if (notifier.budgetAlert) await notifier.budgetAlert(r.workspace_id, title);
  } catch (err) {
    console.error('Budget alert failed:', err.message);
  }
}

module.exports = { budgetUsage, periodStart, budgetAlert };
