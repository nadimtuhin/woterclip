# Webhook Handler Skill

**Date:** 2026-05-21  
**Cycle:** 41  
**Linear:** WOT-2 (Implement webhook integrations for GitHub and Linear)  
**Related:** WOT-15, WOT-22, WOT-23

## Overview

This skill provides a complete webhook integration handler for WoterClip. It enables event-driven heartbeat triggers from GitHub and Linear webhooks, replacing polling-based scheduling with real-time issue processing.

## What This Skill Does

The webhook handler implements three core responsibilities:

1. **Webhook Receiver Setup** – Deploy and configure an HTTP endpoint that accepts events from GitHub and Linear
2. **Signature Validation** – Verify HMAC-SHA256 signatures to ensure webhooks come from trusted sources
3. **Queue Management** – Store webhook events in the SQLite database for reliable, ordered processing with deduplication

## How to Use

### Phase 1: Deploy Webhook Receiver

Set up a standalone webhook receiver service (Node.js/Express):

```bash
# 1. Copy the reference implementation
cp references/webhook-receiver-reference.js /path/to/receiver/app.js
cp references/webhook-queue-infrastructure.md /path/to/receiver/README.md

# 2. Install dependencies
cd /path/to/receiver
npm install express crypto dotenv

# 3. Configure environment
export RECEIVER_TOKEN="your-secret-token"
export GITHUB_WEBHOOK_SECRET="your-github-secret"
export LINEAR_WEBHOOK_SECRET="your-linear-secret"
export CLAUDE_CLI_PATH="/usr/local/bin/claude"
export TARGET_REPO="/path/to/woterclip-repo"
export PORT=3000

# 4. Start receiver
npm start
# Server listens on http://localhost:3000
# Endpoints: /health, /webhooks/github, /webhooks/linear
```

### Phase 2: Configure GitHub Webhooks

In your GitHub repository settings:

1. Go to **Settings → Webhooks**
2. Add webhook:
   - **Payload URL:** `https://your-receiver-domain/webhooks/github`
   - **Content type:** `application/json`
   - **Secret:** (use `GITHUB_WEBHOOK_SECRET`)
   - **Events:** Select:
     - Issues
     - Issue comment
   - **Active:** ✓ Checked

3. GitHub will send events to your receiver endpoint

**Supported GitHub Events:**
- `issues.opened` – New issue created
- `issues.edited` – Issue title/description updated
- `issues.closed` – Issue resolved
- `issues.labeled` – Label added (triggers persona routing)
- `issues.unlabeled` – Label removed
- `issue_comment.created` – Comment added to issue

### Phase 3: Configure Linear Webhooks

In your Linear workspace settings:

1. Go to **Settings → Integrations → Webhooks**
2. Add webhook:
   - **URL:** `https://your-receiver-domain/webhooks/linear`
   - **Secret:** (use `LINEAR_WEBHOOK_SECRET`)
   - **Events:** Select:
     - Issue created
     - Issue updated
     - Issue archived
   - **Status:** Active

3. Linear will send events to your receiver endpoint

**Supported Linear Events:**
- `Issue.created` – New issue created
- `Issue.updated` – Issue state/assignee/labels changed
- `Issue.archived` – Issue marked done/archived

### Phase 4: Test Webhook Connectivity

**Health Check:**
```bash
curl -s http://localhost:3000/health | jq .
# Expected response:
# {
#   "status": "ok",
#   "cache_stats": {
#     "cacheSize": 0,
#     "ttlMs": 300000
#   }
# }
```

**Send Test GitHub Event:**
```bash
# 1. Compute signature
SECRET="your-github-secret"
PAYLOAD='{"action":"opened","issue":{"number":42,"title":"Test","state":"open","labels":[{"name":"backend"}]}}'
SIGNATURE="sha256=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" -hex | cut -d' ' -f2)"

# 2. POST to receiver
curl -X POST http://localhost:3000/webhooks/github \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: $SIGNATURE" \
  -H "X-GitHub-Delivery: test-delivery-123" \
  -d "$PAYLOAD"

# Expected response (202 Accepted or 200 OK)
```

**Send Test Linear Event:**
```bash
# 1. Compute signature (with timestamp)
SECRET="your-linear-secret"
TIMESTAMP=$(date +%s)
PAYLOAD='{"action":"create","data":{"id":"WOT-42","title":"Test","state":{"name":"In Progress"},"labels":[{"name":"backend"}]}}'
MESSAGE="$TIMESTAMP.$PAYLOAD"
SIGNATURE="v1,$(echo -n "$MESSAGE" | openssl dgst -sha256 -hmac "$SECRET" -hex | cut -d' ' -f2)"

# 2. POST to receiver
curl -X POST http://localhost:3000/webhooks/linear \
  -H "Content-Type: application/json" \
  -H "X-Linear-Signature: $SIGNATURE" \
  -H "X-Linear-Signature-Timestamp: $TIMESTAMP" \
  -d "$PAYLOAD"

# Expected response (202 Accepted or 200 OK)
```

## Architecture

### Three-Phase Progression

**Phase 1 (Current – WOT-2):**
- Simple HTTP receiver with in-memory deduplication
- Synchronous heartbeat trigger via `execSync`
- No external queue (suitable for low-volume, development)

```
GitHub/Linear → Webhook Receiver → SimpleEventCache → execSync /heartbeat
```

**Phase 2 (WOT-11):**
- Redis/RabbitMQ queue for persistent event storage
- Async worker pool for non-blocking heartbeat invocation
- Exponential backoff retry logic
- Dead-letter queue for failed events

```
GitHub/Linear → Receiver → Redis Cache + Queue → Worker Pool → /heartbeat
                                                  (retries, DLQ)
```

**Phase 3 (WOT-14):**
- Prometheus metrics (event counts, latencies)
- Distributed request tracing (Jaeger/OpenTelemetry)
- Event history audit table (Postgres/SQLite)
- Event replay API for recovery

```
GitHub/Linear → Receiver → Queue → Workers → Heartbeat
                  ↓         ↓         ↓
                Metrics   Logging   Tracing → Prometheus + Jaeger
```

### Event Flow

```
1. Webhook arrives at receiver
   ↓
2. Parse headers (signature, timestamp, delivery ID)
   ↓
3. Validate HMAC signature (GitHub/Linear specific)
   ↓
4. Extract issue metadata (ID, labels, state)
   ↓
5. Check deduplication cache (5-minute TTL)
   - If cached: return cached status
   - If new: continue to step 6
   ↓
6. Insert into webhook_queue table (status: pending)
   ↓
7. Trigger /heartbeat --source {github|linear} --issue-{number|id}
   - Phase 1: synchronous (blocks receiver)
   - Phase 2: async spawn (non-blocking)
   ↓
8. Update webhook_queue status (triggered/completed/failed)
   ↓
9. Return response (202 Accepted or 200 OK)
```

## Database Integration

### webhook_queue Table

The SQLite database stores webhook events for debugging and observability:

```sql
CREATE TABLE webhook_queue (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id      TEXT NOT NULL UNIQUE,    -- GitHub delivery ID or Linear request ID
    source        TEXT NOT NULL,           -- 'github' or 'linear'
    event_type    TEXT,                    -- 'issue.opened', 'Issue.updated', etc.
    status        TEXT NOT NULL DEFAULT 'pending',  -- pending|triggered|completed|failed
    queued_at     TEXT NOT NULL DEFAULT (datetime('now')),
    triggered_at  TEXT,                    -- When /heartbeat was invoked
    completed_at  TEXT,                    -- When /heartbeat finished
    error_message TEXT,                    -- Failure reason (if any)
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### Adapter Operations

**Insert webhook event:**
```bash
sqlite3 .woterclip/woterclip.db "
INSERT INTO webhook_queue (event_id, source, event_type, status)
VALUES ('github:delivery:123', 'github', 'issues.opened', 'pending');
"
```

**Query pending events:**
```bash
sqlite3 .woterclip/woterclip.db "
SELECT id, event_id, source, event_type, queued_at
FROM webhook_queue
WHERE status = 'pending'
ORDER BY queued_at ASC
LIMIT 10;
"
```

**Update event status:**
```bash
sqlite3 .woterclip/woterclip.db "
UPDATE webhook_queue
SET status = 'triggered', triggered_at = datetime('now')
WHERE event_id = 'github:delivery:123';
"
```

**Mark event complete:**
```bash
sqlite3 .woterclip/woterclip.db "
UPDATE webhook_queue
SET status = 'completed', completed_at = datetime('now')
WHERE event_id = 'github:delivery:123';
"
```

**Mark event failed:**
```bash
sqlite3 .woterclip/woterclip.db "
UPDATE webhook_queue
SET status = 'failed', error_message = 'Heartbeat timed out'
WHERE event_id = 'github:delivery:123';
"
```

## Security Considerations

### Signature Validation

Both GitHub and Linear use HMAC-SHA256 for webhook authentication. Always validate signatures before processing events.

**GitHub Validation:**
```javascript
const signature = req.headers['x-hub-signature-256'];      // "sha256=<hex>"
const payload = req.rawBody;                              // Raw request body
const secret = process.env.GITHUB_WEBHOOK_SECRET;
const expected = 'sha256=' + crypto
  .createHmac('sha256', secret)
  .update(payload)
  .digest('hex');
if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
  return res.status(401).send('Unauthorized');
}
```

**Linear Validation:**
```javascript
const signature = req.headers['x-linear-signature'];      // "v1,<hex>"
const timestamp = req.headers['x-linear-signature-timestamp'];
const payload = req.rawBody;
const secret = process.env.LINEAR_WEBHOOK_SECRET;
const message = `${timestamp}.${payload}`;
const expected = 'v1,' + crypto
  .createHmac('sha256', secret)
  .update(message)
  .digest('hex');
// Also validate timestamp is recent (within ±5 minutes)
if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
  return res.status(401).send('Unauthorized');
}
```

### Secret Management

**Development (.env file, NOT committed):**
```
RECEIVER_TOKEN=dev-secret-only
GITHUB_WEBHOOK_SECRET=gh_test_secret
LINEAR_WEBHOOK_SECRET=lin_test_secret
CLAUDE_CLI_PATH=/usr/local/bin/claude
TARGET_REPO=/path/to/woterclip
```

**Production:**
- Store secrets in environment variables (CI/CD secrets, AWS Secrets Manager, HashiCorp Vault)
- Never commit secrets to version control
- Rotate secrets periodically (Phase 2)
- Audit all secret access (Phase 3)

### Rate Limiting

In Phase 2, implement rate limiting to prevent webhook spam:

```javascript
// Per-source rate limiting: max 100 events/minute per source
const rateLimit = require('express-rate-limit');
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,           // 1 minute
  max: 100,                      // Max 100 events per minute
  keyGenerator: (req) => req.headers['x-github-delivery'] || req.headers['x-linear-signature'],
  message: 'Too many webhook events, please try again later',
});
app.post('/webhooks/github', webhookLimiter, (req, res) => { ... });
app.post('/webhooks/linear', webhookLimiter, (req, res) => { ... });
```

## Troubleshooting

### Webhook Not Triggering Heartbeat

1. **Verify signature validation:**
   - Check that `GITHUB_WEBHOOK_SECRET` and `LINEAR_WEBHOOK_SECRET` match your platform webhook settings
   - Test with `/health` endpoint to confirm receiver is running
   - Check receiver logs for signature validation failures

2. **Verify heartbeat trigger:**
   - Ensure `CLAUDE_CLI_PATH` points to valid `claude` CLI binary
   - Test manually: `claude --cwd /path/to/repo /heartbeat --source github --issue-number 42`
   - Check Claude Code plugin installation: `claude --list-plugins`

3. **Check queue status:**
   ```bash
   sqlite3 .woterclip/woterclip.db "SELECT * FROM webhook_queue WHERE status = 'failed';"
   ```

### Duplicate Events

Events are deduplicated via 5-minute TTL in-memory cache. If receiver crashes and restarts:

- Events arriving after restart may be reprocessed (no persistence in Phase 1)
- Phase 2 adds Redis cache for distributed deduplication
- Heartbeat is idempotent (processes only if issue state changed)

### Performance Degradation

If receiver becomes slow:

1. Check in-memory cache size:
   ```bash
   curl http://localhost:3000/health | jq .cache_stats
   ```
   
2. If cache_size grows unbounded:
   - Increase cleanup frequency (currently every 60s)
   - Phase 2: Switch to Redis with automatic eviction

3. Monitor Claude CLI execution time:
   - Receiver logs show `triggerHeartbeat` duration
   - If heartbeat is slow, optimize persona or backend adapter

## Related Issues

- **WOT-15:** Create E2E test suite for webhook integration (test receiver + heartbeat flow)
- **WOT-22:** Add observability/logging to webhook receiver (metrics, request tracing)
- **WOT-23:** Implement webhook event replay API (recovery from failures)

## Files Delivered

1. ✅ `references/webhooks-integration.md` – Architecture and event schema
2. ✅ `references/webhook-receiver-reference.js` – Phase 1 reference implementation
3. ✅ `references/webhook-queue-infrastructure.md` – Phase 1/2/3 progression
4. ✅ `references/webhook-config-template.yaml` – Config template for `.woterclip/config.yaml`
5. ✅ `references/test-webhook-receiver.js` – Unit test suite
6. ✅ `references/linear-webhook-test-examples.py` – Python test helpers
7. ✅ `skills/webhook-handler/SKILL.md` – This skill (usage guide + deployment)

## Next Steps

**Immediate (Phase 1 complete):**
- Deploy receiver to development environment
- Configure GitHub and Linear webhooks
- Test end-to-end (webhook → receiver → heartbeat → issue update)

**Phase 2 (WOT-11):**
- Add `--source` flag to `/heartbeat` skill
- Implement Redis queue backend
- Add retry logic and DLQ handling
- Upgrade to async heartbeat invocation

**Phase 3 (WOT-14):**
- Metrics instrumentation (Prometheus)
- Distributed request tracing (Jaeger)
- Event history audit table
- Event replay API
