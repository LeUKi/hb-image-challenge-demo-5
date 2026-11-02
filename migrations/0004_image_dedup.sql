-- One file can own a scoring reservation per hongbao, across all players.
-- Keep historical attempts (including any old duplicates) unchanged.
CREATE INDEX image_attempts_fingerprint
  ON image_attempts(hongbao, image_sha256, status, created_at, id);

CREATE TABLE image_claims (
  hongbao TEXT NOT NULL,
  image_sha256 TEXT NOT NULL,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES image_attempts(id),
  PRIMARY KEY (hongbao, image_sha256)
);

INSERT INTO image_claims (hongbao, image_sha256, attempt_id)
SELECT hongbao, image_sha256, id FROM (
  SELECT hongbao, image_sha256, id,
    ROW_NUMBER() OVER (
      PARTITION BY hongbao, image_sha256 ORDER BY created_at, id
    ) AS position
  FROM image_attempts WHERE status IN ('processing', 'ready')
) WHERE position = 1;

-- This runs in the same atomic statement that consumes the player's attempt.
-- A conflicting file still consumes the attempt, but cannot start AI or R2 work.
CREATE TRIGGER image_attempts_claim_file
AFTER INSERT ON image_attempts WHEN NEW.status = 'processing'
BEGIN
  INSERT INTO image_claims (hongbao, image_sha256, attempt_id)
    VALUES (NEW.hongbao, NEW.image_sha256, NEW.id)
    ON CONFLICT DO NOTHING;

  UPDATE image_attempts
    SET status = 'failed', error_code = 'duplicate_image', gallery_shared = 0
    WHERE id = NEW.id AND NOT EXISTS (
      SELECT 1 FROM image_claims
      WHERE hongbao = NEW.hongbao AND image_sha256 = NEW.image_sha256
        AND attempt_id = NEW.id
    );
END;

-- A definitive processing failure may release only its own reservation.
-- Any surviving pre-migration ready/processing copy keeps the file occupied.
CREATE TRIGGER image_attempts_release_failed_file
AFTER UPDATE OF status ON image_attempts
WHEN OLD.status = 'processing' AND NEW.status = 'failed'
BEGIN
  DELETE FROM image_claims
    WHERE hongbao = NEW.hongbao AND image_sha256 = NEW.image_sha256
      AND attempt_id = NEW.id;

  INSERT INTO image_claims (hongbao, image_sha256, attempt_id)
    SELECT hongbao, image_sha256, id FROM image_attempts
    WHERE hongbao = NEW.hongbao AND image_sha256 = NEW.image_sha256
      AND status IN ('processing', 'ready')
    ORDER BY created_at, id LIMIT 1
    ON CONFLICT DO NOTHING;
END;
