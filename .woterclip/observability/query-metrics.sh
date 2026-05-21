#!/bin/bash
# Query metrics and analytics from WoterClip observability logs
# Usage: query-metrics.sh <query-type> [options]

set -euo pipefail

OBSDIR="${1:-.woterclip/observability}"

print_usage() {
    cat << EOF
Usage: query-metrics.sh <query-type> [options]

Query types:
  heartbeat-performance    - Duration and success rate for heartbeats
  subagent-performance     - Per-persona subagent stats
  adapter-operations       - Backend adapter call counts and latencies
  error-summary            - Errors and blockers from events
  decision-log             - Architecture review and QA review decisions
  timeline <hours>         - Event timeline for last N hours (default: 24)

Examples:
  query-metrics.sh heartbeat-performance
  query-metrics.sh subagent-performance
  query-metrics.sh timeline 6
EOF
}

query_heartbeat_performance() {
    echo "=== Heartbeat Performance ==="
    echo ""

    if [ ! -f "$OBSDIR/heartbeat-events.jsonl" ]; then
        echo "No heartbeat events found."
        return
    fi

    local total=$(grep -c "heartbeat.start" "$OBSDIR/heartbeat-events.jsonl" || echo 0)
    local successful=$(grep -c '"status": "completed"' "$OBSDIR/heartbeat-events.jsonl" || echo 0)
    local failed=$(grep -c '"status": "failed"' "$OBSDIR/heartbeat-events.jsonl" || echo 0)

    echo "Total Heartbeats: $total"
    echo "Successful: $successful"
    echo "Failed: $failed"
    echo "Success Rate: $(echo "scale=2; $successful * 100 / $total" | bc)%"
    echo ""
    echo "Recent heartbeats:"
    tail -5 "$OBSDIR/heartbeat-events.jsonl" | grep heartbeat.end | cut -d, -f1-3
}

query_subagent_performance() {
    echo "=== Subagent Performance (by Persona) ==="
    echo ""

    if [ ! -f "$OBSDIR/persona-events.jsonl" ]; then
        echo "No persona events found."
        return
    fi

    echo "Personas worked on:"
    grep '"event_type": "step.completed"' "$OBSDIR/persona-events.jsonl" | \
        grep '"step": 8' | \
        cut -d, -f4 | sort | uniq -c | awk '{print "  " $2 ": " $1 " completions"}'

    echo ""
    echo "Sample execution:"
    tail -3 "$OBSDIR/persona-events.jsonl" | head -1 | jq '.step, .persona, .duration_ms' 2>/dev/null || echo "(Events not in JSON format)"
}

query_adapter_operations() {
    echo "=== Backend Adapter Operations ==="
    echo ""

    if [ ! -f "$OBSDIR/adapter-events.jsonl" ]; then
        echo "No adapter events found."
        return
    fi

    local total=$(wc -l < "$OBSDIR/adapter-events.jsonl")
    local success=$(grep -c '"status": "success"' "$OBSDIR/adapter-events.jsonl" || echo 0)
    local failed=$(grep -c '"status": "failure"' "$OBSDIR/adapter-events.jsonl" || echo 0)

    echo "Total Operations: $total"
    echo "Success: $success"
    echo "Failures: $failed"
    echo ""
    echo "Operations breakdown:"
    grep '"operation":' "$OBSDIR/adapter-events.jsonl" | cut -d'"' -f4 | sort | uniq -c | awk '{print "  " $2 ": " $1}'
}

query_error_summary() {
    echo "=== Errors and Blockers ==="
    echo ""

    local error_count=0
    for file in "$OBSDIR"/*.jsonl; do
        [ -f "$file" ] || continue
        error_count=$(grep -c '"error":' "$file" 2>/dev/null || echo 0)
        if [ "$error_count" -gt 0 ]; then
            echo "File: $(basename $file)"
            grep '"error":' "$file" | head -3
            echo ""
        fi
    done

    if [ "$error_count" -eq 0 ]; then
        echo "No errors recorded."
    fi
}

query_decision_log() {
    echo "=== Architecture Review & QA Review Decisions ==="
    echo ""

    if [ ! -f "$OBSDIR/persona-events.jsonl" ]; then
        echo "No persona events found."
        return
    fi

    echo "Decisions from recent heartbeats:"
    grep '"decision":' "$OBSDIR/persona-events.jsonl" | cut -d'"' -f4 | sort | uniq -c || echo "No decisions recorded yet."
}

query_timeline() {
    local hours="${1:-24}"
    echo "=== Event Timeline (last $hours hours) ==="
    echo ""

    for file in "$OBSDIR"/heartbeat-events.jsonl "$OBSDIR"/persona-events.jsonl "$OBSDIR"/adapter-events.jsonl; do
        [ -f "$file" ] || continue
        echo "File: $(basename $file) — $(wc -l < $file) events"
    done

    echo ""
    echo "Recent events:"
    (
        [ -f "$OBSDIR/heartbeat-events.jsonl" ] && tail -5 "$OBSDIR/heartbeat-events.jsonl" | cut -d, -f1-3
        [ -f "$OBSDIR/persona-events.jsonl" ] && tail -5 "$OBSDIR/persona-events.jsonl" | cut -d, -f1-4
    ) | sort | tail -10
}

# Main
if [ $# -lt 1 ]; then
    print_usage
    exit 1
fi

case "$1" in
    heartbeat-performance)
        query_heartbeat_performance
        ;;
    subagent-performance)
        query_subagent_performance
        ;;
    adapter-operations)
        query_adapter_operations
        ;;
    error-summary)
        query_error_summary
        ;;
    decision-log)
        query_decision_log
        ;;
    timeline)
        query_timeline "${2:-24}"
        ;;
    *)
        echo "Unknown query type: $1"
        print_usage
        exit 1
        ;;
esac
