// Shared workspace helpers.

// The user's role in a workspace, or null if they are not a member.
async function membershipRole(pool, workspaceId, userId) {
  const { rows } = await pool.query('SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2', [workspaceId, userId]);
  return rows[0]?.role || null;
}

// Parses a positive integer id from a URL parameter, or returns null.
function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

module.exports = { membershipRole, parseId };
