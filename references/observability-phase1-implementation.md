# WoterClip Observability Phase 1 — Implementation Guide

## Overview

Phase 1 implements structured logging (JSONL) for the heartbeat loop. This document specifies the exact changes needed to emit observability events at each step.

## Implementation Tasks

### Task 1: Create observability directory structure

```bash
mkdir -p .woterclip/observability/metrics-snapshots
```

Log files:
- `.woterclip/observability/heartbeat-events.jsonl` — Main loop events
- `.woterclip/observability/persona-events.jsonl` — Subagent execution
- `.woterclip/observability/adapter-events.jsonl` — Backend operations

### Task 2: Enhance `/heartbeat` skill with observability

The `/heartbeat` skill in `skills/heartbeat/SKILL.md` needs to emit events at each step.

#### Step 1 (Load Config & Lock)

After creating lockfile, emit:

```json
{
  "timestamp": "2026-05-21T14:30:00Z",
  "heartbeat_number": 17,
  "cycle": "WOT-2",
  "event_type": "heartbeat.start",
  "step": 1,
  "task_name": "load-config-lock",
  "status": "completed",
  "duration_ms": 45,
  "error": null,
  "details": {
    "backend": "sqlite",
    "config_version": 2,
    "lockfile_created": true
  }
}
```

#### Step 2 (Check Inbox)

After inbox query, emit:

```json
{
  "timestamp": "2026-05-21T14:30:05Z",
  "heartbeat_number": 17,
  "event_type": "heartbeat.step",
  "step": 2,
  "task_name": "check-inbox",
  "status": "completed",
  "duration_ms": 125,
  "error": null,
  "details": {
    "issues_found": 3,
    "issues_after_filtering": 2,
    "stale_locks_cleaned": 1
  }
}
```

#### Step 3 (Fan-out Dispatch)

Before dispatch, emit:

```json
{
  "timestamp": "2026-05-21T14:30:07Z",
  "heartbeat_number": 17,
  "event_type": "heartbeat.step",
  "step": 3,
  "task_name": "fan-out-dispatch",
  "status": "starting",
  "duration_ms": 0,
  "error": null,
  "details": {
    "issues_to_dispatch": 1,
    "max_parallel": 2,
    "subagent_count": 1
  }
}
```

After all subagents complete, emit completion event.

#### Step 11 (Cleanup & Exit)

After merging logs, emit:

```json
{
  "timestamp": "2026-05-21T14:31:00Z",
  "heartbeat_number": 17,
  "event_type": "heartbeat.end",
  "step": 11,
  "task_name": "cleanup-exit",
  "status": "completed",
  "duration_ms": 60000,
  "error": null,
  "details": {
    "issues_processed": 1,
    "subagents_success": 1,
    "subagents_failed": 0,
    "orphans_detected": 0,
    "lockfile_deleted": true,
    "total_duration_ms": 60000
  }
}
```

Implementation note: Wrap each main step with timing and logging. Use `date +%s%N` for millisecond precision.

### Task 3: Create subagent observability wrapper

Each subagent (running Steps 4–10) must emit to `persona-events.jsonl`. Create a wrapper function in the subagent template:

```bash
# .woterclip/subagent-template.sh (pseudo-code for reference)

_log_persona_event() {
  local step=$1 task=$2 status=$3 duration=$4 details=$5
  local timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  
  cat >> .woterclip/observability/persona-events.jsonl << JSON
{
  "timestamp": "$timestamp",
  "heartbeat_number": $HEARTBEAT_NUMBER,
  "issue_id": $ISSUE_ID,
  "persona": "$PERSONA",
  "event_type": "step.$status",
  "step": $step,
  "task_name": "$task",
  "status": "$status",
  "duration_ms": $duration,
  "error": null,
  "details": $details
}
JSON
}

# Usage in Step 4:
start_time=$(date +%s%N)
# ... load persona files ...
end_time=$(date +%s%N)
duration=$(( (end_time - start_time) / 1000000 ))
_log_persona_event 4 "resolve-persona" "completed" $duration '{"persona":"backend"}'
```

Emit events for each step (4–10):

#### Step 4: Resolve Persona

```json
{
  "timestamp": "2026-05-21T14:30:10Z",
  "heartbeat_number": 17,
  "issue_id": 12,
  "persona": "backend",
  "event_type": "step.completed",
  "step": 4,
  "task_name": "resolve-persona",
  "status": "completed",
  "duration_ms": 120,
  "error": null,
  "details": {
    "persona_loaded": "backend",
    "model": "claude-3-5-sonnet",
    "thinking_effort": "high",
    "max_turns": 300
  }
}
```

#### Step 5: Validate Tools

```json
{
  "timestamp": "2026-05-21T14:30:12Z",
  "heartbeat_number": 17,
  "issue_id": 12,
  "persona": "backend",
  "event_type": "step.completed",
  "step": 5,
  "task_name": "validate-tools",
  "status": "completed",
  "duration_ms": 80,
  "error": null,
  "details": {
    "required_tools": ["mcp__claude_ai_Linear"],
    "tools_available": true,
    "tools_found": ["mcp__claude_ai_Linear__*"]
  }
}
```

#### Step 6: Lock

```json
{
  "timestamp": "2026-05-21T14:30:13Z",
  "heartbeat_number": 17,
  "issue_id": 12,
  "persona": "backend",
  "event_type": "step.completed",
  "step": 6,
  "task_name": "lock",
  "status": "completed",
  "duration_ms": 15,
  "error": null,
  "details": {
    "lock_acquired": true
  }
}
```

#### Step 7: Understand Context

```json
{
  "timestamp": "2026-05-21T14:30:14Z",
  "heartbeat_number": 17,
  "issue_id": 12,
  "persona": "backend",
  "event_type": "step.completed",
  "step": 7,
  "task_name": "understand-context",
  "status": "completed",
  "duration_ms": 240,
  "error": null,
  "details": {
    "title": "Add observability and metrics to heartbeat",
    "state": "in_progress",
    "priority": 2,
    "comments_fetched": 5,
    "new_comments_since_last_heartbeat": 0,
    "next_heartbeat_number": 18,
    "goal_injected": false
  }
}
```

#### Step 8: Do Work

```json
{
  "timestamp": "2026-05-21T14:30:20Z",
  "heartbeat_number": 17,
  "issue_id": 12,
  "persona": "backend",
  "event_type": "step.completed",
  "step": 8,
  "task_name": "do-work",
  "status": "completed",
  "duration_ms": 3200,
  "error": null,
  "details": {
    "files_created": [
      "references/observability-phase1-implementation.md"
    ],
    "files_modified": [],
    "commits": [
      "abc123 feat: add observability phase 1 implementation guide"
    ],
    "sub_issues_created": 0,
    "tokens_used": 8400,
    "model_used": "claude-3-5-sonnet"
  }
}
```

#### Step 9: Report

```json
{
  "timestamp": "2026-05-21T14:30:21Z",
  "heartbeat_number": 17,
  "issue_id": 12,
  "persona": "backend",
  "event_type": "step.completed",
  "step": 9,
  "task_name": "report",
  "status": "completed",
  "duration_ms": 180,
  "error": null,
  "details": {
    "comment_posted": true,
    "heartbeat_number": 18,
    "issue_title": "Add observability and metrics to heartbeat"
  }
}
```

#### Step 10: Update State

```json
{
  "timestamp": "2026-05-21T14:30:22Z",
  "heartbeat_number": 17,
  "issue_id": 12,
  "persona": "backend",
  "event_type": "step.completed",
  "step": 10,
  "task_name": "update-state",
  "status": "completed",
  "duration_ms": 50,
  "error": null,
  "details": {
    "state_change": "in_progress → in_review",
    "lock_released": true,
    "sub_issues_needed": true
  }
}
```

### Task 4: Add adapter event logging

Both `references/backend-sqlite.md` and `references/backend-linear.md` need observability wrappers.

#### SQLite Backend Adapter Changes

Wrap each operation with timing and event logging:

```bash
# Pseudo-code for each adapter operation

_log_adapter_event() {
  local op=$1 status=$2 duration=$3 rows=$4 error=$5
  local timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  
  cat >> .woterclip/observability/adapter-events.jsonl << JSON
{
  "timestamp": "$timestamp",
  "heartbeat_number": ${HEARTBEAT_NUMBER:-0},
  "issue_id": ${ISSUE_ID:-null},
  "event_type": "adapter.operation",
  "operation": "$op",
  "backend": "sqlite",
  "status": "$status",
  "duration_ms": $duration,
  "rows_affected": $rows,
  "error": $error
}
JSON
}

# Example: list_issues operation
list_issues() {
  local start_time=$(date +%s%N)
  local result=$(sqlite3 .woterclip/woterclip.db "SELECT COUNT(*) FROM issues WHERE state IN ('todo', 'in_progress');")
  local end_time=$(date +%s%N)
  local duration=$(( (end_time - start_time) / 1000000 ))
  
  _log_adapter_event "list_issues" "success" $duration $result "null"
  echo "$result"
}
```

For each operation in backend-sqlite.md:
1. Record start time
2. Execute operation
3. Calculate duration in ms
4. Log event with operation name, status, duration, rows affected
5. Return result

#### Linear Backend Adapter Changes

Similar wrapper for MCP tool calls:

```bash
_log_adapter_event_linear() {
  local op=$1 status=$2 duration=$3 error=$4
  local timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  
  cat >> .woterclip/observability/adapter-events.jsonl << JSON
{
  "timestamp": "$timestamp",
  "heartbeat_number": ${HEARTBEAT_NUMBER:-0},
  "issue_id": ${ISSUE_ID:-null},
  "event_type": "adapter.operation",
  "operation": "$op",
  "backend": "linear",
  "status": "$status",
  "duration_ms": $duration,
  "rows_affected": null,
  "error": $error
}
JSON
}

# Example: list_issues via Linear MCP
list_issues() {
  local start_time=$(date +%s%N)
  local result=$(mcp_call claude_ai_Linear list_issues)
  local end_time=$(date +%s%N)
  local duration=$(( (end_time - start_time) / 1000000 ))
  
  if [ $? -eq 0 ]; then
    _log_adapter_event_linear "list_issues" "success" $duration "null"
  else
    _log_adapter_event_linear "list_issues" "failure" $duration "\"MCP call failed\""
  fi
  echo "$result"
}
```

### Task 5: Update heartbeat merge logic (Step 11)

In the heartbeat skill's Step 11 (Cleanup & Exit), after all subagents complete:

```bash
# Merge persona and adapter logs into main observability structure
cat /tmp/persona-*.jsonl >> .woterclip/observability/persona-events.jsonl 2>/dev/null || true
cat /tmp/adapter-*.jsonl >> .woterclip/observability/adapter-events.jsonl 2>/dev/null || true

# Clean up temp files
rm -f /tmp/persona-*.jsonl /tmp/adapter-*.jsonl
```

### Task 6: Create observability query examples

Add a reference document for operators: `references/observability-queries.md`

```bash
# Recent heartbeat events
tail -20 .woterclip/observability/heartbeat-events.jsonl | jq '{timestamp, step, status, duration_ms}'

# Persona performance for backend
jq 'select(.persona == "backend")' .woterclip/observability/persona-events.jsonl | \
  jq -s 'map({step, duration_ms, status}) | sort_by(.step)'

# Adapter operation latencies
jq 'select(.backend == "sqlite") | {operation, duration_ms}' .woterclip/observability/adapter-events.jsonl | \
  jq -s 'group_by(.operation) | map({op: .[0].operation, p95: (map(.duration_ms) | sort | .[length*0.95|floor])})'
```

## Integration Checklist

- [ ] Create `.woterclip/observability/` directory
- [ ] Modify `/heartbeat` skill to emit heartbeat-events.jsonl at each step
- [ ] Create subagent template wrapper for persona-events.jsonl
- [ ] Add observability logging to backend-sqlite.md adapter operations
- [ ] Add observability logging to backend-linear.md adapter operations
- [ ] Update Step 11 (Cleanup) to merge temp logs
- [ ] Create observability-queries.md reference
- [ ] Test: Run one heartbeat cycle, verify all three event files are populated
- [ ] Test: Verify jq queries work on event files
- [ ] Document retention policy in observability-metrics.md (90-day rolling window)

## Testing

### Test 1: Verify directory creation

```bash
ls -la .woterclip/observability/
# Should show metrics-snapshots/ subdirectory
```

### Test 2: Verify event logging (single heartbeat)

```bash
# Run one heartbeat
/heartbeat --dry-run

# Check event files exist
wc -l .woterclip/observability/*.jsonl
# Each file should have at least 1 entry per step
```

### Test 3: Verify event structure

```bash
# Validate JSON structure
jq empty < .woterclip/observability/heartbeat-events.jsonl
jq empty < .woterclip/observability/persona-events.jsonl
jq empty < .woterclip/observability/adapter-events.jsonl
# Should return without errors
```

### Test 4: Query performance

```bash
# Example: average duration per step
jq -s 'group_by(.step) | map({step: .[0].step, avg_duration: (map(.duration_ms) | add / length)})' \
  .woterclip/observability/persona-events.jsonl
```

## Estimated Effort

- Task 1: 5 min (directory creation)
- Task 2: 30 min (heartbeat skill modifications)
- Task 3: 20 min (subagent template wrapper)
- Task 4: 40 min (adapter logging for both backends)
- Task 5: 10 min (merge logic)
- Task 6: 15 min (query examples)
- Testing: 15 min

**Total Phase 1 effort: ~2 hours implementation + testing**

## Next Steps (Phase 2)

Phase 2 will implement hourly metrics aggregation:
- Read heartbeat-events.jsonl (last hour)
- Aggregate counts, durations (min/max/mean/p50/p95/p99)
- Write metrics-snapshots/{date}T{hour}.json
- Compress old hourly files (gzip)

This enables trending, alerting, and future UI development.
