# WoterClip Observability & Metrics

## Overview

This document specifies structured logging, metrics collection, and observability infrastructure for the WoterClip heartbeat loop. The system tracks performance, reliability, decision-making patterns, and operational health.

**Goal:** Enable operators to understand heartbeat behavior, detect issues, and optimize performance without invasive instrumentation.

## Architecture

### Three-layer observability stack

1. **Structured Logging (JSONL)** — Low-cost event capture, queryable
2. **Metrics (Time-series)** — Aggregated performance indicators
3. **Traces (Optional)** — Deep flow tracing for debugging

### Collection points

```
┌─────────────────────────────────────────────┐
│       Heartbeat Loop (Main)                 │
│  ├─ Entry: tick timestamp, heartbeat #     │
│  ├─ Step 1-3: inbox check, dispatch setup  │
│  ├─ Step 4-10: subagent execution          │
│  ├─ Step 11: orphan cleanup, merge logs    │
│  └─ Exit: success/fail, duration           │
└─────────────────────────────────────────────┘
           │
           ├─→ Structured Log (.jsonl)
           ├─→ Metrics Aggregator (JSON/CSV)
           └─→ Trace Spans (optional OpenTelemetry)
```

## Structured Logging (JSONL)

### Log file location

```
.woterclip/observability/
├── heartbeat-events.jsonl      # Heartbeat loop events (main, dispatch, cleanup)
├── persona-events.jsonl        # Per-persona execution (subagents)
├── adapter-events.jsonl        # Backend adapter calls (Linear/SQLite)
└── metrics-snapshots/
    ├── 2026-05-21T14.json      # Hourly rollup (counts, durations, errors)
    ├── 2026-05-21.json         # Daily rollup
    └── 2026-05.json            # Monthly rollup
```

### Heartbeat event schema (heartbeat-events.jsonl)

```json
{
  "timestamp": "2026-05-21T14:30:00Z",
  "heartbeat_number": 17,
  "cycle": "WOT-2",
  "event_type": "heartbeat.start|heartbeat.step|heartbeat.subagent_dispatch|heartbeat.cleanup|heartbeat.end",
  "step": 1,
  "task_name": "check-inbox",
  "status": "starting|completed|failed|skipped",
  "issue_id": 12,
  "persona": "backend",
  "duration_ms": 125,
  "error": null,
  "details": {
    "issues_found": 3,
    "issues_dispatched": 1,
    "max_parallel": 2,
    "subagent_count": 1,
    "orphans_detected": 0
  }
}
```

### Persona event schema (persona-events.jsonl)

Subagent writes events for steps 4-10:

```json
{
  "timestamp": "2026-05-21T14:30:05Z",
  "heartbeat_number": 17,
  "issue_id": 12,
  "persona": "backend",
  "subagent_id": "sa-12-backend-uuid",
  "event_type": "step.start|step.completed|step.failed",
  "step": 8,
  "task_name": "do-work",
  "status": "completed",
  "duration_ms": 3200,
  "error": null,
  "details": {
    "files_created": ["references/observability-metrics.md"],
    "files_modified": [],
    "decision": "created_spec",
    "tokens_used": 8400,
    "model": "claude-3-5-sonnet"
  }
}
```

### Adapter event schema (adapter-events.jsonl)

Log all backend operations (reads/writes):

```json
{
  "timestamp": "2026-05-21T14:30:06Z",
  "heartbeat_number": 17,
  "issue_id": 12,
  "event_type": "adapter.operation",
  "operation": "update_issue|list_issues|create_comment|close_issue",
  "backend": "sqlite|linear",
  "status": "success|failure",
  "duration_ms": 45,
  "rows_affected": 1,
  "error": null,
  "query": "UPDATE issues SET state='in_review' WHERE id=12;"
}
```

## Metrics Collection

### Aggregation strategy

1. **Real-time:** Log JSONL events as they occur
2. **Hourly rollup:** Aggregate past hour into `metrics-snapshots/{date}T{hour}.json`
3. **Daily rollup:** Aggregate full day into `metrics-snapshots/{date}.json`
4. **Monthly rollup:** Aggregate full month into `metrics-snapshots/{month}.json`

Rolling windows allow queries like:
- "Last 24h" → read last 24 hourly files
- "Last 7d" → read last 7 daily files
- "YTD" → read monthly files + current month

### Metrics schema (hourly snapshot)

```json
{
  "period": "2026-05-21T14:00:00Z/PT1H",
  "heartbeats": {
    "count": 1,
    "success": 1,
    "failed": 0,
    "duration_ms": {
      "min": 4200,
      "max": 4200,
      "mean": 4200,
      "p50": 4200,
      "p95": 4200,
      "p99": 4200
    }
  },
  "issues": {
    "processed": 1,
    "dispatched_to_subagents": 1,
    "state_changes": {
      "new→in_progress": 0,
      "in_progress→in_review": 1,
      "in_review→closed": 0
    }
  },
  "personas": {
    "backend": {
      "invocations": 1,
      "duration_ms": {
        "mean": 3200,
        "p95": 3200
      },
      "errors": 0,
      "files_created": 2,
      "files_modified": 0
    }
  },
  "adapter": {
    "backend_used": "sqlite",
    "operations": {
      "list_issues": { "count": 1, "duration_ms": { "mean": 5 } },
      "update_issue": { "count": 2, "duration_ms": { "mean": 12 } },
      "create_comment": { "count": 1, "duration_ms": { "mean": 8 } }
    },
    "errors": 0,
    "rate_limit_hits": 0
  },
  "system": {
    "heartbeat_loop_errors": 0,
    "orphans_detected": 0,
    "orphans_recovered": 0,
    "lock_contentions": 0,
    "disk_usage_mb": 12.5
  }
}
```

## Querying Observability Data

### Example queries (bash + jq)

```bash
# Last 10 heartbeats
tail -10 .woterclip/observability/heartbeat-events.jsonl

# Heartbeats in last 24h
jq 'select(.timestamp > now - 86400)' .woterclip/observability/heartbeat-events.jsonl

# Issue 12 events (all steps)
jq 'select(.issue_id == 12)' .woterclip/observability/persona-events.jsonl

# Slow persona invocations (>5s)
jq 'select(.duration_ms > 5000)' .woterclip/observability/persona-events.jsonl | \
  jq -s 'sort_by(.duration_ms) | reverse'

# Adapter errors
jq 'select(.status == "failure")' .woterclip/observability/adapter-events.jsonl

# Daily metrics for issue throughput
jq '.issues.processed' .woterclip/observability/metrics-snapshots/2026-05-*.json

# Persona success rates (hourly)
jq '[.personas | .[] | select(.errors == 0)] | length' \
  .woterclip/observability/metrics-snapshots/2026-05-21T*.json
```

## Implementation Phases

### Phase 1: Structured Logging (Immediate)

**Deliverable:** Heartbeat loop writes JSONL events in real-time.

1. Modify `/heartbeat` skill to emit structured events at each step
   - Entry point: heartbeat.start
   - Each step 1-11: step.start, step.completed/failed
   - Exit: heartbeat.end

2. Modify subagent template to emit persona-events.jsonl
   - Steps 4-10: step.start, step.completed/failed
   - Include duration_ms, error details, file I/O summary

3. Adapter wrapper functions (backend-sqlite.md, backend-linear.md)
   - Wrap each operation call with adapter-events logging
   - Log operation name, backend, duration, rows affected, errors

4. Create observability directory structure
   ```bash
   mkdir -p .woterclip/observability/metrics-snapshots
   ```

### Phase 2: Metrics Aggregation (Next cycle)

**Deliverable:** Hourly rollup of JSONL events into metrics snapshots.

1. Hourly cron job (or triggered at heartbeat exit)
   ```bash
   claude --skill observability-aggregate --period hourly
   ```
   - Read heartbeat-events.jsonl (last hour)
   - Aggregate to metrics-snapshots/{date}T{hour}.json
   - Compress old hourly files (gzip)

2. Daily/monthly aggregation
   - Triggered at 00:00 UTC
   - Aggregate hourly files into daily/monthly snapshots
   - Retain granularity for 90 days

### Phase 3: Observability UI (Future: WOT-12)

**Deliverable:** Web dashboard for metrics visualization.

1. Query metrics snapshots and heartbeat-events.jsonl
2. Display:
   - Heartbeat timeline (throughput, success rate, duration)
   - Per-persona performance (latency, error rate, file I/O)
   - Adapter statistics (backend switching, error patterns)
   - System health (lock contentions, orphans, disk usage)
3. Drill-down into individual heartbeat details and persona invocations

## Integration with Existing Workflows

### Heartbeat skill changes

The `/heartbeat` skill already emits JSONL logs to heartbeat-log.jsonl. Enhance with:

```markdown
### Observability

Each step (4-11) writes structured events to `.woterclip/observability/heartbeat-events.jsonl`:

\`\`\`json
{
  "timestamp": "2026-05-21T14:30:05Z",
  "heartbeat_number": 17,
  "step": 8,
  "task_name": "do-work",
  "status": "completed",
  "duration_ms": 3200,
  "details": { ... }
}
\`\`\`

At exit, compute hourly metrics from heartbeat + persona + adapter logs.
```

### Subagent template changes

Each subagent writes `persona-events.jsonl` locally, then main heartbeat merges:

```bash
# In Step 11 (merge logs):
for persona_log in /tmp/persona-*.jsonl; do
  cat "$persona_log" >> .woterclip/observability/persona-events.jsonl
done
```

### Backend adapter wrapper

Every operation in `references/backend-sqlite.md` and `backend-linear.md`:

```bash
# Wrap with observability

_log_adapter_event() {
  local op=$1 backend=$2 status=$3 duration=$4
  echo "{\"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\", \"operation\": \"$op\", \"backend\": \"$backend\", \"status\": \"$status\", \"duration_ms\": $duration}" >> \
    .woterclip/observability/adapter-events.jsonl
}

# Example: list_issues
sqlite3 .woterclip/woterclip.db "SELECT * FROM issues WHERE state='new' LIMIT 10;" && \
_log_adapter_event "list_issues" "sqlite" "success" 5
```

## Retention & Cleanup

### Log rotation

- **heartbeat-events.jsonl:** Keep indefinitely (append-only, ~1KB per heartbeat)
- **persona-events.jsonl:** Keep indefinitely (same scale)
- **adapter-events.jsonl:** Keep 90 days (high volume, ~100KB/day)
- **Hourly metrics:** Keep 1 year (compressed, ~5KB gzipped each)
- **Daily/monthly metrics:** Keep indefinitely (very small)

### Cleanup task

```bash
# In a separate periodic task (daily or weekly):
find .woterclip/observability/ -name "adapter-events-*.jsonl" -mtime +90 -delete
find .woterclip/observability/metrics-snapshots/ -name "*T*.json" -mtime +90 -exec gzip {} \;
```

## Alerting & Monitoring (Future)

### Potential alert conditions

1. **Heartbeat latency:** Duration > 10 minutes
2. **Orphan leak:** Orphans detected > 2 per cycle
3. **Adapter errors:** Failure rate > 5%
4. **Lock contention:** More than 1 lock acquisition in 1 hour
5. **Disk growth:** `.woterclip/` size > 500MB

Alerts can read hourly metrics snapshots:

```bash
jq 'select(.heartbeats.duration_ms.mean > 600000)' \
  .woterclip/observability/metrics-snapshots/2026-05-21T*.json
```

## Examples

### Viewing recent heartbeat activity

```bash
tail -20 .woterclip/observability/heartbeat-events.jsonl | \
  jq '{timestamp, heartbeat_number, step, status, duration_ms}'
```

Output:
```json
{
  "timestamp": "2026-05-21T14:30:05Z",
  "heartbeat_number": 17,
  "step": 8,
  "status": "completed",
  "duration_ms": 3200
}
```

### Analyzing persona performance

```bash
jq 'group_by(.persona) | map({
  persona: .[0].persona,
  invocations: length,
  avg_duration: (map(.duration_ms) | add / length),
  errors: map(select(.status == "failed")) | length
})' .woterclip/observability/persona-events.jsonl
```

Output:
```json
[
  {
    "persona": "backend",
    "invocations": 12,
    "avg_duration": 3100,
    "errors": 0
  }
]
```

### Detecting adapter bottlenecks

```bash
jq 'group_by(.operation) | map({
  operation: .[0].operation,
  count: length,
  p95_duration: (map(.duration_ms) | sort | .[length * 0.95 | floor])
})' .woterclip/observability/adapter-events.jsonl | \
  sort_by(.p95_duration) | reverse
```

## Migration Plan

### For existing heartbeat logs

Current heartbeat-log.jsonl will coexist with new observability logs:

- **Legacy:** `.woterclip/heartbeat-log.jsonl` (deprecated, kept for compatibility)
- **New:** `.woterclip/observability/heartbeat-events.jsonl` (new source of truth)

A compatibility mode in `/heartbeat` reads either format.

## Summary

This observability system provides:

1. **Low-overhead logging** — JSONL events, no external dependencies
2. **Queryable metrics** — Time-series snapshots for trending and alerting
3. **Multi-layer tracing** — Heartbeat → subagent → adapter visibility
4. **Operator-friendly tools** — bash + jq queries, no special infrastructure
5. **Extensible design** — Future UI, alerting, and analytics layers

Phase 1 (logging) requires ~2KB code changes across skill + references.
Phase 2 (metrics) adds hourly aggregation job (~1KB).
Phase 3 (UI) is optional, driven by operator demand.
