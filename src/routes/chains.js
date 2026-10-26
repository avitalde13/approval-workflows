// Approval chain settings.
//
//   GET /api/workspaces/:id/approval-chains            (members)  all three chains
//   PUT /api/workspaces/:id/approval-chains/:type      (Admins)   { steps: [{ name, approver_type, approver_user_id?, min_amount? }] }

const express = require('express');
const { requireUser } = require('../auth/sessions');
const { requireMember } = require('../permissions');
const { REQUEST_TYPES, getChain } = require('../chains');
const { audit } = require('../audit');

const MAX_STEPS = 5;

function chainRoutes(pool) {
  const router = express.Router({ mergeParams: true });
  router.use(requireUser);

  router.get('/', requireMember(pool), async (req, res, next) => {
    try {
      const chains = {};
      for (const type of REQUEST_TYPES) chains[type] = await getChain(pool, req.workspaceId, type);
      res.json(chains);
    } catch (err) {
      next(err);
    }
  });

  router.put('/:type', requireMember(pool, 'admin'), async (req, res, next) => {
    const type = req.params.type;
    if (!REQUEST_TYPES.includes(type)) return res.status(404).json({ error: 'Unknown request type.' });
    const steps = req.body?.steps;
    if (!Array.isArray(steps) || steps.length < 1 || steps.length > MAX_STEPS) {
      return res.status(400).json({ error: `A chain needs 1 to ${MAX_STEPS} steps.` });
    }

    const clean = [];
    for (const [i, s] of steps.entries()) {
      const name = typeof s?.name === 'string' ? s.name.trim() : '';
      if (name.length < 1 || name.length > 40) return res.status(400).json({ error: `Step ${i + 1}: name must be 1–40 characters.` });
      if (!['manager', 'user'].includes(s.approver_type)) return res.status(400).json({ error: `Step ${i + 1}: approver must be "manager" or "user".` });
      let approverUserId = null;
      if (s.approver_type === 'user') {
        approverUserId = Number(s.approver_user_id);
        const member = await pool.query('SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2', [req.workspaceId, approverUserId]);
        if (!Number.isInteger(approverUserId) || !member.rows.length) {
          return res.status(400).json({ error: `Step ${i + 1}: the approver must be a member of this workspace.` });
        }
      }
      let minAmount = null;
      if (s.min_amount !== undefined && s.min_amount !== null && s.min_amount !== '') {
        if (type === 'time_off') return res.status(400).json({ error: 'Time-off requests have no amount, so steps cannot have a minimum amount.' });
        minAmount = Number(s.min_amount);
        if (!Number.isFinite(minAmount) || minAmount < 0) return res.status(400).json({ error: `Step ${i + 1}: minimum amount must be 0 or more.` });
      }
      clean.push({ position: i + 1, name, approver_type: s.approver_type, approver_user_id: approverUserId, min_amount: minAmount });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM approval_steps WHERE workspace_id = $1 AND request_type = $2', [req.workspaceId, type]);
      for (const s of clean) {
        await client.query(
          `INSERT INTO approval_steps (workspace_id, request_type, position, name, approver_type, approver_user_id, min_amount)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [req.workspaceId, type, s.position, s.name, s.approver_type, s.approver_user_id, s.min_amount]
        );
      }
      await audit(client, { workspaceId: req.workspaceId, actorId: req.user.id, action: 'chain.updated', entityType: 'approval_chain', details: { type, steps: clean } });
      await client.query('COMMIT');
      res.json(await getChain(pool, req.workspaceId, type));
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      next(err);
    } finally {
      client.release();
    }
  });

  return router;
}

module.exports = { chainRoutes };
