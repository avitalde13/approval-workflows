// Invitations: Admins invite people by email; the invitee opens the link, signs in and accepts.
//
//   POST   /api/workspaces/:id/invitations            { email, role }   (Admin) create or re-send
//   GET    /api/workspaces/:id/invitations                              (Admin) pending invitations
//   DELETE /api/workspaces/:id/invitations/:inviteId                    (Admin) revoke
//   GET    /auth/invitations/:token                                     (anyone with the link) invitation details
//   POST   /api/invitations/:token/accept                               (signed in, matching email) join

const crypto = require('crypto');
const express = require('express');
const { config } = require('../config');
const { requireUser } = require('../auth/sessions');
const { membershipRole, parseId } = require('../workspaces');
const templates = require('../email/templates');
const { audit } = require('../audit');

const ROLES = ['admin', 'manager', 'employee'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_PENDING = 200;
const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');
const TOKEN_RE = /^[A-Za-z0-9_-]{20,100}$/;

// Middleware: only Admins of :id. Non-members get 404 so other companies' workspaces stay invisible.
function requireAdmin(pool) {
  return async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      const role = id && (await membershipRole(pool, id, req.user.id));
      if (!role) return res.status(404).json({ error: 'Workspace not found.' });
      if (role !== 'admin') return res.status(403).json({ error: 'Only workspace Admins can manage invitations.' });
      req.workspaceId = id;
      next();
    } catch (err) {
      next(err);
    }
  };
}

// Looks up a usable invitation by its link token, with workspace and inviter names.
async function findByToken(pool, token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const { rows } = await pool.query(
    `SELECT i.id, i.workspace_id, i.email, i.role, i.expires_at, i.accepted_at, i.revoked_at,
            w.name AS workspace_name, u.name AS inviter_name
       FROM invitations i
       JOIN workspaces w ON w.id = i.workspace_id
       JOIN users u ON u.id = i.invited_by
      WHERE i.token_hash = $1`,
    [hash(token)]
  );
  return rows[0] || null;
}

function invitationState(inv) {
  if (!inv) return 'not_found';
  if (inv.revoked_at) return 'revoked';
  if (inv.accepted_at) return 'accepted';
  if (new Date(inv.expires_at) <= new Date()) return 'expired';
  return 'pending';
}

function invitationRoutes(pool, mailer) {
  const admin = express.Router({ mergeParams: true });
  admin.use(requireUser, requireAdmin(pool));

  admin.get('/', async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT i.id, i.email, i.role, i.created_at, i.expires_at, u.name AS invited_by_name
           FROM invitations i JOIN users u ON u.id = i.invited_by
          WHERE i.workspace_id = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > NOW()
          ORDER BY i.created_at DESC, i.id DESC`,
        [req.workspaceId]
      );
      res.json({ invitations: rows });
    } catch (err) {
      next(err);
    }
  });

  // Creates an invitation and emails it. Inviting the same email again replaces the old link.
  admin.post('/', async (req, res, next) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const role = req.body?.role || 'employee';
    if (!EMAIL_RE.test(email) || email.length > 254) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'Role must be admin, manager or employee.' });

    try {
      const member = await pool.query(
        'SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND u.email = $2',
        [req.workspaceId, email]
      );
      if (member.rows.length) return res.status(409).json({ error: `${email} is already a member of this workspace.` });

      const pending = await pool.query(
        'SELECT COUNT(*)::int AS n FROM invitations WHERE workspace_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()',
        [req.workspaceId]
      );
      if (pending.rows[0].n >= MAX_PENDING) return res.status(429).json({ error: 'Too many pending invitations. Revoke some first.' });

      // Retire any older pending invitation for this email, so only the newest link works.
      await pool.query(
        'UPDATE invitations SET revoked_at = NOW() WHERE workspace_id = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL',
        [req.workspaceId, email]
      );

      const token = crypto.randomBytes(24).toString('base64url');
      const expiresAt = new Date(Date.now() + config.inviteDays * 24 * 60 * 60 * 1000);
      const { rows } = await pool.query(
        `INSERT INTO invitations (workspace_id, email, role, token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, email, role, created_at, expires_at`,
        [req.workspaceId, email, role, hash(token), req.user.id, expiresAt]
      );
      const ws = await pool.query('SELECT name FROM workspaces WHERE id = $1', [req.workspaceId]);

      const link = `${config.appUrl}/invite/${token}`;
      const message = templates.invitation({
        workspaceName: ws.rows[0].name,
        inviterName: req.user.name,
        role,
        link,
        expiresAt,
      });
      try {
        await mailer.send({ to: email, ...message });
      } catch (err) {
        console.error('Invitation email failed:', err.message);
        await pool.query('UPDATE invitations SET revoked_at = NOW() WHERE id = $1', [rows[0].id]);
        return res.status(502).json({ error: "The invitation email couldn't be sent. Please try again." });
      }
      await audit(pool, {
        workspaceId: req.workspaceId, actorId: req.user.id, action: 'invitation.sent', entityType: 'invitation', entityId: rows[0].id,
        details: { email, role },
      });
      // Without an email provider, the Admin gets the link to share it themselves.
      const emailed = mailer.provider !== 'none';
      res.status(201).json({ ...rows[0], invited_by_name: req.user.name, emailed, ...(emailed ? {} : { link }) });
    } catch (err) {
      next(err);
    }
  });

  admin.delete('/:inviteId', async (req, res, next) => {
    try {
      const inviteId = parseId(req.params.inviteId);
      const result = await pool.query(
        'UPDATE invitations SET revoked_at = NOW() WHERE id = $1 AND workspace_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL',
        [inviteId, req.workspaceId]
      );
      if (!result.rowCount) return res.status(404).json({ error: 'Invitation not found.' });
      await audit(pool, { workspaceId: req.workspaceId, actorId: req.user.id, action: 'invitation.revoked', entityType: 'invitation', entityId: inviteId });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // Public: what the invite link is for (used by the /invite/:token page before signing in).
  const publicRouter = express.Router();
  publicRouter.get('/invitations/:token', async (req, res, next) => {
    try {
      const inv = await findByToken(pool, req.params.token);
      const state = invitationState(inv);
      if (state === 'not_found') return res.status(404).json({ state, error: 'This invitation link is not valid.' });
      res.json({
        state,
        workspace_name: inv.workspace_name,
        inviter_name: inv.inviter_name,
        role: inv.role,
        email: inv.email,
        expires_at: inv.expires_at,
      });
    } catch (err) {
      next(err);
    }
  });

  const accept = express.Router();
  accept.use(requireUser);
  accept.post('/:token/accept', async (req, res, next) => {
    try {
      const inv = await findByToken(pool, req.params.token);
      const state = invitationState(inv);
      if (state === 'not_found') return res.status(404).json({ error: 'This invitation link is not valid.' });
      if (state !== 'pending') return res.status(410).json({ error: `This invitation has ${state === 'expired' ? 'expired' : 'already been ' + state}.` });
      if (inv.email !== req.user.email.toLowerCase()) {
        return res.status(403).json({ error: `This invitation is for ${inv.email}. Sign in with that email to accept it.` });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const existing = await client.query('SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2', [inv.workspace_id, req.user.id]);
        if (!existing.rows.length) {
          await client.query('INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)', [inv.workspace_id, req.user.id, inv.role]);
        }
        await client.query('UPDATE invitations SET accepted_at = NOW(), accepted_by = $1 WHERE id = $2', [req.user.id, inv.id]);
        await audit(client, {
          workspaceId: inv.workspace_id, actorId: req.user.id, action: 'member.joined', entityType: 'user', entityId: req.user.id,
          details: { email: inv.email, role: inv.role, invitation_id: inv.id },
        });
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
      res.json({ ok: true, workspace_id: inv.workspace_id });
    } catch (err) {
      next(err);
    }
  });

  return { admin, publicRouter, accept };
}

module.exports = { invitationRoutes };
