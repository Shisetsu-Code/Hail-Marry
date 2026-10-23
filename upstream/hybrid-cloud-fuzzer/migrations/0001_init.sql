CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  game_id TEXT NOT NULL,
  shot_id TEXT NOT NULL,
  state TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('structured','hybrid','visual')),
  adapter TEXT NOT NULL,
  adapter_version TEXT NOT NULL DEFAULT '1',
  candidates_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  source_sha256 TEXT NOT NULL,
  image_key TEXT,
  image_sha256 TEXT,
  width INTEGER,
  height INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','leased','classified','needs_review')),
  revision INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT,
  lease_until INTEGER,
  decisions_json TEXT,
  reviewer TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(run_id,provider,game_id,shot_id)
);
CREATE INDEX IF NOT EXISTS idx_items_pending ON items(status,lease_until,created_at,id);
CREATE INDEX IF NOT EXISTS idx_items_run ON items(run_id,status,created_at);
CREATE INDEX IF NOT EXISTS idx_items_provider ON items(provider,status,created_at);
CREATE INDEX IF NOT EXISTS idx_items_decisions ON items(status,updated_at,id);
CREATE TABLE IF NOT EXISTS decision_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  revision INTEGER NOT NULL,
  reviewer TEXT NOT NULL,
  status TEXT NOT NULL,
  decisions_json TEXT NOT NULL,
  saved_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (item_id) REFERENCES items(id),
  UNIQUE(item_id, revision)
);
