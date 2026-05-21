# WoterClip Observability Integration Guide

## Overview

This guide documents how to integrate observability instrumentation into WoterClip components. It covers the event emission APIs, metric collection patterns, and query interfaces.

## Architecture

Three layers:

1. **Event Emission** — Components emit events to JSONL logs and SQLite tables
2. **Aggregation** — Periodic aggregation rolls up detailed events into summary metrics
3. **Querying** — Query tools expose metrics for dashboards, alerts, and reporting

## Event Types

### Heartbeat Events
Emitted by `/heartbeat` skill during main loop execution.

**Event Sources:**
- Step 1 (Load Config & Lock) → `heartbeat.start`
- Step 2 (Check Inbox) → `heartbeat.inbox_checked`
- Step 3 (Dispatch) → `heartbeat.dispatch_started` / `heartbeat.dispatch_completed`
- Step 11 (Exit) → `heartbeat.completed`

**Example:**
```json
{
  "timestamp": "2026-05-21T14:30:00Z",
  "event_type": "heartbeat.start",
  "heartbeat_number": 22,
  "metadata": {
    "backend": "sqlite",
    "config_version": 2,
    "lockfile_created": true
  }
}
```

### Persona Events
Emitted by subagents during Steps 4–10.

**Event Sources:**
- Step 4 (Resolve Persona) → `persona.loaded`
- Step 7 (Understand Context) → `persona.context_loaded`
- Step 8 (Do Work) → `persona.work_started` / `persona.work_completed`
- Step 9 (Report) → `persona.report_generated`
- Step 10 (Update State) → `persona.state_updated`

**Example:**
```json
{
  "timestamp": "2026-05-21T14:30:30Z",
  "event_type": "persona.work_completed",
  "heartbeat_number": 22,
  "metadata": {
    "persona": "backend",
    "issue_id": 4,
    "duration_ms": 5000,
    "status": "success"
  }
}
```

### Adapter Events
Emitted by backend adapter calls (Linear or SQLite).

**Event Sources:**
- Each operation (list_issues, get_issue, update_state, etc.)

**Example:**
```json
{
  "timestamp": "2026-05-21T14:30:45Z",
  "event_type": "adapter.operation",
  "heartbeat_number": 22,
  "metadata": {
    "backend": "sqlite",
    "operation": "update_state",
    "issue_id": 4,
    "duration_ms": 12,
    "status": "success"
  }
}
```

## Emission APIs

### 1. Shell Event Emission
**Script:** `.woterclip/observability/emit-event.sh`

**Usage:**
```bash
source "${CLAUDE_PLUGIN_ROOT}/skills/heartbeat/emit-event.sh"

emit_heartbeat_start() {
    emit_event "heartbeat.start" "$HEARTBEAT_NUM" \
        "{\"backend\":\"$BACKEND\",\"config_version\":2}"
}

emit_heartbeat_completed() {
    emit_event "heartbeat.completed" "$HEARTBEAT_NUM" \
        "{\"duration_ms\":$DURATION_MS,\"issues\":$ISSUES_COUNT}"
}

emit_persona_work() {
    emit_event "persona.work_completed" "$HEARTBEAT_NUM" \
        "{\"persona\":\"$PERSONA\",\"issue_id\":$ISSUE_ID,\"duration_ms\":$WORK_MS}"
}
```

### 2. SQLite Event Logging
Events are automatically inserted into the `events` table:

```bash
# Emit state change event
sqlite3 .woterclip/woterclip.db << EOF
INSERT INTO events (timestamp, event_type, issue_id, heartbeat_number, persona, old_value, new_value)
VALUES ('2026-05-21T14:30:00Z', 'issue_state_changed', 4, 22, 'backend', 'in_progress', 'in_review');
EOF
```

### 3. Heartbeat Summary Recording
**Script:** `.woterclip/observability/heartbeat-metrics.sh`

Called at end of heartbeat cycle:

```bash
.woterclip/observability/heartbeat-metrics.sh \
    "$HEARTBEAT_NUM" \
    "$START_TIME" \
    "$END_TIME" \
    "$ISSUES_PROCESSED" \
    "$SUBAGENT_COUNT"
```

Outputs summary JSON and inserts into `heartbeat_summaries` table.

## Integration Points

### `/heartbeat` Skill
The main skill must emit events at key checkpoints:

**Step 1 — After loading config and acquiring lock:**
```markdown
3. Emit heartbeat.start event
   - Log start time, backend, config version
   - Include lock acquisition details
```

**Step 2 — After checking inbox:**
```markdown
3. Emit heartbeat.inbox_checked event
   - Log issues found, issues after filtering
   - Record query duration
```

**Step 3 — Before and after dispatch:**
```markdown
Before: Emit heartbeat.dispatch_started
After:  Emit heartbeat.dispatch_completed
  - Log subagent count, dispatch duration
  - Record any failures
```

**Step 11 — After cleanup & merge logs:**
```markdown
1. Call heartbeat-metrics.sh to record cycle summary
2. Emit heartbeat.completed event
3. Clean up .heartbeat-lock
```

### Persona Subagents
Each subagent SOUL.md should document observability responsibilities:

```markdown
## Observability

- Emit persona.loaded after loading TOOLS.md
- Emit persona.work_started at Step 8 start
- Emit persona.work_completed at Step 8 end (with duration)
- Emit persona.state_updated at Step 10 (with old/new state)
```

### Backend Adapters
Both `backend-sqlite.md` and `backend-linear.md` must wrap operations:

**SQLite Example:**
```bash
# Before operation: note start time
OP_START=$(date +%s%N)

# Run operation
sqlite3 .woterclip/woterclip.db "SELECT ..."

# After operation: calculate duration & emit
OP_END=$(date +%s%N)
DURATION_MS=$(( (OP_END - OP_START) / 1000000 ))

emit_adapter_operation "sqlite" "list_issues" "$DURATION_MS" "success"
```

## Query Tools

### Query JSONL Logs
**Script:** `.woterclip/observability/query-metrics.sh`

```bash
# Heartbeat performance
.woterclip/observability/query-metrics.sh heartbeat-performance

# Subagent performance
.woterclip/observability/query-metrics.sh subagent-performance

# Adapter operations breakdown
.woterclip/observability/query-metrics.sh adapter-operations

# Error summary
.woterclip/observability/query-metrics.sh error-summary

# Event timeline (last 6 hours)
.woterclip/observability/query-metrics.sh timeline 6
```

### Query SQLite Tables
**Script:** `.woterclip/observability/query-metrics-sql.sh`

```bash
# Heartbeat cycle summary
.woterclip/observability/query-metrics-sql.sh heartbeat-summary 22

# Persona workload (current cycle)
.woterclip/observability/query-metrics-sql.sh persona-workload

# Issue state transitions
.woterclip/observability/query-metrics-sql.sh issue-state-transitions

# Recent events (last 50)
.woterclip/observability/query-metrics-sql.sh recent-events 50

# Cycle duration analysis
.woterclip/observability/query-metrics-sql.sh cycle-duration 22

# Persona completion rates
.woterclip/observability/query-metrics-sql.sh persona-completion-rate

# Backend latencies
.woterclip/observability/query-metrics-sql.sh backend-latency
```

## File-based Metric Snapshots

Post-heartbeat, generate per-cycle metric files:

**`.woterclip/metrics/heartbeat_{N}.json`**
```json
{
  "cycle": 22,
  "timestamp": "2026-05-21T14:31:00Z",
  "duration_seconds": 60,
  "issues_processed": 1,
  "issues_completed": 0,
  "backend": "sqlite",
  "backend_latency_ms": 50,
  "subagent_count": 1,
  "personas": {
    "backend": {
      "issues": 1,
      "in_progress": 0,
      "in_review": 1,
      "avg_time_seconds": 60
    }
  }
}
```

**`.woterclip/metrics/lifetime.json`** (cumulative)
```json
{
  "total_cycles": 22,
  "total_issues_processed": 45,
  "total_issues_completed": 18,
  "total_duration_seconds": 1800,
  "personas": {
    "backend": {
      "issues_assigned": 15,
      "completed": 6,
      "avg_time_seconds": 400
    }
  }
}
```

## Implementation Checklist

- [ ] SQLite schema created (events, heartbeat_summaries, persona_metrics tables)
- [ ] emit-event.sh script created & executable
- [ ] heartbeat-metrics.sh script created & executable
- [ ] query-metrics.sh enhanced to parse SQLite tables
- [ ] query-metrics-sql.sh script created
- [ ] `/heartbeat` skill updated with event emission at Steps 1–3, 11
- [ ] Persona SOUL.md files updated with observability responsibilities
- [ ] Backend adapters wrapped with operation timing
- [ ] Metrics directory structure (`.woterclip/metrics/`) initialized
- [ ] Documentation added to CLAUDE.md or this guide
- [ ] E2E test: run heartbeat cycle & verify events in SQLite
- [ ] Dashboard (Phase 2): API endpoint to expose metrics as Prometheus format

## Future Enhancements

1. **Real-time Metrics API** — HTTP endpoint serving Prometheus-format metrics
2. **Grafana Dashboards** — Pre-built panels for heartbeat timeline, persona utilization, issue velocity
3. **Alerting Rules** — Slack/email on threshold violations (slow heartbeats, high error rates)
4. **Cost Tracking** — Integrate with Claude API logging for token usage & estimated cost per persona
5. **Anomaly Detection** — ML-based detection of stuck issues, unusual latencies
6. **SLA Monitoring** — Track issue resolution time against targets per persona
