// Append-only audit log. Every state change in a workspace writes one row here.
// The app has no code path that updates or deletes audit rows.

async function audit(db, { workspaceId, actorId, action, entityType, entityId = null, details = {} }) {
  await db.query(
    `INSERT INTO audit_log (workspace_id, actor_id, action, entity_type, entity_id, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [workspaceId, actorId, action, entityType, entityId, JSON.stringify(details)]
  );
}

module.exports = { audit };
