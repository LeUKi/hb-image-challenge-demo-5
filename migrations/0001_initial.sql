CREATE TABLE IF NOT EXISTS upload_nonces (
  nonce TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS upload_nonces_expiry ON upload_nonces(expires_at);

CREATE TABLE IF NOT EXISTS image_attempts (
  id TEXT PRIMARY KEY,
  hongbao TEXT NOT NULL,
  user_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  image_sha256 TEXT NOT NULL,
  attempt_no INTEGER NOT NULL CHECK (attempt_no BETWEEN 1 AND 10),
  config_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'ready', 'failed')),
  image_key TEXT,
  content_type TEXT NOT NULL,
  score REAL,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (hongbao, user_id, idempotency_key),
  UNIQUE (hongbao, user_id, attempt_no)
);
CREATE INDEX IF NOT EXISTS image_attempts_player ON image_attempts(hongbao, user_id);
