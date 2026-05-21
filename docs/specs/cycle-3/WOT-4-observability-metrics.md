# WoterClip Observability & Metrics Design

## Overview
Comprehensive metrics collection and observability strategy for WoterClip heartbeat execution, persona workload distribution, and issue processing pipeline. Enables performance tuning, bottleneck detection, and capacity planning.

## Core Metrics

### 1. Heartbeat Execution Metrics

#### Heartbeat Cycle Timing
- `heartbeat.duration_seconds` – Total time from start to exit
- `heartbeat.setup_duration_seconds` – Config load + lockfile acquisition
- `heartbeat.inbox_check_duration_seconds` – Backend query time
- `heartbeat.dispatch_duration_seconds` – Subagent spawning overhead
- `heartbeat.orphan_cleanup_duration_seconds` – Crash detection + log merge
- `heartbeat.overall_efficiency` – (duration / max_parallel / avg_issue_time) percentage

Labels:
- `cycle_number` (e.g., 3)
- `backend` (sqlite | linear)
- `max_parallel` (concurrency level)

#### Issue Throughput
- `heartbeat.issues_processed` – Count of issues transitioned in this cycle
- `heartbeat.issues_dispatched` – Count of issues assigned to subagents
- `heartbeat.issues_completed` – Count reaching 'done' state
- `heartbeat.issues_escalated` – Count routed to CEO/Architect
- `heartbeat.issues_blocked` – Count in 'agent-blocked' state
- `heartbeat.issues_crashed` – Count with orphaned state (detected in cleanup)

### 2. Persona Workload Metrics

#### Per-Persona State
- `persona.active_issues` – Count of issues assigned to this persona
- `persona.in_progress_count` – Count with state='in_progress'
- `persona.blocked_count` – Count with state_label='blocked'
- `persona.avg_time_per_issue_seconds` – Mean duration from assignment to 'done'
- `persona.p95_time_per_issue_seconds` – 95th percentile (identifies outliers)
- `persona.issues_completed_total` – Cumulative count (all-time)
- `persona.utilization_pct` – (active_issues / avg_capacity) × 100

Labels:
- `persona_name` (frontend, backend, qa, etc.)

#### Persona Escalations
- `persona.escalations_to_ceo` – Count of issues marked for CEO review
- `persona.escalations_to_architect` – Count of issues marked for architecture review
- `persona.escalation_rate_pct` – (escalations / issues_processed) × 100

### 3. Issue Processing Pipeline Metrics

#### State Transition Tracking
- `issue.state_transitions` – Per-state transition counts (backlog→todo, todo→in_progress, etc.)
- `issue.time_in_state_seconds` – Duration spent in each state (histogram)
- `issue.comments_per_issue` – Count of agent+human comments per issue

State labels:
- backlog, todo, in_progress, in_review, done, canceled

#### Issue Characteristics
- `issue.avg_priority_processed` – Average priority of issues in this cycle (1–5)
- `issue.avg_issue_age_days` – Age of issues at time of processing
- `issue.parent_child_ratio` – Ratio of sub-issues created (on-demand)

### 4. System Health Metrics

#### Concurrency & Locking
- `lockfile.acquisition_duration_ms` – Time to acquire `.heartbeat-lock`
- `lockfile.wait_count` – Count of lock acquisitions that had to wait
- `lockfile.max_wait_duration_seconds` – Longest wait observed

#### Backend Latency
- `backend.query_duration_seconds` – "List issues by state" query time (per backend)
- `backend.update_duration_seconds` – "Update issue state" operation time
- `backend.error_count` – Transient failures (e.g., Linear 429s, SQLite contention)

Labels:
- `operation` (list_issues, update_state, create_issue, close_issue, etc.)
- `backend` (sqlite | linear)

#### Subagent Health
- `subagent.spawn_time_seconds` – Time to spawn and initialize a subagent
- `subagent.runtime_seconds` – Wall-clock time from spawn to completion
- `subagent.crash_count` – Count of unexpected exits (detected in orphan cleanup)

### 5. Commentary & Logging Metrics

#### Comment Activity
- `comments.agent_comments_total` – Cumulative count
- `comments.human_comments_total` – Cumulative count
- `comments.avg_comments_per_issue` – Mean comment depth per issue

### 6. Business Metrics

#### Issue Completion Velocity
- `issue.completion_rate_pct` – (issues_done / total_issues) × 100
- `issue.completion_velocity` – Issues completed per heartbeat (trend)
- `issue.median_time_to_done_days` – Median age when reaching 'done'

#### Persona Efficiency
- `persona.cost_per_issue` – Conceptual: estimated API calls / token usage per issue (future: integrate with API billing)

## Data Collection Strategy

### 1. Event-based Metrics (on write)
Whenever an issue state changes, log:
```json
{
  "timestamp": "2026-05-21T15:45:30Z",
  "event": "issue_state_changed",
  "issue_id": 3,
  "old_state": "todo",
  "new_state": "in_review",
  "persona": "frontend",
  "heartbeat_number": 3,
  "duration_since_prev_state_seconds": 3600
}
```

Store in SQLite `events` table or append-only log file.

### 2. Aggregation & Rollup
After each heartbeat, compute and store:
- Per-persona metrics (in `.woterclip/metrics/heartbeat_{N}.json`)
- Overall heartbeat summary

Example `.woterclip/metrics/heartbeat_3.json`:
```json
{
  "cycle": 3,
  "timestamp": "2026-05-21T15:45:30Z",
  "duration_seconds": 2700,
  "issues_processed": 4,
  "personas": {
    "frontend": {
      "issues": 2,
      "in_progress": 1,
      "blocked": 0,
      "done": 1,
      "avg_time_seconds": 3600
    }
  },
  "backend": "sqlite",
  "backend_latency_ms": 45,
  "subagent_count": 2,
  "subagent_avg_duration_seconds": 1200
}
```

### 3. Exposition Format (for Dashboard)
HTTP endpoint: `GET /api/metrics`
Response (Prometheus-style):
```
# HELP heartbeat_duration_seconds Total time for one heartbeat cycle
# TYPE heartbeat_duration_seconds gauge
heartbeat_duration_seconds{cycle="3",backend="sqlite"} 2700

# HELP persona_active_issues Number of active issues per persona
# TYPE persona_active_issues gauge
persona_active_issues{persona="frontend"} 2
persona_active_issues{persona="backend"} 1

# HELP issue_completion_rate_pct Percentage of issues completed
# TYPE issue_completion_rate_pct gauge
issue_completion_rate_pct 50.0
```

## Storage Structure

### SQLite Schema Addition
```sql
CREATE TABLE events (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp        TEXT NOT NULL,
    event_type       TEXT NOT NULL,
    issue_id         INTEGER,
    heartbeat_number INTEGER,
    persona          TEXT,
    old_value        TEXT,
    new_value        TEXT,
    metadata         TEXT  -- JSON
);

CREATE TABLE heartbeat_summaries (
    cycle_number     INTEGER PRIMARY KEY,
    started_at       TEXT NOT NULL,
    completed_at     TEXT,
    duration_seconds INTEGER,
    issues_processed INTEGER,
    issues_completed INTEGER,
    backend_latency_ms INTEGER,
    subagent_count   INTEGER,
    summary_json     TEXT  -- Full metrics snapshot as JSON
);

CREATE TABLE persona_metrics (
    id               INTEGER PRIMARY KEY,
    heartbeat_number INTEGER NOT NULL,
    persona_name     TEXT NOT NULL,
    active_count     INTEGER,
    in_progress_count INTEGER,
    blocked_count    INTEGER,
    avg_time_seconds INTEGER,
    UNIQUE(heartbeat_number, persona_name)
);
```

### File-based Storage
- `.woterclip/metrics/` directory
- `.woterclip/metrics/heartbeat_{N}.json` – Per-cycle aggregates
- `.woterclip/metrics/lifetime.json` – Cumulative stats (updated per cycle)

Example `lifetime.json`:
```json
{
  "total_cycles": 3,
  "total_issues_processed": 12,
  "total_issues_completed": 6,
  "personas": {
    "frontend": { "issues_assigned": 5, "completed": 3, "avg_time_days": 1.5 }
  }
}
```

## Monitoring & Alerting Rules

### Performance Thresholds
- **Heartbeat duration > 30 min:** Flag as slow
- **Backend latency > 5 sec:** Investigate backend health
- **Subagent spawn time > 10 sec:** Check concurrency/resource limits
- **Issue blocked > 24 hrs:** Escalation candidate

### Workload Imbalance
- **Persona utilization > 90%:** Risk of slowdown
- **Persona utilization < 10%:** Over-provisioned
- **Escalation rate > 20%:** Workers lack context or tools

## Integration Points

1. **Heartbeat Skill:** Emit events during state transitions + final summary
2. **Persona Subagents:** Report completion time + comment count
3. **Backend Adapters:** Measure query/update latency
4. **Dashboard API:** Expose metrics for visualization

## Future Enhancements
1. Grafana integration: real-time metric dashboards
2. Alerting: Slack/email on threshold violations
3. ML-based anomaly detection: identify stuck issues
4. Cost tracking: token usage per persona (with API logging)
5. SLA monitoring: issue resolution time targets per persona
