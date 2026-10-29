// Who a step waits for right now. Approvers are chosen when a request is submitted, but when a step
// becomes active its approver may be out of office: then it goes to the delegate they picked.

const today = () => new Date().toISOString().slice(0, 10);
const day = (v) => (v == null ? null : (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10));

// Whether a member is away on `date` ("YYYY-MM-DD"), and their delegate.
function awayInfo(member, date = today()) {
  const from = day(member?.away_from);
  const until = day(member?.away_until);
  const away = Boolean(until && until >= date && (!from || from <= date));
  return { away, delegateId: away ? member.delegate_id || null : null };
}

// Returns { approverId, delegatedFrom }. The delegate is used only if they are still a member and aren't the requester.
async function availableApprover(db, { workspaceId, approverId, requesterId }) {
  const { rows } = await db.query('SELECT away_from, away_until, delegate_id FROM memberships WHERE workspace_id = $1 AND user_id = $2',
    [workspaceId, approverId]);
  const { delegateId } = awayInfo(rows[0]);
  if (!delegateId || delegateId === requesterId || delegateId === approverId) return { approverId, delegatedFrom: null };
  const member = await db.query('SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2', [workspaceId, delegateId]);
  return member.rows.length ? { approverId: delegateId, delegatedFrom: approverId } : { approverId, delegatedFrom: null };
}

// Makes a waiting step the current one, routed to whoever is available.
async function activateStep(db, stepId, { workspaceId, requesterId, approverId }) {
  const routed = await availableApprover(db, { workspaceId, approverId, requesterId });
  await db.query(
    `UPDATE request_approvals SET status = 'pending', approver_id = $1, pending_since = NOW(), reminded_at = NULL,
            reassigned_from = $2, reassigned_reason = $3 WHERE id = $4`,
    [routed.approverId, routed.delegatedFrom, routed.delegatedFrom ? 'delegated' : null, stepId]
  );
  return routed;
}

module.exports = { availableApprover, activateStep, awayInfo };
