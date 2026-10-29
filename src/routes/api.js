// JSON API for the signed-in user: profile, workspaces, members.

const crypto = require('crypto');
const express = require('express');
const { requireUser } = require('../auth/sessions');
const { membershipRole, parseId } = require('../workspaces');
const { audit } = require('../audit');

const NAME_MIN = 2;
const NAME_MAX = 80;

function slugify(name) {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'workspace';
  return `${base}-${crypto.randomBytes(3).toString('hex')}`;
}


function apiRoutes(pool) {
  const router = express.Router();
  router.use(requireUser);

  router.get('/me', async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT w.id, w.name, w.slug, m.role, w.demo_expires_at
           FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
          WHERE m.user_id = $1
          ORDER BY w.created_at, w.id`,
        [req.user.id]
      );
      res.json({ user: req.user, workspaces: rows });
    } catch (err) {
      next(err);
    }
  });

  // Create a workspace (one per company). The creator becomes its Admin.
  router.post('/workspaces', async (req, res, next) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().replace(/\s+/g, ' ') : '';
    if (name.length < NAME_MIN || name.length > NAME_MAX) {
      return res.status(400).json({ error: `Workspace name must be ${NAME_MIN}–${NAME_MAX} characters.` });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Workspaces made by demo visitors are deleted along with the demo.
      const expires = req.user.is_demo
        ? (await client.query('SELECT MAX(s.expires_at) AS e FROM sessions s WHERE s.user_id = $1', [req.user.id])).rows[0].e
        : null;
      const { rows } = await client.query(
        'INSERT INTO workspaces (name, slug, created_by, demo_expires_at) VALUES ($1, $2, $3, $4) RETURNING id, name, slug, created_at',
        [name, slugify(name), req.user.id, expires]
      );
      await client.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')", [rows[0].id, req.user.id]);
      await audit(client, { workspaceId: rows[0].id, actorId: req.user.id, action: 'workspace.created', entityType: 'workspace', entityId: rows[0].id, details: { name } });
      await client.query('COMMIT');
      res.status(201).json({ ...rows[0], role: 'admin' });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      next(err);
    } finally {
      client.release();
    }
  });

  // Workspace details and members. Non-members get 404, so other companies' workspaces stay invisible.
  router.get('/workspaces/:id', async (req, res, next) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Workspace not found.' });
    try {
      const role = await membershipRole(pool, id, req.user.id);
      if (!role) return res.status(404).json({ error: 'Workspace not found.' });
      const ws = await pool.query('SELECT id, name, slug, created_at, demo_expires_at FROM workspaces WHERE id = $1', [id]);
      const members = await pool.query(
        `SELECT u.id, u.name, u.email, u.avatar_url, m.role, m.manager_id, m.created_at AS joined_at
           FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.workspace_id = $1
          ORDER BY CASE m.role WHEN 'admin' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, u.name`,
        [id]
      );
      res.json({ ...ws.rows[0], role, members: members.rows });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { apiRoutes };
