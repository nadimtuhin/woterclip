# Observability Query Patterns

## Overview

This document provides common SQL and jq queries for analyzing WoterClip observability data. Use these to debug performance, monitor persona execution, and identify bottlenecks.

## JSONL Queries (jq)

All observability events are written as JSONL files in `.woterclip/observability/`.

### Recent Heartbeat Events

```bash
# Last 10 heartbeat events
tail -10 .woterclip/observability/heartbeat-events.jsonl | jq '.'

# Heartbeat events from a specific cycle
jq "select(.heartbeat_number == 23)" .woterclip/observability/heartbeat-events.jsonl

# All heartbeat start/end events
jq "select(.event_type | startswith(\"heartbeat.\"))" .woterclip/observability/heartbeat-events.jsonl
```

### Persona Performance Analysis

```bash
# Duration per step for backend persona
jq "select(.persona == \"backend\") | {step, task_name, duration_ms}" \
  .woterclip/observability/persona-events.jsonl | jq -s 'sort_by(.step)'

# Steps with highest latency
jq "select(.persona == \"backend\") | {step, duration_ms}" \
  .woterclip/observability/persona-events.jsonl | jq -s 'sort_by(-.duration_ms) | .[0:5]'

# Persona with most errors
jq "select(.status == \"failed\") | .persona" \
  .woterclip/observability/persona-events.jsonl | jq -s 'group_by(.) | map({persona: .[0], count: length}) | sort_by(-.count)'
```

### Adapter Operation Analysis

```bash
# All SQLite operations, sorted by latency
jq "select(.backend == \"sqlite\") | {operation, duration_ms, status}" \
  .woterclip/observability/adapter-events.jsonl | jq -s 'sort_by(-.duration_ms)'

# Failed operations
jq "select(.status == \"failure\")" .woterclip/observability/adapter-events.jsonl

# Operation count per backend
jq "{backend, operation}" .woterclip/observability/adapter-events.jsonl | \
  jq -s 'group_by(.backend) | map({backend: .[0].backend, operations: length})'

# P95 latency per operation (SQLite)
jq "select(.backend == \"sqlite\") | {operation, duration_ms}" \
  .woterclip/observability/adapter-events.jsonl | jq -s '
  group_by(.operation) | 
  map({
    operation: .[0].operation,
    p95: (map(.duration_ms) | sort | .[length * 0.95 | floor]),
    max: (map(.duration_ms) | max),
    count: length
  })'
```

## SQL Queries

Query the observability tables for aggregated metrics.

### Heartbeat Summary

```sql
-- Last 5 heartbeats with timing
SELECT 
  cycle_number,
  duration_seconds,
  issues_processed,
  issues_completed,
  subagent_count,
  strftime('%Y-%m-%d %H:%M:%S', started_at) AS start_time
FROM heartbeat_summaries
ORDER BY cycle_number DESC
LIMIT 5;

-- Efficiency: issues_completed / subagent_count
SELECT 
  cycle_number,
  ROUND(CAST(issues_completed AS FLOAT) / NULLIF(subagent_count, 0), 2) AS efficiency,
  duration_seconds
FROM heartbeat_summaries
ORDER BY cycle_number DESC
LIMIT 10;
```

### Persona Metrics

```sql
-- Persona performance per heartbeat
SELECT 
  heartbeat_number,
  persona_name,
  COUNT(*) AS issues_handled,
  AVG(duration_ms) AS avg_duration_ms,
  SUM(tokens_used) AS total_tokens,
  SUM(commits_created) AS commits,
  SUM(errors_encountered) AS errors
FROM persona_metrics
WHERE heartbeat_number >= (SELECT MAX(cycle_number) - 5 FROM heartbeat_summaries)
GROUP BY heartbeat_number, persona_name
ORDER BY heartbeat_number DESC;

-- Slowest personas (by average duration)
SELECT 
  persona_name,
  COUNT(*) AS executions,
  AVG(duration_ms) AS avg_duration_ms,
  MAX(duration_ms) AS max_duration_ms,
  MIN(duration_ms) AS min_duration_ms
FROM persona_metrics
GROUP BY persona_name
ORDER BY avg_duration_ms DESC;

-- Token consumption per persona
SELECT 
  persona_name,
  SUM(tokens_used) AS total_tokens,
  AVG(tokens_used) AS avg_tokens_per_issue,
  COUNT(*) AS issues_handled
FROM persona_metrics
WHERE tokens_used > 0
GROUP BY persona_name
ORDER BY total_tokens DESC;
```

### Adapter Operations

```sql
-- Operation success rate
SELECT 
  backend,
  operation,
  COUNT(*) AS total,
  SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes,
  ROUND(
    CAST(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS FLOAT) / COUNT(*) * 100,
    1
  ) AS success_rate_pct
FROM adapter_operations
GROUP BY backend, operation
ORDER BY success_rate_pct ASC;

-- Slowest operations (p99 latency)
SELECT 
  operation,
  backend,
  COUNT(*) AS count,
  AVG(duration_ms) AS avg_ms,
  MAX(duration_ms) AS max_ms,
  PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY duration_ms) AS p99_ms
FROM adapter_operations
GROUP BY operation, backend
ORDER BY p99_ms DESC
LIMIT 10;

-- Recent failures
SELECT 
  operation,
  backend,
  duration_ms,
  error_message,
  created_at
FROM adapter_operations
WHERE status = 'failure'
ORDER BY created_at DESC
LIMIT 20;
```

## Dashboard Metrics

### Heartbeat Health

```bash
#!/bin/bash
# Monitor heartbeat health in real-time

watch -n 5 'sqlite3 .woterclip/woterclip.db << SQL
SELECT 
  "Latest Heartbeat Summary:" AS metric,
  printf("Cycle %d (duration: %ds, issues: %d/%d)", 
    cycle_number, duration_seconds, issues_completed, issues_processed) AS value
FROM heartbeat_summaries
ORDER BY cycle_number DESC LIMIT 1;
SQL
'
```

### Persona Workload

```sql
-- Current heartbeat persona distribution
SELECT 
  pm.persona_name,
  COUNT(pm.id) AS issues_in_progress,
  AVG(pm.duration_ms) AS avg_duration_ms,
  SUM(pm.tokens_used) AS total_tokens
FROM persona_metrics pm
WHERE pm.heartbeat_number = (SELECT MAX(cycle_number) FROM heartbeat_summaries)
GROUP BY pm.persona_name
ORDER BY issues_in_progress DESC;
```

### Adapter Health

```sql
-- Backend operation latency percentiles (rolling 100 ops)
SELECT 
  operation,
  backend,
  ROUND(AVG(duration_ms), 1) AS p50_ms,
  MAX(CASE WHEN row_num <= count * 0.95 THEN duration_ms END) AS p95_ms
FROM (
  SELECT 
    operation,
    backend,
    duration_ms,
    ROW_NUMBER() OVER (PARTITION BY operation, backend ORDER BY duration_ms) AS row_num,
    COUNT(*) OVER (PARTITION BY operation, backend) AS count
  FROM adapter_operations
  ORDER BY id DESC LIMIT 100
)
GROUP BY operation, backend
ORDER BY p95_ms DESC;
```

## Troubleshooting

### "Heartbeat got stuck"

```bash
# Check for incomplete persona metrics (step count < 7)
sqlite3 .woterclip/woterclip.db "
  SELECT heartbeat_number, persona_name, issue_id, steps_completed, steps_failed
  FROM persona_metrics
  WHERE steps_completed < 7
  ORDER BY heartbeat_number DESC LIMIT 10;
"
```

### "Slow adapter operations"

```bash
# Find operations exceeding threshold (>500ms)
sqlite3 .woterclip/woterclip.db "
  SELECT operation, backend, duration_ms, error_message, created_at
  FROM adapter_operations
  WHERE duration_ms > 500
  ORDER BY duration_ms DESC;
"
```

### "Token usage spike"

```bash
# Check token consumption by persona
sqlite3 .woterclip/woterclip.db "
  SELECT 
    heartbeat_number, 
    persona_name, 
    tokens_used, 
    duration_ms,
    ROUND(CAST(tokens_used AS FLOAT) / duration_ms * 1000, 1) AS tokens_per_sec
  FROM persona_metrics
  WHERE tokens_used > 15000
  ORDER BY tokens_used DESC LIMIT 10;
"
```

## Exporting Data

### Export for Analysis

```bash
# Export adapter operations as CSV
sqlite3 -header -csv .woterclip/woterclip.db \
  "SELECT * FROM adapter_operations LIMIT 1000;" > adapter-ops.csv

# Export persona metrics as JSON
sqlite3 .woterclip/woterclip.db \
  "SELECT * FROM persona_metrics ORDER BY heartbeat_number DESC LIMIT 100;" | \
  sqlite3 .woterclip/woterclip.db -json > persona-metrics.json
```

### Convert JSONL to CSV

```bash
# Adapter events to CSV
jq -r '
  [.timestamp, .heartbeat_number, .operation, .backend, .status, .duration_ms, .rows_affected] | @csv
' .woterclip/observability/adapter-events.jsonl > adapter-events.csv

# Add header
sed -i '1s/^/timestamp,heartbeat_number,operation,backend,status,duration_ms,rows_affected\n/' adapter-events.csv
```

## Alerting Rules (Future Phase 2)

```yaml
# Example alerting thresholds
alerts:
  heartbeat_duration_exceeded:
    condition: "duration_seconds > 300"
    message: "Heartbeat cycle exceeded 5 minutes"
  
  persona_error_rate:
    condition: "steps_failed > 0"
    message: "Persona execution had failures"
  
  adapter_latency_spike:
    condition: "duration_ms > 1000"
    message: "Adapter operation latency exceeds 1 second"
  
  subagent_failures:
    condition: "subagent_failed > 0"
    message: "One or more subagents failed"
```

## Performance Benchmarks (Target)

For reference, target P95 latencies:

| Operation | Target | Note |
|-----------|--------|------|
| list_issues (SQLite) | <100ms | Single query, 5–10 rows |
| create_issue (SQLite) | <50ms | Single insert |
| update_issue (SQLite) | <50ms | Single update |
| add_comment (SQLite) | <50ms | Single insert |
| close_issue (SQLite) | <50ms | Single update |
| — | — | — |
| list_issues (Linear) | <500ms | MCP call overhead |
| create_issue (Linear) | <500ms | MCP call overhead |
| update_issue (Linear) | <500ms | MCP call overhead |
| add_comment (Linear) | <800ms | MCP + Linear API |
| — | — | — |
| Persona (resolve–context) | <1000ms | Load + validation |
| Persona (do-work) | <15000ms | Actual work (token-dependent) |
| Heartbeat (full cycle) | <300000ms | 5 min for 2 parallel subagents |

