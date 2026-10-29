// Workspace settings (Admins change them; every member can read them) and each member's out-of-office.
//
//   GET   /api/workspaces/:id/settings
//   PATCH /api/workspaces/:id/settings      { reminder_hours, escalate_hours }        (Admins)
//   PUT   /api/workspaces/:id/away          { away_from, away_until, delegate_id }    (yourself)
//   DELETE /api/workspaces/:id/away

const express = require('express');
const { requireUser } = require('../auth/sessions');
const { requireMember } = require('../permissions');
const { audit } = require('../audit');
const { activateStep, awayInfo } = require('../routing');
const { loadRequestInfo } = require('../notifier');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Hours between 1 and 30 days, or null (off).
function hoursOrNull(v) {
  if (v === null || v === '' || v === undefined) return { value: null };
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 720) return { error: 'Use a whole number of hours between 1 and 720, or leave it empty to turn it off.' };
  return { value: n };
}

async function loadSettings(pool, workspaceId) {
  const { rows } = await pool.query('SELECT reminder_hours, escalate_hours FROM workspaces WHERE id = $1', [workspaceId]);
  return rows[0];
}

function settingsRoutes(pool, notifier) {
  const router = express.Router({ mergeParams: true });
  router.use(requireUser);

  router.get('/settings', requireMember(pool), async (req, res, next) => {
    try {
      res.json(await loadSettings(pool, req.workspaceId));
    } catch (err) {
      next(err);
    }
  });

  router.patch('/settings', requireMember(pool, 'admin'), async (req, res, next) => {
    try {
      const body = req.body || {};
      const changes = {};
      for (const key of ['reminder_hours', 'escalate_hours']) {
        if (!(key in body)) continue;
        const { value, error } = hoursOrNull(body[key]);
        if (error) return res.status(400).json({ error });
        changes[key] = value;
      }
      const next_ = { ...(await loadSettings(pool, req.workspaceId)), ...changes };
      if (next_.reminder_hours && next_.escalate_hours && next_.escalate_hours <= next_.reminder_hours) {
        return res.status(400).json({ error: 'Escalation should come after the reminder.' });
      }
      for (const [key, value] of Object.entries(changes)) {
        await pool.query(`UPDATE workspaces SET ${key} = $1 WHERE id = $2`, [value, req.workspaceId]); // key is from the fixed list above
      }
      if (Object.keys(changes).length) {
        await audit(pool, { workspaceId: req.workspaceId, actorId: req.user.id, action: 'settings.updated', entityType: 'workspace', entityId: req.workspaceId, details: changes });
      }
      res.json(await loadSettings(pool, req.workspaceId));
    } catch (err) {
      next(err);
    }
  });

  // Out of office. Approvals already waiting for you move to your delegate right away (if you're away today).
  router.put('/away', requireMember(pool), async (req, res, next) => {
    try {
      const { away_from: from, away_until: until } = req.body || {};
      const delegateId = Number(req.body?.delegate_id) || null;
      if ((from && !DATE_RE.test(from)) || !DATE_RE.test(until || '')) return res.status(400).json({ error: 'Pick the dates you are away (YYYY-MM-DD).' });
      if (from && until < from) return res.status(400).json({ error: 'The last day must be on or after the first day.' });
      if (!delegateId || delegateId === req.user.id) return res.status(400).json({ error: 'Pick someone to approve for you while you are away.' });
      const member = await pool.query('SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2', [req.workspaceId, delegateId]);
      if (!member.rows.length) return res.status(400).json({ error: 'The delegate must be a member of this workspace.' });

      await pool.query('UPDATE memberships SET away_from = $1, away_until = $2, delegate_id = $3 WHERE workspace_id = $4 AND user_id = $5',
        [from || null, until, delegateId, req.workspaceId, req.user.id]);
      await audit(pool, { workspaceId: req.workspaceId, actorId: req.user.id, action: 'member.away_set', entityType: 'user', entityId: req.user.id,
        details: { from: from || null, until, delegate_id: delegateId } });

      let moved = 0;
      if (awayInfo({ away_from: from, away_until: until, delegate_id: delegateId }).away) {
        const { rows } = await pool.query(
          `SELECT a.id, r.id AS request_id, r.requester_id FROM request_approvals a JOIN requests r ON r.id = a.request_id
            WHERE r.workspace_id = $1 AND a.approver_id = $2 AND a.status = 'pending' AND r.status = 'pending'`,
          [req.workspaceId, req.user.id]
        );
        for (const step of rows) {
          const routed = await activateStep(pool, step.id, { workspaceId: req.workspaceId, requesterId: step.requester_id, approverId: req.user.id });
          if (routed.delegatedFrom) {
            moved++;
            await notifier.approvalNeeded(await loadRequestInfo(pool, step.request_id), routed.approverId,
              { kind: 'delegated', note: `${req.user.name} is out of office and asked you to approve on their behalf.` });
          }
        }
      }
      res.json({ ok: true, moved });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/away', requireMember(pool), async (req, res, next) => {
    try {
      await pool.query('UPDATE memberships SET away_from = NULL, away_until = NULL, delegate_id = NULL WHERE workspace_id = $1 AND user_id = $2',
        [req.workspaceId, req.user.id]);
      await audit(pool, { workspaceId: req.workspaceId, actorId: req.user.id, action: 'member.away_cleared', entityType: 'user', entityId: req.user.id });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { settingsRoutes };
