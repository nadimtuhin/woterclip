# HTTP Listener + Queue Infrastructure

## Overview

This document specifies the HTTP listener and webhook queue infrastructure for WoterClip. The listener is the entry point for webhook events from GitHub and Linear, providing deduplication, routing, and safe async processing.

## Architecture

### Component Diagram

```
[GitHub Webhook] ---\
                     |-- [HTTP Listener] -- [Dedup Queue] -- [Router] -- [/heartbeat trigger]
[Linear Webhook] ---/
```

### Key Responsibilities

1. **HTTP Listener** — Receive webhook POST requests on a configured port
2. **Request Validation** — Verify Content-Type (application/json) and payload structure
3. **Deduplication Queue** — Prevent duplicate processing via event ID caching (Redis or in-memory)
4. **Router** — Route events by source (GitHub/Linear) to appropriate trigger mechanism
5. **Async Invocation** — Trigger `/heartbeat --source {source} --event-id {id}` safely

## HTTP Listener Specification

### Server Configuration

- **Port:** Configurable via environment variable `WEBHOOK_LISTENER_PORT` (default: 3000)
- **Host:** `0.0.0.0` (listen on all interfaces for deployment flexibility)
- **Framework:** Minimal (Node.js Express, Python Flask, or async Bash + netcat for MVP)
- **Graceful Shutdown:** Exit handlers to flush pending queue items
- **Health Check:** `GET /health` → `{"status": "ok", "uptime_ms": N}` (no logging)

### Endpoint: POST /webhooks

**Request:**
```json
{
  "source": "github" | "linear",
  "event_id": "uuid-or-timestamp",
  "event_type": "issues.opened" | "issues.updated" | etc.,
  "payload": { /* source-specific payload */ }
}
```

**Response:**
- `202 Accepted` — Event queued for processing
- `400 Bad Request` — Invalid source, missing event_id, or malformed payload
- `409 Conflict` — Duplicate event_id (already processed); returns `{"deduplicated": true}`
- `500 Internal Server Error` — Listener failure (queue full, trigger call failed)

### Request Validation

1. **Content-Type:** Require `application/json`
2. **Source:** Validate `source` is `github` or `linear`
3. **Event ID:** Validate `event_id` is non-empty UUID/string
4. **Payload:** Require `payload` field (can be empty object `{}`)
5. **Max Size:** 10 MB (limit oversized payloads)

### Response Examples

**Success (202):**
```json
{
  "status": "queued",
  "event_id": "12345-abcd",
  "queue_depth": 3,
  "expected_trigger_delay_ms": 150
}
```

**Duplicate (409):**
```json
{
  "status": "deduplicated",
  "event_id": "12345-abcd",
  "first_seen_at": "2026-05-21T10:00:00Z"
}
```

## Deduplication Queue

### Design

The queue prevents processing the same webhook event twice. Common causes of duplicates:
- GitHub/Linear webhook retries (transient failures)
- Network retransmission (duplicate ACKs)
- Manual webhook replay (testing)

### Implementation Options

#### Option A: In-Memory Cache (MVP)

- **Storage:** JavaScript Set or Python dict in application memory
- **TTL:** 24 hours (configurable `DEDUP_CACHE_TTL_HOURS`, default: 24)
- **Limitations:**
  - Loss on server restart
  - Single-server only (no distributed state)
  - Memory growth over time (24h × event rate)
  
**For WoterClip:** Acceptable for MVP (typical rate: 1–10 events/hour, ~240 slots/day)

#### Option B: Redis (Production)

- **Storage:** Redis SET with expiration
- **Operations:**
  - `SET event_id WITH NX EX {ttl}` — Atomic check-and-set
  - Returns success (new event) or failure (duplicate)
- **Advantages:** Distributed, persistent, no memory leaks
- **Disadvantages:** Extra dependency, requires Redis server

**Recommendation:** Implement Option A for MVP (Phase 1), support Option B config for Phase 2.

### Cache Entry Format

```yaml
cache_entry:
  event_id: "gh-12345-67890"  # source-prefixed to allow cross-source IDs
  received_at: "2026-05-21T10:00:00Z"
  source: "github"
  event_type: "issues.opened"
  repository: "user/repo"  # GitHub only
  team_id: "team-abc123"   # Linear only
```

### Cache Eviction

- **TTL:** 24 hours from first receipt
- **Manual purge:** `DELETE /admin/dedup-cache` (optional, for testing)
- **Metrics:** Expose cache hit rate via `GET /metrics`

## Event Router

### Routing Logic

```python
def route_event(event):
    if event.source == "github":
        trigger_heartbeat("github", event.event_id, event.payload)
    elif event.source == "linear":
        trigger_heartbeat("linear", event.event_id, event.payload)
    else:
        log_error(f"Unknown source: {event.source}")
        return 400
    return 202
```

### Trigger Mechanism

**Option A: Subprocess (MVP)**
```bash
claude --plugin-dir /path/to/woterclip /heartbeat --source github --event-id gh-12345
```

**Option B: Claude Code API (Future)**
```python
# When Claude Code API stabilizes, call directly
api.run_skill(
    plugin="woterclip",
    skill="heartbeat",
    args={"source": "github", "event_id": "gh-12345"}
)
```

**Recommendation:** Option A for MVP. Spawns new Claude process, fully isolated. Async execution via subprocess.Popen (non-blocking).

### Queue Model

The queue is conceptually a to-do list of events awaiting trigger:

```yaml
queue:
  - { event_id: "gh-123", source: "github", status: "pending", queued_at: "2026-05-21T10:00:00Z", triggered_at: null }
  - { event_id: "lin-456", source: "linear", status: "triggered", queued_at: "2026-05-21T09:55:00Z", triggered_at: "2026-05-21T10:00:05Z" }
  - { event_id: "gh-789", source: "github", status: "failed", queued_at: "2026-05-21T09:45:00Z", error: "Subprocess call failed: exit code 1" }
```

**Fields:**
- `status`: pending | triggered | failed
- `triggered_at`: Timestamp of trigger call
- `error`: Human-readable error message (if failed)

**Retention:** Keep failed events for 48 hours (for debugging), purge successful events after 24 hours.

## Configuration Extension

Extend `.woterclip/config.yaml` to include listener settings:

```yaml
webhook_listener:
  enabled: true
  port: ${WEBHOOK_LISTENER_PORT:-3000}
  host: "0.0.0.0"
  tls:
    enabled: false
    cert_path: null  # Future: HTTPS support
    key_path: null
  dedup_cache:
    ttl_hours: 24
    backend: "memory"  # "memory" or "redis"
    redis_url: ${REDIS_URL:-null}
  max_queue_depth: 100
  request_timeout_ms: 5000
  metrics_enabled: true
```

## Example Implementation: Node.js/Express

```javascript
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');

const app = express();
app.use(express.json({ limit: '10mb' }));

// In-memory dedup cache
const dedupCache = new Map();
const DEDUP_TTL = 24 * 60 * 60 * 1000; // 24 hours

// Queue (for monitoring)
const queue = [];

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime_ms: process.uptime() * 1000, queue_depth: queue.length });
});

// Main webhook endpoint
app.post('/webhooks', async (req, res) => {
  const { source, event_id, event_type, payload } = req.body;

  // Validation
  if (!source || !['github', 'linear'].includes(source)) {
    return res.status(400).json({ error: 'Invalid or missing source' });
  }
  if (!event_id || typeof event_id !== 'string') {
    return res.status(400).json({ error: 'Invalid or missing event_id' });
  }
  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'Invalid or missing payload' });
  }

  // Deduplication check
  if (dedupCache.has(event_id)) {
    return res.status(409).json({
      status: 'deduplicated',
      event_id,
      first_seen_at: dedupCache.get(event_id).received_at
    });
  }

  // Mark as seen
  dedupCache.set(event_id, {
    received_at: new Date().toISOString(),
    source,
    event_type
  });

  // Clean up old cache entries (lazy TTL)
  if (Math.random() < 0.1) { // 10% of requests
    const now = Date.now();
    for (const [id, entry] of dedupCache.entries()) {
      if (now - new Date(entry.received_at).getTime() > DEDUP_TTL) {
        dedupCache.delete(id);
      }
    }
  }

  // Enqueue and trigger async
  const queueEntry = {
    event_id,
    source,
    status: 'pending',
    queued_at: new Date().toISOString()
  };
  queue.push(queueEntry);

  res.status(202).json({
    status: 'queued',
    event_id,
    queue_depth: queue.length,
    expected_trigger_delay_ms: 100
  });

  // Async trigger (non-blocking)
  setImmediate(() => {
    triggerHeartbeat(source, event_id, queueEntry);
  });
});

// Trigger /heartbeat via subprocess
function triggerHeartbeat(source, event_id, queueEntry) {
  const args = ['--plugin-dir', '/path/to/woterclip', '/heartbeat', '--source', source, '--event-id', event_id];
  const proc = spawn('claude', args, { detached: true, stdio: 'ignore' });

  queueEntry.status = 'triggered';
  queueEntry.triggered_at = new Date().toISOString();

  proc.on('error', (err) => {
    queueEntry.status = 'failed';
    queueEntry.error = err.message;
    console.error(`[${event_id}] Trigger failed: ${err.message}`);
  });

  proc.unref(); // Allow parent to exit
}

// Metrics endpoint (optional, for monitoring)
app.get('/metrics', (req, res) => {
  const pendingCount = queue.filter(e => e.status === 'pending').length;
  const triggeredCount = queue.filter(e => e.status === 'triggered').length;
  const failedCount = queue.filter(e => e.status === 'failed').length;

  res.json({
    queue_depth: queue.length,
    pending: pendingCount,
    triggered: triggeredCount,
    failed: failedCount,
    dedup_cache_size: dedupCache.size
  });
});

// Admin endpoints (for testing/debugging)
app.delete('/admin/dedup-cache', (req, res) => {
  const oldSize = dedupCache.size;
  dedupCache.clear();
  res.json({ status: 'cleared', old_size: oldSize });
});

app.delete('/admin/queue', (req, res) => {
  const oldSize = queue.length;
  queue.length = 0;
  res.json({ status: 'cleared', old_size: oldSize });
});

// Start server
const PORT = process.env.WEBHOOK_LISTENER_PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Listener] Listening on port ${PORT}`);
});
```

## Testing Strategy

### Unit Tests

- **Input validation:** Invalid source, missing event_id, oversized payload
- **Deduplication:** First event accepted, duplicate returns 409
- **Cache TTL:** Entries expire after 24 hours

### Integration Tests

1. **End-to-end webhook flow:**
   ```bash
   curl -X POST http://localhost:3000/webhooks \
     -H "Content-Type: application/json" \
     -d '{
       "source": "github",
       "event_id": "gh-test-123",
       "event_type": "issues.opened",
       "payload": { "action": "opened", "issue": { "number": 42 } }
     }'
   # Expected: 202 Accepted, queue_depth: 1
   ```

2. **Duplicate handling:**
   ```bash
   # Send same event_id twice
   # Expected: 202 (first), 409 (second)
   ```

3. **Subprocess trigger:**
   - Mock `/heartbeat` invocation
   - Verify process spawned with correct arguments
   - Capture exit code

## Security Considerations

### Signature Verification

Webhook sources (GitHub, Linear) include HMAC signatures. The listener currently **skips signature verification** (assuming HTTPS + reverse proxy auth). Future implementations:

1. **GitHub:** Verify `X-Hub-Signature-256` header (SHA256)
2. **Linear:** Verify request signature (depends on Linear API version)

See `references/webhooks-integration.md` for signature validation algorithms.

### Rate Limiting

- **Per source:** Max 100 requests/minute from single IP
- **Global:** Max 1000 requests/minute total
- **Queue depth:** Reject if queue > max_queue_depth (default: 100)

Implementation: Token bucket algorithm (simple, no external deps).

### Privilege Model

- **Public:** `/health` (no auth required)
- **Webhook receivers:** Must know the listener port (assume private network or reverse proxy auth)
- **Admin endpoints:** `DELETE /admin/*` require environment variable `ADMIN_SECRET` header (Phase 2)

## Deployment Options

### Option A: Docker (Recommended for Phase 2)

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY listener.js .
RUN npm install express uuid
EXPOSE 3000
CMD ["node", "listener.js"]
```

**Launch:**
```bash
docker run -p 3000:3000 \
  -e WEBHOOK_LISTENER_PORT=3000 \
  -e CLAUDE_PLUGIN_ROOT=/woterclip \
  woterclip-listener
```

### Option B: Systemd Service (For Linux VPS)

```ini
[Unit]
Description=WoterClip Webhook Listener
After=network.target

[Service]
Type=simple
User=woterclip
WorkingDirectory=/opt/woterclip
ExecStart=/usr/bin/node /opt/woterclip/listener.js
Environment="WEBHOOK_LISTENER_PORT=3000"
Environment="CLAUDE_PLUGIN_ROOT=/opt/woterclip"
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

### Option C: Serverless (AWS Lambda, Cloud Run) — Phase 3

- Wrap HTTP listener as Lambda handler
- Use DynamoDB for dedup cache
- Trigger via IAM or API Gateway auth

## Implementation Roadmap

### Phase 1 (Current: WOT-2 cycle 20)

- [x] Spec this document
- [ ] Implement Node.js/Express listener (minimal, 300 lines)
- [ ] In-memory dedup cache
- [ ] Queue model (in-memory list, no persistence)
- [ ] Manual testing against mock events
- [ ] Subprocess-based trigger via `spawn('claude', [...])`

### Phase 2 (WOT-3)

- [ ] Integrate listener config into `/woterclip-init` skill
- [ ] Add `--source` and `--event-id` flags to `/heartbeat`
- [ ] Async queue persistence (SQLite + wal journal)
- [ ] Metrics endpoint for monitoring
- [ ] Rate limiting (token bucket)
- [ ] Docker deployment template
- [ ] End-to-end test (mock GitHub webhook → listener → /heartbeat)

### Phase 3 (WOT-8+)

- [ ] Redis backend for dedup cache
- [ ] Webhook signature verification (GitHub SHA256, Linear)
- [ ] Admin UI (view queue, replay events, clear cache)
- [ ] Event history and replay mechanism
- [ ] Serverless deployment (AWS Lambda, Cloud Run)
- [ ] Load testing (locust or k6) — measure max throughput

## Success Criteria

- [x] Spec complete and documented
- [ ] Phase 1 implementation: Listener receives webhooks, deduplicates, queues, triggers `/heartbeat`
- [ ] Can handle 100+ events/hour without data loss or duplicates
- [ ] Documented API for GitHub/Linear webhook sources
- [ ] Example curl commands for manual testing
- [ ] Graceful error handling and logging

## Open Questions

1. **Webhook source registration:** How do users register webhooks in GitHub/Linear?
   - **Answer (WOT-4):** Out of scope for Phase 1. Document manual webhook setup steps.

2. **Async queue failures:** What happens if trigger subprocess fails?
   - **Answer (Phase 1):** Mark as failed, log error, don't retry. Phase 2: Implement retry logic + dead-letter queue.

3. **Multi-instance deployment:** Can we run multiple listeners safely?
   - **Answer (Phase 2):** Requires distributed dedup cache (Redis). Phase 1 is single-instance.

4. **Claude Code API availability:** When will it be stable?
   - **Answer (Phase 1):** Assume subprocess for now. Switch to API in Phase 2 when available.

## References

- `references/webhooks-integration.md` — Webhook architecture and event schemas
- `references/backend-sqlite.md` — Backend adapter operations
- `docs/specs/2026-03-25-woterclip-design.md` — Overall system design

