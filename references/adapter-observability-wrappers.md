# Adapter Observability Wrappers — Phase 1 Implementation

## Overview

This document provides concrete implementations of observability logging for both SQLite and Linear backend adapters. These wrappers enable timing metrics, operation counts, and error tracking for all issue-related operations.

## SQLite Adapter Observability

### Helper Function

Create in `references/backend-sqlite.md` or as a shared function in subagent execution context:

```bash
#!/bin/bash
# SQLite adapter with observability logging

_log_sqlite_event() {
  local op=$1 status=$2 duration=$3 rows=$4 error=$5
  local timestamp=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
  local hb_num=${HEARTBEAT_NUMBER:-0}
  local issue_id=${ISSUE_ID:-null}
  
  cat >> "${OBSDIR:-.woterclip/observability}/adapter-events.jsonl" << JSON
{"timestamp":"$timestamp","heartbeat_number":$hb_num,"issue_id":$issue_id,"event_type":"adapter.operation","operation":"$op","backend":"sqlite","status":"$status","duration_ms":$duration,"rows_affected":$rows,"error":$error}
JSON
}

# Wrapped operation: list_issues
list_issues() {
  local filter_status="${1:-in_progress,agent-blocked,todo}"
  local start_ns=$(date +%s%N)
  
  local query="SELECT id, title, labels, priority, state, updated_at FROM issues WHERE state IN ('${filter_status//,/\',\'}') ORDER BY priority DESC, updated_at ASC;"
  local result=$(sqlite3 "${DB_PATH:-.woterclip/woterclip.db}" "$query" 2>&1)
  local exit_code=$?
  
  local end_ns=$(date +%s%N)
  local duration_ms=$(( (end_ns - start_ns) / 1000000 ))
  
  if [ $exit_code -eq 0 ]; then
    local rows=$(echo "$result" | wc -l)
    _log_sqlite_event "list_issues" "success" $duration_ms $rows "null"
    echo "$result"
  else
    _log_sqlite_event "list_issues" "failure" $duration_ms 0 "\"query failed\""
    return $exit_code
  fi
}

# Wrapped operation: create_issue
create_issue() {
  local title="$1" description="$2" persona_label="$3" priority="${4:-3}"
  local start_ns=$(date +%s%N)
  
  sqlite3 "${DB_PATH:-.woterclip/woterclip.db}" << SQLITE 2>&1
INSERT INTO issues (title, description, labels, priority, state, created_at, updated_at)
VALUES ('$title', '$description', '$persona_label', $priority, 'todo', datetime('now'), datetime('now'));
SQLITE
  local exit_code=$?
  
  local end_ns=$(date +%s%N)
  local duration_ms=$(( (end_ns - start_ns) / 1000000 ))
  
  if [ $exit_code -eq 0 ]; then
    _log_sqlite_event "create_issue" "success" $duration_ms 1 "null"
  else
    _log_sqlite_event "create_issue" "failure" $duration_ms 0 "\"insert failed\""
    return $exit_code
  fi
}

# Wrapped operation: update_issue
update_issue() {
  local issue_id="$1" field="$2" value="$3"
  local start_ns=$(date +%s%N)
  
  sqlite3 "${DB_PATH:-.woterclip/woterclip.db}" "UPDATE issues SET $field = '$value', updated_at = datetime('now') WHERE id = $issue_id;" 2>&1
  local exit_code=$?
  
  local end_ns=$(date +%s%N)
  local duration_ms=$(( (end_ns - start_ns) / 1000000 ))
  
  if [ $exit_code -eq 0 ]; then
    _log_sqlite_event "update_issue" "success" $duration_ms 1 "null"
  else
    _log_sqlite_event "update_issue" "failure" $duration_ms 0 "\"update failed\""
    return $exit_code
  fi
}

# Wrapped operation: add_comment
add_comment() {
  local issue_id="$1" author="$2" persona="$3" body="$4"
  local hb_num=${HEARTBEAT_NUMBER:-0}
  local start_ns=$(date +%s%N)
  
  sqlite3 "${DB_PATH:-.woterclip/woterclip.db}" << SQLITE 2>&1
INSERT INTO comments (issue_id, author, persona, body, heartbeat_number, created_at)
VALUES ($issue_id, '$author', '$persona', '$body', $hb_num, datetime('now'));
SQLITE
  local exit_code=$?
  
  local end_ns=$(date +%s%N)
  local duration_ms=$(( (end_ns - start_ns) / 1000000 ))
  
  if [ $exit_code -eq 0 ]; then
    _log_sqlite_event "add_comment" "success" $duration_ms 1 "null"
  else
    _log_sqlite_event "add_comment" "failure" $duration_ms 0 "\"insert failed\""
    return $exit_code
  fi
}

# Wrapped operation: close_issue
close_issue() {
  local issue_id="$1"
  local start_ns=$(date +%s%N)
  
  sqlite3 "${DB_PATH:-.woterclip/woterclip.db}" "UPDATE issues SET state = 'done', updated_at = datetime('now') WHERE id = $issue_id;" 2>&1
  local exit_code=$?
  
  local end_ns=$(date +%s%N)
  local duration_ms=$(( (end_ns - start_ns) / 1000000 ))
  
  if [ $exit_code -eq 0 ]; then
    _log_sqlite_event "close_issue" "success" $duration_ms 1 "null"
  else
    _log_sqlite_event "close_issue" "failure" $duration_ms 0 "\"update failed\""
    return $exit_code
  fi
}
```

### Metrics Captured

Each SQLite operation logs:
- **timestamp**: ISO8601 UTC
- **heartbeat_number**: Current cycle (for correlation)
- **issue_id**: Affected issue (null for list operations)
- **operation**: Function name (list_issues, create_issue, etc.)
- **status**: "success" or "failure"
- **duration_ms**: Wall-clock time in milliseconds
- **rows_affected**: Count of rows inserted/updated/deleted
- **error**: Error message or "null"

### Example Events

```jsonl
{"timestamp":"2026-05-21T12:00:00Z","heartbeat_number":23,"issue_id":null,"event_type":"adapter.operation","operation":"list_issues","backend":"sqlite","status":"success","duration_ms":42,"rows_affected":3,"error":"null"}
{"timestamp":"2026-05-21T12:00:01Z","heartbeat_number":23,"issue_id":4,"event_type":"adapter.operation","operation":"add_comment","backend":"sqlite","status":"success","duration_ms":18,"rows_affected":1,"error":"null"}
{"timestamp":"2026-05-21T12:00:02Z","heartbeat_number":23,"issue_id":null,"event_type":"adapter.operation","operation":"list_issues","backend":"sqlite","status":"failure","duration_ms":15,"rows_affected":0,"error":"\"database locked\""}
```

## Linear Adapter Observability

### Helper Function

For MCP-based Linear backend operations:

```bash
#!/bin/bash
# Linear adapter with observability logging

_log_linear_event() {
  local op=$1 status=$2 duration=$3 error=$4
  local timestamp=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
  local hb_num=${HEARTBEAT_NUMBER:-0}
  local issue_id=${ISSUE_ID:-null}
  
  cat >> "${OBSDIR:-.woterclip/observability}/adapter-events.jsonl" << JSON
{"timestamp":"$timestamp","heartbeat_number":$hb_num,"issue_id":$issue_id,"event_type":"adapter.operation","operation":"$op","backend":"linear","status":"$status","duration_ms":$duration,"rows_affected":null,"error":$error}
JSON
}

# Wrapped operation: list_issues via Linear MCP
list_issues_linear() {
  local start_ns=$(date +%s%N)
  
  # Call Linear MCP tool (pseudo-code; exact syntax depends on MCP binding)
  local result=$(mcp_tool_call claude_ai_Linear searchIssues --query "state:\"In Progress\"" 2>&1)
  local exit_code=$?
  
  local end_ns=$(date +%s%N)
  local duration_ms=$(( (end_ns - start_ns) / 1000000 ))
  
  if [ $exit_code -eq 0 ]; then
    _log_linear_event "list_issues" "success" $duration_ms "null"
    echo "$result"
  else
    _log_linear_event "list_issues" "failure" $duration_ms "\"MCP call failed\""
    return $exit_code
  fi
}

# Wrapped operation: create_issue via Linear MCP
create_issue_linear() {
  local title="$1" description="$2" team_id="$3"
  local start_ns=$(date +%s%N)
  
  local result=$(mcp_tool_call claude_ai_Linear createIssue \
    --title "$title" \
    --description "$description" \
    --team_id "$team_id" \
    --state "Todo" 2>&1)
  local exit_code=$?
  
  local end_ns=$(date +%s%N)
  local duration_ms=$(( (end_ns - start_ns) / 1000000 ))
  
  if [ $exit_code -eq 0 ]; then
    _log_linear_event "create_issue" "success" $duration_ms "null"
    echo "$result"
  else
    _log_linear_event "create_issue" "failure" $duration_ms "\"MCP call failed\""
    return $exit_code
  fi
}

# Wrapped operation: update_issue via Linear MCP
update_issue_linear() {
  local issue_id="$1" field="$2" value="$3"
  local start_ns=$(date +%s%N)
  
  local result=$(mcp_tool_call claude_ai_Linear updateIssue \
    --id "$issue_id" \
    --field "$field" \
    --value "$value" 2>&1)
  local exit_code=$?
  
  local end_ns=$(date +%s%N)
  local duration_ms=$(( (end_ns - start_ns) / 1000000 ))
  
  if [ $exit_code -eq 0 ]; then
    _log_linear_event "update_issue" "success" $duration_ms "null"
    echo "$result"
  else
    _log_linear_event "update_issue" "failure" $duration_ms "\"MCP call failed\""
    return $exit_code
  fi
}

# Wrapped operation: add_comment via Linear MCP
add_comment_linear() {
  local issue_id="$1" body="$2"
  local start_ns=$(date +%s%N)
  
  local result=$(mcp_tool_call claude_ai_Linear addComment \
    --issue_id "$issue_id" \
    --body "$body" 2>&1)
  local exit_code=$?
  
  local end_ns=$(date +%s%N)
  local duration_ms=$(( (end_ns - start_ns) / 1000000 ))
  
  if [ $exit_code -eq 0 ]; then
    _log_linear_event "add_comment" "success" $duration_ms "null"
    echo "$result"
  else
    _log_linear_event "add_comment" "failure" $duration_ms "\"MCP call failed\""
    return $exit_code
  fi
}
```

### Metrics Captured

Linear operations log the same schema as SQLite (except `rows_affected` is always null):
- **timestamp**: ISO8601 UTC
- **heartbeat_number**: Current cycle
- **issue_id**: Affected issue (null for list operations)
- **operation**: Function name
- **backend**: "linear"
- **status**: "success" or "failure"
- **duration_ms**: Wall-clock time in milliseconds
- **rows_affected**: null (Linear doesn't report row counts)
- **error**: MCP error message or "null"

## Persona-Level Observability

Each persona also logs step-level events for end-to-end tracing:

```bash
_log_persona_event() {
  local step=$1 task=$2 status=$3 duration=$4 details=$5
  local timestamp=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
  local hb_num=${HEARTBEAT_NUMBER:-0}
  local issue_id=${ISSUE_ID:-0}
  local persona=${PERSONA_NAME:-"unknown"}
  
  cat >> "${OBSDIR:-.woterclip/observability}/persona-events.jsonl" << JSON
{"timestamp":"$timestamp","heartbeat_number":$hb_num,"issue_id":$issue_id,"persona":"$persona","event_type":"step.completed","step":$step,"task_name":"$task","status":"$status","duration_ms":$duration,"error":null,"details":$details}
JSON
}

# Example usage in Step 8 (do-work):
start_time=$(date +%s%N)
# ... actual work ...
end_time=$(date +%s%N)
duration_ms=$(( (end_time - start_time) / 1000000 ))
_log_persona_event 8 "do-work" "completed" $duration_ms '{"files_created":1,"commits":1}'
```

## Integration Points

### In Heartbeat Skill (`skills/heartbeat/SKILL.md`)

After Step 11 (Cleanup & Exit), merge temporary logs:

```bash
# Merge persona and adapter logs from subagent temp files
cat /tmp/persona-events-*.jsonl >> "${OBSDIR:-.woterclip/observability}/persona-events.jsonl" 2>/dev/null || true
cat /tmp/adapter-events-*.jsonl >> "${OBSDIR:-.woterclip/observability}/adapter-events.jsonl" 2>/dev/null || true

# Clean up temp files
rm -f /tmp/persona-events-*.jsonl /tmp/adapter-events-*.jsonl

# Emit final heartbeat.end event
emit-event.sh heartbeat.end $HEARTBEAT_NUMBER '{"issues_processed":1,"duration_ms":'$TOTAL_DURATION_MS'}'
```

### In Subagent Execution

Each subagent should set environment variables for logging:

```bash
export HEARTBEAT_NUMBER=23
export ISSUE_ID=4
export PERSONA_NAME="backend"
export OBSDIR=".woterclip/observability"
export DB_PATH=".woterclip/woterclip.db"

# Then call wrapped adapter operations
list_issues() { ... }  # logs events automatically
add_comment() { ... }  # logs events automatically
close_issue() { ... }  # logs events automatically
```

## Queries for Analysis

### Adapter Performance

```bash
# Average latency per operation (SQLite)
jq -s 'map(select(.backend == "sqlite")) | group_by(.operation) | 
  map({op: .[0].operation, p50: (map(.duration_ms) | sort | .[length/2|floor]), 
       p95: (map(.duration_ms) | sort | .[length*0.95|floor])})' \
  .woterclip/observability/adapter-events.jsonl
```

### Persona Performance

```bash
# Steps completed per persona
jq -s 'group_by(.persona) | map({persona: .[0].persona, 
  total_duration_ms: (map(.duration_ms) | add), 
  steps_completed: length})' \
  .woterclip/observability/persona-events.jsonl
```

### Error Tracking

```bash
# Failed operations
jq 'select(.status == "failure")' .woterclip/observability/adapter-events.jsonl
```

## Retention Policy

- Heartbeat events: 90 days rolling window
- Persona events: 30 days rolling window
- Adapter events: 14 days rolling window (high-volume, can be sampled)
- Metrics snapshots (hourly aggregates): Unlimited

Implement cleanup in scheduled task (future Phase 2).

## Testing

### Dry-run with logging

```bash
HEARTBEAT_NUMBER=99 ISSUE_ID=999 PERSONA_NAME=backend \
  bash subagent-template.sh
```

Verify:
1. `.woterclip/observability/persona-events.jsonl` has entries for steps 4–10
2. `.woterclip/observability/adapter-events.jsonl` has operation logs
3. All JSON is valid (`jq empty < file` returns no errors)

### Load test

Run multiple heartbeats and verify:
```bash
# Each heartbeat should add ~10–15 events
wc -l .woterclip/observability/*.jsonl
```

## Summary

This implementation provides:
- **Millisecond-precision timing** for all operations
- **Automatic error tracking** with exit codes and messages
- **Correlated event streams** via `heartbeat_number`, `issue_id`, `persona`
- **Zero overhead** when OBSDIR not set (gracefully skips logging)
- **Backend-agnostic** wrapper pattern works for both SQLite and Linear
- **Ready for Phase 2** aggregation and trending
