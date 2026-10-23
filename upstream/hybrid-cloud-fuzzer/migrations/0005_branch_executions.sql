-- Durable execution reservations. No automatic retry after a possible click.
CREATE TABLE IF NOT EXISTS branch_executions (
 task_id TEXT PRIMARY KEY,
 run_id TEXT NOT NULL,
 provider TEXT NOT NULL,
 game_id TEXT NOT NULL,
 parent_id TEXT NOT NULL REFERENCES items(id),
 parent_revision INTEGER NOT NULL,
 parent_source_sha256 TEXT NOT NULL,
 action_index INTEGER NOT NULL,
 token TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('running','done','blocked','uncertain')),
 child_id TEXT,
 reason TEXT,
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_branch_run ON branch_executions(run_id,task_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_branch_running_game
 ON branch_executions(run_id,provider,game_id) WHERE status='running';
