-- Departments with spending budgets, and a base currency with exchange rates for reporting.

ALTER TABLE workspaces ADD COLUMN base_currency TEXT NOT NULL DEFAULT 'USD';

-- 1 unit of `currency` = `rate` units of the workspace's base currency.
CREATE TABLE exchange_rates (
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  currency     TEXT NOT NULL,
  rate         NUMERIC(18, 8) NOT NULL,
  source       TEXT NOT NULL DEFAULT 'manual',   -- 'manual' or 'ecb' (European Central Bank, via Frankfurter)
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, currency)
);

CREATE TABLE departments (
  id            SERIAL PRIMARY KEY,
  workspace_id  INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  budget_amount NUMERIC(14, 2),                  -- in the base currency; NULL = no budget
  budget_period TEXT NOT NULL DEFAULT 'quarter' CHECK (budget_period IN ('month', 'quarter', 'year')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, name)
);

ALTER TABLE memberships ADD COLUMN department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL;
-- The requester's department when the request was submitted, so moving people later doesn't rewrite history.
ALTER TABLE requests ADD COLUMN department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL;
