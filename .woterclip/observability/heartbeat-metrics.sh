#!/bin/bash
# heartbeat-metrics.sh — Compute and record metrics for a completed heartbeat cycle
# Usage: heartbeat-metrics.sh <heartbeat-number> <start-time> <end-time> <issues-processed> <subagent-count> [db-path]

set -euo pipefail

HB_NUM="${1:?Heartbeat number required}"
START_TIME="${2:?Start time required}"
END_TIME="${3:?End time required}"
ISSUES_PROCESSED="${4:?Issues processed required}"
SUBAGENT_COUNT="${5:?Subagent count required}"
DB_PATH="${6:-.woterclip/woterclip.db}"

# Calculate duration in seconds
START_EPOCH=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$START_TIME" +%s 2>/dev/null || date -d "$START_TIME" +%s 2>/dev/null || echo 0)
END_EPOCH=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$END_TIME" +%s 2>/dev/null || date -d "$END_TIME" +%s 2>/dev/null || echo 0)
DURATION_SECS=$((END_EPOCH - START_EPOCH))

# Count completed issues
ISSUES_COMPLETED=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM issues WHERE state = 'done' AND updated_at >= '$START_TIME';" 2>/dev/null || echo 0)

# Measure backend latency (mock for now; would be enhanced with actual measurements)
BACKEND_LATENCY_MS=50

# Build summary JSON
SUMMARY_JSON=$(cat << EOF | jq -c '.'
{
  "heartbeat_number": $HB_NUM,
  "started_at": "$START_TIME",
  "completed_at": "$END_TIME",
  "duration_seconds": $DURATION_SECS,
  "issues_processed": $ISSUES_PROCESSED,
  "issues_completed": $ISSUES_COMPLETED,
  "backend_latency_ms": $BACKEND_LATENCY_MS,
  "subagent_count": $SUBAGENT_COUNT,
  "efficiency_score": 0.0
}
EOF
)

# Insert into heartbeat_summaries
sqlite3 "$DB_PATH" << EOF
INSERT INTO heartbeat_summaries (
    cycle_number,
    started_at,
    completed_at,
    duration_seconds,
    issues_processed,
    issues_completed,
    backend_latency_ms,
    subagent_count,
    summary_json
) VALUES (
    $HB_NUM,
    '$START_TIME',
    '$END_TIME',
    $DURATION_SECS,
    $ISSUES_PROCESSED,
    $ISSUES_COMPLETED,
    $BACKEND_LATENCY_MS,
    $SUBAGENT_COUNT,
    '$SUMMARY_JSON'
) ON CONFLICT(cycle_number) DO UPDATE SET
    completed_at = '$END_TIME',
    duration_seconds = $DURATION_SECS,
    issues_completed = $ISSUES_COMPLETED,
    summary_json = '$SUMMARY_JSON';
EOF

# Log completion
echo "✓ Recorded heartbeat #$HB_NUM metrics: ${DURATION_SECS}s, $ISSUES_PROCESSED issues, $SUBAGENT_COUNT subagents" >&2

# Return summary JSON
echo "$SUMMARY_JSON"
