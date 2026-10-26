-- Milestone 3: reporting lines, approval chains, requests, approvals and the audit log.

-- Who each member reports to (their direct manager in this workspace).
ALTER TABLE memberships ADD COLUMN manager_id INTEGER REFERENCES users(id);

-- Approval chain per workspace and request type. Steps run in "position" order.
--   approver_type 'manager': the requester's direct manager
--   approver_type 'user':    a specific member (e.g. the finance lead or the VP)
--   min_amount:              the step only applies when the request amount is at least this much
CREATE TABLE approval_steps (
  id               SERIAL PRIMARY KEY,
  workspace_id     INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_type     TEXT NOT NULL CHECK (request_type IN ('purchase', 'expense', 'time_off')),
  position         INTEGER NOT NULL,
  name             TEXT NOT NULL,
  approver_type    TEXT NOT NULL CHECK (approver_type IN ('manager', 'user')),
  approver_user_id INTEGER REFERENCES users(id),
  min_amount       NUMERIC(14, 2),
  UNIQUE (workspace_id, request_type, position)
);

CREATE TABLE requests (
  id           SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  requester_id INTEGER NOT NULL REFERENCES users(id),
  type         TEXT NOT NULL CHECK (type IN ('purchase', 'expense', 'time_off')),
  title        TEXT NOT NULL,
  description  TEXT,
  amount       NUMERIC(14, 2),
  currency     TEXT NOT NULL DEFAULT 'USD',
  vendor       TEXT,
  start_date   DATE,
  end_date     DATE,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at   TIMESTAMPTZ
);
CREATE INDEX requests_workspace ON requests (workspace_id, created_at);

-- One row per step of a request's chain. Approvers are fixed when the request is submitted.
CREATE TABLE request_approvals (
  id          SERIAL PRIMARY KEY,
  request_id  INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  step_name   TEXT NOT NULL,
  approver_id INTEGER REFERENCES users(id),
  status      TEXT NOT NULL CHECK (status IN ('waiting', 'pending', 'approved', 'rejected', 'skipped', 'cancelled')),
  comment     TEXT,
  decided_at  TIMESTAMPTZ,
  UNIQUE (request_id, position)
);
CREATE INDEX request_approvals_approver ON request_approvals (approver_id, status);

-- Append-only record of every action. The app never updates or deletes rows here.
CREATE TABLE audit_log (
  id           SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id     INTEGER REFERENCES users(id),
  action       TEXT NOT NULL,
  entity_type  TEXT NOT NULL,
  entity_id    INTEGER,
  details      JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX audit_log_workspace ON audit_log (workspace_id, id);
