# Observability Schema Migration Guide

## Overview

This document specifies SQLite schema migrations required for Phase 1 observability integration. These tables capture per-heartbeat metrics and persona-level statistics.

## Migration 1: heartbeat_summaries table

Captures aggregate metrics for each heartbeat cycle.

### SQL

```sql
CREATE TABLE IF NOT EXISTS heartbeat_summaries (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_number          INTEGER UNIQUE NOT NULL,
  started_at            TEXT NOT NULL,
  completed_at          TEXT NOT NULL,
  duration_seconds      INTEGER NOT NULL,
  issues_processed      INTEGER NOT NULL DEFAULT 0,
  issues_completed      INTEGER NOT NULL DEFAULT 0,
  backend_latency_ms    INTEGER DEFAULT 0,
  subagent_count        INTEGER DEFAULT 0,
  subagent_failed       INTEGER DEFAULT 0,
  orphans_detected      INTEGER DEFAULT 0,
  summary_json          TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_hb_summaries_cycle ON heartbeat_summaries(cycle_number DESC);
CREATE INDEX idx_hb_summaries_started ON heartbeat_summaries(started_at DESC);
```

### Example Record

```json
{
  "id": 1,
  "cycle_number": 23,
  "started_at": "2026-05-21T12:00:00Z",
  "completed_at": "2026-05-21T12:01:30Z",
  "duration_seconds": 90,
  "issues_processed": 2,
  "issues_completed": 1,
  "backend_latency_ms": 245,
  "subagent_count": 2,
  "subagent_failed": 0,
  "orphans_detected": 0,
  "summary_json": "{\"efficiency_score\": 0.92}"
}
```

## Migration 2: persona_metrics table

Tracks performance and resource consumption per persona per heartbeat.

### SQL

```sql
CREATE TABLE IF NOT EXISTS persona_metrics (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  heartbeat_number      INTEGER NOT NULL,
  persona_name          TEXT NOT NULL,
  issue_id              INTEGER,
  start_time            TEXT NOT NULL,
  end_time              TEXT NOT NULL,
  duration_ms           INTEGER NOT NULL,
  steps_completed       INTEGER NOT NULL DEFAULT 7,  -- Steps 4–10
  steps_failed          INTEGER DEFAULT 0,
  tokens_used           INTEGER DEFAULT 0,
  model_used            TEXT,
  files_created         INTEGER DEFAULT 0,
  files_modified        INTEGER DEFAULT 0,
  commits_created       INTEGER DEFAULT 0,
  sub_issues_created    INTEGER DEFAULT 0,
  comments_posted       INTEGER DEFAULT 0,
  state_changes         INTEGER DEFAULT 0,
  errors_encountered    INTEGER DEFAULT 0,
  metrics_json          TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  
  FOREIGN KEY(heartbeat_number) REFERENCES heartbeat_summaries(cycle_number),
  UNIQUE(heartbeat_number, persona_name, issue_id)
);

CREATE INDEX idx_pm_heartbeat ON persona_metrics(heartbeat_number);
CREATE INDEX idx_pm_persona ON persona_metrics(persona_name);
CREATE INDEX idx_pm_issue ON persona_metrics(issue_id);
```

### Example Record

```json
{
  "id": 1,
  "heartbeat_number": 23,
  "persona_name": "backend",
  "issue_id": 4,
  "start_time": "2026-05-21T12:00:05Z",
  "end_time": "2026-05-21T12:00:45Z",
  "duration_ms": 40000,
  "steps_completed": 7,
  "steps_failed": 0,
  "tokens_used": 8500,
  "model_used": "claude-3-5-sonnet-20241022",
  "files_created": 2,
  "files_modified": 1,
  "commits_created": 1,
  "sub_issues_created": 0,
  "comments_posted": 1,
  "state_changes": 1,
  "errors_encountered": 0,
  "metrics_json": "{\"efficiency_score\": 0.94}"
}
```

## Migration 3: adapter_operations table

Tracks individual backend operations for performance analysis.

### SQL

```sql
CREATE TABLE IF NOT EXISTS adapter_operations (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  heartbeat_number      INTEGER NOT NULL,
  issue_id              INTEGER,
  operation             TEXT NOT NULL,
  backend               TEXT NOT NULL CHECK(backend IN ('sqlite', 'linear')),
  status                TEXT NOT NULL CHECK(status IN ('success', 'failure', 'timeout')),
  duration_ms           INTEGER NOT NULL,
  rows_affected         INTEGER,
  error_message         TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  
  FOREIGN KEY(heartbeat_number) REFERENCES heartbeat_summaries(cycle_number)
);

CREATE INDEX idx_ao_heartbeat ON adapter_operations(heartbeat_number);
CREATE INDEX idx_ao_operation ON adapter_operations(operation);
CREATE INDEX idx_ao_backend ON adapter_operations(backend);
CREATE INDEX idx_ao_status ON adapter_operations(status);
```

### Example Records

```json
{"id": 1, "heartbeat_number": 23, "issue_id": null, "operation": "list_issues", "backend": "sqlite", "status": "success", "duration_ms": 42, "rows_affected": 3, "error_message": null}
{"id": 2, "heartbeat_number": 23, "issue_id": 4, "operation": "update_issue", "backend": "sqlite", "status": "success", "duration_ms": 18, "rows_affected": 1, "error_message": null}
{"id": 3, "heartbeat_number": 23, "issue_id": 4, "operation": "add_comment", "backend": "sqlite", "status": "success", "duration_ms": 25, "rows_affected": 1, "error_message": null}
```

## Migration Script

Apply migrations with:

```bash
#!/bin/bash
# apply-observability-migrations.sh

DB_PATH="${1:-.woterclip/woterclip.db}"

echo "Applying observability schema migrations to $DB_PATH..."

# Migration 1: heartbeat_summaries
sqlite3 "$DB_PATH" << 'SQL'
CREATE TABLE IF NOT EXISTS heartbeat_summaries (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_number          INTEGER UNIQUE NOT NULL,
  started_at            TEXT NOT NULL,
  completed_at          TEXT NOT NULL,
  duration_seconds      INTEGER NOT NULL,
  issues_processed      INTEGER NOT NULL DEFAULT 0,
  issues_completed      INTEGER NOT NULL DEFAULT 0,
  backend_latency_ms    INTEGER DEFAULT 0,
  subagent_count        INTEGER DEFAULT 0,
  subagent_failed       INTEGER DEFAULT 0,
  orphans_detected      INTEGER DEFAULT 0,
  summary_json          TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_hb_summaries_cycle ON heartbeat_summaries(cycle_number DESC);
CREATE INDEX IF NOT EXISTS idx_hb_summaries_started ON heartbeat_summaries(started_at DESC);
SQL

# Migration 2: persona_metrics
sqlite3 "$DB_PATH" << 'SQL'
CREATE TABLE IF NOT EXISTS persona_metrics (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  heartbeat_number      INTEGER NOT NULL,
  persona_name          TEXT NOT NULL,
  issue_id              INTEGER,
  start_time            TEXT NOT NULL,
  end_time              TEXT NOT NULL,
  duration_ms           INTEGER NOT NULL,
  steps_completed       INTEGER NOT NULL DEFAULT 7,
  steps_failed          INTEGER DEFAULT 0,
  tokens_used           INTEGER DEFAULT 0,
  model_used            TEXT,
  files_created         INTEGER DEFAULT 0,
  files_modified        INTEGER DEFAULT 0,
  commits_created       INTEGER DEFAULT 0,
  sub_issues_created    INTEGER DEFAULT 0,
  comments_posted       INTEGER DEFAULT 0,
  state_changes         INTEGER DEFAULT 0,
  errors_encountered    INTEGER DEFAULT 0,
  metrics_json          TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  
  FOREIGN KEY(heartbeat_number) REFERENCES heartbeat_summaries(cycle_number),
  UNIQUE(heartbeat_number, persona_name, issue_id)
);

CREATE INDEX IF NOT EXISTS idx_pm_heartbeat ON persona_metrics(heartbeat_number);
CREATE INDEX IF NOT EXISTS idx_pm_persona ON persona_metrics(persona_name);
CREATE INDEX IF NOT EXISTS idx_pm_issue ON persona_metrics(issue_id);
SQL

# Migration 3: adapter_operations
sqlite3 "$DB_PATH" << 'SQL'
CREATE TABLE IF NOT EXISTS adapter_operations (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  heartbeat_number      INTEGER NOT NULL,
  issue_id              INTEGER,
  operation             TEXT NOT NULL,
  backend               TEXT NOT NULL CHECK(backend IN ('sqlite', 'linear')),
  status                TEXT NOT NULL CHECK(status IN ('success', 'failure', 'timeout')),
  duration_ms           INTEGER NOT NULL,
  rows_affected         INTEGER,
  error_message         TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  
  FOREIGN KEY(heartbeat_number) REFERENCES heartbeat_summaries(cycle_number)
);

CREATE INDEX IF NOT EXISTS idx_ao_heartbeat ON adapter_operations(heartbeat_number);
CREATE INDEX IF NOT EXISTS idx_ao_operation ON adapter_operations(operation);
CREATE INDEX IF NOT EXISTS idx_ao_backend ON adapter_operations(backend);
CREATE INDEX IF NOT EXISTS idx_ao_status ON adapter_operations(status);
SQL

echo "✓ Migrations applied successfully"

# Verify
echo "Tables created:"
sqlite3 "$DB_PATH" "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%heartbeat%' OR name LIKE '%persona%' OR name LIKE '%adapter%';"
```

## Deployment

Run migration script once during `/woterclip-init`:

```bash
bash references/observability-schema-migration.md "$DB_PATH"
```

Or manually:

```bash
sqlite3 .woterclip/woterclip.db < references/observability-schema-migration.md
```

## Rollback

If needed, drop tables with:

```bash
sqlite3 .woterclip/woterclip.db << 'SQL'
DROP TABLE IF EXISTS adapter_operations;
DROP TABLE IF EXISTS persona_metrics;
DROP TABLE IF EXISTS heartbeat_summaries;
SQL
```

## Version Tracking

Update `config.yaml` schema version on migration:

```yaml
# Before
version: 2

# After
version: 3
schema:
  observability: true
  tables:
    - heartbeat_summaries
    - persona_metrics
    - adapter_operations
```

## Testing

Verify schema:

```bash
sqlite3 .woterclip/woterclip.db ".schema heartbeat_summaries"
sqlite3 .woterclip/woterclip.db ".schema persona_metrics"
sqlite3 .woterclip/woterclip.db ".schema adapter_operations"

# Count records (should be 0 after migration)
sqlite3 .woterclip/woterclip.db "SELECT COUNT(*) FROM heartbeat_summaries;"
```

## Next Steps

Phase 2 will:
1. Populate these tables during heartbeat execution
2. Create hourly metrics snapshots (`.woterclip/observability/metrics-snapshots/`)
3. Implement retention policies (90-day rolling window)
4. Add Prometheus-style exposition format for dashboard integration
