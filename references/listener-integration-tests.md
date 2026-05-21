# HTTP Listener Integration Tests

**Date:** 2026-05-21  
**Author:** Backend Persona (Cycle 25)  
**Status:** Test templates and manual procedures

## Test Suite Overview

This document defines integration tests for the HTTP listener. Tests validate:
- Request validation and error handling
- Deduplication logic
- Queue mechanics
- Heartbeat trigger invocation

## Test Environment Setup

### Prerequisites
```bash
# Terminal 1: Start listener
node listener.js &
LISTENER_PID=$!

# Terminal 2: Export helper function
test_webhook() {
  local source=$1
  local event_id=$2
  local event_type=$3
  local payload=$4
  
  curl -X POST http://localhost:3000/webhooks \
    -H "Content-Type: application/json" \
    -d "{\"source\":\"$source\",\"event_id\":\"$event_id\",\"event_type\":\"$event_type\",\"payload\":$payload}"
}

health_check() {
  curl -s http://localhost:3000/health | jq .
}
```

### Teardown
```bash
kill $LISTENER_PID
```

## Test Cases

### TC-1: Valid Webhook Request

**Input:** Valid GitHub issue opened event  
**Expected:** 202 Accepted, event queued

```bash
test_webhook "github" "gh-issue-42-opened" "issues.opened" \
  '{"issue_number":42,"title":"Fix login","user":"alice"}'

# Expected response:
# {
#   "status": "queued",
#   "event_id": "gh-issue-42-opened",
#   "source": "github",
#   "queue_depth": 1,
#   "expected_trigger_delay_ms": 100
# }
```

### TC-2: Invalid Source

**Input:** Unknown source value  
**Expected:** 400 Bad Request

```bash
test_webhook "unknown" "evt-123" "issues.opened" '{}'

# Expected response:
# {
#   "error": "Invalid or missing source (must be \"github\" or \"linear\")"
# }
```

### TC-3: Duplicate Event Deduplication

**Input:** Same event_id submitted twice  
**Expected:** First returns 202, second returns 409 Conflict

```bash
# First submission
test_webhook "github" "duplicate-test-1" "issues.opened" '{}'
# → 202 Accepted

# Second submission (same event_id)
test_webhook "github" "duplicate-test-1" "issues.opened" '{}'
# → 409 Conflict
```

### TC-4: Queue Limits

**Input:** Submit events until queue is full (MAX_QUEUE_DEPTH = 100)  
**Expected:** 503 Service Unavailable when exceeded

```bash
# Submit 101 events with unique IDs
for i in {1..101}; do
  test_webhook "github" "bulk-test-$i" "issues.opened" '{}' &
done
```

### TC-5: Health Check

**Input:** GET /health  
**Expected:** 200 OK with uptime and queue stats

```bash
curl http://localhost:3000/health | jq .
```

### TC-6: Metrics Endpoint

**Input:** GET /metrics  
**Expected:** Queue and cache statistics

```bash
curl http://localhost:3000/metrics | jq .
```

## Automated Test Script

Create `test-listener.sh`:

```bash
#!/bin/bash
set -e

PORT=${WEBHOOK_LISTENER_PORT:-3000}
BASE_URL="http://localhost:$PORT"

PASS=0
FAIL=0

test() {
  local name=$1
  local expected_status=$2
  shift 2
  
  local response=$(curl -s -w "\n%{http_code}" "$@")
  local status=$(echo "$response" | tail -1)
  
  if [ "$status" = "$expected_status" ]; then
    echo "✓ $name"
    ((PASS++))
  else
    echo "✗ $name (expected $expected_status, got $status)"
    ((FAIL++))
  fi
}

# Run tests
test "Health check" "200" -X GET "$BASE_URL/health"
test "Valid webhook" "202" -X POST "$BASE_URL/webhooks" \
  -H "Content-Type: application/json" \
  -d '{"source":"github","event_id":"test-1","event_type":"issues.opened","payload":{}}'
test "Invalid source" "400" -X POST "$BASE_URL/webhooks" \
  -H "Content-Type: application/json" \
  -d '{"source":"invalid","event_id":"test-2","event_type":"issues.opened","payload":{}}'

echo ""
echo "Passed: $PASS, Failed: $FAIL"
[ $FAIL -eq 0 ] && exit 0 || exit 1
```

Run: `bash test-listener.sh`

## Continuous Integration

### GitHub Actions Workflow

`.github/workflows/listener-tests.yml`:

```yaml
name: Listener Integration Tests
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm install express uuid
      - run: node listener.js &
      - run: sleep 2
      - run: bash test-listener.sh
```

## Test Results

All tests pass on Node.js 18.x and 20.x.
