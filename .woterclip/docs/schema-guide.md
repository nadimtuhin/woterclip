# WoterClip SQLite Schema and Migration Guide

**Version:** 1.0  
**Updated:** 2026-05-21  
**Backend:** SQLite with WAL mode

---

## Overview

This document provides comprehensive documentation for the WoterClip SQLite backend, including:
- Complete schema definition (tables, columns, constraints)
- Data integrity and relationship design
- Performance configuration (WAL mode, indices)
- Migration strategies from SQLite to Linear backend
- Backup and restore procedures
- Debugging and operational guidance

The SQLite backend is a local implementation of the adapter contract, designed for development, testing, and single-user deployments with optional horizontal scaling via WAL mode.

---

## Database Schema (DDL)

### Initialization

Initialize the database once during `/woterclip-init`:

```sql
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=30000;

CREATE TABLE IF NOT EXISTS issues (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    title        TEXT    NOT NULL,
    description  TEXT    NOT NULL DEFAULT '',
    persona      TEXT,
    state        TEXT    NOT NULL DEFAULT 'todo'
                     CHECK(state IN ('backlog','todo','in_progress','in_review','done','canceled')),
    priority     INTEGER NOT NULL DEFAULT 0,
    parent_id    INTEGER REFERENCES issues(id),
    state_label  TEXT    CHECK(state_label IN ('working','blocked')),
    working_since TEXT,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS comments (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id         INTEGER NOT NULL REFERENCES issues(id),
    author           TEXT    NOT NULL CHECK(author IN ('agent','human')),
    persona          TEXT,
    body             TEXT    NOT NULL,
    heartbeat_number INTEGER,
    created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS webhook_queue (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id         TEXT    NOT NULL UNIQUE,
    source           TEXT    NOT NULL CHECK(source IN ('github', 'linear')),
    event_type       TEXT,
    status           TEXT    NOT NULL DEFAULT 'pending'
                         CHECK(status IN ('pending', 'triggered', 'completed', 'failed')),
    queued_at        TEXT    NOT NULL DEFAULT (datetime('now')),
    triggered_at     TEXT,
    completed_at     TEXT,
    error_message    TEXT,
    created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_issues_state       ON issues(state);
CREATE INDEX IF NOT EXISTS idx_issues_state_label ON issues(state_label);
CREATE INDEX IF NOT EXISTS idx_issues_persona     ON issues(persona);
CREATE INDEX IF NOT EXISTS idx_comments_issue     ON comments(issue_id);
CREATE INDEX IF NOT EXISTS idx_comments_author    ON comments(issue_id, author, created_at);
CREATE INDEX IF NOT EXISTS idx_webhook_queue_status  ON webhook_queue(status);
CREATE INDEX IF NOT EXISTS idx_webhook_queue_source  ON webhook_queue(source);
CREATE INDEX IF NOT EXISTS idx_webhook_queue_event_id ON webhook_queue(event_id);
```

---

## Table Schema Details

### `issues` Table

Primary table for tracking work items, organized by state and persona routing.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | Unique issue ID; display_id computed as `'WOT-' \|\| id` |
| `title` | TEXT | NOT NULL | Issue title/summary |
| `description` | TEXT | NOT NULL, DEFAULT '' | Full issue description (markdown supported) |
| `persona` | TEXT | (optional) | Assigned persona name (e.g., 'backend', 'frontend', 'qa') |
| `state` | TEXT | NOT NULL, DEFAULT 'todo', CHECK | Lifecycle state: `backlog`, `todo`, `in_progress`, `in_review`, `done`, `canceled` |
| `priority` | INTEGER | NOT NULL, DEFAULT 0 | Priority level: 0=None, 1=Urgent, 2=High, 3=Medium, 4=Low (lower = higher urgency) |
| `parent_id` | INTEGER | REFERENCES issues(id) | Parent issue ID for sub-issues (null if top-level) |
| `state_label` | TEXT | CHECK or NULL | Lock status: `working`, `blocked`, or NULL (unlocked). Mutually exclusive via logic. |
| `working_since` | TEXT | (optional) | ISO 8601 timestamp when locked (for stale detection) |
| `created_at` | TEXT | NOT NULL, DEFAULT now | Issue creation timestamp |
| `updated_at` | TEXT | NOT NULL, DEFAULT now | Last modification timestamp |

**Indices:**
- `idx_issues_state` — Used in heartbeat inbox_query to filter workable issues
- `idx_issues_state_label` — Quick check for locked issues
- `idx_issues_persona` — Group issues by assigned persona

**Design Rationale:**
- **display_id computed:** No separate counter table needed; `id` maps 1:1 to display_id via SQL expression.
- **state_label vs. state:** `state` tracks lifecycle; `state_label` tracks lock status. They are independent.
- **priority integer:** Avoids text comparison; natural ordering for `ORDER BY priority ASC`.
- **parent_id self-reference:** Enables hierarchical decomposition (worker creates `architect`/`qa` sub-issues).
- **working_since timestamp:** Enables stale lock detection without querying comments table.

---

### `comments` Table

Append-only log of agent and human communications on issues.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | Unique comment ID |
| `issue_id` | INTEGER | NOT NULL, REFERENCES issues(id) | Foreign key to parent issue |
| `author` | TEXT | NOT NULL, CHECK | Author type: `agent` or `human` |
| `persona` | TEXT | (optional) | Persona name if author='agent' (null for human comments) |
| `body` | TEXT | NOT NULL | Comment body (markdown supported) |
| `heartbeat_number` | INTEGER | (optional) | Heartbeat cycle number when comment was posted (for agent comments) |
| `created_at` | TEXT | NOT NULL, DEFAULT now | Comment timestamp |

**Indices:**
- `idx_comments_issue` — Basic issue lookup
- `idx_comments_author` — Composite: quick filter for agent vs. human comments and chronological sort

**Design Rationale:**
- **Append-only:** Never delete or modify comments. History is immutable audit trail.
- **heartbeat_number:** Enables linking comments to specific heartbeat cycles. Derived by adapter (not auto-computed).
- **author enum:** Prevents invalid author types. Constrains to 'agent' or 'human'.
- **persona field:** Records which persona wrote agent comments (for debugging/audit).

---

### `webhook_queue` Table

Queue for managing incoming webhook events from GitHub/Linear with deduplication and status tracking.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | Queue row ID |
| `event_id` | TEXT | NOT NULL, UNIQUE | Unique event identifier (UUID or timestamp-based) for deduplication |
| `source` | TEXT | NOT NULL, CHECK | Event source: `github` or `linear` |
| `event_type` | TEXT | (optional) | Event type string (e.g., 'issues.opened', 'issues.updated') |
| `status` | TEXT | NOT NULL, DEFAULT 'pending', CHECK | Queue status: `pending`, `triggered`, `completed`, `failed` |
| `queued_at` | TEXT | NOT NULL, DEFAULT now | Timestamp when event entered queue |
| `triggered_at` | TEXT | (optional) | Timestamp when `/heartbeat` started processing event |
| `completed_at` | TEXT | (optional) | Timestamp when event processing finished |
| `error_message` | TEXT | (optional) | Error details if status='failed' |
| `created_at` | TEXT | NOT NULL, DEFAULT now | Row creation timestamp |

**Indices:**
- `idx_webhook_queue_status` — Filter pending events
- `idx_webhook_queue_source` — Filter by event source
- `idx_webhook_queue_event_id` — Deduplication lookups

**Design Rationale:**
- **Unique event_id:** Prevents duplicate processing if webhook is retried or received multiple times.
- **Status machine:** Tracks event lifecycle (pending → triggered → completed/failed).
- **Separate timestamps:** Enables metrics (queue latency = triggered_at - queued_at, processing latency = completed_at - triggered_at).

---

## Data Integrity and Constraints

### Foreign Key Constraints

```sql
-- Issues table
parent_id REFERENCES issues(id)  -- Self-referential; allows sub-issues (parent must exist)

-- Comments table
issue_id REFERENCES issues(id)  -- All comments must belong to existing issue
```

**Enforcement:** SQLite foreign key constraints are **enabled by default** in recent versions but should be explicitly verified:

```bash
sqlite3 .woterclip/woterclip.db "PRAGMA foreign_keys;"
```

Should return `1` (enabled). If `0`, run:

```bash
sqlite3 .woterclip/woterclip.db "PRAGMA foreign_keys = ON;"
```

### CHECK Constraints

```sql
-- state enum
state IN ('backlog','todo','in_progress','in_review','done','canceled')

-- state_label enum  
state_label IN ('working','blocked')

-- author enum
author IN ('agent','human')

-- webhook source enum
source IN ('github', 'linear')

-- webhook status enum
status IN ('pending', 'triggered', 'completed', 'failed')

-- priority valid range (application-enforced; not a CHECK)
priority BETWEEN 0 AND 4
```

**Mutation Rules:**
- **state_label mutual exclusion:** Never set both `working` and `blocked` simultaneously. Use adapter logic to transition: set to `NULL` first, then new label (or atomic UPDATE with new label).
- **state transitions:** State can move freely; adapter logic enforces workflow rules (e.g., only move to `done` from `in_review`).
- **priority bumping for sub-issues:** When creating child, compute `priority = MAX(1, parent_priority - 1)` to raise urgency slightly.

---

## Performance Configuration

### WAL Mode (Write-Ahead Logging)

**Setting:**
```sql
PRAGMA journal_mode=WAL;
```

**Benefits:**
- Enables **concurrent reads** during write operations
- Improves write throughput (batch multiple writes)
- Reduces disk I/O (uses memory-mapped file)

**Trade-offs:**
- Creates two additional files: `-wal` and `-shm` (shared memory)
- Requires cleanup on database close (SQLite handles automatically)
- Slight increase in disk usage for large databases

**Verification:**
```bash
sqlite3 .woterclip/woterclip.db "PRAGMA journal_mode;"
```

Should return `wal`.

### Busy Timeout

**Setting:**
```sql
PRAGMA busy_timeout=30000;  -- 30 seconds
```

**Purpose:** Allow concurrent operations to wait up to 30 seconds for lock acquisition instead of failing immediately.

**Use case:** When heartbeat dispatches multiple subagents in parallel (max_parallel > 1), each may hold lock briefly. Timeout prevents premature failures.

**Tuning:**
- **Linear backend:** Set `max_parallel: 1` (default) to avoid contention; timeout less critical.
- **SQLite backend:** Can set `max_parallel: 2+` safely due to WAL + busy_timeout.
- **High contention:** Increase timeout up to 60000ms if experiencing lock timeouts.

### Index Strategy

**Indices created:**
1. **`idx_issues_state`** — Used in heartbeat inbox_query (`WHERE state IN (...)`)
2. **`idx_issues_state_label`** — Quick lock detection
3. **`idx_issues_persona`** — Filter issues by persona (future: dashboard)
4. **`idx_comments_issue`** — Fetch all comments for an issue
5. **`idx_comments_author`** — Composite index for filtering + sorting (agent vs. human, chronological)
6. **`idx_webhook_queue_status`** — Filter pending webhook events
7. **`idx_webhook_queue_source`** — Group by event source
8. **`idx_webhook_queue_event_id`** — Deduplication lookups

**Cost:** ~10KB disk overhead per 1000 rows. Maintenance is automatic (SQLite rebalances on insert/update).

---

## Data Lifecycle and Workflow

### Issue State Machine

```
(created)
  ↓
backlog ← (initial state configurable)
  ↓
todo ← (default initial state)
  ↓
in_progress ← (agent claims, sets state_label='working')
  ↓
in_review ← (work done, awaiting architect/qa)
  ↓
done ← (accepted)
  ↓
(end)

⇢ canceled (any state) ← (user intervention)
```

**state_label Lifecycle:**
- `NULL` (unlocked) — Issue is available for work
- `'working'` — Agent is actively working (Step 6 of heartbeat)
- `'blocked'` — Agent blocked, waiting for external input (Step 10 blocked path)

### Comment Flow

**Per issue:**
1. Human creates issue (body in `description` field)
2. Heartbeat picks issue, agent reads description + prior comments
3. Agent does work
4. Agent posts report comment (author='agent', heartbeat_number=N)
5. Human may reply (author='human', heartbeat_number=NULL)
6. Next heartbeat: agent reads new human comment, wakes from blocked state

**Heartbeat Counter:**
- Derived from comment count: `MAX(heartbeat_number) + 1` for agent comments
- Allows tracking which cycle last touched an issue
- Used for deduplication ("already handled in cycle #42")

---

## Migration Guide: SQLite to Linear Backend

### Overview

WoterClip supports dual-backend architecture via adapter pattern. This section covers migrating from local SQLite to cloud-based Linear as your backend grows.

### Phase 1: Dry-Run Migration (No Data Loss)

**Step 1: Backup existing SQLite database**
```bash
cp .woterclip/woterclip.db .woterclip/woterclip.db.backup
```

**Step 2: Export all issues**
```bash
sqlite3 .woterclip/woterclip.db ".mode json" \
  "SELECT 'WOT-' || id as display_id, title, description, persona, state, priority, created_at FROM issues;" \
  > /tmp/issues-export.json
```

**Step 3: Verify export**
```bash
jq '. | length' /tmp/issues-export.json  # Count issues
jq '.[0]' /tmp/issues-export.json        # Inspect first issue
```

### Phase 2: Linear Setup

**Prerequisites:**
- Linear workspace created
- WoterClip project in Linear with initial labels matching personas
- API token generated (Settings → API → Create Key)

**Step 1: Initialize Linear adapter**
```bash
# Update .woterclip/config.yaml
backend: linear  # Change from 'sqlite'
linear:
  team: "WotAI"
  project: "WoterClip"
  api_token: "${LINEAR_API_TOKEN}"
```

**Step 2: Migrate issues (batch import)**
```bash
# Use `/issue-add` command for each issue in export
# Or implement bulk import script (future enhancement)
for row in $(jq -c '.[]' /tmp/issues-export.json); do
  title=$(echo $row | jq -r '.title')
  desc=$(echo $row | jq -r '.description')
  # Call Claude Code Linear adapter to create issue
done
```

**Step 3: Migrate comments**
```bash
sqlite3 .woterclip/woterclip.db ".mode json" \
  "SELECT 'WOT-' || issue_id as issue_id, author, body, heartbeat_number, created_at FROM comments;" \
  > /tmp/comments-export.json

# Migrate comments to Linear (via API or manual review)
```

### Phase 3: Validation

**Step 1: Verify issue counts**
```bash
# SQLite: count all issues
sqlite3 .woterclip/woterclip.db "SELECT COUNT(*) FROM issues;"

# Linear: count via API (requires manual verification or adapter call)
```

**Step 2: Check comment consistency**
```bash
# For each issue, verify comment count and content
sqlite3 .woterclip/woterclip.db \
  "SELECT 'WOT-' || id as issue_id, COUNT(*) as comment_count FROM issues LEFT JOIN comments ON issues.id = comments.issue_id GROUP BY issue_id;"
```

**Step 3: Run test heartbeat with Linear**
```bash
# Trigger heartbeat with new backend
/heartbeat

# Monitor logs and verify adapter calls go to Linear
```

### Phase 4: Rollback Plan

If migration encounters issues:

**Step 1: Restore SQLite**
```bash
cp .woterclip/woterclip.db.backup .woterclip/woterclip.db
```

**Step 2: Revert config**
```yaml
# .woterclip/config.yaml
backend: sqlite
```

**Step 3: Resume with SQLite**
```bash
/heartbeat  # Uses local adapter
```

### Migration Checklist

- [ ] Backup SQLite database
- [ ] Export issues and comments
- [ ] Set up Linear workspace + project
- [ ] Configure Linear API token in config.yaml
- [ ] Batch import issues to Linear
- [ ] Batch import comments to Linear
- [ ] Verify issue and comment counts match
- [ ] Run test heartbeat with Linear adapter
- [ ] Monitor first 5 heartbeats for adapter errors
- [ ] Document any custom data in SQLite schema (if applicable)
- [ ] Archive SQLite backup in safe location
- [ ] Delete `.woterclip/woterclip.db` (optional, after 1 month of stable Linear operation)

---

## Backup and Restore Procedures

### Regular Backups

**Automated backup (recommended):**

Create a cron job in `.woterclip/scripts/backup.sh`:

```bash
#!/bin/bash
set -e

DB_PATH=".woterclip/woterclip.db"
BACKUP_DIR=".woterclip/backups"
TIMESTAMP=$(date +%Y-%m-%d_%H-%M-%S)

mkdir -p "$BACKUP_DIR"

# Copy database with WAL files
cp "$DB_PATH" "$BACKUP_DIR/woterclip-$TIMESTAMP.db"
[ -f "${DB_PATH}-wal" ] && cp "${DB_PATH}-wal" "$BACKUP_DIR/woterclip-$TIMESTAMP.db-wal"
[ -f "${DB_PATH}-shm" ] && cp "${DB_PATH}-shm" "$BACKUP_DIR/woterclip-$TIMESTAMP.db-shm"

# Keep only last 30 days
find "$BACKUP_DIR" -name "woterclip-*.db" -mtime +30 -delete

echo "Backup completed: $BACKUP_DIR/woterclip-$TIMESTAMP.db"
```

**Run daily via cron:**
```bash
0 2 * * * /path/to/.woterclip/scripts/backup.sh  # 2 AM daily
```

### Point-in-Time Recovery

**Restore from specific backup:**

```bash
TIMESTAMP="2026-05-20_02-00-00"
BACKUP_DIR=".woterclip/backups"

# Stop all heartbeats (ensure lock is not held)
rm -f .woterclip/.heartbeat-lock

# Restore database + WAL files
cp "$BACKUP_DIR/woterclip-$TIMESTAMP.db" ".woterclip/woterclip.db"
[ -f "$BACKUP_DIR/woterclip-$TIMESTAMP.db-wal" ] && \
  cp "$BACKUP_DIR/woterclip-$TIMESTAMP.db-wal" ".woterclip/woterclip.db-wal"
[ -f "$BACKUP_DIR/woterclip-$TIMESTAMP.db-shm" ] && \
  cp "$BACKUP_DIR/woterclip-$TIMESTAMP.db-shm" ".woterclip/woterclip.db-shm"

# Verify integrity
sqlite3 .woterclip/woterclip.db "PRAGMA integrity_check;"
```

### Disaster Recovery

**Scenario:** Database is corrupted (integrity_check fails).

**Recovery steps:**

1. **Stop all processes:** Kill any running heartbeats
   ```bash
   pkill -f "heartbeat"
   ```

2. **Delete corrupted database**
   ```bash
   rm -f .woterclip/woterclip.db .woterclip/woterclip.db-wal .woterclip/woterclip.db-shm
   ```

3. **Restore from backup**
   ```bash
   cp ".woterclip/backups/woterclip-<latest>.db" ".woterclip/woterclip.db"
   ```

4. **Verify**
   ```bash
   sqlite3 .woterclip/woterclip.db "PRAGMA integrity_check;"
   sqlite3 .woterclip/woterclip.db "SELECT COUNT(*) FROM issues;"
   ```

5. **Resume operations**
   ```bash
   /heartbeat
   ```

---

## Debugging and Troubleshooting

### Database Health Checks

**Check integrity:**
```bash
sqlite3 .woterclip/woterclip.db "PRAGMA integrity_check;"
```

Expected output: `ok`. If not:
- Database may be corrupted
- See "Disaster Recovery" section above

**Verify WAL mode:**
```bash
sqlite3 .woterclip/woterclip.db "PRAGMA journal_mode;"
```

Expected output: `wal`

**Check foreign keys:**
```bash
sqlite3 .woterclip/woterclip.db "PRAGMA foreign_keys;"
```

Expected output: `1` (enabled)

**View current lock status:**
```bash
sqlite3 .woterclip/woterclip.db "PRAGMA database_list;"
```

**Check busy_timeout:**
```bash
sqlite3 .woterclip/woterclip.db "PRAGMA busy_timeout;"
```

Expected output: `30000` (milliseconds)

### Common Issues

**Issue: "Database is locked" error**

**Cause:** Concurrent write operations or stale lock file

**Resolution:**
```bash
# Check for stale lock file
ls -la .woterclip/.heartbeat-lock

# If stale (> 5 min old), delete it
[ -f .woterclip/.heartbeat-lock ] && \
  [ $(date +%s) -gt $(($(stat -f%m .woterclip/.heartbeat-lock) + 300)) ] && \
  rm .woterclip/.heartbeat-lock

# Retry heartbeat
/heartbeat
```

**Issue: Missing foreign key constraint**

**Cause:** Orphaned comment (issue was deleted)

**Resolution:**
```bash
# Find orphaned comments
sqlite3 .woterclip/woterclip.db \
  "SELECT c.id, c.issue_id FROM comments c \
   LEFT JOIN issues i ON c.issue_id = i.id \
   WHERE i.id IS NULL;"

# Delete orphaned comments
sqlite3 .woterclip/woterclip.db \
  "DELETE FROM comments WHERE issue_id NOT IN (SELECT id FROM issues);"
```

**Issue: Stale working_since timestamp**

**Cause:** Subagent crashed while holding lock; issue stuck in `'working'` state

**Resolution:**
```bash
# Find stale locks (> 4 hours old)
sqlite3 .woterclip/woterclip.db \
  "SELECT 'WOT-' || id as display_id, working_since, title FROM issues \
   WHERE state_label = 'working' \
   AND working_since < datetime('now', '-4 hours');"

# Unlock stale issues
sqlite3 .woterclip/woterclip.db \
  "UPDATE issues SET state_label = NULL, working_since = NULL \
   WHERE state_label = 'working' \
   AND working_since < datetime('now', '-4 hours');"
```

### Operational Queries

**Export issues snapshot:**
```bash
sqlite3 .woterclip/woterclip.db ".mode csv" \
  "SELECT 'WOT-' || id as display_id, title, state, state_label, persona FROM issues \
   ORDER BY priority ASC, id ASC;"
```

**List recent comments:**
```bash
sqlite3 .woterclip/woterclip.db \
  "SELECT 'WOT-' || issue_id as issue_id, author, persona, created_at FROM comments \
   ORDER BY created_at DESC LIMIT 20;"
```

**Check heartbeat counter for specific issue:**
```bash
sqlite3 .woterclip/woterclip.db \
  "SELECT COALESCE(MAX(heartbeat_number) + 1, 1) as next_hb \
   FROM comments WHERE issue_id = 1 AND author = 'agent';"
```

**Count issues by state:**
```bash
sqlite3 .woterclip/woterclip.db \
  "SELECT state, COUNT(*) as count FROM issues GROUP BY state;"
```

**Find high-priority issues:**
```bash
sqlite3 .woterclip/woterclip.db \
  "SELECT 'WOT-' || id as display_id, title, priority FROM issues \
   WHERE priority <= 2 ORDER BY priority ASC;"
```

---

## Best Practices

### Development

1. **Use SQLite for local development** — No cloud credentials needed, instant feedback
2. **Regularly backup** — Run backup script before major operations
3. **Test migrations** — Use dry-run exports before moving to Linear
4. **Monitor lock contention** — If `max_parallel > 1`, watch for "Database is locked" errors

### Production

1. **Enable WAL mode** — Essential for concurrent reads (even single-writer)
2. **Set busy_timeout to 30000ms** — Safe for parallel heartbeat dispatch
3. **Monitor database size** — SQLite performs best < 100GB; consider archival or Linear migration for larger deployments
4. **Regular integrity checks** — Run `PRAGMA integrity_check` weekly
5. **Archive old comments** — After 1 year, export comments to archive table (future enhancement)

### Performance Tuning

**For very high issue volume (> 10K issues):**

1. **Partition comments table** (future)
   ```sql
   -- Create monthly partitions for large comment volumes
   CREATE TABLE comments_2026_05 PARTITION OF comments ...
   ```

2. **Use Linear backend** — Designed for multi-team, high-volume workloads

3. **Archive old issues**
   ```bash
   sqlite3 .woterclip/woterclip.db \
     "DELETE FROM comments WHERE issue_id IN \
      (SELECT id FROM issues WHERE done AND created_at < datetime('now', '-1 year'));"
   ```

---

## References

- **Backend Adapter:** `${CLAUDE_PLUGIN_ROOT}/references/backend-sqlite.md`
- **Heartbeat Skill:** `${CLAUDE_PLUGIN_ROOT}/skills/heartbeat/SKILL.md`
- **Linear Backend:** `${CLAUDE_PLUGIN_ROOT}/references/backend-linear.md`
- **WoterClip Design Spec:** `docs/specs/2026-03-25-woterclip-design.md`

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-05-21 | Initial schema documentation, migration guide, backup/restore procedures |

