-- Existing uploads retain the privacy policy under which they were submitted.
ALTER TABLE image_attempts ADD COLUMN gallery_shared INTEGER NOT NULL DEFAULT 0 CHECK (gallery_shared IN (0, 1));
ALTER TABLE image_attempts ADD COLUMN nsfw_score REAL;
ALTER TABLE image_attempts ADD COLUMN image_width INTEGER;
ALTER TABLE image_attempts ADD COLUMN image_height INTEGER;

CREATE INDEX image_attempts_gallery ON image_attempts(hongbao, status, created_at DESC, id DESC);

-- Issued only to the authenticated judge. A participant receives this opaque
-- capability in their private committed view after a successful settlement.
CREATE TABLE gallery_grants (
  hongbao TEXT NOT NULL,
  user_id TEXT NOT NULL,
  grant TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (hongbao, user_id)
);
