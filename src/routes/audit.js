// Audit log (Admins). Newest first, paged with ?before=<id>.
//
//   GET /api/workspaces/:id/audit-log?limit=50&before=123

const express = require('express');
const { requireUser } = require('../auth/sessions');
const { requireMember } = require('../permissions');

function auditRoutes(pool) {
  const router = express.Router({ mergeParams: true });
  router.use(requireUser, requireMember(pool, 'admin'));

  router.get('/', async (req, res, next) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const before = Number(req.query.before) || null;
    try {
      const params = [req.workspaceId, limit];
      if (before) params.push(before);
      const { rows } = await pool.query(
        `SELECT a.id, a.action, a.entity_type, a.entity_id, a.details, a.created_at, a.actor_id, u.name AS actor_name, u.email AS actor_email
           FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
          WHERE a.workspace_id = $1${before ? ' AND a.id < $3' : ''}
          ORDER BY a.id DESC LIMIT $2`,
        params
      );
      res.json({ entries: rows, next_before: rows.length === limit ? rows[rows.length - 1].id : null });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { auditRoutes };
