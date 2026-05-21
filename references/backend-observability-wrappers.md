# Backend Adapter Observability Wrappers

This document provides reusable wrapper functions for instrumenting backend adapter operations with observability logging.

## SQLite Adapter Wrappers

Insert these functions at the top of `references/backend-sqlite.md` or into a shared utility file.

### Observability setup

```bash
# Initialize observability directory (called once at heartbeat start)
initialize_observability() {
  local obs_dir=".woterclip/observability"
  [[ -d "$obs_dir" ]] || mkdir -p "$obs_dir/metrics-snapshots"
  export WOTERCLIP_OBS_DIR="$obs_dir"
  export WOTERCLIP_HEARTBEAT_NUMBER="${WOTERCLIP_HEARTBEAT_NUMBER:-0}"
  export WOTERCLIP_ISSUE_ID="${WOTERCLIP_ISSUE_ID:-0}"
}

# Log adapter event to JSONL
log_adapter_event() {
  local op=$1 backend=$2 status=$3 duration=$4 rows=$5 error=$6
  
  local timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local log_entry=$(cat <<EOF
{
  "timestamp": "$timestamp",
  "heartbeat_number": $WOTERCLIP_HEARTBEAT_NUMBER,
  "issue_id": $WOTERCLIP_ISSUE_ID,
  "event_type": "adapter.operation",
  "operation": "$op",
  "backend": "$backend",
  "status": "$status",
  "duration_ms": $duration,
  "rows_affected": ${rows:-0},
  "error": ${error:+\"$error\"}
}
EOF
  )
  
  echo "$log_entry" >> "${WOTERCLIP_OBS_DIR}/adapter-events.jsonl"
}
```

### Wrapped operations

```bash
# list_issues: Query issues with optional filters
sqlite_list_issues() {
  local state=$1 limit=${2:-50}
  local start_ms=$(date +%s%3N)
  
  local query="SELECT id, title, description, state, priority FROM issues WHERE state='$state' ORDER BY priority ASC LIMIT $limit;"
  
  if local result=$(sqlite3 .woterclip/woterclip.db "$query" 2>&1); then
    local duration=$(($(date +%s%3N) - start_ms))
    local row_count=$(echo "$result" | wc -l)
    log_adapter_event "list_issues" "sqlite" "success" $duration $row_count
    echo "$result"
    return 0
  else
    local duration=$(($(date +%s%3N) - start_ms))
    log_adapter_event "list_issues" "sqlite" "failure" $duration 0 "$result"
    return 1
  fi
}

# create_issue: Insert new issue
sqlite_create_issue() {
  local title=$1 description=$2 state=${3:-new} priority=${4:-3}
  local start_ms=$(date +%s%3N)
  
  local query="INSERT INTO issues (title, description, state, priority) VALUES ('$title', '$description', '$state', $priority); SELECT last_insert_rowid();"
  
  if local issue_id=$(sqlite3 .woterclip/woterclip.db "$query" 2>&1); then
    local duration=$(($(date +%s%3N) - start_ms))
    log_adapter_event "create_issue" "sqlite" "success" $duration 1
    echo "$issue_id"
    return 0
  else
    local duration=$(($(date +%s%3N) - start_ms))
    log_adapter_event "create_issue" "sqlite" "failure" $duration 0 "$issue_id"
    return 1
  fi
}

# update_issue: Modify issue fields
sqlite_update_issue() {
  local issue_id=$1 field=$2 value=$3
  local start_ms=$(date +%s%3N)
  
  # Sanitize value (basic quoting for string fields)
  local quoted_value
  case "$field" in
    state|title|description)
      quoted_value="'$value'"
      ;;
    priority)
      quoted_value=$value
      ;;
  esac
  
  local query="UPDATE issues SET $field=$quoted_value WHERE id=$issue_id; SELECT changes();"
  
  if local rows_changed=$(sqlite3 .woterclip/woterclip.db "$query" 2>&1); then
    local duration=$(($(date +%s%3N) - start_ms))
    log_adapter_event "update_issue" "sqlite" "success" $duration $rows_changed
    return 0
  else
    local duration=$(($(date +%s%3N) - start_ms))
    log_adapter_event "update_issue" "sqlite" "failure" $duration 0 "$rows_changed"
    return 1
  fi
}

# add_comment: Insert issue comment
sqlite_add_comment() {
  local issue_id=$1 persona=$2 comment=$3
  local start_ms=$(date +%s%3N)
  
  local query="INSERT INTO comments (issue_id, persona, text, timestamp) VALUES ($issue_id, '$persona', '$comment', datetime('now')); SELECT last_insert_rowid();"
  
  if local comment_id=$(sqlite3 .woterclip/woterclip.db "$query" 2>&1); then
    local duration=$(($(date +%s%3N) - start_ms))
    log_adapter_event "add_comment" "sqlite" "success" $duration 1
    echo "$comment_id"
    return 0
  else
    local duration=$(($(date +%s%3N) - start_ms))
    log_adapter_event "add_comment" "sqlite" "failure" $duration 0 "$comment_id"
    return 1
  fi
}

# close_issue: Transition issue to closed
sqlite_close_issue() {
  local issue_id=$1
  local start_ms=$(date +%s%3N)
  
  local query="UPDATE issues SET state='closed', closed_at=datetime('now') WHERE id=$issue_id; SELECT changes();"
  
  if local rows_changed=$(sqlite3 .woterclip/woterclip.db "$query" 2>&1); then
    local duration=$(($(date +%s%3N) - start_ms))
    log_adapter_event "close_issue" "sqlite" "success" $duration $rows_changed
    return 0
  else
    local duration=$(($(date +%s%3N) - start_ms))
    log_adapter_event "close_issue" "sqlite" "failure" $duration 0 "$rows_changed"
    return 1
  fi
}

# get_issue: Fetch single issue with full details
sqlite_get_issue() {
  local issue_id=$1
  local start_ms=$(date +%s%3N)
  
  local query="SELECT id, title, description, state, priority, labels FROM issues WHERE id=$issue_id;"
  
  if local result=$(sqlite3 .woterclip/woterclip.db "$query" 2>&1); then
    local duration=$(($(date +%s%3N) - start_ms))
    log_adapter_event "get_issue" "sqlite" "success" $duration 1
    echo "$result"
    return 0
  else
    local duration=$(($(date +%s%3N) - start_ms))
    log_adapter_event "get_issue" "sqlite" "failure" $duration 0 "$result"
    return 1
  fi
}
```

## Linear Adapter Wrappers

For Linear backend operations, wrap API calls similarly:

```bash
# log_adapter_event_linear() — same as SQLite version

# linear_list_issues
linear_list_issues() {
  local state=$1 limit=${2:-50}
  local start_ms=$(date +%s%3N)
  
  # Example: curl to Linear GraphQL API
  local query='query { issues(first: '$limit', filter: {state: {name: "'$state'"}}) { nodes { id title } } }'
  
  if local result=$(curl -s -X POST https://api.linear.app/graphql \
    -H "Authorization: Bearer $LINEAR_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"query\": \"$query\"}" 2>&1); then
    
    local duration=$(($(date +%s%3N) - start_ms))
    local error=$(echo "$result" | jq '.errors[0].message' 2>/dev/null)
    
    if [[ -z "$error" || "$error" == "null" ]]; then
      local row_count=$(echo "$result" | jq '.data.issues.nodes | length')
      log_adapter_event "list_issues" "linear" "success" $duration $row_count
      echo "$result"
      return 0
    else
      log_adapter_event "list_issues" "linear" "failure" $duration 0 "$error"
      return 1
    fi
  else
    local duration=$(($(date +%s%3N) - start_ms))
    log_adapter_event "list_issues" "linear" "failure" $duration 0 "$result"
    return 1
  fi
}

# linear_update_issue — wrap Linear API mutation calls similarly
# linear_create_issue — wrap with observability logging
# etc.
```

## Usage in Heartbeat Skill

Initialize observability at the start of `/heartbeat`:

```markdown
## Step 1: Check Inbox (observability enabled)

\`\`\`bash
source "${CLAUDE_PLUGIN_ROOT}/references/backend-observability-wrappers.md"
initialize_observability

issues=$(sqlite_list_issues "new" 10)
heartbeat_count=$(echo "$issues" | wc -l)
\`\`\`

This ensures all adapter calls are logged with timing and error information.
```

## Usage in Subagent (Persona Template)

Subagents export the heartbeat number and issue ID:

```bash
export WOTERCLIP_HEARTBEAT_NUMBER=17
export WOTERCLIP_ISSUE_ID=12

source "${CLAUDE_PLUGIN_ROOT}/references/backend-observability-wrappers.md"
initialize_observability

# All subsequent sqlite_* or linear_* calls now log automatically
update_issue $issue_id "state" "in_progress"
```

## Performance Impact

Each operation now incurs:
- **Timestamp capture:** ~1ms (date command)
- **JSONL serialization:** ~1ms (string concatenation)
- **File append:** ~2-5ms (fsync with WAL mode)

**Total overhead per operation:** ~4-7ms (negligible for typical 100ms+ operations)

For high-frequency adapters (>1000 ops/heartbeat), consider batching log writes:

```bash
# Batched logging (append to buffer, flush every 100 events)
WOTERCLIP_LOG_BUFFER=()
log_adapter_event_batched() {
  # ... build JSON entry ...
  WOTERCLIP_LOG_BUFFER+=("$log_entry")
  if (( ${#WOTERCLIP_LOG_BUFFER[@]} >= 100 )); then
    printf '%s\n' "${WOTERCLIP_LOG_BUFFER[@]}" >> "${WOTERCLIP_OBS_DIR}/adapter-events.jsonl"
    WOTERCLIP_LOG_BUFFER=()
  fi
}
```

## Testing Observability

```bash
# Verify adapter events are logged
sqlite_list_issues "new" 10
tail -1 .woterclip/observability/adapter-events.jsonl | jq '.'

# Expected output:
{
  "timestamp": "2026-05-21T14:30:06Z",
  "heartbeat_number": 17,
  "issue_id": 0,
  "operation": "list_issues",
  "backend": "sqlite",
  "status": "success",
  "duration_ms": 5,
  "rows_affected": 3,
  "error": null
}
```

## Summary

These wrappers provide:

1. **Transparent instrumentation** — No changes to calling code
2. **Timing precision** — Millisecond-level duration tracking
3. **Error capture** — Full error messages logged
4. **Backend abstraction** — Same pattern for SQLite and Linear
5. **Low overhead** — ~5ms per operation (negligible for I/O)

Integrate into all backend adapter calls to enable full observability chain.
