// Runs every 15 minutes: nudges approvers who haven't answered, and moves long-waiting steps on.
//   after reminder_hours: one reminder to the approver
//   after escalate_hours: the step goes to the approver's own manager, or else an Admin (once per step)
// Demo workspaces are left alone.

const { audit } = require('./audit');
const { loadRequestInfo } = require('./notifier');
const { availableApprover } = require('./routing');

const HOUR = 60 * 60 * 1000;
const waited = (hours) => (hours < 48 ? `${Math.round(hours)} hours` : `${Math.round(hours / 24)} days`);

// Someone else who can take over the step: the approver's manager, or another Admin. Never the requester.
async function escalationTarget(db, { workspaceId, approverId, requesterId }) {
  const skip = (id) => !id || id === approverId || id === requesterId;
  const { rows: [m] } = await db.query('SELECT manager_id FROM memberships WHERE workspace_id = $1 AND user_id = $2', [workspaceId, approverId]);
  if (!skip(m?.manager_id)) return m.manager_id;
  const admins = await db.query("SELECT user_id FROM memberships WHERE workspace_id = $1 AND role = 'admin' ORDER BY created_at, user_id", [workspaceId]);
  return admins.rows.map((r) => r.user_id).find((id) => !skip(id)) || null;
}

async function runReminders(pool, notifier, now = new Date()) {
  const { rows } = await pool.query(
    `SELECT a.id, a.request_id, a.approver_id, a.step_name, a.pending_since, a.reminded_at, a.reassigned_reason,
            r.created_at, r.workspace_id, r.requester_id, w.reminder_hours, w.escalate_hours, u.name AS approver_name
       FROM request_approvals a
       JOIN requests r ON r.id = a.request_id
       JOIN workspaces w ON w.id = r.workspace_id
       LEFT JOIN users u ON u.id = a.approver_id
      WHERE a.status = 'pending' AND r.status = 'pending' AND w.demo_expires_at IS NULL`
  );
  const done = { reminded: 0, escalated: 0 };
  for (const step of rows) {
    const hours = (now - new Date(step.pending_since || step.created_at)) / HOUR;
    const request = await loadRequestInfo(pool, step.request_id);
    if (step.escalate_hours && hours >= step.escalate_hours && step.reassigned_reason !== 'escalated') {
      const target = await escalationTarget(pool, { workspaceId: step.workspace_id, approverId: step.approver_id, requesterId: step.requester_id });
      if (target) {
        const routed = await availableApprover(pool, { workspaceId: step.workspace_id, approverId: target, requesterId: step.requester_id });
        const moved = await pool.query(
          `UPDATE request_approvals SET approver_id = $1, reassigned_from = $2, reassigned_reason = 'escalated', pending_since = $3, reminded_at = NULL
            WHERE id = $4 AND status = 'pending' AND approver_id = $2`,
          [routed.approverId, step.approver_id, now, step.id]
        );
        if (moved.rowCount) {
          await audit(pool, { workspaceId: step.workspace_id, actorId: null, action: 'request.escalated', entityType: 'request', entityId: step.request_id,
            details: { step: step.step_name, from: step.approver_name, hours: Math.round(hours) } });
          await notifier.approvalNeeded(request, routed.approverId, { kind: 'escalated',
            note: `${step.approver_name || 'The approver'} hasn't answered in ${waited(hours)}, so it moved to you.` });
          await notifier.inApp({ userId: step.approver_id, workspaceId: step.workspace_id, requestId: step.request_id, kind: 'escalated_away',
            title: `"${request.title}" moved to someone else after ${waited(hours)} without an answer` });
          done.escalated++;
          continue;
        }
      }
    }
    if (step.reminder_hours && hours >= step.reminder_hours && !step.reminded_at) {
      await pool.query('UPDATE request_approvals SET reminded_at = $1 WHERE id = $2', [now, step.id]);
      await notifier.approvalNeeded(request, step.approver_id, { kind: 'reminder', note: `This has been waiting for you for ${waited(hours)}.` });
      done.reminded++;
    }
  }
  return done;
}

module.exports = { runReminders, escalationTarget };
