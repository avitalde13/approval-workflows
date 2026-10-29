// Time off: business days (Monday to Friday), yearly balances and the team calendar.

const DAY = 24 * 60 * 60 * 1000;
const day = (v) => (v == null ? null : (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10));

// Business days from start to end (inclusive), optionally only those inside `year`.
function businessDays(start, end, year = null) {
  let n = 0;
  for (let t = Date.parse(`${day(start)}T00:00:00Z`); t <= Date.parse(`${day(end)}T00:00:00Z`); t += DAY) {
    const d = new Date(t);
    if (year && d.getUTCFullYear() !== year) continue;
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) n++;
  }
  return n;
}

// Balances for the given members (or everyone) in `year`: allowance, used (approved), waiting, left.
async function balances(db, workspaceId, { year = new Date().getUTCFullYear(), userIds = null, excludeRequestId = null } = {}) {
  const { rows: [w] } = await db.query('SELECT vacation_days FROM workspaces WHERE id = $1', [workspaceId]);
  const { rows: members } = await db.query(
    `SELECT m.user_id, u.name, m.vacation_days FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 ORDER BY u.name`,
    [workspaceId]);
  const { rows: requests } = await db.query(
    `SELECT id, requester_id, start_date, end_date, status FROM requests
      WHERE workspace_id = $1 AND type = 'time_off' AND status IN ('approved', 'pending', 'changes_requested')`, [workspaceId]);
  return members.filter((m) => !userIds || userIds.includes(m.user_id)).map((m) => {
    const allowance = m.vacation_days ?? w.vacation_days;
    let used = 0;
    let waiting = 0;
    for (const r of requests) {
      if (r.requester_id !== m.user_id || r.id === excludeRequestId) continue;
      const days = businessDays(r.start_date, r.end_date, year);
      if (r.status === 'approved') used += days;
      else waiting += days;
    }
    return { user_id: m.user_id, name: m.name, allowance, custom: m.vacation_days != null, used, waiting, left: allowance - used - waiting, year };
  });
}

// Approved and waiting time off overlapping [from, to] ("YYYY-MM-DD"), for the calendar.
async function calendar(db, workspaceId, from, to) {
  const { rows } = await db.query(
    `SELECT r.id, r.requester_id, u.name, r.title, r.start_date, r.end_date, r.status FROM requests r JOIN users u ON u.id = r.requester_id
      WHERE r.workspace_id = $1 AND r.type = 'time_off' AND r.status IN ('approved', 'pending', 'changes_requested')
        AND r.start_date <= $3 AND r.end_date >= $2
      ORDER BY r.start_date, u.name`,
    [workspaceId, from, to]);
  return rows.map((r) => ({ ...r, start_date: day(r.start_date), end_date: day(r.end_date) }));
}

module.exports = { businessDays, balances, calendar };
