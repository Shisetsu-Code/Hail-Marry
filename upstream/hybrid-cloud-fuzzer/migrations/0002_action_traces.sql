-- Immutable sanitized action-correlated network evidence; screenshots/decisions remain unchanged.
CREATE TABLE IF NOT EXISTS action_traces (
 trace_id TEXT PRIMARY KEY,
 parent_item_id TEXT NOT NULL REFERENCES items(id),
 child_item_id TEXT NOT NULL REFERENCES items(id),
 parent_source_sha256 TEXT NOT NULL,
 parent_revision INTEGER NOT NULL,
 storage_key TEXT NOT NULL,
 content_sha256 TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_action_traces_parent ON action_traces(parent_item_id);
