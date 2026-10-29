-- Needs changes: an approver can send a request back. The requester edits it and resubmits,
-- which starts a new round of approvals (earlier rounds stay in the timeline).
ALTER TABLE requests DROP CONSTRAINT IF EXISTS requests_status_check;
ALTER TABLE requests ADD CONSTRAINT requests_status_check
  CHECK (status IN ('pending', 'changes_requested', 'approved', 'rejected', 'cancelled'));
ALTER TABLE request_approvals DROP CONSTRAINT IF EXISTS request_approvals_status_check;
ALTER TABLE request_approvals ADD CONSTRAINT request_approvals_status_check
  CHECK (status IN ('waiting', 'pending', 'approved', 'rejected', 'returned', 'skipped', 'cancelled'));
ALTER TABLE requests ADD COLUMN round INTEGER NOT NULL DEFAULT 1;
ALTER TABLE request_approvals ADD COLUMN round INTEGER NOT NULL DEFAULT 1;

-- Receipts and invoices attached to a request (images or PDF, up to 5 MB each).
-- Stored in the database as base64 so the app needs no separate file storage.
CREATE TABLE request_files (
  id           SERIAL PRIMARY KEY,
  request_id   INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  data_base64  TEXT NOT NULL,
  uploaded_by  INTEGER NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX request_files_request ON request_files (request_id);
