// Role-based access control.
//
//   Role      | Can
//   ----------|--------------------------------------------------------------------------
//   Employee  | submit requests, see their own requests, act on approvals assigned to them
//   Manager   | + see their direct reports' requests
//   Admin     | + manage members and roles, configure approval chains, see all requests, read the audit log
//
// Non-members always get 404, so other companies' workspaces stay invisible.

const { membershipRole, parseId } = require('./workspaces');

const RANK = { employee: 1, manager: 2, admin: 3 };

// Middleware: the user must be a member of :id with at least `minRole`. Sets req.workspaceId and req.role.
function requireMember(pool, minRole = 'employee') {
  return async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      const role = id && (await membershipRole(pool, id, req.user.id));
      if (!role) return res.status(404).json({ error: 'Workspace not found.' });
      if (RANK[role] < RANK[minRole]) {
        return res.status(403).json({ error: `Only ${minRole === 'admin' ? 'workspace Admins' : 'Managers and Admins'} can do this.` });
      }
      req.workspaceId = id;
      req.role = role;
      next();
    } catch (err) {
      next(err);
    }
  };
}

// Whether the signed-in user may see a request: requester, any approver in its chain,
// the requester's manager, or an Admin.
async function canViewRequest(pool, { request, userId, role }) {
  if (role === 'admin' || request.requester_id === userId) return true;
  const approver = await pool.query('SELECT 1 FROM request_approvals WHERE request_id = $1 AND approver_id = $2', [request.id, userId]);
  if (approver.rows.length) return true;
  const manager = await pool.query(
    'SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2 AND manager_id = $3',
    [request.workspace_id, request.requester_id, userId]
  );
  return manager.rows.length > 0;
}

module.exports = { requireMember, canViewRequest, RANK };
