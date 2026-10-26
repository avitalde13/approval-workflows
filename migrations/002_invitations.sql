-- Milestone 2: email invitations to a workspace.

CREATE TABLE invitations (
  id           SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,                -- stored lowercase
  role         TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'employee')),
  token_hash   TEXT NOT NULL UNIQUE,         -- SHA-256 of the link token; the raw token is only in the email
  invited_by   INTEGER NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL,
  accepted_at  TIMESTAMPTZ,
  accepted_by  INTEGER REFERENCES users(id),
  revoked_at   TIMESTAMPTZ
);

CREATE INDEX invitations_workspace_email ON invitations (workspace_id, email);
