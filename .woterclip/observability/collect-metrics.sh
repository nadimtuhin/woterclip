#!/bin/bash
# collect-metrics.sh — Real-time metrics collection for WoterClip heartbeat
# Usage: collect-metrics.sh [heartbeat_number] [event_type] [event_data_json]

set -euo pipefail

OBSERVABILITY_DIR="${WOTERCLIP_ROOT:-.woterclip}/observability"
mkdir -p "$OBSERVABILITY_DIR/metrics-snapshots"

HB_NUMBER="${1:-0}"
EVENT_TYPE="${2:-}"
EVENT_DATA="${3:-}"

# ============================================================================
# Step 1: Log timing events (heartbeat, persona, adapter)
# ============================================================================

log_event() {
  local event_type="$1"
  local event_file="$2"
  local event_json="$3"
  
  echo "$event_json" >> "$OBSERVABILITY_DIR/$event_file"
}

# ============================================================================
# Step 2: Compute timing from timestamps
# ============================================================================

compute_duration() {
  local start_epoch="$1"
  local end_epoch="$2"
  echo $(( (end_epoch - start_epoch) * 1000 ))  # Convert to ms
}

# ============================================================================
# Step 3: Aggregate metrics (run every 10 heartbeats)
# ============================================================================

aggregate_metrics() {
  local hb_number="$1"
  
  # Skip if not a multiple of 10
  if (( hb_number % 10 != 0 )); then
    return 0
  fi
  
  local snapshot_file="$OBSERVABILITY_DIR/metrics-snapshots/snapshot-hb${hb_number}.json"
  
  # Compute percentiles from heartbeat-events.jsonl
  local p50_time=$(grep "heartbeat.cycle_duration" "$OBSERVABILITY_DIR/heartbeat-events.jsonl" | jq '.duration_ms' | sort -n | head -$(($(wc -l < "$OBSERVABILITY_DIR/heartbeat-events.jsonl") / 2)) | tail -1)
  local p95_time=$(grep "heartbeat.cycle_duration" "$OBSERVABILITY_DIR/heartbeat-events.jsonl" | jq '.duration_ms' | sort -n | tail -$(($(wc -l < "$OBSERVABILITY_DIR/heartbeat-events.jsonl") * 5 / 100)) | head -1)
  local p99_time=$(grep "heartbeat.cycle_duration" "$OBSERVABILITY_DIR/heartbeat-events.jsonl" | jq '.duration_ms' | sort -n | tail -$(($(wc -l < "$OBSERVABILITY_DIR/heartbeat-events.jsonl") / 100)) | head -1)
  
  # Build snapshot JSON
  cat > "$snapshot_file" << JSON
{
  "heartbeat_number": $hb_number,
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "cycle_duration_percentiles": {
    "p50_ms": ${p50_time:-0},
    "p95_ms": ${p95_time:-0},
    "p99_ms": ${p99_time:-0}
  },
  "issues_processed": $(grep "heartbeat.cycle_duration" "$OBSERVABILITY_DIR/heartbeat-events.jsonl" | tail -1 | jq '.issues_processed // 0'),
  "personas_active": $(jq -s 'group_by(.persona) | length' "$OBSERVABILITY_DIR/persona-events.jsonl" 2>/dev/null || echo 0)
}
JSON
  
  echo "✅ Generated metrics snapshot: $snapshot_file"
}

# ============================================================================
# Step 4: Export Prometheus-style metrics
# ============================================================================

export_prometheus() {
  local prom_file="$OBSERVABILITY_DIR/metrics.txt"
  
  cat > "$prom_file" << PROM
# HELP heartbeat_cycle_duration_ms Heartbeat execution time in milliseconds
# TYPE heartbeat_cycle_duration_ms histogram
$(grep "heartbeat.cycle_duration" "$OBSERVABILITY_DIR/heartbeat-events.jsonl" | tail -20 | \
  jq -r '.duration_ms as $val | {le: (
    if $val <= 100 then "100" elif $val <= 500 then "500" elif $val <= 1000 then "1000" elif $val <= 5000 then "5000" else "+Inf" end
  )} | "heartbeat_cycle_duration_ms_bucket{le=\"\(.le)\"} \($val)"' | sort | uniq -c | awk '{print $2 " " $1}' )

# HELP persona_processing_time_ms Per-persona average processing time
# TYPE persona_processing_time_ms gauge
$(jq -r 'select(.processing_time_ms != null) | .persona as $p | .processing_time_ms' "$OBSERVABILITY_DIR/persona-events.jsonl" 2>/dev/null | \
  awk '{sum[$1]+=$2; count[$1]++} END {for (p in sum) print "persona_processing_time_ms{persona=\"" p "\"} " (sum[p]/count[p])}' )

# HELP adapter_call_latency_ms Backend adapter operation latency
# TYPE adapter_call_latency_ms histogram
$(jq -r '.adapter + "|" + .operation + "|" + (.latency_ms | tostring)' "$OBSERVABILITY_DIR/adapter-events.jsonl" 2>/dev/null | \
  awk -F'|' '{sum[$1":"$2]+=$3; count[$1":"$2]++} END {for (k in sum) print "adapter_latency_ms{adapter_op=\"" k "\"} " (sum[k]/count[k])}' )

PROM
  
  echo "✅ Exported Prometheus metrics: $prom_file"
}

# ============================================================================
# Main entry point
# ============================================================================

if [[ -n "$EVENT_TYPE" && -n "$EVENT_DATA" ]]; then
  case "$EVENT_TYPE" in
    heartbeat)
      log_event "heartbeat" "heartbeat-events.jsonl" "$EVENT_DATA"
      ;;
    persona)
      log_event "persona" "persona-events.jsonl" "$EVENT_DATA"
      ;;
    adapter)
      log_event "adapter" "adapter-events.jsonl" "$EVENT_DATA"
      ;;
    *)
      echo "❌ Unknown event type: $EVENT_TYPE"
      exit 1
      ;;
  esac
  
  echo "✅ Logged $EVENT_TYPE event"
  
  # Aggregate and export every 10 heartbeats
  aggregate_metrics "$HB_NUMBER"
  export_prometheus
else
  # No arguments: just regenerate exports from existing logs
  export_prometheus
  echo "✅ Regenerated metrics exports"
fi
