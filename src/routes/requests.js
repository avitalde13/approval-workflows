// Requests and approvals.
//
//   POST /api/workspaces/:id/requests                          submit (any member)
//   GET  /api/workspaces/:id/requests?scope=mine|to_approve|team|all
//   GET  /api/workspaces/:id/requests/:requestId               details and approval timeline
//   POST /api/workspaces/:id/requests/:requestId/decision      { decision: "approve" | "reject" | "request_changes", comment }  (current approver)
//   POST /api/workspaces/:id/requests/:requestId/resubmit      edited fields (requester, after changes were requested)
//   POST /api/workspaces/:id/requests/:requestId/cancel        (requester, while pending or sent back)
//   POST   /api/workspaces/:id/requests/:requestId/files       { filename, content_type, data (base64) }  (requester)
//   GET    /api/workspaces/:id/requests/:requestId/files/:fileId
//   DELETE /api/workspaces/:id/requests/:requestId/files/:fileId (requester, while not decided)

const express = require('express');
const { requireUser } = require('../auth/sessions');
const { requireMember, canViewRequest } = require('../permissions');
const { parseId } = require('../workspaces');
const { REQUEST_TYPES, resolveApprovers, ChainError } = require('../chains');
const { audit } = require('../audit');
const { activateStep } = require('../routing');
const { budgetAlert } = require('../budgets');
const { runRuleChecks, runAi, getInsight, asArray } = require('../insights');
const { RANK } = require('../permissions');

const MAX_AMOUNT = 10_000_000;
const OPEN = ['pending', 'changes_requested']; // not decided yet: files can be removed, the requester can cancel
const ATTACHABLE = [...OPEN, 'approved'];    // receipts often arrive after approval, so they can still be added

// Receipts: images or PDF, checked by their first bytes as well as the declared type.
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 5;
const FILE_TYPES = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP',
  'image/gif': (b) => b.subarray(0, 4).toString() === 'GIF8',
  'application/pdf': (b) => b.subarray(0, 5).toString() === '%PDF-',
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TYPE_LABEL = { purchase: 'Purchase', expense: 'Expense', time_off: 'Time off' };

const toDate = (v) => (v == null ? null : typeof v === 'string' ? v.slice(0, 10) : v.toISOString().slice(0, 10));

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
    `SELECT a.id, a.position, a.round, a.step_name, a.approver_id, u.name AS approver_name, a.status, a.comment, a.decided_at,
            a.reassigned_reason, ru.name AS reassigned_from_name
       FROM request_approvals a LEFT JOIN users u ON u.id = a.approver_id LEFT JOIN users ru ON ru.id = a.reassigned_from
      WHERE a.request_id = $1 ORDER BY a.position`,
    [requestId]
  );
  return rows;
}

async function loadFiles(db, requestId) {
  const { rows } = await db.query(
    `SELECT f.id, f.filename, f.content_type, f.size_bytes, f.created_at, u.name AS uploaded_by_name
       FROM request_files f JOIN users u ON u.id = f.uploaded_by WHERE f.request_id = $1 ORDER BY f.id`,
    [requestId]
  );
  return rows;
}

// Writes the approval rows for one round and starts the first active step.
// Returns { approverId, delegatedFrom } for that step, or null when no step applies (approved right away).
async function insertApprovals(client, requestId, approvers, { round = 1, after = 0, workspaceId, requesterId }) {
  const firstActive = approvers.find((a) => a.status === 'waiting') || null;
  let firstId = null;
  for (const a of approvers) {
    const { rows } = await client.query(
      `INSERT INTO request_approvals (request_id, position, round, step_name, approver_id, status, comment, decided_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [requestId, after + a.position, round, a.name, a.approver_id, a.status, a.note || null, a.status === 'skipped' ? new Date() : null]
    );
    if (a === firstActive) firstId = rows[0].id;
  }
  return firstActive ? activateStep(client, firstId, { workspaceId, requesterId, approverId: firstActive.approver_id }) : null;
}

// Explains a reassignment to the new approver.
async function routeNote(db, routed) {
  if (!routed?.delegatedFrom) return null;
  const { rows } = await db.query('SELECT name FROM users WHERE id = $1', [routed.delegatedFrom]);
  return `${rows[0]?.name || 'The usual approver'} is out of office and asked you to approve on their behalf.`;
}

// insights: { classifier: AI classifier or null, track(promise) } (track lets tests wait for background work)
function requestRoutes(pool, notifier, insights = { classifier: null, track: (p) => p }) {
  const router = express.Router({ mergeParams: true });
  router.use(requireUser, requireMember(pool));

  async function notifyApprover(request, routed) {
    await notifier.approvalNeeded(request, routed.approverId, { note: await routeNote(pool, routed) });
  }

  function startAi(requestId) {
    if (insights.classifier) insights.track(runAi(pool, insights.classifier, requestId));
  }

  async function notifyRequester(request, status, actorName, comment) {
    await notifier.statusChanged(request, status, actorName, comment);
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
    const autoApproved = !approvers.some((a) => a.status === 'waiting');
    let firstActive = null;

    const { rows: [membership] } = await pool.query('SELECT department_id FROM memberships WHERE workspace_id = $1 AND user_id = $2', [req.workspaceId, req.user.id]);
    const client = await pool.connect();
    let requestId;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO requests (workspace_id, requester_id, type, title, description, amount, currency, vendor, start_date, end_date, status, decided_at, department_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
        [req.workspaceId, req.user.id, data.type, data.title, data.description, data.amount, data.currency, data.vendor,
          data.start_date, data.end_date, autoApproved ? 'approved' : 'pending', autoApproved ? new Date() : null, membership?.department_id || null]
      );
      requestId = rows[0].id;
      firstActive = await insertApprovals(client, requestId, approvers, { workspaceId: req.workspaceId, requesterId: req.user.id });
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

    try {
      await runRuleChecks(pool, requestId, { aiEnabled: Boolean(insights.classifier) });
    } catch (err) {
      console.error('Rule checks failed:', err); // never block a submission on insights
    }
    startAi(requestId);
    const request = await loadRequest(pool, req.workspaceId, requestId);
    if (firstActive) await notifyApprover(request, firstActive);
    else await notifyRequester(request, 'approved', 'Greenlight');
    const { requester_email: _hidden, ...created } = request;
    res.status(201).json({ ...created, approvals: await loadApprovals(pool, requestId), insight: await getInsight(pool, requestId) });
  });

  // ---------- List ----------
  router.get('/', async (req, res, next) => {
    const scope = req.query.scope || 'mine';
    const select = `
      SELECT r.id, r.type, r.title, r.amount, r.currency, r.vendor, r.start_date, r.end_date, r.status, r.created_at, r.decided_at,
             r.requester_id, u.name AS requester_name,
             cur.step_name AS current_step, cu.name AS current_approver,
             ri.risk_level, ri.category, ri.rule_flags, ri.ai_flags
        FROM requests r
        JOIN users u ON u.id = r.requester_id
        LEFT JOIN request_insights ri ON ri.request_id = r.id
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
      // Risk details are for approvers and up: requesters see their own list without them.
      const hideRisk = scope === 'mine' && req.role === 'employee';
      const ids = result.rows.map((r) => r.id);
      const counts = new Map();
      if (ids.length) {
        const list = ids.map((_, i) => `$${i + 1}`).join(', ');
        const files = await pool.query(`SELECT request_id, COUNT(*)::int AS n FROM request_files WHERE request_id IN (${list}) GROUP BY request_id`, ids);
        for (const f of files.rows) counts.set(f.request_id, f.n);
      }
      res.json({
        requests: result.rows.map(({ rule_flags: rf, ai_flags: af, ...r }) => ({
          ...shape(r),
          file_count: counts.get(r.id) || 0,
          risk_level: hideRisk ? null : r.risk_level,
          flag_count: hideRisk ? 0 : asArray(rf).length + asArray(af).length,
        })),
      });
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
      // Insights help reviewers; a requester who isn't also an approver, manager or Admin doesn't see them.
      const isReviewer = req.role === 'admin' || approvals.some((a) => a.approver_id === req.user.id) || request.requester_id !== req.user.id;
      res.json({
        ...publicRequest,
        insight: isReviewer ? await getInsight(pool, request.id) : null,
        type_label: TYPE_LABEL[request.type],
        approvals,
        files: await loadFiles(pool, request.id),
        can_decide: request.status === 'pending' && current?.approver_id === req.user.id,
        can_cancel: OPEN.includes(request.status) && request.requester_id === req.user.id,
        can_edit: request.status === 'changes_requested' && request.requester_id === req.user.id,
        can_attach: ATTACHABLE.includes(request.status) && request.requester_id === req.user.id,
        can_remove_files: OPEN.includes(request.status) && request.requester_id === req.user.id,
      });
    } catch (err) {
      next(err);
    }
  });

  // ---------- Approve / reject ----------
  router.post('/:requestId/decision', async (req, res, next) => {
    const decision = req.body?.decision;
    const comment = typeof req.body?.comment === 'string' ? req.body.comment.trim().slice(0, 1000) : '';
    if (!['approve', 'reject', 'request_changes'].includes(decision)) {
      return res.status(400).json({ error: 'decision must be "approve", "reject" or "request_changes".' });
    }
    if (decision === 'reject' && comment.length < 2) return res.status(400).json({ error: 'Please add a short reason when rejecting.' });
    if (decision === 'request_changes' && comment.length < 2) return res.status(400).json({ error: 'Please say what should change.' });

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
          [{ approve: 'approved', reject: 'rejected', request_changes: 'returned' }[decision], comment || null, current.id]
        );
        if (!claimed.rowCount) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'This step was already decided.' });
        }
        if (decision === 'approve') {
          nextStep = approvals.find((a) => a.position > current.position && a.status === 'waiting') || null;
          if (nextStep) {
            nextStep.routed = await activateStep(client, nextStep.id, { workspaceId: req.workspaceId, requesterId: request.requester_id, approverId: nextStep.approver_id });
          } else {
            finalStatus = 'approved';
          }
        } else {
          // Rejected, or sent back for changes: the rest of this round won't run.
          finalStatus = decision === 'reject' ? 'rejected' : null;
          await client.query("UPDATE request_approvals SET status = 'cancelled' WHERE request_id = $1 AND status = 'waiting'", [request.id]);
        }
        if (finalStatus) {
          await client.query('UPDATE requests SET status = $1, decided_at = NOW() WHERE id = $2', [finalStatus, request.id]);
        }
        if (decision === 'request_changes') {
          await client.query("UPDATE requests SET status = 'changes_requested' WHERE id = $1", [request.id]);
        }
        await audit(client, {
          workspaceId: req.workspaceId, actorId: req.user.id,
          action: { approve: finalStatus ? 'request.approved' : 'request.step_approved', reject: 'request.rejected', request_changes: 'request.changes_requested' }[decision],
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

      if (decision === 'request_changes') {
        await notifyRequester(request, 'changes_requested', req.user.name, comment);
      } else if (nextStep) {
        await notifyApprover(request, nextStep.routed);
        await notifyRequester(request, 'advanced', req.user.name, comment || null);
      } else {
        await notifyRequester(request, finalStatus, req.user.name, comment || null);
        if (finalStatus === 'approved') await budgetAlert(pool, notifier, request.id);
      }
      const updated = await loadRequest(pool, req.workspaceId, request.id);
      res.json({ ...updated, requester_email: undefined, approvals: await loadApprovals(pool, request.id) });
    } catch (err) {
      next(err);
    }
  });

  // ---------- Re-run AI (Admins) ----------
  router.post('/:requestId/reanalyze', async (req, res, next) => {
    try {
      if (req.role !== 'admin') return res.status(403).json({ error: 'Only workspace Admins can do this.' });
      if (!insights.classifier) return res.status(409).json({ error: 'AI classification is not set up (ANTHROPIC_API_KEY).' });
      const request = await loadRequest(pool, req.workspaceId, parseId(req.params.requestId));
      if (!request) return res.status(404).json({ error: 'Request not found.' });
      const existing = await getInsight(pool, request.id);
      if (!existing) await runRuleChecks(pool, request.id, { aiEnabled: true });
      else await pool.query("UPDATE request_insights SET ai_status = 'pending', ai_error = NULL WHERE request_id = $1", [request.id]);
      startAi(request.id);
      res.status(202).json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // ---------- Resubmit after changes were requested ----------
  router.post('/:requestId/resubmit', async (req, res, next) => {
    try {
      const request = await loadRequest(pool, req.workspaceId, parseId(req.params.requestId));
      if (!request || request.requester_id !== req.user.id) return res.status(404).json({ error: 'Request not found.' });
      if (request.status !== 'changes_requested') return res.status(409).json({ error: 'Only requests sent back for changes can be resubmitted.' });
      const { data, error } = validate({ ...req.body, type: request.type });
      if (error) return res.status(400).json({ error });

      let approvers;
      try {
        approvers = await resolveApprovers(pool, { workspaceId: req.workspaceId, type: data.type, requesterId: req.user.id, amount: data.amount });
      } catch (err) {
        if (err instanceof ChainError) return res.status(422).json({ error: err.message });
        throw err;
      }
      const round = request.round + 1;
      let firstActive = null;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const moved = await client.query(
          `UPDATE requests SET title = $1, description = $2, amount = $3, currency = $4, vendor = $5, start_date = $6, end_date = $7,
                  status = $8, round = $9, decided_at = $10 WHERE id = $11 AND status = 'changes_requested'`,
          [data.title, data.description, data.amount, data.currency, data.vendor, data.start_date, data.end_date,
            approvers.some((a) => a.status === 'waiting') ? 'pending' : 'approved', round,
            approvers.some((a) => a.status === 'waiting') ? null : new Date(), request.id]
        );
        if (!moved.rowCount) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'This request was already resubmitted.' });
        }
        const { rows: [last] } = await client.query('SELECT MAX(position) AS p FROM request_approvals WHERE request_id = $1', [request.id]);
        firstActive = await insertApprovals(client, request.id, approvers,
          { round, after: Number(last.p) || 0, workspaceId: req.workspaceId, requesterId: req.user.id });
        await audit(client, {
          workspaceId: req.workspaceId, actorId: req.user.id, action: 'request.resubmitted', entityType: 'request', entityId: request.id,
          details: { title: data.title, amount: data.amount, currency: data.currency, round },
        });
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      // Fresh checks for the edited request.
      await pool.query('DELETE FROM request_insights WHERE request_id = $1', [request.id]);
      await runRuleChecks(pool, request.id, { aiEnabled: Boolean(insights.classifier) }).catch((err) => console.error('Rule checks failed:', err));
      startAi(request.id);
      const updated = await loadRequest(pool, req.workspaceId, request.id);
      if (firstActive) await notifyApprover(updated, firstActive);
      else await notifyRequester(updated, 'approved', 'Greenlight');
      res.json({ ...updated, requester_email: undefined, approvals: await loadApprovals(pool, request.id) });
    } catch (err) {
      next(err);
    }
  });

  // ---------- Receipts and other files ----------
  async function openForFiles(req, res) {
    const request = await loadRequest(pool, req.workspaceId, parseId(req.params.requestId));
    if (!request || !(await canViewRequest(pool, { request, userId: req.user.id, role: req.role }))) {
      res.status(404).json({ error: 'Request not found.' });
      return null;
    }
    return request;
  }

  router.post('/:requestId/files', async (req, res, next) => {
    try {
      const request = await openForFiles(req, res);
      if (!request) return;
      if (request.requester_id !== req.user.id) return res.status(403).json({ error: 'Only the person who submitted the request can attach files.' });
      if (!ATTACHABLE.includes(request.status)) return res.status(409).json({ error: `Files can't be added to a ${request.status} request.` });
      const filename = String(req.body?.filename || '').replace(/[\x00-\x1f/\\]/g, '').trim().slice(0, 120);
      const type = String(req.body?.content_type || '');
      const data = typeof req.body?.data === 'string' ? Buffer.from(req.body.data, 'base64') : Buffer.alloc(0);
      if (!filename) return res.status(400).json({ error: 'The file needs a name.' });
      if (!FILE_TYPES[type] || !FILE_TYPES[type](data)) return res.status(400).json({ error: 'Attach a photo (JPG, PNG, WebP, GIF) or a PDF.' });
      if (data.length > MAX_FILE_BYTES) return res.status(413).json({ error: 'Files can be at most 5 MB.' });
      const { rows: [count] } = await pool.query('SELECT COUNT(*)::int AS n FROM request_files WHERE request_id = $1', [request.id]);
      if (count.n >= MAX_FILES) return res.status(409).json({ error: `A request can have at most ${MAX_FILES} files.` });
      const { rows: [file] } = await pool.query(
        `INSERT INTO request_files (request_id, filename, content_type, size_bytes, data_base64, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, filename, content_type, size_bytes, created_at`,
        [request.id, filename, type, data.length, data.toString('base64'), req.user.id]
      );
      await audit(pool, { workspaceId: req.workspaceId, actorId: req.user.id, action: 'request.file_added', entityType: 'request', entityId: request.id, details: { filename } });
      res.status(201).json(file);
    } catch (err) {
      next(err);
    }
  });

  router.get('/:requestId/files/:fileId', async (req, res, next) => {
    try {
      const request = await openForFiles(req, res);
      if (!request) return;
      const { rows: [file] } = await pool.query(
        'SELECT filename, content_type, data_base64 FROM request_files WHERE id = $1 AND request_id = $2', [parseId(req.params.fileId), request.id]);
      if (!file) return res.status(404).json({ error: 'File not found.' });
      // Served as-is, never run: a strict policy blocks scripts even if a file was crafted to contain them.
      res.set('Content-Type', file.content_type);
      res.set('Content-Disposition', `inline; filename="${file.filename.replace(/[^\w.\- ]/g, '_')}"`);
      res.set('Cache-Control', 'private, max-age=3600');
      if (file.content_type !== 'application/pdf') res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
      res.send(Buffer.from(file.data_base64, 'base64'));
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:requestId/files/:fileId', async (req, res, next) => {
    try {
      const request = await openForFiles(req, res);
      if (!request) return;
      if (request.requester_id !== req.user.id) return res.status(403).json({ error: 'Only the person who submitted the request can remove files.' });
      if (!OPEN.includes(request.status)) return res.status(409).json({ error: `Files can't be removed once a request is ${request.status}.` });
      const { rows: [file] } = await pool.query('DELETE FROM request_files WHERE id = $1 AND request_id = $2 RETURNING filename', [parseId(req.params.fileId), request.id]);
      if (!file) return res.status(404).json({ error: 'File not found.' });
      await audit(pool, { workspaceId: req.workspaceId, actorId: req.user.id, action: 'request.file_removed', entityType: 'request', entityId: request.id, details: { filename: file.filename } });
      res.json({ ok: true });
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
      const cancelled = await pool.query(
        "UPDATE requests SET status = 'cancelled', decided_at = NOW() WHERE id = $1 AND status IN ('pending', 'changes_requested')", [request.id]);
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

module.exports = { requestRoutes, insertApprovals };
