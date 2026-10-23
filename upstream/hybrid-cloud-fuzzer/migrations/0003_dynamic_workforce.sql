-- Durable, provider-scoped workforce tickets. A ticket is a discovery or a
-- catalog capture request, not a classified decision or a DEMO wager.
CREATE TABLE IF NOT EXISTS workforce_jobs (
 id TEXT PRIMARY KEY,
 run_id TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('discovery','catalog')),
 provider TEXT NOT NULL,
 subject TEXT NOT NULL,
 payload_json TEXT NOT NULL,
 priority INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','leased','done','failed')),
 attempts INTEGER NOT NULL DEFAULT 0,
 max_attempts INTEGER NOT NULL DEFAULT 3,
 available_at INTEGER NOT NULL DEFAULT 0,
 lease_token TEXT,
 lease_owner TEXT,
 lease_until INTEGER,
 result_json TEXT,
 last_error TEXT,
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 updated_at TEXT NOT NULL DEFAULT (datetime('now')),
 UNIQUE(run_id,role,provider,subject)
);
CREATE INDEX IF NOT EXISTS idx_workforce_jobs_ready
 ON workforce_jobs(run_id,role,status,available_at,priority DESC,created_at,id);
CREATE INDEX IF NOT EXISTS idx_workforce_jobs_provider
 ON workforce_jobs(run_id,provider,role,status);
CREATE TABLE IF NOT EXISTS workforce_agents (
 run_id TEXT NOT NULL,
 worker_id TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('discovery','catalog','classification','branches')),
 host TEXT NOT NULL,
 capacity INTEGER NOT NULL DEFAULT 1,
 last_heartbeat INTEGER NOT NULL,
 updated_at TEXT NOT NULL DEFAULT (datetime('now')),
 PRIMARY KEY(run_id,worker_id,role)
);
CREATE INDEX IF NOT EXISTS idx_workforce_agents_active ON workforce_agents(run_id,last_heartbeat);
