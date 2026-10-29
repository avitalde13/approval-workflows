-- Live demo: visitors explore a sample company without signing up. Demo users and workspaces
-- are created on demand and deleted when they expire.

ALTER TABLE users ADD COLUMN is_demo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE workspaces ADD COLUMN demo_expires_at TIMESTAMPTZ;
