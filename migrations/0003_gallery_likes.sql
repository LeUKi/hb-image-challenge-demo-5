-- A numeric player has one shared acceptance gate across tabs and Worker instances.
CREATE TABLE gallery_like_gates (
  hongbao TEXT NOT NULL,
  user_id TEXT NOT NULL,
  next_allowed_at INTEGER NOT NULL,
  PRIMARY KEY (hongbao, user_id)
);

-- Keep accepted batch IDs so an old, timed-out retry can never add votes again.
CREATE TABLE gallery_like_batches (
  hongbao TEXT NOT NULL,
  user_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  items_json TEXT NOT NULL,
  rejected_json TEXT NOT NULL,
  accepted_at INTEGER NOT NULL,
  operation_id TEXT NOT NULL,
  PRIMARY KEY (hongbao, user_id, batch_id)
);

CREATE TABLE gallery_like_counts (
  image_id TEXT PRIMARY KEY REFERENCES image_attempts(id),
  likes INTEGER NOT NULL DEFAULT 0 CHECK (likes BETWEEN 0 AND 9007199254740991)
);
