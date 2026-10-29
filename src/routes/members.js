// Member management (Admins): change a member's role, set who they report to, remove them.
//
//   PATCH  /api/workspaces/:id/members/:userId   { role?, manager_id? }   manager_id: null clears it
//   DELETE /api/workspaces/:id/members/:userId

const express = require('express');
const { requireUser } = require('../auth/sessions');
const { requireMember } = require('../permissions');
const { parseId } = require('../workspaces');
const { audit } = require('../audit');

const ROLES = ['admin', 'manager', 'employee'];

async function getMember(db, workspaceId, userId) {
  const { rows } = await db.query(
    `SELECT m.user_id, m.role, m.manager_id, u.name, u.email
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = $1 AND m.user_id = $2`,
    [workspaceId, userId]
  );
  return rows[0] || null;
}

async function adminCount(db, workspaceId) {
  const { rows } = await db.query("SELECT COUNT(*)::int AS n FROM memberships WHERE workspace_id = $1 AND role = 'admin'", [workspaceId]);
  return rows[0].n;
}

// True if making `managerId` the manager of `userId` would create a loop (A → B → … → A).
async function createsCycle(db, workspaceId, userId, managerId) {
  let current = managerId;
  for (let i = 0; i < 100 && current; i++) {
    if (current === userId) return true;
    const { rows } = await db.query('SELECT manager_id FROM memberships WHERE workspace_id = $1 AND user_id = $2', [workspaceId, current]);
    current = rows[0]?.manager_id || null;
  }
  return false;
}

function memberRoutes(pool) {
  const router = express.Router({ mergeParams: true });
  router.use(requireUser, requireMember(pool, 'admin'));

  router.patch('/:userId', async (req, res, next) => {
    try {
      const userId = parseId(req.params.userId);
      const member = userId && (await getMember(pool, req.workspaceId, userId));
      if (!member) return res.status(404).json({ error: 'Member not found.' });
      const body = req.body || {};
      const changes = {};

      if ('role' in body) {
        if (!ROLES.includes(body.role)) return res.status(400).json({ error: 'Role must be admin, manager or employee.' });
        if (member.role === 'admin' && body.role !== 'admin' && (await adminCount(pool, req.workspaceId)) === 1) {
          return res.status(400).json({ error: 'A workspace needs at least one Admin.' });
        }
        if (body.role !== member.role) changes.role = body.role;
      }

      if ('manager_id' in body) {
        const managerId = body.manager_id === null ? null : parseId(body.manager_id);
        if (body.manager_id !== null && !managerId) return res.status(400).json({ error: 'manager_id must be a member id or null.' });
        if (managerId === userId) return res.status(400).json({ error: "Someone can't be their own manager." });
        if (managerId) {
          if (!(await getMember(pool, req.workspaceId, managerId))) return res.status(400).json({ error: 'The manager must be a member of this workspace.' });
          if (await createsCycle(pool, req.workspaceId, userId, managerId)) {
            return res.status(400).json({ error: 'That would create a loop in the reporting lines.' });
          }
        }
        if (managerId !== member.manager_id) changes.manager_id = managerId;
      }

      if ('department_id' in body) {
        const deptId = body.department_id === null ? null : parseId(body.department_id);
        if (deptId) {
          const dept = await pool.query('SELECT 1 FROM departments WHERE id = $1 AND workspace_id = $2', [deptId, req.workspaceId]);
          if (!dept.rows.length) return res.status(400).json({ error: 'Pick a department from this workspace.' });
        }
        await pool.query('UPDATE memberships SET department_id = $1 WHERE workspace_id = $2 AND user_id = $3', [deptId, req.workspaceId, userId]);
        await audit(pool, { workspaceId: req.workspaceId, actorId: req.user.id, action: 'member.department_changed', entityType: 'user', entityId: userId,
          details: { email: member.email, to: deptId } });
      }

      if ('role' in changes) {
        await pool.query('UPDATE memberships SET role = $1 WHERE workspace_id = $2 AND user_id = $3', [changes.role, req.workspaceId, userId]);
        await audit(pool, {
          workspaceId: req.workspaceId, actorId: req.user.id, action: 'member.role_changed', entityType: 'user', entityId: userId,
          details: { email: member.email, from: member.role, to: changes.role },
        });
      }
      if ('manager_id' in changes) {
        await pool.query('UPDATE memberships SET manager_id = $1 WHERE workspace_id = $2 AND user_id = $3', [changes.manager_id, req.workspaceId, userId]);
        await audit(pool, {
          workspaceId: req.workspaceId, actorId: req.user.id, action: 'member.manager_changed', entityType: 'user', entityId: userId,
          details: { email: member.email, from: member.manager_id, to: changes.manager_id },
        });
      }
      res.json(await getMember(pool, req.workspaceId, userId));
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:userId', async (req, res, next) => {
    try {
      const userId = parseId(req.params.userId);
      const member = userId && (await getMember(pool, req.workspaceId, userId));
      if (!member) return res.status(404).json({ error: 'Member not found.' });
      if (member.role === 'admin' && (await adminCount(pool, req.workspaceId)) === 1) {
        return res.status(400).json({ error: 'A workspace needs at least one Admin.' });
      }
      const waiting = await pool.query(
        `SELECT COUNT(*)::int AS n FROM request_approvals a JOIN requests r ON r.id = a.request_id
          WHERE r.workspace_id = $1 AND a.approver_id = $2 AND a.status IN ('pending', 'waiting') AND r.status = 'pending'`,
        [req.workspaceId, userId]
      );
      if (waiting.rows[0].n > 0) {
        return res.status(409).json({ error: `${member.name} still has ${waiting.rows[0].n} approval(s) waiting. Reassign or finish them first.` });
      }
      await pool.query('UPDATE memberships SET manager_id = NULL WHERE workspace_id = $1 AND manager_id = $2', [req.workspaceId, userId]);
      await pool.query('UPDATE approval_steps SET approver_user_id = NULL WHERE workspace_id = $1 AND approver_user_id = $2', [req.workspaceId, userId]);
      await pool.query('DELETE FROM memberships WHERE workspace_id = $1 AND user_id = $2', [req.workspaceId, userId]);
      await audit(pool, {
        workspaceId: req.workspaceId, actorId: req.user.id, action: 'member.removed', entityType: 'user', entityId: userId,
        details: { email: member.email, role: member.role },
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { memberRoutes };
