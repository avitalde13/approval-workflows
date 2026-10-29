// Time off balances and the team calendar.
//
//   GET   /api/workspaces/:id/time-off/balance                 your balance this year
//   GET   /api/workspaces/:id/time-off/balances                Managers: their team; Admins: everyone
//   PATCH /api/workspaces/:id/time-off/allowance/:userId       { vacation_days }  (Admins; null = workspace default)
//   GET   /api/workspaces/:id/time-off/calendar?month=YYYY-MM  who's out (every member can see names and dates)

const express = require('express');
const { requireUser } = require('../auth/sessions');
const { requireMember } = require('../permissions');
const { parseId } = require('../workspaces');
const { audit } = require('../audit');
const { balances, calendar } = require('../timeoff');

function timeOffRoutes(pool) {
  const router = express.Router({ mergeParams: true });
  router.use(requireUser, requireMember(pool));

  router.get('/balance', async (req, res, next) => {
    try {
      const [mine] = await balances(pool, req.workspaceId, { userIds: [req.user.id] });
      res.json(mine);
    } catch (err) {
      next(err);
    }
  });

  router.get('/balances', async (req, res, next) => {
    try {
      if (req.role === 'employee') return res.status(403).json({ error: 'Only Managers and Admins can see team balances.' });
      let userIds = null;
      if (req.role === 'manager') {
        const { rows } = await pool.query('SELECT user_id FROM memberships WHERE workspace_id = $1 AND (manager_id = $2 OR user_id = $2)', [req.workspaceId, req.user.id]);
        userIds = rows.map((r) => r.user_id);
      }
      const { rows: [w] } = await pool.query('SELECT vacation_days FROM workspaces WHERE id = $1', [req.workspaceId]);
      res.json({ default_days: w.vacation_days, balances: await balances(pool, req.workspaceId, { userIds }) });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/allowance/:userId', async (req, res, next) => {
    try {
      if (req.role !== 'admin') return res.status(403).json({ error: 'Only workspace Admins can do this.' });
      const userId = parseId(req.params.userId);
      const v = req.body?.vacation_days;
      const days = v === null || v === '' ? null : Number(v);
      if (days !== null && (!Number.isInteger(days) || days < 0 || days > 365)) return res.status(400).json({ error: 'Use a whole number of days (0–365), or empty for the default.' });
      const updated = await pool.query('UPDATE memberships SET vacation_days = $1 WHERE workspace_id = $2 AND user_id = $3', [days, req.workspaceId, userId]);
      if (!updated.rowCount) return res.status(404).json({ error: 'Member not found.' });
      await audit(pool, { workspaceId: req.workspaceId, actorId: req.user.id, action: 'member.allowance_changed', entityType: 'user', entityId: userId, details: { vacation_days: days } });
      const [b] = await balances(pool, req.workspaceId, { userIds: [userId] });
      res.json(b);
    } catch (err) {
      next(err);
    }
  });

  router.get('/calendar', async (req, res, next) => {
    try {
      const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : new Date().toISOString().slice(0, 7);
      const [y, m] = month.split('-').map(Number);
      const from = `${month}-01`;
      const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      const entries = await calendar(pool, req.workspaceId, from, to);
      // Everyone sees who is out and when; the request title only for the person themself, Managers and Admins.
      const showTitle = req.role !== 'employee';
      res.json({ month, from, to, entries: entries.map((e) => ({ ...e, title: showTitle || e.requester_id === req.user.id ? e.title : null })) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { timeOffRoutes };
