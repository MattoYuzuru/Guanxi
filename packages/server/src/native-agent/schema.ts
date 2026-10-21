/** Migration 32. Native ownership and resumable deletion; prior migrations stay immutable. */
export const NATIVE_LIFECYCLE_MIGRATION = `
  CREATE TABLE run_execution (
    run_id TEXT PRIMARY KEY REFERENCES durable_runs(id),
    policy TEXT NOT NULL,
    calls INTEGER NOT NULL DEFAULT 0,
    report_calls INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    report_started_at INTEGER,
    terminal_reason TEXT
  );
  CREATE TABLE native_sessions (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id),
    thread_id TEXT NOT NULL UNIQUE REFERENCES threads(id),
    trashed_at TEXT,
    leave_at TEXT,
    deletion_requested INTEGER NOT NULL DEFAULT 0 CHECK(deletion_requested IN (0,1))
  );
  -- Adopt pre-integration native sessions, preserving their immutable policy and trace.
  INSERT INTO threads(id,title,mode,model,num_ctx,temperature,think,created_at,updated_at,
    project_id,retention_policy,retention_policy_source,retention_policy_updated_at,
    last_user_activity_at,last_user_activity_source)
    SELECT s.id,'Agent session','agent',json_extract(e.payload,'$.model'),
      COALESCE(json_extract(e.payload,'$.contextTokens'),4096),0.7,'auto',s.created_at,s.created_at,
      NULL,'ttl','default',s.created_at,
      COALESCE((SELECT MAX(p.created_at) FROM session_events p WHERE p.session_id=s.id
        AND p.type='prompt' AND json_extract(p.payload,'$.origin')='typed'),s.created_at),
      CASE WHEN EXISTS(SELECT 1 FROM session_events p WHERE p.session_id=s.id
        AND p.type='prompt' AND json_extract(p.payload,'$.origin')='typed')
        THEN 'user_message' ELSE 'chat_created' END
    FROM sessions s JOIN session_events e ON e.session_id=s.id AND e.type='agent.policy'
    WHERE s.thread_id IS NULL;
  DROP TRIGGER sessions_identity_immutable;
  UPDATE sessions SET thread_id=id WHERE thread_id IS NULL
    AND EXISTS(SELECT 1 FROM session_events e WHERE e.session_id=sessions.id AND e.type='agent.policy');
  CREATE TRIGGER sessions_identity_immutable BEFORE UPDATE OF id,kind,thread_id,created_at ON sessions
    BEGIN SELECT RAISE(ABORT,'Session identity is immutable'); END;
  INSERT INTO native_sessions(session_id,thread_id)
    SELECT s.id,s.thread_id FROM sessions s WHERE s.thread_id IS NOT NULL
      AND EXISTS(SELECT 1 FROM session_events e WHERE e.session_id=s.id AND e.type='agent.policy');
  -- Generic Thread deletion must use the native coordinated cleanup protocol too.
  CREATE TRIGGER native_thread_delete_guard BEFORE DELETE ON threads
    WHEN EXISTS(SELECT 1 FROM native_sessions n WHERE n.thread_id=OLD.id)
    BEGIN SELECT RAISE(ABORT,'Native session requires coordinated deletion'); END;
`
