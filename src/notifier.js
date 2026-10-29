// Everything that tells people something happened: an in-app notification (the bell) plus an email.
// Nothing here ever blocks or undoes an action: failures are logged.

const { config } = require('./config');
const templates = require('./email/templates');
const { getInsight } = require('./insights');

const requestLink = (workspaceId, requestId) => `${config.appUrl}/app?ws=${workspaceId}&request=${requestId}`;

// The request fields notifications need (title, people, workspace name).
async function loadRequestInfo(db, requestId) {
  const { rows } = await db.query(
    `SELECT r.id, r.workspace_id, r.requester_id, r.type, r.title, r.amount, r.currency, r.status,
            u.name AS requester_name, u.email AS requester_email, w.name AS workspace_name
       FROM requests r JOIN users u ON u.id = r.requester_id JOIN workspaces w ON w.id = r.workspace_id
      WHERE r.id = $1`,
    [requestId]
  );
  const r = rows[0];
  return r ? { ...r, amount: r.amount == null ? null : Number(r.amount) } : null;
}

function createNotifier({ pool, mailer }) {
  async function email(to, message) {
    try {
      await mailer.send({ to, ...message });
    } catch (err) {
      console.error('Notification email failed:', err.message);
    }
  }

  async function inApp({ userId, workspaceId, requestId = null, kind, title, body = null }) {
    try {
      await pool.query(
        'INSERT INTO notifications (user_id, workspace_id, request_id, kind, title, body) VALUES ($1, $2, $3, $4, $5, $6)',
        [userId, workspaceId, requestId, kind, title.slice(0, 200), body ? body.slice(0, 500) : null]
      );
    } catch (err) {
      console.error('In-app notification failed:', err.message);
    }
  }

  // A request is waiting for `approverId`. `note` explains reminders, escalations and delegations.
  async function approvalNeeded(request, approverId, { kind = 'approval_needed', note = null } = {}) {
    const { rows } = await pool.query('SELECT email FROM users WHERE id = $1', [approverId]);
    if (!rows[0]) return;
    const insight = await getInsight(pool, request.id);
    const flags = insight ? [...insight.rule_flags, ...insight.ai_flags] : [];
    const prefix = kind === 'reminder' ? 'Reminder: ' : '';
    await inApp({ userId: approverId, workspaceId: request.workspace_id, requestId: request.id, kind,
      title: `${prefix}${request.requester_name} needs your approval: ${request.title}`, body: note });
    await email(rows[0].email, templates.approvalNeeded({
      workspaceName: request.workspace_name, requesterName: request.requester_name, requestTitle: request.title,
      amount: request.amount, currency: request.currency, link: requestLink(request.workspace_id, request.id), flags, note, reminder: kind === 'reminder',
    }));
  }

  // The requester hears about decisions on their request.
  async function statusChanged(request, status, actorName, comment = null) {
    const what = { approved: 'approved', rejected: 'rejected', advanced: 'approved a step of', changes_requested: 'asked for changes to' }[status] || status;
    await inApp({ userId: request.requester_id, workspaceId: request.workspace_id, requestId: request.id, kind: `request_${status}`,
      title: status === 'approved' && actorName === 'Greenlight' ? `"${request.title}" was approved` : `${actorName} ${what} "${request.title}"`,
      body: comment });
    await email(request.requester_email, templates.requestStatusChanged({
      workspaceName: request.workspace_name, requestTitle: request.title, status, actorName, comment,
      link: requestLink(request.workspace_id, request.id),
    }));
  }

  return { approvalNeeded, statusChanged, inApp };
}

module.exports = { createNotifier, loadRequestInfo, requestLink };
