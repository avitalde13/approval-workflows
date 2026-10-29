// Everything that tells people something happened: an in-app notification (the bell), an email,
// and a message in the workspace's Slack channel when Slack is connected.
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

// Slack's mrkdwn: escape &, < and > in user text; links are <url|label>.
const slackEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtMoney = (amount, currency) => {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount); } catch { return `${amount} ${currency}`; }
};
const SLACK_RE = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_\-/]+$/;

function createNotifier({ pool, mailer, fetchImpl = fetch }) {
  // Posts to the workspace's Slack channel. Returns true when Slack accepted the message.
  async function slack(workspaceId, text) {
    try {
      const { rows: [w] } = await pool.query('SELECT slack_webhook_url FROM workspaces WHERE id = $1', [workspaceId]);
      if (!w?.slack_webhook_url || !SLACK_RE.test(w.slack_webhook_url)) return false;
      const res = await fetchImpl(w.slack_webhook_url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, unfurl_links: false }) });
      if (!res.ok) console.error(`Slack message failed: ${res.status}`);
      return res.ok;
    } catch (err) {
      console.error('Slack message failed:', err.message);
      return false;
    }
  }
  const slackLink = (request) => `<${requestLink(request.workspace_id, request.id)}|${slackEscape(request.title)}>`;
  const slackAmount = (request) => (request.amount != null ? ` · ${fmtMoney(request.amount, request.currency)}` : '');

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
    if (kind !== 'reminder') {
      const { rows: [who] } = await pool.query('SELECT name FROM users WHERE id = $1', [approverId]);
      const risky = insight && insight.risk_level !== 'low' ? ` · ⚠️ ${insight.risk_level === 'high' ? 'High risk' : 'Worth a look'}` : '';
      await slack(request.workspace_id, `📝 *${slackEscape(request.requester_name)}* needs approval from *${slackEscape(who?.name || 'an approver')}*: ${slackLink(request)}${slackAmount(request)}${risky}`
        + (note ? `\n_${slackEscape(note)}_` : ''));
    }
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
    const icon = { approved: '✅', rejected: '❌', changes_requested: '↩️' }[status];
    if (icon) {
      await slack(request.workspace_id, `${icon} ${slackLink(request)}${slackAmount(request)} from *${slackEscape(request.requester_name)}* was `
        + `${status === 'changes_requested' ? 'sent back for changes' : status}${actorName === 'Greenlight' ? '' : ` by *${slackEscape(actorName)}*`}`
        + (comment ? `\n> ${slackEscape(comment)}` : ''));
    }
  }

  async function budgetAlert(workspaceId, title) {
    await slack(workspaceId, `💰 ${slackEscape(title)}`);
  }

  return { approvalNeeded, statusChanged, inApp, budgetAlert, slack };
}

module.exports = { createNotifier, loadRequestInfo, requestLink, SLACK_RE };
