# SQLite Backend Adapter Reference

This file documents the complete SQLite backend for WoterClip, implementing the 11-operation adapter contract. All adapter operations are performed via `sqlite3 .woterclip/woterclip.db "SQL"` or the `Write` tool for multi-line statements.

## Database Schema (DDL)

Initialize the database with the following SQL. Execute once at setup:

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
CREATE INDEX IF NOT EXISTS idx_issues_priority    ON issues(priority);
CREATE INDEX IF NOT EXISTS idx_issues_created_at  ON issues(created_at);
CREATE INDEX IF NOT EXISTS idx_issues_updated_at  ON issues(updated_at);
CREATE INDEX IF NOT EXISTS idx_comments_issue     ON comments(issue_id);
CREATE INDEX IF NOT EXISTS idx_comments_author    ON comments(issue_id, author, created_at);
CREATE INDEX IF NOT EXISTS idx_webhook_queue_status  ON webhook_queue(status);
CREATE INDEX IF NOT EXISTS idx_webhook_queue_source  ON webhook_queue(source);
CREATE INDEX IF NOT EXISTS idx_webhook_queue_event_id ON webhook_queue(event_id);

-- Full-Text Search (FTS5) for title and description
CREATE VIRTUAL TABLE IF NOT EXISTS issues_fts USING fts5(
    title, description, content='issues', content_rowid='id'
);

-- Triggers to keep FTS5 index in sync with issues table
CREATE TRIGGER IF NOT EXISTS issues_ai AFTER INSERT ON issues BEGIN
  INSERT INTO issues_fts(rowid, title, description) VALUES (new.id, new.title, new.description);
END;

CREATE TRIGGER IF NOT EXISTS issues_ad AFTER DELETE ON issues BEGIN
  INSERT INTO issues_fts(issues_fts, rowid, title, description) VALUES('delete', old.id, old.title, old.description);
END;

CREATE TRIGGER IF NOT EXISTS issues_au AFTER UPDATE ON issues BEGIN
  INSERT INTO issues_fts(issues_fts, rowid, title, description) VALUES('delete', old.id, old.title, old.description);
  INSERT INTO issues_fts(rowid, title, description) VALUES (new.id, new.title, new.description);
END;
```

### Schema Design Notes

- **display_id**: Computed as `'WOT-' || id` in every SELECT. No counter table needed.
- **state_label CHECK**: Enforces `NULL`, `'working'`, or `'blocked'` only. Mutual exclusion of `working` ↔ `blocked` is managed by adapter operation logic (never set both simultaneously).
- **persona**: Single TEXT column (one persona per issue). Matches Linear's one-label-per-issue constraint.
- **priority**: Integer mapping: 0=none, 1=urgent, 2=high, 3=medium, 4=low. Lower values = higher urgency.
  - Sub-issue priority bump: `priority = MAX(1, parent_priority - 1)` (decrement to raise urgency, floor at 1 to avoid going below urgent).
- **working_since**: ISO 8601 timestamp when `state_label` was set to `'working'`. Used for stale detection.
- **WAL mode + busy_timeout**: Enable concurrent reads. Writes serialize but `busy_timeout=30000` (30 seconds) provides sufficient patience for parallel lock acquisition during multi-issue heartbeat dispatch (Step 3). Essential for parallel processing with max_parallel > 1.
- **FTS5 (Full-Text Search)**: Virtual table `issues_fts` indexes title and description for efficient search. Kept in sync via triggers on INSERT/UPDATE/DELETE. See operation 12 `search_issues()` for query syntax.
- **Performance Indexes**: Composite and single-column indexes on frequently filtered fields (state, persona, priority, created_at, updated_at) for O(log N) lookups. FTS5 provides O(log N) text search with ranking.

---

## Adapter Operations

Each operation below shows the SQL statement(s) and usage context. All queries are static or use the escaping strategy described in "Quoting Strategy" section.

### 1. inbox_query()

**Purpose:** Fetch ordered queue of actionable issues.

**SQL:**
```sql
SELECT 
    'WOT-' || id AS display_id,
    id,
    title,
    persona,
    priority,
    state,
    state_label
FROM issues
WHERE state IN ('todo', 'in_progress') AND state_label IS NULL
ORDER BY priority ASC, id ASC
LIMIT 100;
```

**Usage:** Heartbeat Step 2. Returns issues ready for work (not in blocked or done state, not locked).

**Returns:** List of issue records with `display_id`, `id` (internal), `title`, `persona`, `priority`, `state`, `state_label`.

---

### 2. get_issue(display_id)

**Purpose:** Fetch full issue record by display_id.

**SQL (escape display_id):**
```sql
SELECT 
    'WOT-' || id AS display_id,
    id,
    title,
    description,
    persona,
    state,
    priority,
    parent_id,
    state_label,
    working_since,
    created_at,
    updated_at
FROM issues
WHERE id = (CAST(SUBSTR('DISPLAY_ID', 5) AS INTEGER))
  AND SUBSTR('DISPLAY_ID', 1, 4) = 'WOT-';
```

**Quoting:** `DISPLAY_ID` is a literal string from caller (e.g., `'WOT-42'`).

**Usage:** Heartbeat Step 7. Fetch full issue context before work begins.

**Returns:** Single row with all issue fields. Fails (no row) if display_id is invalid.

---

### 3. save_issue(fields)

**Purpose:** Create new issue or update existing.

**SQL for create:**
```sql
INSERT INTO issues(title, description, persona, state, priority, parent_id)
VALUES ('TITLE', 'DESCRIPTION', 'PERSONA', 'STATE', PRIORITY, PARENT_ID);
```

**SQL for update:**
```sql
UPDATE issues
SET title='TITLE', description='DESCRIPTION', persona='PERSONA', 
    state='STATE', priority=PRIORITY, updated_at=datetime('now')
WHERE id=ID;
```

**Quoting:** Title, description, persona are user-supplied strings. Escape single quotes: `'` → `''`.

**Multi-line write strategy:** For long descriptions or multi-paragraph text, use the Write tool to create a temp SQL file, then `sqlite3 .woterclip/woterclip.db < /tmp/query.sql`, then delete temp file.

**Usage:** 
- Create: Called during `/issue-add` command or `/heartbeat` decomposition (create sub-issue).
- Update: Called to change priority, state, or persona.

**Returns:** Last inserted ID (for creates) or row count updated (for updates).

---

### 4. create_sub_issue(parent_id, fields)

**Purpose:** Create child issue under a parent.

**SQL:**
```sql
INSERT INTO issues(title, description, persona, state, priority, parent_id)
VALUES ('TITLE', 'DESCRIPTION', 'PERSONA', 'todo', PRIORITY, PARENT_ID);
```

Where `PRIORITY = MAX(1, parent_priority - 1)` — look up parent priority first:

```sql
SELECT priority FROM issues WHERE id=PARENT_ID;
```

Then compute child priority and insert.

**Quoting:** Same as save_issue. Title, description are escaped.

**Usage:** Heartbeat Step 8. Developer persona creates `architect`- or `qa`-labeled sub-issues during work (future feature, PR3).

**Returns:** Last inserted ID of new sub-issue.

---

### 5. list_comments(display_id)

**Purpose:** Fetch all comments on an issue, ordered chronologically.

**SQL:**
```sql
SELECT 
    id,
    author,
    persona,
    body,
    heartbeat_number,
    created_at
FROM comments
WHERE issue_id = (CAST(SUBSTR('DISPLAY_ID', 5) AS INTEGER))
  AND SUBSTR('DISPLAY_ID', 1, 4) = 'WOT-'
ORDER BY created_at ASC;
```

**Quoting:** `DISPLAY_ID` is a literal string (e.g., `'WOT-42'`).

**Usage:** Heartbeat Step 7. Fetch issue history and prior heartbeat reports.

**Returns:** List of comment rows in chronological order.

---

### 6. save_comment(display_id, body, heartbeat_number, persona)

**Purpose:** Append agent or human comment to an issue.

**SQL:**
```sql
INSERT INTO comments(issue_id, author, persona, body, heartbeat_number, created_at)
VALUES (
    (CAST(SUBSTR('DISPLAY_ID', 5) AS INTEGER)),
    'agent',
    'PERSONA',
    'BODY',
    HEARTBEAT_NUMBER,
    datetime('now')
);
```

**Quoting:** 
- `DISPLAY_ID`: literal string (e.g., `'WOT-42'`).
- `PERSONA`: persona name, escape single quotes.
- `BODY`: comment text, escape single quotes.
- `HEARTBEAT_NUMBER`: integer.

**Multi-line write:** Use Write tool for long comment bodies (heartbeat reports often span multiple paragraphs).

**Author determination:** Always insert `author='agent'`. Human comments are added externally (future: web UI or email integration).

**Usage:** Heartbeat Step 9. Agent writes report comment with findings and decisions.

**Returns:** Last inserted comment ID.

---

### 7. set_state_label(display_id, label)

**Purpose:** Lock issue with `state_label='working'` or `'blocked'`, or unlock with `NULL`.

**SQL:**
```sql
UPDATE issues
SET state_label='LABEL', working_since=TIMESTAMP
WHERE id = (CAST(SUBSTR('DISPLAY_ID', 5) AS INTEGER))
  AND SUBSTR('DISPLAY_ID', 1, 4) = 'WOT-';
```

Where:
- `LABEL`: `'working'`, `'blocked'`, or `NULL` (to unlock)
- `TIMESTAMP`: `datetime('now')` when setting to `'working'` or `'blocked'`; `NULL` when unsetting

**SQL for lock (working):**
```sql
UPDATE issues
SET state_label='working', working_since=datetime('now')
WHERE id = (CAST(SUBSTR('DISPLAY_ID', 5) AS INTEGER));
```

**SQL for unlock:**
```sql
UPDATE issues
SET state_label=NULL, working_since=NULL
WHERE id = (CAST(SUBSTR('DISPLAY_ID', 5) AS INTEGER));
```

**Mutual exclusion note:** The CHECK constraint ensures `state_label` is valid. Mutual exclusion of `working` ↔ `blocked` is enforced by adapter logic: never call `set_state_label('working')` if already `blocked`, and vice versa. When transitioning, first set to `NULL`, then to the new label (or use single UPDATE with `state_label='new'`).

**Usage:**
- Heartbeat Step 6: Set `'working'` when claiming issue.
- Heartbeat Step 10: Set `NULL` to unlock when done.
- Blocked path: Set `'blocked'` when escalating, `NULL` when unblocking.

**Returns:** Row count updated (should be 1).

---

### 8. update_state(display_id, new_state)

**Purpose:** Update issue lifecycle state.

**SQL:**
```sql
UPDATE issues
SET state='STATE', updated_at=datetime('now')
WHERE id = (CAST(SUBSTR('DISPLAY_ID', 5) AS INTEGER))
  AND SUBSTR('DISPLAY_ID', 1, 4) = 'WOT-';
```

Where `STATE` is one of: `'backlog'`, `'todo'`, `'in_progress'`, `'in_review'`, `'done'`, `'canceled'`.

**Quoting:** State value is from a fixed enum (no escaping needed).

**Usage:** Heartbeat Step 10. Transition issue to `'done'` or `'canceled'` after work completes.

**Returns:** Row count updated (should be 1).

---

### 9. has_new_human_comments(display_id)

**Purpose:** Check if there are human comments after the last agent comment (for blocked dedup).

**SQL:**
```sql
SELECT COUNT(*) AS new_human_count
FROM comments
WHERE issue_id = (CAST(SUBSTR('DISPLAY_ID', 5) AS INTEGER))
  AND author = 'human'
  AND created_at > (
    SELECT MAX(created_at)
    FROM comments
    WHERE issue_id = (CAST(SUBSTR('DISPLAY_ID', 5) AS INTEGER))
      AND author = 'agent'
  );
```

**Logic:** Returns 0 if no human comments exist after the last agent comment. Returns > 0 if human has replied since agent's last report.

**Usage:** Heartbeat Step 10 (blocked path). Before re-entering `'blocked'` state, check if human has provided new direction. If yes, agent should wake up and re-read comments. If no, agent stays blocked and waits.

**Returns:** Integer count. Interpret as boolean: `new_human_count > 0` means yes.

---

### 10. detect_stale_working(hours)

**Purpose:** Find issues locked in `'working'` state for too long (orphaned locks).

**SQL:**
```sql
SELECT 
    'WOT-' || id AS display_id,
    id,
    title,
    persona,
    working_since
FROM issues
WHERE state_label = 'working'
  AND working_since < datetime('now', '-HOURS hours');
```

Where `HOURS` is an integer (e.g., `4` for 4 hours).

**Quoting:** Hours is a number; no escaping needed.

**Usage:** Heartbeat Step 2 (after inbox_query). Filter out stale locked issues (subagent crash or timeout). Optionally log and unlock them.

**Returns:** List of stale issue records. Empty list if none exist.

**Semantics note:** Differs from Linear's "no comment in N hours" — SQLite uses `working_since` timestamp. This is intentional simplification: agent may have commented after locking, so checking last comment is noisy.

---

### 11. next_heartbeat_number(display_id)

**Purpose:** Derive next heartbeat number for an issue (1-indexed counter).

**SQL:**
```sql
SELECT COALESCE(MAX(heartbeat_number) + 1, 1) AS next_number
FROM comments
WHERE issue_id = (CAST(SUBSTR('DISPLAY_ID', 5) AS INTEGER))
  AND author = 'agent';
```

**Logic:** Parse all agent comments for this issue, find max `heartbeat_number`, return `MAX + 1`. If no agent comments exist, return 1.

**Usage:** Heartbeat Step 7. Fetch number for the current heartbeat cycle. Injected into persona context and used in Step 9 comment body.

**Returns:** Single integer.

---

### 12. search_issues(query, limit, offset)

**Purpose:** Advanced search and filtering with FTS5 full-text search and field operators.

**Query Syntax:** Supports field operators (`state:todo`, `persona:backend`, `priority:high`, `label:architect`), boolean operators (AND, OR, -NOT), and full-text search. See `references/search-syntax.md` for complete syntax documentation.

**SQL Translation Example:**

User query: `state:todo AND priority:high "user login"`

Translates to:
```sql
SELECT 
    'WOT-' || i.id AS display_id,
    i.id,
    i.title,
    i.description,
    i.persona,
    i.priority,
    i.state,
    i.state_label,
    i.created_at,
    i.updated_at
FROM issues i
WHERE i.state = 'todo'
  AND i.priority <= 3
  AND i.id IN (
    SELECT rowid FROM issues_fts
    WHERE issues_fts MATCH 'user AND login'
  )
ORDER BY i.priority ASC, i.created_at DESC
LIMIT 100 OFFSET 0;
```

**Field Operators (parsed from query string):**

| Operator | Field | Valid Values |
|----------|-------|--------------|
| `state:` | state | `todo`, `in_progress`, `done`, `canceled`, `backlog`, `in_review` |
| `persona:` | persona | any persona name from config |
| `priority:` | priority | `none` (0), `low` (4), `medium` (3), `high` (2), `urgent` (1) |
| `label:` | custom label (free-form, stored as comment metadata or future label column) | any string |
| `parent:` | parent_id | issue display ID (parsed to numeric ID) |
| `author:` | comment author | `agent`, `human` |
| `created_after:` | created_at | ISO 8601 date (YYYY-MM-DD) |
| `created_before:` | created_at | ISO 8601 date (YYYY-MM-DD) |
| `updated_after:` | updated_at | ISO 8601 date (YYYY-MM-DD) |
| `updated_before:` | updated_at | ISO 8601 date (YYYY-MM-DD) |

**Boolean Operators:**
- `AND` — all conditions must match (implicit between tokens)
- `OR` — at least one condition must match
- `-` prefix — exclude (NOT)
- Parentheses for grouping

**Full-Text Search:**
- Text without operators is searched against `issues_fts(title, description)` using FTS5 MATCH syntax
- Phrases in double quotes are exact phrase matches
- Multiple words are implicitly AND'd

**Pagination:**
- `limit` — max results (default: 100, max: 1000)
- `offset` — skip N results (for page M: offset = M * limit)

**Response Format (JSON):**
```json
{
  "results": [
    {
      "display_id": "WOT-42",
      "id": 42,
      "title": "...",
      "description": "...",
      "persona": "backend",
      "priority": 2,
      "state": "todo",
      "state_label": null,
      "created_at": "2026-05-20T10:30:00Z",
      "updated_at": "2026-05-21T14:22:00Z"
    }
  ],
  "total": 342,
  "limit": 100,
  "offset": 0,
  "has_more": true
}
```

**Implementation Notes:**
- Parser converts query string into SQL WHERE clauses and MATCH conditions
- State/persona/priority constraints are AND'd together
- FTS5 queries are restricted to indexed columns (title, description)
- Result ordering: priority ASC (urgent first), then created_at DESC (newest first)
- For large result sets (total > 1000), pagination is required

**Usage:** Heartbeat Step 2 (advanced inbox queries), manual issue lookup via skill command, or future dashboard.

**Returns:** JSON object with `results` array, `total` count, and pagination metadata.

---

## Webhook Queue Operations (Phase 2)

### 12. enqueue_webhook(event_id, source, event_type)

**Purpose:** Add a webhook event to the queue for processing.

**SQL:**
```sql
INSERT INTO webhook_queue(event_id, source, event_type, status)
VALUES ('EVENT_ID', 'SOURCE', 'EVENT_TYPE', 'pending');
```

Where:
- `EVENT_ID`: Unique identifier (UUID or timestamp-based string)
- `SOURCE`: 'github' or 'linear'
- `EVENT_TYPE`: Optional event type string (e.g., 'issues.opened')

**Returns:** Last inserted row ID (can be ignored for this operation).

**Error Handling:** If `event_id` already exists (UNIQUE constraint), returns constraint error. Check via operation 13 first.

---

### 13. webhook_event_exists(event_id)

**Purpose:** Check if a webhook event has been seen before (deduplication).

**SQL:**
```sql
SELECT COUNT(*) AS exists
FROM webhook_queue
WHERE event_id = 'EVENT_ID';
```

**Returns:** 0 if not seen, > 0 if duplicate.

**Logic:** Used for deduplication in the HTTP listener. If `exists > 0`, return 409 Conflict without enqueueing.

---

### 14. mark_webhook_triggered(event_id)

**Purpose:** Mark a queued event as triggered (i.e., `/heartbeat` invocation started).

**SQL:**
```sql
UPDATE webhook_queue
SET status = 'triggered', triggered_at = datetime('now')
WHERE event_id = 'EVENT_ID';
```

**Returns:** Row count updated (should be 1).

---

### 15. mark_webhook_completed(event_id)

**Purpose:** Mark a triggered event as completed successfully.

**SQL:**
```sql
UPDATE webhook_queue
SET status = 'completed', completed_at = datetime('now')
WHERE event_id = 'EVENT_ID';
```

**Returns:** Row count updated (should be 1).

---

### 16. mark_webhook_failed(event_id, error_message)

**Purpose:** Mark a triggered event as failed with error details.

**SQL:**
```sql
UPDATE webhook_queue
SET status = 'failed', completed_at = datetime('now'), error_message = 'ERROR_MSG'
WHERE event_id = 'EVENT_ID';
```

Where `ERROR_MSG` is the error text (escaped).

**Returns:** Row count updated (should be 1).

---

### 17. list_pending_webhooks(limit)

**Purpose:** Fetch pending webhooks for batch processing (optional, for admin/debugging).

**SQL:**
```sql
SELECT 
    id,
    event_id,
    source,
    event_type,
    status,
    queued_at
FROM webhook_queue
WHERE status = 'pending'
ORDER BY queued_at ASC
LIMIT LIMIT_VALUE;
```

**Returns:** List of pending webhook rows.

---

### 18. cleanup_webhook_queue(hours)

**Purpose:** Purge old completed/failed webhook events to prevent table bloat.

**SQL:**
```sql
DELETE FROM webhook_queue
WHERE status IN ('completed', 'failed')
  AND completed_at < datetime('now', '-HOURS hours');
```

Where `HOURS` is an integer (default: 48).

**Returns:** Row count deleted.

**Usage:** Run periodically (e.g., daily) to clean up processed events.

---

## Quoting Strategy

SQLite's escaping rules: single quotes inside strings are escaped by doubling (`'` → `''`). Backticks and double quotes are for identifiers; not needed here.

### Tier 1: Static Queries

Queries with no user input (enum values, computed IDs):

```bash
sqlite3 .woterclip/woterclip.db 'SELECT ... WHERE state_label="working"'
```

**Safe:** Hardcoded strings and numbers.

### Tier 2: User-Supplied Strings (Single-Statement)

Titles, descriptions, persona names, comment bodies in one INSERT or UPDATE:

```bash
# Escape user input: replace ' with ''
user_title="Test's issue"
escaped_title="${user_title//\'/\'\'}"  # bash: replace ' with ''

sqlite3 .woterclip/woterclip.db "INSERT INTO issues(title) VALUES('$escaped_title')"
```

**Rule:** Before interpolating user strings into SQL, replace all `'` with `''`.

### Tier 3: Multi-Line Writes (Temp File)

Long descriptions or multi-paragraph comment bodies:

```bash
# Write SQL to temp file
cat > /tmp/wot_insert.sql <<'EOF'
INSERT INTO issues(title, description) VALUES(
    'New feature',
    'This is a longer description
that spans multiple lines.
Quotes like ''this'' are escaped.'
);
EOF

sqlite3 .woterclip/woterclip.db < /tmp/wot_insert.sql
rm /tmp/wot_insert.sql
```

**Rule:** For descriptions or comment bodies that are multi-line or user-supplied with special characters, use the Write tool to create a `.sql` file, execute via `sqlite3 .read`, then delete.

---

## Typical Use Cases

### Creating an Issue

1. Prompt user for title, description, persona, priority.
2. Escape title and description (Tier 2 or Tier 3).
3. Execute `save_issue()` with `state='todo'`.
4. Return display_id (parse from `id` returned by last insert).

### Listing Issues

1. Execute `inbox_query()`.
2. Display results in table format.

### Starting Heartbeat

1. Load config, read `config.backend`.
2. Execute `inbox_query()`.
3. Pick first N issues (up to `max_parallel`).
4. For each, execute `set_state_label(display_id, 'working')`.
5. Dispatch subagent per issue.

### Agent Reports Findings

1. Format report text (may be multi-paragraph).
2. Execute `next_heartbeat_number()` for issue.
3. Execute `save_comment()` with report body, agent author, persona, heartbeat_number.

### Completing Work

1. Execute `update_state(display_id, 'done')`.
2. Execute `set_state_label(display_id, NULL)` to unlock.
3. Optional: check for sub-issues still in progress (parent stays `'in_progress'` until all children are `'done'`).

### Blocked Escalation

1. Check `has_new_human_comments()` — if true, wake up and continue.
2. If false, execute `set_state_label(display_id, 'blocked')`.
3. Wait for human input (next heartbeat cycle checks again).

---

## Concurrency Notes

### WAL Mode Behavior

- **PRAGMA journal_mode=WAL**: Enables Write-Ahead Logging. Concurrent readers don't block writers; multiple readers can proceed in parallel.
- **PRAGMA busy_timeout=5000**: If a connection encounters a locked database (writer in progress), retry for up to 5 seconds instead of failing immediately.

### Multiple Subagents (PR2+)

When processing up to `max_parallel` issues simultaneously:
- Subagent 1 locks issue WOT-1 (`state_label='working'`).
- Subagent 2 locks issue WOT-2 (`state_label='working'`).
- Both can read the schema and other issues' metadata in parallel.
- Writes serialize: Subagent 1's comment insert completes first, Subagent 2's write waits (< 5s).
- `busy_timeout` prevents "database is locked" errors under normal load.

### Single-Statement Safety

Each adapter operation is a single SQL statement (no multi-statement transactions). SQLite's implicit transaction wrapping is sufficient. No explicit `BEGIN`/`COMMIT` needed.

### Orphaned Locks

If a subagent crashes while `state_label='working'`:
- Parent heartbeat (main loop) detects the orphan via `detect_stale_working(hours)`.
- Parent unlocks: `set_state_label(display_id, NULL)`.
- Issue re-enters queue on next heartbeat.

---

## Priority Mapping

| Value | Meaning   |
|-------|-----------|
| 0     | None      |
| 1     | Urgent    |
| 2     | High      |
| 3     | Medium    |
| 4     | Low       |

**Lower integer = higher priority.** Queries use `ORDER BY priority ASC` to sort by urgency.

### Sub-Issue Priority Bump

When creating a child issue under a parent:
- Fetch parent's `priority`.
- Compute child: `child_priority = MAX(1, parent_priority - 1)`.
- Example: parent priority 3 (medium) → child priority 2 (high). Parent priority 1 (urgent) → child priority 1 (stays urgent).

This ensures sub-issues are slightly more urgent than their parents, pulling forward critical blocking work.

---

## SQL Syntax Quick Reference

### Common patterns

**Fetch single issue:**
```sql
SELECT * FROM issues WHERE 'WOT-' || id = 'WOT-42';
```

**All comments on issue:**
```sql
SELECT * FROM comments WHERE issue_id = 42 ORDER BY created_at ASC;
```

**Count agent reports (heartbeat counter):**
```sql
SELECT COUNT(*) FROM comments WHERE issue_id = 42 AND author = 'agent';
```

**Issues ready to work:**
```sql
SELECT * FROM issues WHERE state IN ('todo', 'in_progress') AND state_label IS NULL;
```

**Check sub-issue relationship:**
```sql
SELECT 'WOT-' || parent_id AS parent FROM issues WHERE 'WOT-' || id = 'WOT-99';
```

---

## Error Handling

- **Invalid display_id format** (not `WOT-N`): Query returns 0 rows. Heartbeat should error with message: "Issue not found."
- **Constraint violations** (e.g., bad state_label): SQLite returns IntegrityError. Log error and escalate to CEO.
- **Database locked**: Retried up to 5 seconds by `busy_timeout`. If still locked after 5s, heartbeat fails and logs: "Database locked — concurrent heartbeat likely running."
- **Parent issue not found** (invalid parent_id in create_sub_issue): Foreign key constraint fails. Validate parent exists before creating child.

---

## Files Referenced

- `.woterclip/woterclip.db`: SQLite database (created by `woterclip-init` skill).
- `.woterclip/config.yaml`: Heartbeat reads `backend: sqlite` field here.
- `heartbeat-log.jsonl`: Append-only audit log (separate from DB, not affected by backend choice).

---

## Debugging Tips

### Check database integrity:
```bash
sqlite3 .woterclip/woterclip.db "PRAGMA integrity_check;"
```

### Inspect schema:
```bash
sqlite3 .woterclip/woterclip.db ".schema"
```

### Export issue snapshot:
```bash
sqlite3 .woterclip/woterclip.db ".mode csv" "SELECT 'WOT-' || id, title, state, state_label FROM issues;"
```

### Tail comments (latest 10):
```bash
sqlite3 .woterclip/woterclip.db "SELECT 'WOT-' || issue_id, author, body FROM comments ORDER BY created_at DESC LIMIT 10;"
```

### Verify WAL mode:
```bash
sqlite3 .woterclip/woterclip.db "PRAGMA journal_mode;"  # Should output: wal
```
