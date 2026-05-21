#!/bin/bash
# query-metrics-sql.sh — Query observability metrics from SQLite
# Usage: query-metrics-sql.sh <query-type> [db-path]

set -euo pipefail

QUERY_TYPE="${1:?Query type required}"
DB_PATH=".woterclip/woterclip.db"

if [ ! -f "$DB_PATH" ]; then
    echo "Error: Database not found at $DB_PATH"
    exit 1
fi

print_usage() {
    cat << EOF
Usage: query-metrics-sql.sh <query-type> [db-path]

Query types:
  heartbeat-summary <cycle>      - Summary for a specific cycle
  persona-workload               - Per-persona active issue counts
  issue-state-transitions        - Count of state changes
  recent-events [limit]          - Last N events (default: 20)
  cycle-duration <cycle>         - Duration of a heartbeat cycle
  persona-completion-rate        - Completion rate by persona
  backend-latency                - Backend operation latencies

Examples:
  query-metrics-sql.sh heartbeat-summary 22
  query-metrics-sql.sh persona-workload
  query-metrics-sql.sh recent-events 50
EOF
}

query_heartbeat_summary() {
    local cycle="${1:?Cycle number required}"
    echo "=== Heartbeat Summary: Cycle $cycle ==="
    echo ""
    sqlite3 "$DB_PATH" << EOF
SELECT
    'Started' as metric,
    started_at as value
FROM heartbeat_summaries
WHERE cycle_number = $cycle

UNION ALL

SELECT
    'Completed' as metric,
    completed_at as value
FROM heartbeat_summaries
WHERE cycle_number = $cycle

UNION ALL

SELECT
    'Duration (seconds)' as metric,
    CAST(duration_seconds AS TEXT) as value
FROM heartbeat_summaries
WHERE cycle_number = $cycle

UNION ALL

SELECT
    'Issues Processed' as metric,
    CAST(issues_processed AS TEXT) as value
FROM heartbeat_summaries
WHERE cycle_number = $cycle

UNION ALL

SELECT
    'Issues Completed' as metric,
    CAST(issues_completed AS TEXT) as value
FROM heartbeat_summaries
WHERE cycle_number = $cycle

UNION ALL

SELECT
    'Backend Latency (ms)' as metric,
    CAST(backend_latency_ms AS TEXT) as value
FROM heartbeat_summaries
WHERE cycle_number = $cycle

UNION ALL

SELECT
    'Subagent Count' as metric,
    CAST(subagent_count AS TEXT) as value
FROM heartbeat_summaries
WHERE cycle_number = $cycle;
EOF
}

query_persona_workload() {
    echo "=== Persona Workload (Current Cycle) ==="
    echo ""
    sqlite3 "$DB_PATH" << EOF
SELECT
    pm.persona_name,
    pm.active_count,
    pm.in_progress_count,
    pm.blocked_count,
    ROUND(CAST(pm.avg_time_seconds AS REAL) / 60.0, 1) as avg_time_minutes
FROM persona_metrics pm
WHERE pm.heartbeat_number = (SELECT MAX(heartbeat_number) FROM persona_metrics)
ORDER BY pm.active_count DESC;
EOF
}

query_issue_state_transitions() {
    echo "=== Issue State Transitions ==="
    echo ""
    sqlite3 "$DB_PATH" << EOF
SELECT
    old_value as from_state,
    new_value as to_state,
    COUNT(*) as transition_count
FROM events
WHERE event_type = 'issue_state_changed'
GROUP BY old_value, new_value
ORDER BY transition_count DESC;
EOF
}

query_recent_events() {
    local limit="${1:-20}"
    echo "=== Recent Events (Last $limit) ==="
    echo ""
    sqlite3 "$DB_PATH" << EOF
SELECT
    timestamp,
    event_type,
    COALESCE(issue_id, '-') as issue_id,
    COALESCE(persona, '-') as persona,
    metadata
FROM events
ORDER BY timestamp DESC
LIMIT $limit;
EOF
}

query_cycle_duration() {
    local cycle="${1:?Cycle number required}"
    echo "=== Cycle $cycle Duration Analysis ==="
    echo ""
    sqlite3 "$DB_PATH" << EOF
SELECT
    'Total Duration (seconds)' as metric,
    CAST(duration_seconds AS TEXT) as value
FROM heartbeat_summaries
WHERE cycle_number = $cycle

UNION ALL

SELECT
    'Subagent Average Runtime (seconds)' as metric,
    CAST(ROUND(CAST(duration_seconds AS REAL) / NULLIF(subagent_count, 0), 2) AS TEXT) as value
FROM heartbeat_summaries
WHERE cycle_number = $cycle;
EOF
}

query_persona_completion_rate() {
    echo "=== Persona Completion Rate (Last 5 Cycles) ==="
    echo ""
    sqlite3 "$DB_PATH" << EOF
SELECT
    pm.persona_name,
    COUNT(DISTINCT pm.heartbeat_number) as cycles_active,
    ROUND(100.0 * COUNT(CASE WHEN i.state = 'done' THEN 1 END) /
        NULLIF(COUNT(*), 0), 2) as completion_rate_pct
FROM persona_metrics pm
LEFT JOIN issues i ON i.persona = pm.persona_name
WHERE pm.heartbeat_number >= (SELECT MAX(heartbeat_number) - 4 FROM persona_metrics)
GROUP BY pm.persona_name
ORDER BY completion_rate_pct DESC;
EOF
}

query_backend_latency() {
    echo "=== Backend Operation Latencies ==="
    echo ""
    sqlite3 "$DB_PATH" << EOF
SELECT
    'Cycle' as metric,
    cycle_number as value,
    'Backend Latency (ms)' as detail,
    CAST(backend_latency_ms AS TEXT) as latency
FROM heartbeat_summaries
ORDER BY cycle_number DESC
LIMIT 10;
EOF
}

# Main
if [ $# -lt 1 ]; then
    print_usage
    exit 1
fi

case "$QUERY_TYPE" in
    heartbeat-summary)
        query_heartbeat_summary "${2:?Cycle number required}"
        ;;
    persona-workload)
        query_persona_workload
        ;;
    issue-state-transitions)
        query_issue_state_transitions
        ;;
    recent-events)
        query_recent_events "${2:-20}"
        ;;
    cycle-duration)
        query_cycle_duration "${2:?Cycle number required}"
        ;;
    persona-completion-rate)
        query_persona_completion_rate
        ;;
    backend-latency)
        query_backend_latency
        ;;
    *)
        echo "Unknown query type: $QUERY_TYPE"
        print_usage
        exit 1
        ;;
esac
