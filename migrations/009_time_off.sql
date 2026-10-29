-- Vacation allowance: days per calendar year for everyone in the workspace, with an optional per-person override.
ALTER TABLE workspaces ADD COLUMN vacation_days INTEGER NOT NULL DEFAULT 12;
ALTER TABLE memberships ADD COLUMN vacation_days INTEGER;
