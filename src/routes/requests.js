// Requests and approvals.
//
//   POST /api/workspaces/:id/requests                          submit (any member)
//   GET  /api/workspaces/:id/requests?scope=mine|to_approve|team|all
//   GET  /api/workspaces/:id/requests/:requestId               details and approval timeline
//   POST /api/workspaces/:id/requests/:requestId/decision      { decision: "approve" | "reject", comment }  (current approver)
//   POST /api/workspaces/:id/requests/:requestId/cancel        (requester, while pending)

const express = require('express');
const { config } = require('../config');
const { requireUser } = require('../auth/sessions');
const { requireMember, canViewRequest } = require('../permissions');
const { parseId } = require('../workspaces');
const { REQUEST_TYPES, resolveApprovers, ChainError } = require('../chains');
const { audit } = require('../audit');
const templates = require('../email/templates');

const MAX_AMOUNT = 10_000_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TYPE_LABEL = { purchase: 'Purchase', expense: 'Expense', time_off: 'Time off' };

const toDate = (v) => (v == null ? null : typeof v === 'string' ? v.slice(0, 10) : v.toISOString().slice(0, 10));
const requestLink = (workspaceId, requestId) => `${config.appUrl}/app?ws=${workspaceId}&request=${requestId}`;

function validate(body) {
  const type = body?.type;
  if (!REQUEST_TYPES.includes(type)) return { error: 'Type must be purchase, expense or time_off.' };
  const title = typeof body.title === 'string' ? body.title.trim().replace(/\s+/g, ' ') : '';
  if (title.length < 3 || title.length > 120) return { error: 'Title must be 3–120 characters.' };
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (description.length > 2000) return { error: 'Description can be at most 2000 characters.' };
  const out = { type, title, description: description || null, amount: null, currency: 'USD', vendor: null, start_date: null, end_date: null };

  if (type === 'time_off') {
    if (!DATE_RE.test(body.start_date || '') || !DATE_RE.test(body.end_date || '')) return { error: 'Start and end dates are required (YYYY-MM-DD).' };
    if (Number.isNaN(Date.parse(body.start_date)) || Number.isNaN(Date.parse(body.end_date))) return { error: 'Dates are not valid.' };
    if (body.end_date < body.start_date) return { error: 'End date must be on or after the start date.' };
    out.start_date = body.start_date;
    out.end_date = body.end_date;
  } else {
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) return { error: 'Amount must be more than 0.' };
    out.amount = Math.round(amount * 100) / 100;
    const currency = typeof body.currency === 'string' && body.currency ? body.currency.toUpperCase() : 'USD';
    if (!/^[A-Z]{3}$/.test(currency)) return { error: 'Currency must be a 3-letter code, like USD or ILS.' };
    out.currency = currency;
    const vendor = typeof body.vendor === 'string' ? body.vendor.trim() : '';
    if (vendor.length > 120) return { error: 'Vendor can be at most 120 characters.' };
    if (type === 'purchase' && !vendor) return { error: 'Vendor is required for purchases.' };
    out.vendor = vendor || null;
  }
  return { data: out };
}

function shape(r) {
  return { ...r, amount: r.amount == null ? null : Number(r.amount), start_date: toDate(r.start_date), end_date: toDate(r.end_date) };
}

async function loadRequest(db, workspaceId, requestId) {
  const { rows } = await db.query(
    `SELECT r.*, u.name AS requester_name, u.email AS requester_email, w.name AS workspace_name
       FROM requests r JOIN users u ON u.id = r.requester_id JOIN workspaces w ON w.id = r.workspace_id
      WHERE r.id = $1 AND r.workspace_id = $2`,
    [requestId, workspaceId]
  );
  return rows[0] ? shape(rows[0]) : null;
}

async function loadApprovals(db, requestId) {
  const { rows } = await db.query(
    `SELECT a.id, a.position, a.step_name, a.approver_id, u.name AS approver_name, a.status, a.comment, a.decided_at
       FROM request_approvals a LEFT JOIN users u ON u.id = a.approver_id
      WHERE a.request_id = $1 ORDER BY a.position`,
    [requestId]
  );
  return rows;
}

function requestRoutes(pool, mailer) {
  const router = express.Router({ mergeParams: true });
  router.use(requireUser, requireMember(pool));

  // Emails never block or undo an action; failures are logged.
  async function notify(to, message) {
    try {
      await mailer.send({ to, ...message });
    } catch (err) {
      console.error('Notification email failed:', err.message);
    }
  }

  async function notifyApprover(request, approverId) {
    const { rows } = await pool.query('SELECT email FROM users WHERE id = $1', [approverId]);
    if (!rows[0]) return;
    await notify(rows[0].email, templates.approvalNeeded({
      workspaceName: request.workspace_name, requesterName: request.requester_name, requestTitle: request.title,
      amount: request.amount, currency: request.currency, link: requestLink(request.workspace_id, request.id),
    }));
  }

  async function notifyRequester(request, status, actorName, comment) {
    await notify(request.requester_email, templates.requestStatusChanged({
      workspaceName: request.workspace_name, requestTitle: request.title, status, actorName, comment,
      link: requestLink(request.workspace_id, request.id),
    }));
  }

  // ---------- Submit ----------
  router.post('/', async (req, res, next) => {
    const { data, error } = validate(req.body);
    if (error) return res.status(400).json({ error });

    let approvers;
    try {
      approvers = await resolveApprovers(pool, { workspaceId: req.workspaceId, type: data.type, requesterId: req.user.id, amount: data.amount });
    } catch (err) {
      if (err instanceof ChainError) return res.status(422).json({ error: err.message });
      return next(err);
    }
    const firstActive = approvers.find((a) => a.status === 'waiting');
    if (firstActive) firstActive.status = 'pending';
    const autoApproved = !firstActive;

    const client = await pool.connect();
    let requestId;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO requests (workspace_id, requester_id, type, title, description, amount, currency, vendor, start_date, end_date, status, decided_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [req.workspaceId, req.user.id, data.type, data.title, data.description, data.amount, data.currency, data.vendor,
          data.start_date, data.end_date, autoApproved ? 'approved' : 'pending', autoApproved ? new Date() : null]
      );
      requestId = rows[0].id;
      for (const a of approvers) {
        await client.query(
          `INSERT INTO request_approvals (request_id, position, step_name, approver_id, status, comment, decided_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [requestId, a.position, a.name, a.approver_id, a.status, a.note || null, a.status === 'skipped' ? new Date() : null]
        );
      }
      await audit(client, {
        workspaceId: req.workspaceId, actorId: req.user.id, action: 'request.submitted', entityType: 'request', entityId: requestId,
        details: { type: data.type, title: data.title, amount: data.amount, currency: data.currency, vendor: data.vendor,
          steps: approvers.map((a) => ({ step: a.name, approver_id: a.approver_id, status: a.status })) },
      });
      if (autoApproved) {
        await audit(client, { workspaceId: req.workspaceId, actorId: null, action: 'request.approved', entityType: 'request', entityId: requestId, details: { reason: 'No approval steps applied' } });
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      return next(err);
    } finally {
      client.release();
    }

    const request = await loadRequest(pool, req.workspaceId, requestId);
    if (firstActive) await notifyApprover(request, firstActive.approver_id);
    else await notifyRequester(request, 'approved', 'Approval Workflows');
    res.status(201).json({ ...request, approvals: await loadApprovals(pool, requestId) });
  });

  // ---------- List ----------
  router.get('/', async (req, res, next) => {
    const scope = req.query.scope || 'mine';
    const select = `
      SELECT r.id, r.type, r.title, r.amount, r.currency, r.vendor, r.start_date, r.end_date, r.status, r.created_at, r.decided_at,
             r.requester_id, u.name AS requester_name,
             cur.step_name AS current_step, cu.name AS current_approver
        FROM requests r
        JOIN users u ON u.id = r.requester_id
        LEFT JOIN request_approvals cur ON cur.request_id = r.id AND cur.status = 'pending'
        LEFT JOIN users cu ON cu.id = cur.approver_id`;
    const order = ' ORDER BY r.created_at DESC, r.id DESC LIMIT 200';
    try {
      let result;
      if (scope === 'mine') {
        result = await pool.query(`${select} WHERE r.workspace_id = $1 AND r.requester_id = $2${order}`, [req.workspaceId, req.user.id]);
      } else if (scope === 'to_approve') {
        result = await pool.query(
          `${select} WHERE r.workspace_id = $1 AND r.status = 'pending' AND cur.approver_id = $2${order}`,
          [req.workspaceId, req.user.id]
        );
      } else if (scope === 'team') {
        if (req.role === 'employee') return res.status(403).json({ error: 'Only Managers and Admins can see team requests.' });
        result = await pool.query(
          `${select} WHERE r.workspace_id = $1 AND r.requester_id IN
             (SELECT user_id FROM memberships WHERE workspace_id = $1 AND manager_id = $2)${order}`,
          [req.workspaceId, req.user.id]
        );
      } else if (scope === 'all') {
        if (req.role !== 'admin') return res.status(403).json({ error: 'Only Admins can see all requests.' });
        result = await pool.query(`${select} WHERE r.workspace_id = $1${order}`, [req.workspaceId]);
      } else {
        return res.status(400).json({ error: 'scope must be mine, to_approve, team or all.' });
      }
      res.json({ requests: result.rows.map(shape) });
    } catch (err) {
      next(err);
    }
  });

  // ---------- Details ----------
  router.get('/:requestId', async (req, res, next) => {
    try {
      const request = await loadRequest(pool, req.workspaceId, parseId(req.params.requestId));
      if (!request || !(await canViewRequest(pool, { request, userId: req.user.id, role: req.role }))) {
        return res.status(404).json({ error: 'Request not found.' });
      }
      const approvals = await loadApprovals(pool, request.id);
      const current = approvals.find((a) => a.status === 'pending');
      const { requester_email: _hidden, ...publicRequest } = request;
      res.json({
        ...publicRequest,
        type_label: TYPE_LABEL[request.type],
        approvals,
        can_decide: request.status === 'pending' && current?.approver_id === req.user.id,
        can_cancel: request.status === 'pending' && request.requester_id === req.user.id,
      });
    } catch (err) {
      next(err);
    }
  });

  // ---------- Approve / reject ----------
  router.post('/:requestId/decision', async (req, res, next) => {
    const decision = req.body?.decision;
    const comment = typeof req.body?.comment === 'string' ? req.body.comment.trim().slice(0, 1000) : '';
    if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'decision must be "approve" or "reject".' });
    if (decision === 'reject' && comment.length < 2) return res.status(400).json({ error: 'Please add a short reason when rejecting.' });

    try {
      const request = await loadRequest(pool, req.workspaceId, parseId(req.params.requestId));
      if (!request || !(await canViewRequest(pool, { request, userId: req.user.id, role: req.role }))) {
        return res.status(404).json({ error: 'Request not found.' });
      }
      if (request.status !== 'pending') return res.status(409).json({ error: `This request is already ${request.status}.` });
      const approvals = await loadApprovals(pool, request.id);
      const current = approvals.find((a) => a.status === 'pending');
      if (!current || current.approver_id !== req.user.id) {
        return res.status(403).json({ error: 'This request is not waiting for your approval.' });
      }

      let nextStep = null;
      let finalStatus = null;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Only one decision can win, even if two clicks arrive at once.
        const claimed = await client.query(
          "UPDATE request_approvals SET status = $1, comment = $2, decided_at = NOW() WHERE id = $3 AND status = 'pending'",
          [decision === 'approve' ? 'approved' : 'rejected', comment || null, current.id]
        );
        if (!claimed.rowCount) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'This step was already decided.' });
        }
        if (decision === 'approve') {
          nextStep = approvals.find((a) => a.position > current.position && a.status === 'waiting') || null;
          if (nextStep) {
            await client.query("UPDATE request_approvals SET status = 'pending' WHERE id = $1", [nextStep.id]);
          } else {
            finalStatus = 'approved';
          }
        } else {
          finalStatus = 'rejected';
          await client.query("UPDATE request_approvals SET status = 'cancelled' WHERE request_id = $1 AND status = 'waiting'", [request.id]);
        }
        if (finalStatus) {
          await client.query('UPDATE requests SET status = $1, decided_at = NOW() WHERE id = $2', [finalStatus, request.id]);
        }
        await audit(client, {
          workspaceId: req.workspaceId, actorId: req.user.id,
          action: decision === 'approve' ? (finalStatus ? 'request.approved' : 'request.step_approved') : 'request.rejected',
          entityType: 'request', entityId: request.id,
          details: { step: current.step_name, comment: comment || null, next_step: nextStep?.step_name || null },
        });
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      if (nextStep) {
        await notifyApprover(request, nextStep.approver_id);
        await notifyRequester(request, 'advanced', req.user.name, comment || null);
      } else {
        await notifyRequester(request, finalStatus, req.user.name, comment || null);
      }
      const updated = await loadRequest(pool, req.workspaceId, request.id);
      res.json({ ...updated, requester_email: undefined, approvals: await loadApprovals(pool, request.id) });
    } catch (err) {
      next(err);
    }
  });

  // ---------- Cancel ----------
  router.post('/:requestId/cancel', async (req, res, next) => {
    try {
      const request = await loadRequest(pool, req.workspaceId, parseId(req.params.requestId));
      if (!request || !(await canViewRequest(pool, { request, userId: req.user.id, role: req.role }))) {
        return res.status(404).json({ error: 'Request not found.' });
      }
      if (request.requester_id !== req.user.id) return res.status(403).json({ error: 'Only the person who submitted a request can cancel it.' });
      const cancelled = await pool.query("UPDATE requests SET status = 'cancelled', decided_at = NOW() WHERE id = $1 AND status = 'pending'", [request.id]);
      if (!cancelled.rowCount) return res.status(409).json({ error: `This request is already ${request.status}.` });
      await pool.query("UPDATE request_approvals SET status = 'cancelled' WHERE request_id = $1 AND status IN ('pending', 'waiting')", [request.id]);
      await audit(pool, { workspaceId: req.workspaceId, actorId: req.user.id, action: 'request.cancelled', entityType: 'request', entityId: request.id, details: { title: request.title } });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { requestRoutes };
