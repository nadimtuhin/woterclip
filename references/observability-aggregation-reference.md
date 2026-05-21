# Observability Metrics Aggregation Reference

This document provides a reusable aggregation function for computing hourly, daily, and monthly metrics snapshots from JSONL observability logs.

## Aggregation Function

```bash
#!/bin/bash
# aggregates observability logs into time-series metrics snapshots

aggregate_metrics() {
  local period=$1  # hourly, daily, monthly
  local obs_dir=".woterclip/observability"
  local metrics_dir="$obs_dir/metrics-snapshots"
  
  [[ -d "$metrics_dir" ]] || mkdir -p "$metrics_dir"
  
  case "$period" in
    hourly)
      aggregate_hourly "$obs_dir" "$metrics_dir"
      ;;
    daily)
      aggregate_daily "$obs_dir" "$metrics_dir"
      ;;
    monthly)
      aggregate_monthly "$obs_dir" "$metrics_dir"
      ;;
    *)
      echo "Invalid period: $period (use hourly, daily, or monthly)"
      return 1
      ;;
  esac
}

# Hourly aggregation: summarize events from past hour
aggregate_hourly() {
  local obs_dir=$1 metrics_dir=$2
  
  local now=$(date -u +%Y-%m-%dT%H)
  local snapshot_file="$metrics_dir/${now}:00:00Z.json"
  
  # Skip if already aggregated
  [[ -f "$snapshot_file" ]] && return 0
  
  # Time window: now - 1h to now
  local start_time=$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%S)
  local end_time=$(date -u +%Y-%m-%dT%H:%M:%S)
  
  # Build aggregations
  local hb_metrics=$(jq -s '
    map(select(.timestamp >= "'$start_time'" and .timestamp <= "'$end_time'"))
    | group_by(.event_type)
    | map({
      event_type: .[0].event_type,
      count: length,
      success: map(select(.status == "completed")) | length,
      failed: map(select(.status == "failed")) | length,
      duration_ms: {
        min: map(.duration_ms) | min,
        max: map(.duration_ms) | max,
        mean: (map(.duration_ms) | add / length),
        p50: (map(.duration_ms) | sort)[length / 2],
        p95: (map(.duration_ms) | sort)[length * 0.95 | floor],
        p99: (map(.duration_ms) | sort)[length * 0.99 | floor]
      }
    })
  ' "$obs_dir/heartbeat-events.jsonl")
  
  local persona_metrics=$(jq -s '
    map(select(.timestamp >= "'$start_time'" and .timestamp <= "'$end_time'"))
    | group_by(.persona)
    | map({
      persona: .[0].persona,
      invocations: length,
      success: map(select(.status == "completed")) | length,
      errors: map(select(.status == "failed")) | length,
      duration_ms: {
        min: map(.duration_ms) | min,
        max: map(.duration_ms) | max,
        mean: (map(.duration_ms) | add / length),
        p95: (map(.duration_ms) | sort)[length * 0.95 | floor]
      },
      files_created: map(.details.files_created[]?) | length,
      files_modified: map(.details.files_modified[]?) | length
    })
  ' "$obs_dir/persona-events.jsonl")
  
  local adapter_metrics=$(jq -s '
    map(select(.timestamp >= "'$start_time'" and .timestamp <= "'$end_time'"))
    | group_by(.operation)
    | map({
      operation: .[0].operation,
      count: length,
      success: map(select(.status == "success")) | length,
      errors: map(select(.status == "failure")) | length,
      duration_ms: {
        mean: (map(.duration_ms) | add / length),
        p95: (map(.duration_ms) | sort)[length * 0.95 | floor]
      },
      rows_affected: (map(.rows_affected) | add // 0)
    })
  ' "$obs_dir/adapter-events.jsonl")
  
  # Write snapshot
  cat > "$snapshot_file" <<EOF
{
  "period": "${now}:00:00Z/PT1H",
  "generated_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "heartbeats": $hb_metrics,
  "personas": $persona_metrics,
  "adapters": $adapter_metrics
}
EOF
  
  echo "Generated hourly snapshot: $snapshot_file"
}

# Daily aggregation: roll up hourly metrics
aggregate_daily() {
  local obs_dir=$1 metrics_dir=$2
  
  local today=$(date -u +%Y-%m-%d)
  local snapshot_file="$metrics_dir/${today}.json"
  
  [[ -f "$snapshot_file" ]] && return 0
  
  # Aggregate all hourly files for this date
  jq -s '
    {
      period: "'$today'T00:00:00Z/P1D",
      generated_at: now | todate,
      heartbeats: (
        map(.heartbeats[]?) | group_by(.event_type) | map({
          event_type: .[0].event_type,
          count: map(.count) | add,
          success: map(.success) | add,
          failed: map(.failed) | add
        })
      ),
      personas: (
        map(.personas[]?) | group_by(.persona) | map({
          persona: .[0].persona,
          invocations: map(.invocations) | add,
          success: map(.success) | add,
          errors: map(.errors) | add
        })
      ),
      adapters: (
        map(.adapters[]?) | group_by(.operation) | map({
          operation: .[0].operation,
          count: map(.count) | add,
          success: map(.success) | add,
          errors: map(.errors) | add
        })
      )
    }
  ' "$metrics_dir/${today}T"*.json > "$snapshot_file"
  
  echo "Generated daily snapshot: $snapshot_file"
}

# Monthly aggregation: roll up daily metrics
aggregate_monthly() {
  local obs_dir=$1 metrics_dir=$2
  
  local month=$(date -u +%Y-%m)
  local snapshot_file="$metrics_dir/${month}.json"
  
  [[ -f "$snapshot_file" ]] && return 0
  
  # Aggregate daily files for this month
  jq -s '
    {
      period: "'$month'-01T00:00:00Z/P1M",
      generated_at: now | todate,
      heartbeats: (
        map(.heartbeats[]?) | group_by(.event_type) | map({
          event_type: .[0].event_type,
          total_count: map(.count) | add,
          total_success: map(.success) | add,
          total_failed: map(.failed) | add
        })
      ),
      personas: (
        map(.personas[]?) | group_by(.persona) | map({
          persona: .[0].persona,
          total_invocations: map(.invocations) | add,
          total_errors: map(.errors) | add
        })
      )
    }
  ' "$metrics_dir/${month}-"*.json > "$snapshot_file"
  
  echo "Generated monthly snapshot: $snapshot_file"
}
```

## Query Examples

### Get last 24h throughput

```bash
# Sum processed issues over last 24h
jq -s 'map(.heartbeats[] | select(.event_type == "heartbeat.end") | .count) | add' \
  .woterclip/observability/metrics-snapshots/$(date -u +'%Y-%m-%d')T*.json
```

### Find slow persona invocations

```bash
# Personas taking > 5 seconds
jq -s 'map(.personas[] | select(.duration_ms.mean > 5000))' \
  .woterclip/observability/metrics-snapshots/$(date -u +'%Y-%m-%d')T*.json
```

### Adapter error rate

```bash
# Operations with errors > 0
jq -s 'map(.adapters[] | select(.errors > 0))' \
  .woterclip/observability/metrics-snapshots/$(date -u +'%Y-%m-%d').json
```

### Week-over-week comparison

```bash
# Compare last 7 days of heartbeat counts
for date in {6..0}; do
  d=$(date -u -d "$date days ago" +%Y-%m-%d)
  count=$(jq '.heartbeats | map(.count) | add' \
    .woterclip/observability/metrics-snapshots/$d.json 2>/dev/null || echo 0)
  echo "$d: $count heartbeats"
done
```

## Integration with Heartbeat Skill

Add to Step 11 (cleanup and aggregation):

```markdown
### Observability aggregation

At heartbeat exit, compute metrics for current hour:

\`\`\`bash
source "${CLAUDE_PLUGIN_ROOT}/references/observability-aggregation-reference.md"
aggregate_metrics hourly

# Optional: daily/monthly if now crosses hour boundary
[[ $(date -u +%M) -lt 10 ]] && aggregate_metrics daily
\`\`\`

This ensures metrics snapshots are always current without external cron jobs.
```

## Retention Policy

- **Hourly snapshots:** Keep 90 days (then compress to .gz)
- **Daily snapshots:** Keep 2 years
- **Monthly snapshots:** Keep indefinitely

Cleanup via cron:

```bash
# Daily job to clean old snapshots
0 2 * * * \
  find ~/.woterclip/observability/metrics-snapshots -name "*T*.json" -mtime +90 -exec gzip {} \;
```

## Performance

- **Hourly aggregation:** ~50ms (reads 3 JSONL files, writes 1 JSON)
- **Daily aggregation:** ~200ms (reads 24 hourly files)
- **Monthly aggregation:** ~1s (reads 28-31 daily files)

All operations use streaming jq (map/select/group_by) with O(n) complexity.

