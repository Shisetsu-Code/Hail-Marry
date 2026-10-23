CREATE TABLE IF NOT EXISTS capture_timings (
 provider TEXT NOT NULL, game_id TEXT NOT NULL, wait_ms INTEGER NOT NULL DEFAULT 25000,
 updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(provider,game_id)
);
CREATE TABLE IF NOT EXISTS capture_reviews (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL, provider TEXT NOT NULL, game_id TEXT NOT NULL,
 shot_id TEXT NOT NULL, session_id TEXT NOT NULL, revision INTEGER NOT NULL,
 image_sha256 TEXT NOT NULL, image_key TEXT NOT NULL, status TEXT NOT NULL,
 action_json TEXT, history_json TEXT NOT NULL DEFAULT '[]', expires_at INTEGER NOT NULL,
 updated_at TEXT NOT NULL DEFAULT (datetime('now')),
 UNIQUE(run_id,provider,game_id,shot_id)
);
CREATE INDEX IF NOT EXISTS idx_capture_reviews_pending ON capture_reviews(run_id,status,id);
