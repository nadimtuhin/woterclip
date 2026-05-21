# WOT-9: Advanced Issue Search & Filtering - Technical Specification

**Issue**: WOT-9  
**Persona**: backend  
**Heartbeat Cycle**: #5  
**Status**: in_review  
**Date**: 2026-05-21

## Overview
Full-text search capability with advanced filtering for WoterClip issues across backends (Linear cloud and SQLite).

## API Design

### Search Endpoint
```
GET /issues/search?q=<query>&filters=<filters>&limit=<limit>&offset=<offset>
```

**Query Parameter**
- `q` (string, required): Free-text search query. Searches across title, description, and comments.

**Filter Parameters** (all optional, all can be combined)
- `state` (comma-separated): `backlog|todo|in_progress|in_review|done|canceled`
- `persona` (comma-separated): `backend|frontend|qa|architect|ceo|orchestrator`
- `priority` (comma-separated): `0|1|2|3` (0=None, 1=Urgent, 2=High, 3=Medium, 4=Low)
- `label` (comma-separated): Any custom label strings
- `created_after` (ISO-8601): Filter by creation date
- `created_before` (ISO-8601): Filter by creation date
- `state_label` (comma-separated): `working|blocked`
- `has_comments` (boolean): `true|false` — only issues with/without comments

**Pagination**
- `limit` (integer, default 50, max 500): Results per page
- `offset` (integer, default 0): For manual offset pagination

**Response**
```json
{
  "total": 42,
  "limit": 50,
  "offset": 0,
  "results": [
    {
      "id": 9,
      "title": "Implement advanced issue search and filtering",
      "persona": "backend",
      "state": "in_review",
      "priority": 3,
      "created_at": "2026-05-21T10:00:00Z",
      "updated_at": "2026-05-21T14:30:00Z"
    }
  ]
}
```

## Full-Text Search Implementation

### SQLite Backend
Use SQLite FTS5 (Full-Text Search) module:
```sql
CREATE VIRTUAL TABLE issues_fts USING fts5(
  title,
  description,
  content=issues,
  content_rowid=id
);
```

**Search query:**
```sql
SELECT issues.id, issues.title, issues.description
FROM issues
JOIN issues_fts ON issues.id = issues_fts.rowid
WHERE issues_fts MATCH 'advanced AND search'
  AND issues.state IN (?, ?, ...)
ORDER BY rank;
```

### Linear Backend
Use Linear API search parameters:
- Filter via `filter` parameter in GraphQL query
- Full-text matching on title/description fields
- Combine with state/assignee filters

## Filter Implementation

### SQLite
Build dynamic WHERE clause:
```sql
WHERE (title LIKE ? OR description LIKE ?)
  AND state IN (?, ?, ...)
  AND persona IN (?, ?, ...)
  AND priority IN (?, ?, ...)
  AND created_at >= ?
  AND created_at <= ?
```

### Linear
Combine GraphQL filter fields:
```graphql
issues(
  filter: {
    title: { contains: "search" }
    state: { in: ["backlog", "todo"] }
    assignee: { displayName: { contains: "backend" } }
  }
  first: 50
)
```

## Ranking & Sorting
- **Full-text**: SQLite FTS rank, Linear relevance score
- **Custom sort**: By created_at, updated_at, priority
- **Default**: Relevance (FTS rank), then most recent first

## Search Query Syntax (Optional Phase 2)
- `"exact phrase"` — phrase search
- `+required -excluded` — boolean operators
- `field:value` — scoped search (e.g., `state:done`, `persona:backend`)

## Error Handling
- Invalid persona/state → 400 Bad Request with field hints
- Query too long (>1000 chars) → 422 Unprocessable Entity
- Backend timeout → 504 Gateway Timeout

## Performance Considerations
- Index on: `state`, `persona`, `priority`, `created_at`
- FTS5 index for SQLite
- GraphQL query limits for Linear
- Cache search results for 5 minutes (optional)

## Testing Requirements
- Empty query with filters only
- Full-text search with multiple keywords
- Combined full-text + filters
- Pagination across results
- Cross-backend consistency (same query on both)

## Implementation Steps
1. Define adapter interfaces for search
2. Implement SQLite FTS5 integration
3. Implement Linear GraphQL search
4. Build REST endpoint/CLI command
5. Add search to UI/dashboard (phase 2)
6. Performance testing & optimization

## Next Steps
Awaiting architecture review before implementation begins.
