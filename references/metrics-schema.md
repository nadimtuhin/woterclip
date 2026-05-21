# WoterClip Observability Metrics Schema

## Overview

This document defines the metrics collected by WoterClip heartbeat to enable monitoring, optimization, and dashboard visualization.

## Core Metrics Categories

### 1. Heartbeat Execution Metrics

**Scope:** Per-heartbeat cycle (global)

| Metric | Type | Unit | Description |
|--------|------|------|-------------|
| `heartbeat.cycle_duration` | Histogram | milliseconds | Total heartbeat execution time (Steps 1–11) |
| `heartbeat.initialization_time` | Histogram | milliseconds | Time for Steps 1–3 (config load, lock acquire) |
| `heartbeat.dispatch_time` | Histogram | milliseconds | Time to fan-out subagents (Step 3) |
| `heartbeat.cleanup_time` | Histogram | milliseconds | Time for orphan detection + log merge (Step 11) |
| `heartbeat.issues_processed` | Counter | count | Total issues handled in cycle |
| `heartbeat.parallel_subagents` | Gauge | count | Active subagents at peak |
| `heartbeat.lock_wait_time` | Histogram | milliseconds | Time spent waiting for .heartbeat-lock |
| `heartbeat.config_load_time` | Histogram | milliseconds | Time to load .woterclip/config.yaml + personas |

### 2. Per-Issue Processing Metrics

**Scope:** Per issue (label: `issue_id`)

| Metric | Type | Unit | Description |
|--------|------|------|-------------|
| `issue.processing_time` | Histogram | milliseconds | Total time from dispatch to completion (Steps 4–10) |
| `issue.persona_resolution_time` | Histogram | milliseconds | Step 4 duration (load SOUL, TOOLS, config) |
| `issue.context_understanding_time` | Histogram | milliseconds | Step 7 duration (parse issue, load comments) |
| `issue.work_duration` | Histogram | milliseconds | Step 8 duration (actual work execution) |
| `issue.report_generation_time` | Histogram | milliseconds | Step 9 duration (format report) |
| `issue.state_update_time` | Histogram | milliseconds | Step 10 duration (write DB, label changes) |
| `issue.adapter_call_latency` | Histogram | milliseconds | Per-adapter-operation latency (backend-specific) |
| `issue.resolution_rate` | Counter | boolean | 1 if completed, 0 if failed or blocked |
| `issue.state_changes` | Counter | count | Number of label/state transitions |
| `issue.comment_count` | Gauge | count | Total comments on issue at processing |

### 3. Persona Workload Metrics

**Scope:** Per persona (label: `persona`)

| Metric | Type | Unit | Description |
|--------|------|------|-------------|
| `persona.issues_assigned` | Counter | count | Total issues routed to persona |
| `persona.issues_completed` | Counter | count | Issues moved to in_review / done |
| `persona.issues_blocked` | Counter | count | Issues marked agent-blocked |
| `persona.avg_processing_time` | Gauge | milliseconds | Mean issue.processing_time |
| `persona.p99_processing_time` | Gauge | milliseconds | 99th percentile processing time |
| `persona.work_time_ratio` | Gauge | ratio (0–1) | (work_duration) / (processing_time) |
| `persona.concurrent_issues` | Gauge | count | Max simultaneous issues per persona |
| `persona.error_rate` | Gauge | ratio (0–1) | Fraction of failed/blocked issues |
| `persona.model_tokens_total` | Counter | tokens | Cumulative input+output tokens (from config) |

### 4. System Health Metrics

**Scope:** Global

| Metric | Type | Unit | Description |
|--------|------|------|-------------|
| `system.lock_contention` | Histogram | milliseconds | Histogram of lock wait times |
| `system.db_write_latency` | Histogram | milliseconds | Time to write .woterclip/woterclip.db |
| `system.db_query_latency` | Histogram | milliseconds | Time to query issues/comments |
| `system.concurrent_heartbeats` | Gauge | count | Active heartbeat processes (should be ≤1) |
| `system.stale_lock_events` | Counter | count | Detected stale locks (> 4 hours) |
| `system.error_total` | Counter | count | Total errors across all heartbeats |
| `system.adapter_errors` | Counter | count | Errors from backend adapter calls |

### 5. Commentary Activity Metrics

**Scope:** Global

| Metric | Type | Unit | Description |
|--------|------|------|-------------|
| `comments.total_generated` | Counter | count | Comments written by agents |
| `comments.heartbeat_summaries` | Counter | count | Agent-generated heartbeat summary comments |
| `comments.avg_length` | Gauge | characters | Mean comment body length |
| `comments.write_latency` | Histogram | milliseconds | Time to insert comment in DB |

### 6. Business KPIs

**Scope:** Global

| Metric | Type | Unit | Description |
|--------|------|------|-------------|
| `kpi.issues_done_per_day` | Gauge | count | Issues moved to done/closed per 24h |
| `kpi.cycle_time_median` | Gauge | milliseconds | Median time from created_at to done |
| `kpi.throughput_issues_per_hour` | Gauge | count | Issues completed per hour |
| `kpi.architect_escalations` | Counter | count | Issues routed to architect for review |
| `kpi.ceo_escalations` | Counter | count | Issues escalated to CEO |
| `kpi.work_items_in_flight` | Gauge | count | Issues in (agent-working) state |

## Storage Strategy

### Event-Based Collection

Real-time events are written to `.woterclip/observability/{event_type}.jsonl`:

1. **`heartbeat-events.jsonl`** — Cycle lifecycle
   ```json
   {
     "timestamp": "2026-05-21T11:40:00Z",
     "heartbeat_number": 21,
     "event_type": "heartbeat.start|heartbeat.end",
     "step": "3|11",
     "duration_ms": 500,
     "cycle_duration_ms": 5000,
     "issues_processed": 2,
     "errors": null
   }
   ```

2. **`persona-events.jsonl`** — Per-persona metrics
   ```json
   {
     "timestamp": "2026-05-21T11:40:00Z",
     "heartbeat_number": 21,
     "persona": "backend",
     "event_type": "persona.work_start|persona.work_end",
     "issue_id": 4,
     "processing_time_ms": 1200,
     "work_time_ms": 500,
     "status": "completed|blocked|error"
   }
   ```

3. **`adapter-events.jsonl`** — Backend adapter calls
   ```json
   {
     "timestamp": "2026-05-21T11:40:00Z",
     "heartbeat_number": 21,
     "adapter": "sqlite|linear",
     "operation": "list_issues|update_issue|create_comment",
     "latency_ms": 45,
     "status": "ok|error",
     "error_message": null
   }
   ```

### Aggregation & Snapshots

Every 10 heartbeats, run `metrics-aggregator.sh` to:
1. Parse all three event files
2. Compute percentiles (p50, p95, p99)
3. Generate `metrics-snapshots/snapshot-{heartbeat_number}.json`
4. Rotate old snapshots (keep last 100)

### Prometheus-Style Exposition

Generate `.woterclip/observability/metrics.txt` (Prometheus format) for dashboard scraping:

```
# HELP heartbeat_cycle_duration_milliseconds Heartbeat execution duration
# TYPE heartbeat_cycle_duration_milliseconds histogram
heartbeat_cycle_duration_milliseconds_bucket{le="100"} 0
heartbeat_cycle_duration_milliseconds_bucket{le="500"} 5
heartbeat_cycle_duration_milliseconds_bucket{le="1000"} 12
heartbeat_cycle_duration_milliseconds_bucket{le="+Inf"} 15
heartbeat_cycle_duration_milliseconds_sum 8250
heartbeat_cycle_duration_milliseconds_count 15

# HELP persona_processing_time_ms Average issue processing time per persona
# TYPE persona_processing_time_ms gauge
persona_processing_time_ms{persona="backend"} 850
persona_processing_time_ms{persona="frontend"} 720
```

## Dashboard Integration

Metrics are designed to feed:

1. **CLI Dashboards** — `query-metrics.sh` provides real-time stats
2. **Web Dashboards** — Prometheus-compatible scraping
3. **Alerting** — Thresholds for SLA violations (e.g., cycle > 5s)

## Schema Changes

To support the above metrics, add SQLite tables to `.woterclip/woterclip.db`:

```sql
CREATE TABLE IF NOT EXISTS metrics_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  heartbeat_number INTEGER,
  persona TEXT,
  issue_id INTEGER,
  metric_name TEXT,
  metric_value REAL,
  unit TEXT,
  timestamp TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS metrics_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  heartbeat_number INTEGER UNIQUE,
  snapshot_data JSON,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

## Implementation Phases

### Phase 1: Core Instrumentation (Current)
- Add timing collection to heartbeat steps 1–11
- Wire persona workload metrics into subagents
- Export event-based logs to `.woterclip/observability/`

### Phase 2: Aggregation & Dashboard (WOT-12)
- Implement `metrics-aggregator.sh` with percentile computation
- Generate Prometheus exposition format
- Create basic CLI query tool (`query-metrics.sh` enhancements)

### Phase 3: Web Dashboard (WOT-12)
- Standalone Node.js server that scrapes `.woterclip/observability/metrics.txt`
- Charts: cycle time trend, persona workload distribution, issue throughput
- Alerts: SLA violations, adapter errors, stale locks

## Alerting Rules

| Alert | Condition | Action |
|-------|-----------|--------|
| High Cycle Time | `heartbeat.cycle_duration > 5000ms` | Log warning, investigate adapter latency |
| Adapter Degradation | `adapter.error_rate > 0.1` | Halt new issues, investigate backend |
| Lock Contention | `system.lock_wait_time > 500ms` | Check for stale locks, consider WAL tuning |
| Work Starvation | `persona.work_time_ratio < 0.3` | Persona spending time on I/O, optimize queries |
| Escalation Surge | `kpi.ceo_escalations > 5 per day` | Strategy misalignment, review routing |

