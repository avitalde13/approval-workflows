-- Milestone 4: automatic classification and anomaly flags for each request.

CREATE TABLE request_insights (
  request_id   INTEGER PRIMARY KEY REFERENCES requests(id) ON DELETE CASCADE,
  risk_level   TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high')),
  rule_flags   JSONB NOT NULL DEFAULT '[]',   -- deterministic checks, always present
  category     TEXT,                          -- from AI (NULL until AI ran, or when AI is off)
  summary      TEXT,                          -- from AI
  ai_flags     JSONB NOT NULL DEFAULT '[]',   -- judgment flags from AI
  ai_status    TEXT NOT NULL DEFAULT 'off' CHECK (ai_status IN ('off', 'pending', 'done', 'failed')),
  ai_model     TEXT,
  ai_error     TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
