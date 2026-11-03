CREATE TABLE IF NOT EXISTS login_rate_limits (
  key_hash char(64) PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts > 0),
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS login_rate_limits_updated_at_idx ON login_rate_limits (updated_at);
