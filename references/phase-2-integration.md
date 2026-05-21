# Phase 2 Integration — HTTP Listener + Heartbeat

This document describes Phase 2 of webhook infrastructure: integrating the Phase 1 HTTP listener with WoterClip heartbeat, adding SQLite queue persistence, and configuring `/woterclip-init` to scaffold listener setup.

## Overview

Phase 2 extends WoterClip with:
- **SQLite queue persistence** for webhook events (resilience across restarts)
- **Heartbeat flag support** (`--source`, `--event-id`) for webhook-triggered invocations
- **Init integration** to configure listener in `.woterclip/config.yaml`
- **Rate limiting & metrics** endpoints in listener

## Architecture

```
[GitHub/Linear] 
    ↓
[HTTP Listener] 
    ↓ (dedup in-memory cache + SQLite queue)
[/webhooks POST] 
    ↓
[SQLite webhook_queue table] 
    ↓
[spawn subprocess: claude /heartbeat --source github --event-id gh-12345]
    ↓
[Heartbeat main loop: Steps 1-11]
    ↓
[Update webhook_queue: status='completed' | 'failed']
```

## Database Schema Extension

### New Table: webhook_queue

```sql
CREATE TABLE IF NOT EXISTS webhook_queue (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id         TEXT    NOT NULL UNIQUE,
    source           TEXT    NOT NULL CHECK(source IN ('github', 'linear')),
    event_type       TEXT,
    status           TEXT    NOT NULL DEFAULT 'pending'
                         CHECK(status IN ('pending', 'triggered', 'completed', 'failed')),
    queued_at        TEXT    NOT NULL DEFAULT (datetime('now')),
    triggered_at     TEXT,
    completed_at     TEXT,
    error_message    TEXT,
    created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

**Indexes:**
```sql
CREATE INDEX idx_webhook_queue_status ON webhook_queue(status);
CREATE INDEX idx_webhook_queue_source ON webhook_queue(source);
CREATE INDEX idx_webhook_queue_event_id ON webhook_queue(event_id);
```

## Modified Heartbeat Command (Phase 2)

### New Flags

```bash
/heartbeat [--dry-run] [--persona NAME] [--source SOURCE] [--event-id ID]
```

**Arguments:**
- `--source <github|linear>` — Webhook source (optional)
- `--event-id <UUID>` — Unique event identifier (optional)

### Execution Flow with Webhook Metadata

**If `--source` and `--event-id` provided:**

1. **Pre-heartbeat:** Update SQLite webhook queue
   ```sql
   UPDATE webhook_queue SET status='triggered', triggered_at=NOW() WHERE event_id='EVENT_ID'
   ```
   (Listener already added to queue; this transitions from 'pending' to 'triggered')

2. **Execute heartbeat** (Steps 1-11 as normal)

3. **Post-heartbeat:** Update queue based on outcome
   - If heartbeat succeeded → `UPDATE ... SET status='completed', completed_at=NOW()`
   - If heartbeat failed → `UPDATE ... SET status='failed', completed_at=NOW(), error_message='...'`

**If `--source` or `--event-id` missing:**
- Proceed as normal heartbeat (no queue updates)

## HTTP Listener Phase 2 Enhancements

### Deduplication: Dual-Layer Strategy

**Layer 1: In-Memory Cache** (as Phase 1)
- Fast, sub-millisecond check
- TTL: 24 hours
- Loss on server restart (acceptable for MVP)

**Layer 2: SQLite Queue** (Phase 2, optional fallback)
- Check webhook_queue before enqueuing
- Prevents duplicate processing if listener restarted

**Logic (in listener's POST /webhooks):**

```javascript
// Dedup check (order matters for performance)
1. Check in-memory dedupCache → if found, return 409
2. (Optional) Query SQLite for event_id → if found and not too old, return 409
3. Add to dedupCache AND enqueue to webhook_queue
4. Respond 202 Accepted
5. Async spawn heartbeat
```

### Listener Integration with SQLite

Listener no longer needs to spawn a subprocess with full path. Instead:

```javascript
// In listener, when enqueuing
function enqueueWebhook(event_id, source, event_type) {
  const sql = `
    INSERT INTO webhook_queue(event_id, source, event_type, status)
    VALUES ('${escapeQuote(event_id)}', '${source}', '${escapeQuote(event_type)}', 'pending')
  `;
  
  // Execute via child_process.execSync (simple) or sqlite3 module
  exec(`sqlite3 .woterclip/woterclip.db "${sql}"`, (err) => {
    if (err) {
      // Constraint violation = duplicate, safe to ignore
      if (err.includes('UNIQUE constraint failed')) {
        return;
      }
      console.error('Webhook queue insert failed:', err);
      // Continue anyway; listener will proceed to trigger
    }
  });
}
```

### Response Envelope Changes

Listener response body now includes optional queue info (Phase 2):

```json
{
  "status": "queued",
  "event_id": "gh-12345",
  "source": "github",
  "queue_depth": 3,
  "expected_trigger_delay_ms": 100,
  "queue_id": 42  // SQLite row ID (new, for reference)
}
```

## Config Schema Update

`.woterclip/config.yaml` gains a `webhook_listener` section:

```yaml
webhook_listener:
  enabled: true
  port: ${WEBHOOK_LISTENER_PORT:-3000}
  host: "0.0.0.0"
  
  dedup_cache:
    ttl_hours: 24
    backend: "memory"  # "memory" or "redis" (Phase 3)
    redis_url: ${REDIS_URL:-null}
  
  queue:
    backend: "sqlite"  # "sqlite" or "redis" (Phase 3)
    retention_hours: 48  # How long to keep completed/failed events
  
  max_queue_depth: 100
  request_timeout_ms: 5000
  
  metrics_enabled: true
  
  # Rate limiting (Phase 2)
  rate_limit:
    enabled: true
    per_source_rpm: 100    # Per source IP, per minute
    global_rpm: 1000       # Total requests/minute
```

## `/woterclip-init` Integration

### Step 5a (New): Prompt for Webhook Listener Setup

After project goal prompts, ask:

```
Would you like to set up the webhook listener? (y/n)
> 
```

If **no**, skip to Step 6 (summary).

If **yes**:

```
Configure webhook listener:
  1. Listener port [3000]: 
  2. Webhook retention hours [48]:
  3. Enable rate limiting? (y/n) [y]:
  4. Global rate limit (req/min) [1000]:
```

Write answers to `.woterclip/config.yaml` under `webhook_listener:`.

### Step 5b (New): Print Setup Instructions

After listener config, print:

```
Webhook Listener configured! Next steps:

1. Start the listener:
   npm install express uuid  # (if needed)
   node ${CLAUDE_PLUGIN_ROOT}/references/listener-implementation-node.js

2. Test with curl:
   curl -X POST http://localhost:3000/webhooks \
     -H "Content-Type: application/json" \
     -d '{"source":"github","event_id":"test-1","payload":{}}'

3. Register webhooks in GitHub/Linear:
   - GitHub: Repo Settings → Webhooks → Add webhook
     URL: {listener_url}/webhooks
     Events: Issues, Issue comments
   - Linear: Workspace Settings → Webhooks → Add webhook
     URL: {listener_url}/webhooks
     Events: Issue created, Issue updated

4. Monitor listener:
   curl http://localhost:3000/health
   curl http://localhost:3000/metrics

Docs: ${CLAUDE_PLUGIN_ROOT}/references/http-listener-spec.md
```

## Testing Strategy (Phase 2)

### Unit Tests (in listener code)

- Input validation (as Phase 1)
- SQLite queue insertion (new)
- Dedup cache + queue coordination (new)

### Integration Tests

1. **Webhook → queue → heartbeat → completion:**
   ```bash
   curl -X POST http://localhost:3000/webhooks \
     -d '{"source":"github","event_id":"test-e2e-1","event_type":"issues.opened","payload":{}}'
   
   # Verify queue entry
   sqlite3 .woterclip/woterclip.db "SELECT status FROM webhook_queue WHERE event_id='test-e2e-1'"
   # Expected: 'completed' (after ~5s)
   ```

2. **Rate limiting:**
   ```bash
   for i in {1..101}; do
     curl -X POST http://localhost:3000/webhooks \
       -d '{"source":"github","event_id":"limit-$i","payload":{}}'
   done
   # Request 101 should get 429 Too Many Requests
   ```

3. **Queue cleanup:**
   ```bash
   # After 48 hours, completed events should be purged
   # Run cleanup manually for testing:
   sqlite3 .woterclip/woterclip.db "DELETE FROM webhook_queue WHERE status='completed' AND completed_at < datetime('now', '-48 hours')"
   ```

## Deployment Considerations

### SQLite Database

- Listener and heartbeat both read/write `.woterclip/woterclip.db`
- WAL mode handles concurrent access safely
- Ensure `PRAGMA busy_timeout=5000` is set (prevents lock errors)

### Multiple Listener Instances

Phase 2 is **single-instance only** (SQLite is file-based).

For multi-instance deployment:
- Phase 3: Switch to Redis for dedup cache and queue persistence
- Requires `redis_url` in config and Redis deployment

### Security

- Listener runs on **private network or behind reverse proxy** (no public access by default)
- Webhook signatures not validated in Phase 1 (assumed HTTPS + reverse proxy auth)
- Phase 2: Add signature validation (separate issue)
- Admin endpoints (`DELETE /admin/dedup-cache`, etc.) require `ADMIN_SECRET` header (Phase 2.5)

## Migration Path (v1 → Phase 2)

If a v1 config exists (Linear backend):

1. Run `/woterclip-init` → User chooses backend
2. If SQLite: create webhook_queue table (auto-migrated)
3. If Linear: webhook_listener section optional (listeners run separately from Linear backend)

## Files Modified/Created

### New Files
- `references/phase-2-integration.md` (this file)

### Modified Files
- `references/backend-sqlite.md` — Added webhook_queue schema + operations 12-18
- `commands/heartbeat.md` — Added `--source` and `--event-id` flags
- `templates/config.yaml` — Add `webhook_listener` section
- `skills/init/SKILL.md` — Add Step 5a/5b for listener setup

### No Changes Required
- `references/listener-implementation-node.js` — Phase 1 code still valid; listener enqueues directly
- `references/http-listener-spec.md` — Spec still valid; Phase 2 adds persistence layer below

## Success Criteria

- [x] SQLite schema includes webhook_queue table
- [x] Heartbeat supports `--source` and `--event-id` flags
- [ ] Listener enqueues webhooks to SQLite (Phase 2 impl)
- [ ] Heartbeat updates queue status (Phase 2 impl)
- [ ] `/woterclip-init` prompts for listener config (Phase 2 impl)
- [ ] E2E test: webhook → queue → heartbeat → completion (Phase 2 impl)
- [ ] Cleanup script purges old queue entries (Phase 2 impl)

## Phase 3 Preview

After Phase 2 completes:

1. **Redis backend** for dedup cache and queue (multi-instance support)
2. **Webhook signature validation** (GitHub SHA256, Linear)
3. **Admin UI** (queue monitoring, event replay, cache management)
4. **Serverless deployment** (AWS Lambda, Cloud Run)
5. **Advanced metrics** (event latency, source breakdown, error rates)

