// Email templates. Each returns { subject, text, html }. Every value from users is HTML-escaped.

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ROLE_LABEL = { admin: 'Admin', manager: 'Manager', employee: 'Employee' };
const fmtDate = (d) => new Date(d).toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const fmtMoney = (amount, currency) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(Number(amount));

function layout({ heading, bodyHtml, buttonText, buttonUrl, footer }) {
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f6f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111827">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
    <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border:1px solid #e5e7eb;border-radius:14px">
      <tr><td style="padding:28px 32px 8px;font-weight:700;font-size:15px;color:#059669">Greenlight</td></tr>
      <tr><td style="padding:0 32px"><h1 style="font-size:20px;margin:8px 0 12px">${heading}</h1>${bodyHtml}</td></tr>
      <tr><td style="padding:16px 32px 8px"><a href="${escapeHtml(buttonUrl)}" style="display:inline-block;background:#059669;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:10px">${buttonText}</a></td></tr>
      <tr><td style="padding:8px 32px 28px;font-size:13px;color:#6b7280">${footer}</td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

function invitation({ workspaceName, inviterName, role, link, expiresAt }) {
  const roleLabel = ROLE_LABEL[role] || role;
  const subject = `${inviterName} invited you to ${workspaceName} on Greenlight`;
  const text =
    `${inviterName} invited you to join ${workspaceName} as ${roleLabel}.\n\n` +
    `Accept the invitation: ${link}\n\n` +
    `This invitation expires on ${fmtDate(expiresAt)}. If you weren't expecting it, you can ignore this email.`;
  const html = layout({
    heading: `Join ${escapeHtml(workspaceName)}`,
    bodyHtml: `<p style="margin:0 0 8px;line-height:1.6"><strong>${escapeHtml(inviterName)}</strong> invited you to join <strong>${escapeHtml(workspaceName)}</strong> as <strong>${roleLabel}</strong>.</p>`,
    buttonText: 'Accept invitation',
    buttonUrl: link,
    footer: `This invitation expires on ${fmtDate(expiresAt)}. If you weren't expecting it, you can ignore this email.`,
  });
  return { subject, text, html };
}

// Sent to the next approver in the chain (wired to requests in Milestone 3).
function approvalNeeded({ workspaceName, requesterName, requestTitle, amount, currency, link, flags = [] }) {
  const money = amount != null ? ` (${fmtMoney(amount, currency)})` : '';
  const subject = `Approval needed: ${requestTitle}${money}`;
  const text =
    `${requesterName} submitted "${requestTitle}"${money} in ${workspaceName}, and it's waiting for your approval.\n\n` +
    (flags.length ? `Worth a look:\n${flags.map((f) => `- ${f.message}`).join('\n')}\n\n` : '') +
    `Review it: ${link}`;
  const html = layout({
    heading: 'A request is waiting for your approval',
    bodyHtml: `<p style="margin:0 0 8px;line-height:1.6"><strong>${escapeHtml(requesterName)}</strong> submitted <strong>${escapeHtml(requestTitle)}</strong>${escapeHtml(money)} in ${escapeHtml(workspaceName)}.</p>` +
      (flags.length
        ? `<div style="margin:8px 0;padding:10px 12px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;color:#92400e"><strong>Worth a look</strong><ul style="margin:6px 0 0;padding-left:18px">${flags.map((f) => `<li>${escapeHtml(f.message)}</li>`).join('')}</ul></div>`
        : ''),
    buttonText: 'Review request',
    buttonUrl: link,
    footer: `You're getting this because you're an approver in ${escapeHtml(workspaceName)}.`,
  });
  return { subject, text, html };
}

// Sent to the requester when their request is approved, rejected or moves to the next step.
function requestStatusChanged({ workspaceName, requestTitle, status, actorName, comment, link }) {
  const verb = { approved: 'approved', rejected: 'rejected', advanced: 'approved and moved to the next approver' }[status] || status;
  const subject = `Your request "${requestTitle}" was ${status === 'advanced' ? 'approved by ' + actorName : verb}`;
  const text =
    `${actorName} ${verb} your request "${requestTitle}" in ${workspaceName}.` +
    (comment ? `\n\nComment: ${comment}` : '') +
    `\n\nView it: ${link}`;
  const html = layout({
    heading: `Your request was ${status === 'rejected' ? 'rejected' : 'approved'}`,
    bodyHtml:
      `<p style="margin:0 0 8px;line-height:1.6"><strong>${escapeHtml(actorName)}</strong> ${verb} <strong>${escapeHtml(requestTitle)}</strong>.</p>` +
      (comment ? `<p style="margin:0 0 8px;padding:10px 12px;background:#f6f7fb;border-radius:8px;line-height:1.6">${escapeHtml(comment)}</p>` : ''),
    buttonText: 'View request',
    buttonUrl: link,
    footer: `Workspace: ${escapeHtml(workspaceName)}`,
  });
  return { subject, text, html };
}

module.exports = { invitation, approvalNeeded, requestStatusChanged, escapeHtml };
