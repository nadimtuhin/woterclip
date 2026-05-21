# WoterClip Observability Queries

This document provides common queries for analyzing WoterClip observability data using bash, jq, and standard Unix tools.

## Heartbeat Events

### View recent heartbeats

```bash
# Last 10 heartbeat start/end events
tail -10 .woterclip/observability/heartbeat-events.jsonl | jq 'select(.event_type | contains("start") or contains("end"))'
```

### Heartbeat performance summary

```bash
# Duration and success rate of last 5 heartbeats
jq -s 'map(select(.event_type == "heartbeat.end")) | .[-5:] | map({timestamp, duration_ms, status})' \
  .woterclip/observability/heartbeat-events.jsonl
```

### Find slow heartbeats

```bash
# Heartbeats that took longer than 10 minutes (600000ms)
jq 'select(.event_type == "heartbeat.end" and .duration_ms > 600000)' \
  .woterclip/observability/heartbeat-events.jsonl | \
  jq '{timestamp, duration_ms, issues_processed: .details.issues_processed}'
```

### Issues processed per heartbeat

```bash
# Trend of issues processed over time
jq -s 'map(select(.event_type == "heartbeat.end")) | map({timestamp, count: .details.issues_processed})' \
  .woterclip/observability/heartbeat-events.jsonl
```

## Persona Events

### Performance by persona

```bash
# Average duration and error count per persona
jq -s 'group_by(.persona) | map({
  persona: .[0].persona,
  total_invocations: length,
  avg_duration_ms: (map(.duration_ms) | add / length),
  errors: map(select(.status == "failed")) | length,
  success_rate: (map(select(.status == "completed")) | length / length * 100 | round)
})' .woterclip/observability/persona-events.jsonl
```

### Step-by-step breakdown for a single issue

```bash
# All steps for issue ID 12
jq "select(.issue_id == 12) | {step, task_name, status, duration_ms}" \
  .woterclip/observability/persona-events.jsonl | \
  jq -s 'sort_by(.step)'
```

### Slow steps across all personas

```bash
# Steps taking longer than 1 second (1000ms)
jq 'select(.duration_ms > 1000)' .woterclip/observability/persona-events.jsonl | \
  jq -s 'sort_by(.duration_ms) | reverse | .[] | {step, task_name, persona, duration_ms}'
```

### Files created/modified summary

```bash
# Total files created/modified by all personas
jq '.details | {files_created: (.files_created | length), files_modified: (.files_modified | length)}' \
  .woterclip/observability/persona-events.jsonl | \
  jq -s '{
    total_files_created: map(.files_created) | add,
    total_files_modified: map(.files_modified) | add
  }'
```

### Most common file creations

```bash
# Count file creations by path
jq '.details.files_created[]?' .woterclip/observability/persona-events.jsonl | \
  jq -s 'group_by(.) | map({file: .[0], count: length}) | sort_by(.count) | reverse'
```

## Adapter Events

### Adapter operation success rate

```bash
# Success/failure breakdown by operation
jq -s 'group_by(.operation) | map({
  operation: .[0].operation,
  total: length,
  success: map(select(.status == "success")) | length,
  failures: map(select(.status == "failure")) | length,
  avg_duration_ms: (map(.duration_ms) | add / length)
})' .woterclip/observability/adapter-events.jsonl
```

### Slowest adapter operations

```bash
# Top 10 slowest individual operations
jq -s 'sort_by(.duration_ms) | reverse | .[0:10] | map({operation, backend, duration_ms})' \
  .woterclip/observability/adapter-events.jsonl
```

### Backend comparison

```bash
# Performance comparison between SQLite and Linear
jq -s 'group_by(.backend) | map({
  backend: .[0].backend,
  operations: length,
  avg_duration_ms: (map(.duration_ms) | add / length),
  errors: map(select(.status == "failure")) | length
})' .woterclip/observability/adapter-events.jsonl
```

### Database rows affected per operation

```bash
# Track data modifications (SQLite only)
jq 'select(.rows_affected != null)' .woterclip/observability/adapter-events.jsonl | \
  jq -s 'group_by(.operation) | map({
    operation: .[0].operation,
    total_rows_affected: map(.rows_affected) | add
  })'
```

### Recent adapter failures

```bash
# Last 5 failed operations
jq -s 'map(select(.status == "failure")) | .[-5:] | map({timestamp, operation, backend, error})' \
  .woterclip/observability/adapter-events.jsonl
```

## Combined Analysis

### Full heartbeat execution timeline

```bash
# Merge all three event streams, sorted by timestamp
(
  cat .woterclip/observability/heartbeat-events.jsonl
  cat .woterclip/observability/persona-events.jsonl
  cat .woterclip/observability/adapter-events.jsonl
) | jq -s 'sort_by(.timestamp) | .[] | {timestamp, event_type: (.event_type // .operation), status, duration_ms}' | head -50
```

### Detect synchronization issues

```bash
# Find gaps between heartbeat start and first persona event
jq -s 'map(select(.event_type == "heartbeat.start")) as $hb |
        map(select(.event_type == "step.completed" and .step == 4)) as $p4 |
        [$hb, $p4] | transpose | map({
          hb_timestamp: .[0].timestamp,
          step4_timestamp: .[1].timestamp,
          gap_ms: ((.[1].timestamp | fromdateiso8601) - (.[0].timestamp | fromdateiso8601)) * 1000
        })' \
  <(cat .woterclip/observability/heartbeat-events.jsonl .woterclip/observability/persona-events.jsonl)
```

### Issue-level cost analysis

```bash
# Total time spent on each issue (across all heartbeats)
jq 'select(.issue_id != null) | {issue_id, duration_ms}' \
  .woterclip/observability/persona-events.jsonl | \
  jq -s 'group_by(.issue_id) | map({
    issue_id: .[0].issue_id,
    total_duration_ms: map(.duration_ms) | add,
    invocations: length,
    avg_duration_ms: (map(.duration_ms) | add / length)
  }) | sort_by(.total_duration_ms) | reverse'
```

## Time-based Queries

### Events in last 24 hours

```bash
# All events from the past 24 hours
now=$(date +%s)
day_ago=$((now - 86400))

jq "select((.timestamp | fromdateiso8601) > $day_ago)" \
  .woterclip/observability/heartbeat-events.jsonl
```

### Events during specific time window

```bash
# Events between 2026-05-20 and 2026-05-21
jq 'select(.timestamp >= "2026-05-20T00:00:00Z" and .timestamp < "2026-05-21T00:00:00Z")' \
  .woterclip/observability/heartbeat-events.jsonl
```

### Hourly distribution

```bash
# Count events per hour
jq '.timestamp | split("T")[1] | split(":")[0]' \
  .woterclip/observability/heartbeat-events.jsonl | \
  sort | uniq -c
```

## Advanced Queries

### Anomaly detection: unusually slow step

```bash
# Identify steps that deviate from average (>2 std dev)
jq -s '
  group_by(.step) as $by_step |
  map(
    (map(.duration_ms) | add / length) as $avg |
    (map((.duration_ms - $avg) * (.duration_ms - $avg)) | add / length | sqrt) as $stddev |
    map(select(.duration_ms > $avg + 2 * $stddev))
  ) | flatten | sort_by(.duration_ms) | reverse
' .woterclip/observability/persona-events.jsonl
```

### Token efficiency

```bash
# Token usage per file created
jq '.details | select(.tokens_used != null) | {tokens_used, files_created: (.files_created | length)}' \
  .woterclip/observability/persona-events.jsonl | \
  jq -s '{
    total_tokens: map(.tokens_used) | add,
    total_files: map(.files_created) | add,
    tokens_per_file: (map(.tokens_used) | add) / (map(.files_created) | add)
  }'
```

### Model usage distribution

```bash
# Breakdown of model usage
jq '.details.model_used?' .woterclip/observability/persona-events.jsonl | \
  jq -s 'group_by(.) | map({model: .[0], count: length})'
```

## Dashboarding

### Generate CSV for external tools

```bash
# Export persona events to CSV
jq -r '[.timestamp, .issue_id, .persona, .step, .status, .duration_ms] | @csv' \
  .woterclip/observability/persona-events.jsonl > events.csv
```

### Generate summary JSON for monitoring

```bash
# Create a metrics snapshot for external systems
{
  timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  total_heartbeats=$(jq 'select(.event_type == "heartbeat.end")' .woterclip/observability/heartbeat-events.jsonl | wc -l)
  avg_duration=$(jq -s 'map(select(.event_type == "heartbeat.end") | .duration_ms) | add / length' .woterclip/observability/heartbeat-events.jsonl)
  total_issues=$(jq '.details.issues_processed' .woterclip/observability/heartbeat-events.jsonl | jq -s 'add')
  errors=$(jq 'select(.status == "failed")' .woterclip/observability/persona-events.jsonl | wc -l)
  
  jq -n --arg ts "$timestamp" --argjson hb "$total_heartbeats" --argjson dur "$avg_duration" \
        --argjson iss "$total_issues" --argjson err "$errors" \
    '{timestamp: $ts, heartbeats: $hb, avg_duration_ms: $dur, total_issues: $iss, errors: $err}'
}
```

## Troubleshooting Queries

### Find orphaned locks

```bash
# Issues marked as working for more than 4 hours
hours=4
cutoff=$(($(date +%s) - hours * 3600))

jq "select(.details.lock_acquired == true and (.timestamp | fromdateiso8601) < $cutoff)" \
  .woterclip/observability/persona-events.jsonl | \
  jq -r '.issue_id' | sort -u
```

### Detect cascade failures

```bash
# Find when one failure leads to others
jq 'select(.status == "failed")' .woterclip/observability/persona-events.jsonl | \
  jq -s 'sort_by(.timestamp) | .[] | {timestamp, issue_id, step, task_name}'
```

### Validate event stream integrity

```bash
# Check for missing heartbeat numbers
jq '.heartbeat_number' .woterclip/observability/heartbeat-events.jsonl | \
  sort -n | uniq | jq -s 'to_entries | map(select(.value != .key + 1))'
```

## Export & Share

### Create a report for specific issue

```bash
issue=12
{
  echo "=== Persona Events for Issue $issue ==="
  jq "select(.issue_id == $issue)" .woterclip/observability/persona-events.jsonl
  
  echo ""
  echo "=== Adapter Events for Issue $issue ==="
  jq "select(.issue_id == $issue)" .woterclip/observability/adapter-events.jsonl
} > issue-${issue}-report.txt
```

### Daily summary email

```bash
yesterday=$(date -d yesterday +%Y-%m-%d)

cat << REPORT
WoterClip Heartbeat Daily Summary — $yesterday

Heartbeats: $(jq "select(.timestamp | startswith(\"$yesterday\"))" .woterclip/observability/heartbeat-events.jsonl | wc -l)
Issues Processed: $(jq "select(.timestamp | startswith(\"$yesterday\")) | .details.issues_processed" .woterclip/observability/heartbeat-events.jsonl | jq -s 'add')
Persona Errors: $(jq "select(.timestamp | startswith(\"$yesterday\")) | select(.status == \"failed\")" .woterclip/observability/persona-events.jsonl | wc -l)

Top Files Modified:
$(jq "select(.timestamp | startswith(\"$yesterday\")) | .details.files_modified[]?" .woterclip/observability/persona-events.jsonl | jq -s 'group_by(.) | sort_by(length) | reverse | .[0:5] | .[]')

REPORT
```

All queries use standard UNIX tools (jq, grep, awk) and can be combined and piped as needed.
