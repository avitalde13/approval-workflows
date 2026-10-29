// The bell: the signed-in person's latest notifications across their workspaces.
//
//   GET  /api/notifications              { unread, items: [...] }
//   POST /api/notifications/read         { ids: [..] } or {} for all

const express = require('express');
const { requireUser } = require('../auth/sessions');

function notificationRoutes(pool) {
  const router = express.Router();
  router.use(requireUser);

  router.get('/', async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT n.id, n.workspace_id, w.name AS workspace_name, n.request_id, n.kind, n.title, n.body, n.read_at, n.created_at
           FROM notifications n JOIN workspaces w ON w.id = n.workspace_id
           JOIN memberships m ON m.workspace_id = n.workspace_id AND m.user_id = n.user_id
          WHERE n.user_id = $1 ORDER BY n.id DESC LIMIT 30`,
        [req.user.id]
      );
      const unread = await pool.query('SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [req.user.id]);
      res.json({ unread: unread.rows[0].n, items: rows });
    } catch (err) {
      next(err);
    }
  });

  router.post('/read', async (req, res, next) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger).slice(0, 100) : null;
      if (ids && ids.length) {
        const list = ids.map((_, i) => `$${i + 2}`).join(', ');
        await pool.query(`UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL AND id IN (${list})`, [req.user.id, ...ids]);
      } else {
        await pool.query('UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL', [req.user.id]);
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { notificationRoutes };
