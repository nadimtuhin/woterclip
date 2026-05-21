# Advanced Search Syntax for WoterClip

This reference defines the query language for advanced issue search and filtering in WoterClip. The search syntax is backend-agnostic but implemented via SQLite FTS5 for the SQLite backend.

## Overview

The search system provides:
1. **Full-text search (FTS)** – search issue titles and descriptions
2. **Filter operators** – structured queries on specific fields
3. **Boolean operators** – AND, OR combinations
4. **Pagination** – handle result sets > 100 items
5. **Performance** – indexed queries for fast filtering

## Query Syntax

### Basic Full-Text Search

Search across title and description without operators:

```
"authentication flow"          # phrase search
search term                    # implicit AND between words
```

Examples:
- `login page` – find issues mentioning both "login" and "page"
- `"user authentication"` – exact phrase match

### Field Operators

Structure queries with `field:value` syntax:

| Operator | Field | Values | Examples |
|----------|-------|--------|----------|
| `state:` | issue state | `todo`, `in_progress`, `done`, `canceled`, `backlog`, `in_review` | `state:done` |
| `persona:` | assigned persona | persona name from config | `persona:backend`, `persona:qa` |
| `priority:` | issue priority | `none` (0), `low` (1), `medium` (2), `high` (3), `urgent` (4) | `priority:high`, `priority:urgent` |
| `label:` | string label (free-form) | any string | `label:architect`, `label:blocker` |
| `parent:` | parent issue ID | issue display ID | `parent:WOT-5` |
| `author:` | comment author | `agent`, `human` | `author:agent` |

### Boolean Operators

Combine clauses with explicit operators:

- `AND` – all conditions must match (default between clauses)
- `OR` – at least one condition must match
- `-` (NOT prefix) – exclude results matching this clause

Examples:
```
state:todo AND persona:backend
state:done OR priority:high
state:todo AND -persona:qa
priority:urgent AND (state:todo OR state:in_progress)
```

### Complex Queries

Nest conditions with parentheses:

```
(state:todo OR state:in_progress) AND persona:backend
(priority:urgent OR priority:high) AND label:blocker
state:done AND created_after:2026-05-01
```

## Search Operators (Time-based)

For temporal filtering:

| Operator | Meaning | Examples |
|----------|---------|----------|
| `created_after:YYYY-MM-DD` | issues created after date | `created_after:2026-05-01` |
| `created_before:YYYY-MM-DD` | issues created before date | `created_before:2026-05-15` |
| `updated_after:YYYY-MM-DD` | issues updated after date | `updated_after:2026-05-10` |
| `updated_before:YYYY-MM-DD` | issues updated before date | `updated_before:2026-05-20` |

Examples:
```
state:todo created_after:2026-05-10
priority:high updated_after:2026-05-15
```

## Pagination

For large result sets, use pagination parameters:

- `limit: N` – return at most N results (default: 100, max: 1000)
- `offset: M` – skip first M results for page M

Examples:
```json
{
  "query": "state:todo",
  "limit": 50,
  "offset": 0
}
```

Response includes:
```json
{
  "results": [...],
  "total": 342,
  "limit": 50,
  "offset": 0,
  "has_more": true
}
```

## Implementation Details

### SQLite FTS5 Table

The search system uses SQLite's Full-Text Search 5 (FTS5) for efficient text queries:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS issues_fts USING fts5(
  title, description, content='issues', content_rowid='id'
);
```

This virtual table is populated via triggers whenever issues are created or updated.

### Indexes

For performance on filtered queries:

```sql
CREATE INDEX IF NOT EXISTS idx_issues_state       ON issues(state);
CREATE INDEX IF NOT EXISTS idx_issues_state_label ON issues(state_label);
CREATE INDEX IF NOT EXISTS idx_issues_persona     ON issues(persona);
CREATE INDEX IF NOT EXISTS idx_issues_priority    ON issues(priority);
CREATE INDEX IF NOT EXISTS idx_issues_created_at  ON issues(created_at);
CREATE INDEX IF NOT EXISTS idx_issues_updated_at  ON issues(updated_at);
```

### Query Translation

The search engine translates user queries into SQL with FTS5:

**User Query:**
```
state:todo AND priority:high "user login"
```

**Translated SQL:**
```sql
SELECT i.* FROM issues i
WHERE i.state = 'todo'
  AND i.priority >= 3
  AND i.id IN (
    SELECT rowid FROM issues_fts
    WHERE issues_fts MATCH 'user AND login'
  )
ORDER BY i.priority DESC, i.created_at DESC
LIMIT 100;
```

## Common Patterns

### Find my work
```
persona:backend state:in_progress
```

### Urgent blockers
```
priority:urgent AND label:blocker
```

### Recent completed items
```
state:done created_after:2026-05-15
```

### Sub-issues
```
parent:WOT-5
```

### Issues waiting on QA
```
state:in_review AND persona:qa
```

## Error Handling

Invalid queries return structured errors:

```json
{
  "error": "invalid_query",
  "message": "Unknown operator: 'status:'. Did you mean 'state:'?",
  "suggestion": "state:todo"
}
```

Common mistakes:
- `status:todo` → should be `state:todo`
- `owner:backend` → should be `persona:backend`
- Unmatched parentheses → parse error with position
- Invalid state values → list valid states in error message

## Performance Considerations

### Query Cost

- **FTS5 text search** – O(log N) with index
- **Single field filter** (e.g., `state:todo`) – O(log N) with index
- **Multiple filters** – O(log N) per indexed field, then set intersection
- **Unindexed filter** – O(N) full scan (rare; most fields are indexed)

### Optimization Tips

1. **Use state filters first** – most selective, heavily indexed
2. **Combine with persona** – narrow result set early
3. **Avoid full-text without structure** – pair with a field operator for best performance
4. **Pagination for large sets** – use `limit`/`offset` for sets > 1000 items

### Caching

The heartbeat skill may cache search results for the current cycle:
- Inbox queries are cached for duration of the cycle
- `max_parallel` issues are fetched and cached at Step 2
- No secondary caching at adapter level (rely on SQLite query cache)

## Adapter Implementation

Both Linear and SQLite adapters expose search via:

```
adapter.search_issues(query, limit=100, offset=0)
```

The Linear adapter translates the syntax to its GraphQL filters; SQLite uses native SQL.

### SQLite Search Operation

Called from heartbeat Step 2:

```bash
# Invoke via bash + jq
sqlite3 .woterclip/.database.db "
  SELECT json_object(
    'display_id', 'WOT-' || id,
    'title', title,
    'state', state,
    'persona', persona,
    'priority', priority
  ) FROM issues
  WHERE state IN ('todo', 'in_progress')
  ORDER BY state DESC, priority DESC
  LIMIT 100;
" | jq -s .
```

## Examples

### Find all backend work
```
persona:backend state:todo
```

### Urgent items in progress
```
priority:urgent state:in_progress
```

### Issues by a specific person (via author of comments)
```
author:human
```

### Completed architectural work
```
state:done persona:architect
```

### Find issues with specific label
```
label:critical
```

### Multi-condition: high-priority backend work
```
priority:high AND persona:backend AND (state:todo OR state:in_progress)
```
