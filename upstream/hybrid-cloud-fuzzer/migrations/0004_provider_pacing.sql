-- Global (cross-run/cross-runner) provider pacing for public DEMO browser sessions.
-- A policy is explicitly configured for each provider; no implicit global 3/min rule.
CREATE TABLE IF NOT EXISTS provider_policies (
 provider TEXT PRIMARY KEY,
 min_start_interval_ms INTEGER NOT NULL CHECK(min_start_interval_ms BETWEEN 1000 AND 300000),
 max_active INTEGER NOT NULL CHECK(max_active BETWEEN 1 AND 32),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 next_start_ms INTEGER NOT NULL DEFAULT 0,
 updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS provider_sessions (
 lease_id TEXT PRIMARY KEY,
 provider TEXT NOT NULL REFERENCES provider_policies(provider),
 run_id TEXT NOT NULL,
 game_id TEXT NOT NULL,
 owner TEXT NOT NULL,
 lease_until_ms INTEGER NOT NULL,
 released_at_ms INTEGER,
 created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_provider_sessions_active
 ON provider_sessions(provider,lease_until_ms,released_at_ms);
