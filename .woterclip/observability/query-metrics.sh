#!/bin/bash
# query-metrics.sh — Interactive query tool for WoterClip observability metrics
# Usage: query-metrics.sh [query] [--json]

OBSERVABILITY_DIR="${WOTERCLIP_ROOT:-.woterclip}/observability"
JSON_OUTPUT="${2:---human}"

query="${1:-help}"

case "$query" in
  last-heartbeat)
    echo "=== Last Heartbeat Cycle ==="
    tail -1 "$OBSERVABILITY_DIR/heartbeat-events.jsonl" | jq '{heartbeat_number, timestamp, issues_processed: .details.max_parallel}'
    ;;
  
  persona-stats)
    echo "=== Persona Workload Distribution ==="
    jq -s 'group_by(.persona) | map({
      persona: .[0].persona,
      cycles: length,
      avg_processing_ms: (map(.processing_time_ms // 0) | add / length),
      completed: (map(select(.status == "completed")) | length),
      blocked: (map(select(.status == "blocked")) | length)
    })' "$OBSERVABILITY_DIR/persona-events.jsonl" 2>/dev/null | jq .[] | column -t
    ;;
  
  adapter-performance)
    echo "=== Adapter Performance (Last 10 Calls) ==="
    tail -10 "$OBSERVABILITY_DIR/adapter-events.jsonl" | jq '{adapter, operation, latency_ms, status}'
    ;;
  
  adapter-latency-percentiles)
    echo "=== Adapter Latency Percentiles ==="
    jq -s 'map(.latency_ms) | sort | {
      p50: .[length * 0.50 | floor],
      p95: .[length * 0.95 | floor],
      p99: .[length * 0.99 | floor],
      max: max,
      min: min,
      avg: (add / length)
    }' "$OBSERVABILITY_DIR/adapter-events.jsonl" 2>/dev/null | jq .
    ;;
  
  cycle-duration)
    echo "=== Cycle Duration Trend (Last 5) ==="
    grep "heartbeat.end" "$OBSERVABILITY_DIR/heartbeat-events.jsonl" 2>/dev/null | tail -5 | \
      jq -r '.heartbeat_number, .cycle_duration_ms' | paste - - | column -t -s$'\t'
    ;;
  
  health-check)
    echo "=== System Health Check ==="
    echo "✓ Event files:"
    wc -l "$OBSERVABILITY_DIR"/*.jsonl 2>/dev/null | tail -1
    echo ""
    echo "✓ Latest heartbeat:"
    tail -1 "$OBSERVABILITY_DIR/heartbeat-events.jsonl" | jq '.heartbeat_number, .timestamp' | tr '\n' ' ' && echo ""
    echo ""
    echo "✓ Adapter status (last 10):"
    tail -10 "$OBSERVABILITY_DIR/adapter-events.jsonl" | jq '.status' | sort | uniq -c
    ;;
  
  export-prometheus)
    echo "=== Prometheus Metrics Export ==="
    if [[ -f "$OBSERVABILITY_DIR/metrics.txt" ]]; then
      cat "$OBSERVABILITY_DIR/metrics.txt"
    else
      echo "❌ metrics.txt not found. Run: collect-metrics.sh export"
    fi
    ;;
  
  help|--help|-h)
    cat << HELP
Usage: query-metrics.sh [query]

Queries:
  last-heartbeat              Show most recent heartbeat cycle metadata
  persona-stats               Persona workload distribution (cycles, avg time, completion rate)
  adapter-performance         Last 10 adapter calls (latency, status)
  adapter-latency-percentiles Adapter call latency percentiles (p50, p95, p99)
  cycle-duration              Heartbeat cycle duration trend (last 5)
  health-check                System health summary (event counts, status)
  export-prometheus           Show Prometheus metrics export

Examples:
  query-metrics.sh last-heartbeat
  query-metrics.sh persona-stats
  query-metrics.sh health-check

HELP
    ;;
  
  *)
    echo "❌ Unknown query: $query"
    echo "Run 'query-metrics.sh help' for available queries."
    exit 1
    ;;
esac
