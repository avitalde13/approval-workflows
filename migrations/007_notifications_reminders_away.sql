-- In-app notifications (the bell), reminders and escalation for slow approvals, and out-of-office delegation.

CREATE TABLE notifications (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_id   INTEGER REFERENCES requests(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  title        TEXT NOT NULL,
  body         TEXT,
  read_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX notifications_user ON notifications (user_id, id);

-- Per workspace: remind the approver after reminder_hours, move the step on after escalate_hours (NULL = off).
ALTER TABLE workspaces ADD COLUMN reminder_hours INTEGER DEFAULT 48;
ALTER TABLE workspaces ADD COLUMN escalate_hours INTEGER DEFAULT 96;

ALTER TABLE request_approvals ADD COLUMN pending_since TIMESTAMPTZ;      -- when the step started waiting for its approver
ALTER TABLE request_approvals ADD COLUMN reminded_at TIMESTAMPTZ;
ALTER TABLE request_approvals ADD COLUMN reassigned_from INTEGER REFERENCES users(id);
ALTER TABLE request_approvals ADD COLUMN reassigned_reason TEXT;        -- 'delegated' (out of office) or 'escalated' (no answer)

-- Out of office: between away_from and away_until (inclusive), new approvals go to delegate_id.
ALTER TABLE memberships ADD COLUMN away_from DATE;
ALTER TABLE memberships ADD COLUMN away_until DATE;
ALTER TABLE memberships ADD COLUMN delegate_id INTEGER REFERENCES users(id);
