/** Migration 30: additive, separate from legacy Jobs so old CHECKs and replay stay valid. */
export const DURABLE_RUNS_MIGRATION = `
  CREATE TABLE durable_runs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
    parent_id TEXT REFERENCES durable_runs(id),
    state TEXT NOT NULL CHECK (state IN ('submitted','working','waiting_children','input_required',
      'wrapping_up','completed','failed','canceled','rejected','interrupted')),
    version INTEGER NOT NULL DEFAULT 1,
    wake_seq INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    cancel_count INTEGER NOT NULL DEFAULT 0 CHECK (cancel_count BETWEEN 0 AND 1)
  );
  CREATE TABLE leases (
    key TEXT PRIMARY KEY,
    epoch INTEGER NOT NULL CHECK (epoch > 0),
    token INTEGER NOT NULL CHECK (token > 0),
    holder TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    released INTEGER NOT NULL DEFAULT 0 CHECK (released IN (0,1))
  );
  CREATE TABLE run_attempts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES durable_runs(id),
    ordinal INTEGER NOT NULL,
    wake_seq INTEGER,
    state TEXT NOT NULL CHECK (state IN ('delivered','started','sleeping','completed','lost','canceled')),
    epoch INTEGER NOT NULL,
    token INTEGER NOT NULL,
    first_model_at INTEGER,
    UNIQUE (run_id, ordinal)
  );
  CREATE UNIQUE INDEX idx_run_attempt_active ON run_attempts(run_id)
    WHERE state IN ('delivered','started');
  CREATE TABLE promises (
    id TEXT PRIMARY KEY,
    parent_id TEXT NOT NULL REFERENCES durable_runs(id),
    child_id TEXT NOT NULL UNIQUE REFERENCES durable_runs(id),
    delegation_key TEXT NOT NULL,
    deadline_policy TEXT NOT NULL CHECK (deadline_policy IN ('cancel_wrap_up','detach')),
    cancel_policy TEXT NOT NULL CHECK (cancel_policy IN ('cancel','detach')),
    detached INTEGER NOT NULL DEFAULT 0 CHECK (detached IN (0,1)),
    outcome TEXT CHECK (outcome IN ('completed','failed','canceled','rejected','deadline')),
    resolved_at INTEGER,
    UNIQUE (parent_id, delegation_key),
    CHECK ((outcome IS NULL) = (resolved_at IS NULL))
  );
  CREATE TABLE timers (
    promise_id TEXT PRIMARY KEY REFERENCES promises(id),
    due_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending','fired','canceled'))
  );
  CREATE INDEX idx_run_timers_due ON timers(state, due_at);
  CREATE TABLE outbox (
    run_id TEXT NOT NULL REFERENCES durable_runs(id),
    wake_seq INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('resolution','escalation','quota')),
    source_key TEXT NOT NULL,
    attempt_id TEXT REFERENCES run_attempts(id),
    deliveries INTEGER NOT NULL DEFAULT 0,
    acknowledged_at INTEGER,
    suppressed_at INTEGER,
    PRIMARY KEY (run_id, wake_seq),
    UNIQUE (run_id, kind, source_key)
  );
  CREATE TABLE run_resources (
    key TEXT PRIMARY KEY REFERENCES leases(key),
    run_id TEXT NOT NULL REFERENCES durable_runs(id),
    kind TEXT NOT NULL CHECK (kind IN ('worktree','scratch')),
    retain_until INTEGER NOT NULL,
    released_at INTEGER
  );
  CREATE TABLE run_costs (
    run_id TEXT NOT NULL REFERENCES durable_runs(id),
    entry_key TEXT NOT NULL,
    attempt_id TEXT NOT NULL REFERENCES run_attempts(id),
    input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
    output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
    cost_microunits INTEGER CHECK (cost_microunits >= 0),
    currency TEXT NOT NULL CHECK (currency IN ('USD','EUR','RUB','unknown')),
    observed_at INTEGER NOT NULL,
    PRIMARY KEY (run_id, entry_key)
  );
  CREATE INDEX idx_run_session ON durable_runs(session_id);
  CREATE INDEX idx_session_mirror_backlog_thread ON session_mirror_backlog(thread_id, job_id);
`
