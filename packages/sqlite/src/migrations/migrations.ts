import { createHash } from "node:crypto";

export interface Migration {
  readonly version: number;
  readonly sql: string;
  readonly checksum: string;
}

const initialSchema = `
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  workspace_root TEXT NOT NULL,
  workspace_fingerprint TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  current_branch_id TEXT,
  active_run_id TEXT,
  degraded_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (current_branch_id) REFERENCES branches(branch_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (active_run_id) REFERENCES runs(run_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE branches (
  branch_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  parent_branch_id TEXT REFERENCES branches(branch_id),
  fork_record_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (session_id, branch_id),
  FOREIGN KEY (session_id, fork_record_id)
    REFERENCES ledger_records(session_id, record_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  branch_id TEXT NOT NULL REFERENCES branches(branch_id),
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'aborted', 'failed', 'limited')),
  metadata_json TEXT NOT NULL,
  report_json TEXT,
  started_at INTEGER NOT NULL,
  terminal_at INTEGER,
  lease_epoch INTEGER NOT NULL CHECK (lease_epoch >= 1),
  CHECK ((status = 'active' AND report_json IS NULL AND terminal_at IS NULL)
    OR (status <> 'active' AND report_json IS NOT NULL AND terminal_at IS NOT NULL)),
  UNIQUE (session_id, run_id)
);

CREATE UNIQUE INDEX one_active_run_per_session
  ON runs(session_id) WHERE status = 'active';

CREATE TABLE ledger_records (
  record_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  ledger_seq INTEGER NOT NULL CHECK (ledger_seq > 0),
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  branch_id TEXT NOT NULL REFERENCES branches(branch_id),
  parent_entry_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN (
    'run_started', 'user_message', 'assistant_message', 'model_failure',
    'tool_started', 'tool_outcome', 'run_terminal', 'run_boundary', 'recovery'
  )),
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (session_id, ledger_seq),
  UNIQUE (session_id, record_id),
  FOREIGN KEY (session_id, parent_entry_id)
    REFERENCES ledger_records(session_id, record_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX ledger_branch_order ON ledger_records(session_id, branch_id, ledger_seq);
CREATE INDEX ledger_run_order ON ledger_records(run_id, ledger_seq);

CREATE TABLE branch_heads (
  branch_id TEXT PRIMARY KEY REFERENCES branches(branch_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  record_id TEXT,
  FOREIGN KEY (session_id, record_id)
    REFERENCES ledger_records(session_id, record_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE tool_calls (
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  source_order INTEGER NOT NULL CHECK (source_order >= 0),
  state TEXT NOT NULL CHECK (state IN ('planned', 'started', 'settled', 'cancelled', 'unknown_effect')),
  call_json TEXT NOT NULL,
  outcome_json TEXT,
  effect_state TEXT,
  created_at INTEGER NOT NULL,
  settled_at INTEGER,
  PRIMARY KEY (run_id, call_id),
  UNIQUE (run_id, source_order),
  CHECK ((state IN ('planned', 'started') AND outcome_json IS NULL)
    OR (state IN ('settled', 'cancelled', 'unknown_effect') AND outcome_json IS NOT NULL))
);

CREATE INDEX tool_calls_session_state ON tool_calls(session_id, state);

CREATE TABLE queue_items (
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  command_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('steering', 'follow_up')),
  text TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  status TEXT NOT NULL CHECK (status IN ('queued', 'delivered', 'draft', 'cancelled')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, command_id),
  UNIQUE (run_id, ordinal)
);

CREATE INDEX queue_run_status_order ON queue_items(run_id, status, ordinal);

CREATE TABLE context_manifests (
  manifest_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  model_attempt_count INTEGER NOT NULL CHECK (model_attempt_count > 0),
  digest TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (run_id, model_attempt_count)
);

CREATE TABLE compaction_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  branch_id TEXT NOT NULL REFERENCES branches(branch_id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  source_start_seq INTEGER NOT NULL,
  source_end_seq INTEGER NOT NULL,
  source_digest TEXT NOT NULL,
  summary_artifact_id TEXT,
  strategy_version TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (source_start_seq > 0 AND source_end_seq >= source_start_seq)
);

CREATE INDEX checkpoints_branch_range
  ON compaction_checkpoints(session_id, branch_id, source_end_seq);

CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY,
  digest_algorithm TEXT NOT NULL CHECK (digest_algorithm = 'sha256'),
  digest_hex TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  media_type TEXT NOT NULL,
  provenance TEXT NOT NULL,
  preview TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'committed')),
  created_at INTEGER NOT NULL,
  committed_at INTEGER,
  UNIQUE (digest_algorithm, digest_hex),
  UNIQUE (storage_key),
  CHECK ((state = 'pending' AND committed_at IS NULL)
    OR (state = 'committed' AND committed_at IS NOT NULL))
);

CREATE TABLE session_leases (
  session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  token_digest TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK (epoch >= 1),
  acquired_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK (expires_at > heartbeat_at)
);

CREATE TABLE migration_history (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  tool_version TEXT NOT NULL
);
`;

function migration(version: number, sql: string): Migration {
  return {
    version,
    sql,
    checksum: createHash("sha256").update(sql, "utf8").digest("hex"),
  };
}

const durableLeaseEpoch = `
ALTER TABLE sessions
  ADD COLUMN lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0);
`;

const durableModelTurnCount = `
ALTER TABLE runs
  ADD COLUMN model_turn_count INTEGER NOT NULL DEFAULT 0 CHECK (model_turn_count >= 0);
`;

export const migrations: readonly Migration[] = [
  migration(1, initialSchema),
  migration(2, durableLeaseEpoch),
  migration(3, durableModelTurnCount),
];
