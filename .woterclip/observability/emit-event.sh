#!/bin/bash
# emit-event.sh — Emit observability events to JSONL logs
# Usage: emit-event.sh <event-type> <heartbeat-number> [metadata-json]
# Example: emit-event.sh heartbeat.start 22 '{"backend":"sqlite","config_version":2}'

set -euo pipefail

EVENT_TYPE="${1:?Event type required}"
HEARTBEAT_NUM="${2:?Heartbeat number required}"
METADATA="${3:-{}}"
OBSDIR="${OBSDIR:-.woterclip/observability}"

# Determine log file based on event type
if [[ "$EVENT_TYPE" == heartbeat.* ]]; then
    LOGFILE="$OBSDIR/heartbeat-events.jsonl"
elif [[ "$EVENT_TYPE" == persona.* ]]; then
    LOGFILE="$OBSDIR/persona-events.jsonl"
elif [[ "$EVENT_TYPE" == adapter.* ]]; then
    LOGFILE="$OBSDIR/adapter-events.jsonl"
else
    LOGFILE="$OBSDIR/heartbeat-events.jsonl"  # default
fi

# Ensure directory exists
mkdir -p "$OBSDIR"

# Generate ISO8601 timestamp
TIMESTAMP=$(date -u +'%Y-%m-%dT%H:%M:%SZ')

# Emit event as JSONL
cat >> "$LOGFILE" << EOF
{"timestamp":"$TIMESTAMP","event_type":"$EVENT_TYPE","heartbeat_number":$HEARTBEAT_NUM,"metadata":$METADATA}
EOF

echo "✓ Emitted $EVENT_TYPE to $LOGFILE" >&2
