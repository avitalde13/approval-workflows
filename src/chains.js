// Approval chains: which steps a request goes through, and who approves each step.

const REQUEST_TYPES = ['purchase', 'expense', 'time_off'];
const DEFAULT_CHAIN = [{ position: 1, name: 'Manager', approver_type: 'manager', approver_user_id: null, min_amount: null }];

// The configured steps for a request type, or the default (just the requester's manager).
async function getChain(db, workspaceId, type) {
  const { rows } = await db.query(
    `SELECT s.position, s.name, s.approver_type, s.approver_user_id, s.min_amount, u.name AS approver_name
       FROM approval_steps s LEFT JOIN users u ON u.id = s.approver_user_id
      WHERE s.workspace_id = $1 AND s.request_type = $2
      ORDER BY s.position`,
    [workspaceId, type]
  );
  return rows.length
    ? { default: false, steps: rows.map((r) => ({ ...r, min_amount: r.min_amount === null ? null : Number(r.min_amount) })) }
    : { default: true, steps: DEFAULT_CHAIN.map((s) => ({ ...s, approver_name: null })) };
}

class ChainError extends Error {}

// Picks the approver for each step of a new request.
// - Steps whose min_amount is above the request amount are skipped.
// - "manager" steps go to the requester's manager; if they have none, to an Admin.
// - Nobody approves their own request: such steps go to another Admin, or are skipped if there is none.
async function resolveApprovers(db, { workspaceId, type, requesterId, amount }) {
  const { steps } = await getChain(db, workspaceId, type);
  const admins = (
    await db.query("SELECT user_id FROM memberships WHERE workspace_id = $1 AND role = 'admin' ORDER BY created_at, user_id", [workspaceId])
  ).rows.map((r) => r.user_id);
  const otherAdmin = admins.find((id) => id !== requesterId) || null;
  const membership = await db.query('SELECT manager_id FROM memberships WHERE workspace_id = $1 AND user_id = $2', [workspaceId, requesterId]);
  const managerId = membership.rows[0]?.manager_id || null;

  return steps.map((step) => {
    if (step.min_amount !== null && (amount === null || amount < step.min_amount)) {
      return { ...step, approver_id: null, status: 'skipped', note: `Only for amounts of ${step.min_amount} or more` };
    }
    let approver = step.approver_type === 'manager' ? managerId || otherAdmin : step.approver_user_id;
    if (step.approver_type === 'user' && !approver) {
      throw new ChainError(`The "${step.name}" step has no approver. Ask an Admin to update the approval chain.`);
    }
    if (approver === requesterId) approver = otherAdmin;
    if (!approver) return { ...step, approver_id: null, status: 'skipped', note: 'No other approver available' };
    return { ...step, approver_id: approver, status: 'waiting' };
  });
}

module.exports = { REQUEST_TYPES, getChain, resolveApprovers, ChainError };
