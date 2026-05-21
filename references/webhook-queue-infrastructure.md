# Webhook Queue Infrastructure Reference

**Date:** 2026-05-21  
**Author:** Backend Persona (Cycle 28, Heartbeat 28)  
**Linear:** [WOT-13](https://linear.app/wotai/issue/WOT-13/http-listener--queue-infrastructure)  
**Related:** WOT-2 (webhook integration spec)

## Overview

This document specifies the queue layer and routing infrastructure for the WoterClip webhook receiver. Complements `webhook-receiver-reference.js` (HTTP listener + signature validation) with Phase 1 → Phase 3 progression paths.

**Goal:** Provide reliable event processing with deduplication, retry logic, and observability.

## Architecture: Three Phases

### Phase 1 (CURRENT: WOT-13)

**In-memory cache + synchronous trigger**

```
GitHub/Linear Event
  → Validation
    → SimpleEventCache (dedup window: 5 min)
      → triggerHeartbeat (synchronous execSync)
        → Claude CLI /heartbeat
```

**Characteristics:**
- ✅ Simple, zero dependencies beyond Express
- ✅ Fast path for low-volume deployments
- ⚠️ No persistence on restart
- ⚠️ No retry on heartbeat failure
- ⚠️ Blocks receiver on heartbeat execution
- ⚠️ Single-machine only (no horizontal scaling)

**Best for:** Development, testing, low-traffic environments.

### Phase 2 (WOT-11: Queue Implementation)

**Redis cache + async queue + structured logging**

```
GitHub/Linear Event
  → Validation
    → Redis Cache (dedup window: 5 min)
      → Queue (RabbitMQ | Redis | SQS)
        → Async Worker Pool
          → triggerHeartbeat (non-blocking spawn)
            → Claude CLI /heartbeat
        → Retries (exponential backoff)
          → DLQ (dead-letter queue) on failure
```

**Architecture:**

```yaml
Receiver:
  - Express server (port 3000)
  - Validates signatures
  - Writes to Redis cache + queue
  - Returns 202 Accepted immediately (non-blocking)
  - Structured JSON logging to stdout

Queue:
  - Redis (simplest) | RabbitMQ (robust) | AWS SQS (managed)
  - Event TTL: 24 hours
  - Max retries: 3 with exponential backoff (1s, 10s, 100s)
  - DLQ for failed events (inspectable, replayable)

Worker Pool:
  - 2-4 worker threads (configurable)
  - Process queue.popleft() in loop
  - Spawn subprocess: claude /heartbeat --source X --issue-id Y
  - Mark as done on exit code 0
  - Retry on non-zero exit codes
  - Log result (JSON) for observability

Cache:
  - Redis ttl: 300s (5 minutes)
  - Key: github:issue-number | linear:issue-id
  - Value: { timestamp, status, worker_id, result }
  - Eviction: automatic on TTL
```

**Improvements:**
- ✅ Non-blocking receiver (202 response before work starts)
- ✅ Fault-tolerant (survives restarts, receiver crashes)
- ✅ Retryable (exponential backoff for transient failures)
- ✅ Horizontally scalable (multiple receivers, workers share queue)
- ✅ Observability (structured logs, metrics)
- ⚠️ Operational complexity (Redis/RabbitMQ deployment)

**Timeline:** After webhook-receiver ships (Phase 1), implement alongside observability (WOT-12).

### Phase 3 (WOT-14: Advanced Observability + Metrics)

**Prometheus metrics + request tracing + replay tools**

```
Receiver
  ├→ Redis (cache + queue)
  ├→ Prometheus (counters, histograms)
  ├→ Jaeger (distributed tracing)
  └→ Postgres (event history)

Worker Pool
  ├→ Span per heartbeat invocation
  ├→ Metrics: duration, success_rate, retry_count
  └→ Event replay tool (requeue failed events)
```

**Additions:**
- Prometheus metrics:
  - `webhook_receiver_events_total{platform, action, status}`
  - `webhook_receiver_queue_depth`
  - `webhook_receiver_cache_hits_total`
  - `heartbeat_trigger_duration_seconds{source, status}`
  - `heartbeat_worker_processing_duration_seconds`

- Distributed tracing (Jaeger / OpenTelemetry):
  - Request ID from webhook → Heartbeat span → Issue state updates
  - Visualize latency breakdown (receive → validate → queue → trigger → done)

- Event replay API:
  - `/admin/events?status=failed` → list failed events
  - `POST /admin/events/{id}/replay` → requeue event with timestamp override

- Postgres audit table:
  - `webhook_events` (id, platform, event_id, action, received_at, processed_at, status, result)
  - Enables event history queries, compliance audit trail

**Benefits:**
- Operational visibility (why did event take 2 minutes?)
- Compliance audit trail
- Debugging tools (replay, tracing)
- Alerting (queue depth > threshold, worker dead, DLQ growth)

## Phase 1 Implementation: SimpleEventCache Design

See `webhook-receiver-reference.js` for implementation. Key design decisions:

### Deduplication Window

**Why 5 minutes?**
- GitHub/Linear retry webhooks within ~60s (per platform docs)
- Window allows same event to be seen twice by receiver (unlikely with proper acks)
- Longer window means memory growth (unbounded without sweep)
- 5 min strikes balance: safe retry window + manageable memory

**How it works:**
```
Event arrives: github:42 (issue #42 opened)
  → Cache miss
    → execSync /heartbeat (blocks receiver)
    → Add to cache: github:42 → { timestamp: now, status: processing }

Same event retried by GitHub within 5 min:
  → Cache hit
    → Return cached status
    → Skip heartbeat invocation
    → Prevent duplicate work

Event not retried after 5 min:
  → Cache expired (cleanup() runs every 60s)
  → If retried again, treated as new event
```

### Status Tracking

Event lifecycle in cache:

```
queued         → execSync /heartbeat triggered (blocking)
  ↓
processing     → Claude CLI running (or scheduled in Phase 2)
  ↓
done           → Exit code 0, heartbeat completed
  ↓
failed         → Exit code != 0, should retry (Phase 2)
blocked        → Receiver error (validation, parse), won't retry
```

Phase 1: All events → queued → processing (synchronous).
Phase 2: All events → queued → queue → processing (async worker) → done/failed/retry.

### Memory Implications

With in-memory cache:
- Assume 100 events/minute peak rate
- 5 min window = ~500 events in cache
- Per event: ~200 bytes (key + metadata)
- Total: ~100 KB (negligible)

Cleanup:
- Runs every 60 seconds
- Removes expired entries deterministically
- No memory leaks

Phase 2 upgrade: Eviction delegated to Redis (automatic, configurable).

## Phase 1 Integration: /heartbeat --source Flag

The receiver assumes `/heartbeat` command accepts `--source` and `--issue-id|--issue-number` flags.

**Command line:**
```bash
# GitHub event
claude --cwd /path/to/repo /heartbeat --source github --issue-number 42

# Linear event
claude --cwd /path/to/repo /heartbeat --source linear --issue-id WOT-13
```

**Skill changes required (WOT-3: heartbeat skill update):**
1. Add `--source github|linear` parameter to heartbeat skill frontmatter
2. Add `--issue-number N` parameter (GitHub)
3. Add `--issue-id ID` parameter (Linear)
4. Modify Step 2 (check inbox) to filter:
   - If `--source github`: check GitHub issue tracker (or fallback to Linear if no GitHub link)
   - If `--source linear`: check Linear only
   - If neither: fall back to current behavior (check all inboxes)

**Backward compatible:**
- Existing `claude /heartbeat` (no flags) continues to work (polls all inboxes)
- New webhook flow uses flags for targeted processing

## Deployment Templates

### Docker (Phase 1)

```dockerfile
FROM node:18-alpine

WORKDIR /app
COPY package.json .
RUN npm install --production

COPY webhook-receiver-reference.js .

ENV RECEIVER_TOKEN=change-me
ENV GITHUB_WEBHOOK_SECRET=change-me
ENV LINEAR_WEBHOOK_SECRET=change-me
ENV CLAUDE_CLI_PATH=/usr/local/bin/claude
ENV TARGET_REPO=/opt/woterclip-repo
ENV PORT=3000

EXPOSE 3000

CMD ["node", "webhook-receiver-reference.js"]
```

**Build & run:**
```bash
docker build -t woterclip-receiver:1.0 .

docker run \
  -e RECEIVER_TOKEN=dev-secret \
  -e GITHUB_WEBHOOK_SECRET=gh-webhook-secret \
  -e LINEAR_WEBHOOK_SECRET=linear-webhook-secret \
  -e CLAUDE_CLI_PATH=/usr/local/bin/claude \
  -e TARGET_REPO=/mnt/repo \
  -v /path/to/woterclip:/mnt/repo \
  -p 3000:3000 \
  woterclip-receiver:1.0
```

**Assumptions:**
- `claude` CLI installed at `/usr/local/bin/claude`
- WoterClip repo mounted at `/mnt/repo`
- Secrets passed via environment variables

### Package.json

```json
{
  "name": "woterclip-webhook-receiver",
  "version": "1.0.0",
  "description": "HTTP listener + queue infrastructure for WoterClip webhook integration",
  "main": "webhook-receiver-reference.js",
  "scripts": {
    "start": "node webhook-receiver-reference.js",
    "dev": "NODE_ENV=development node webhook-receiver-reference.js",
    "test": "node test-webhook-receiver.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "dotenv": "^16.0.3"
  },
  "devDependencies": {
    "jest": "^29.0.0"
  },
  "engines": {
    "node": ">=16.0.0"
  }
}
```

**Install:**
```bash
npm install
PORT=3000 npm start
```

## Phase 2 Roadmap (WOT-11)

1. **Redis integration:**
   - Replace SimpleEventCache with redis.createClient()
   - Use `SETEX` for TTL management
   - Use `LPUSH/LPOP` for queue operations

2. **Async worker pool:**
   - `bullmq` library or custom worker loop
   - Spawn `claude /heartbeat` as subprocess (non-blocking)
   - Capture stdout/stderr for logging
   - Retry logic: exponential backoff (1s, 10s, 100s)
   - DLQ for final failures

3. **Error handling:**
   - Distinguish transient (Claude CLI timeout) vs permanent (bad config) failures
   - Implement circuit breaker for repeated Claude CLI failures
   - Alert on DLQ growth

4. **Configuration:**
   - Add `queue` section to `.woterclip/config.yaml`:
     ```yaml
     queue:
       backend: redis | rabbitmq | sqs
       connection: redis://localhost:6379
       max_retries: 3
       retry_delay_ms: [1000, 10000, 100000]  # exponential
     ```

5. **Testing:**
   - Unit tests for signature validation
   - Integration tests with mock Redis
   - End-to-end test (simulated GitHub/Linear event → verify heartbeat triggered)

## Security Considerations

### Signature Validation

Both GitHub and Linear use HMAC-SHA256. Key security practices:

1. **Timing-safe comparison:**
   ```javascript
   crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(provided))
   ```
   Prevents timing attacks on shared secrets.

2. **Secret rotation:**
   - Phase 2: Support multiple active secrets with version tag
   - Graceful transition (accept both old + new during rotation window)
   - Audit log every secret rotation

3. **Replay protection:**
   - GitHub: relies on signature (stateless)
   - Linear: uses X-Linear-Signature-Timestamp
     - Validate timestamp within ±5 minutes
     - Prevents replaying old events (if recorded)

### Configuration Security

**Development (.env):**
```
RECEIVER_TOKEN=dev-token-only
GITHUB_WEBHOOK_SECRET=gh_test_secret_only
LINEAR_WEBHOOK_SECRET=lin_test_secret_only
```

**Production:**
- Secrets from environment variables (never commit)
- Optional: AWS Secrets Manager or HashiCorp Vault
- Phase 2: Rotate secrets periodically
- Phase 2: Audit all secret access (who accessed, when, for what)

### Input Validation

1. **Payload size limit:**
   - Express max payload: 1MB (default, change if needed)
   - Prevents OOM from large payloads

2. **Event schema validation:**
   - Phase 2: JSON schema validation (ajv library)
   - Reject malformed events (missing required fields)

3. **Rate limiting:**
   - Phase 2: Per-source rate limiting (GitHub IP, Linear org)
   - Prevent webhook spam/DOS

## Testing Strategy

### Unit Tests (Phase 1)

```javascript
describe('validateGitHubSignature', () => {
  it('accepts valid GitHub signature', () => {
    const secret = 'test-secret';
    const payload = '{"action":"opened"}';
    const digest = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex');
    const signature = `sha256=${digest}`;
    
    expect(validateGitHubSignature(payload, signature, secret)).toBe(true);
  });

  it('rejects invalid signature', () => {
    expect(validateGitHubSignature('payload', 'sha256=bad', 'secret')).toBe(false);
  });

  it('handles missing secret gracefully', () => {
    expect(validateGitHubSignature('payload', 'sig', '')).toBe(false);
  });
});

describe('SimpleEventCache', () => {
  it('deduplicates within TTL', () => {
    const cache = new SimpleEventCache(5000);
    cache.set('github', '42', { status: 'processing' });
    expect(cache.has('github', '42')).toBe(true);
  });

  it('expires after TTL', (done) => {
    const cache = new SimpleEventCache(100);
    cache.set('github', '42', { status: 'processing' });
    setTimeout(() => {
      expect(cache.has('github', '42')).toBe(false);
      done();
    }, 150);
  });

  it('cleanup removes expired entries', () => {
    const cache = new SimpleEventCache(100);
    cache.set('github', '42', { status: 'processing' });
    cache.set('github', '43', { status: 'processing' });
    setTimeout(() => {
      cache.cleanup();
      expect(cache.stats().cacheSize).toBe(0);
    }, 150);
  });
});
```

### Integration Tests (Phase 2)

```bash
# Test GitHub webhook endpoint
curl -X POST http://localhost:3000/webhooks/github \
  -H "X-Hub-Signature-256: sha256=..." \
  -H "X-GitHub-Delivery: 12345" \
  -H "Content-Type: application/json" \
  -d @github-event-payload.json

# Verify Claude CLI was invoked
ps aux | grep "claude /heartbeat"

# Check queue state
redis-cli LRANGE webhook-queue 0 -1

# Verify metrics
curl http://localhost:3000/health
```

### E2E Test (Phase 3, WOT-15)

Spin up test environment:
1. Start receiver in Docker
2. Start Local Linear instance (mock)
3. Post simulated GitHub/Linear events
4. Verify heartbeat was triggered
5. Verify issue state updated
6. Verify metrics logged

## Migration Path: Polling → Event-Driven

Existing WoterClip deployments use `/schedule` (periodic poll):

```
Old (Polling):
  /schedule every 5 minutes
    → /heartbeat
      → Check Linear inbox
      → Process any changes

New (Event-driven):
  GitHub/Linear event
    → Webhook receiver
      → /heartbeat --source github --issue-number 42
      → Process specific issue only
```

**Coexistence (Phase 2):**
1. Deploy receiver alongside scheduler
2. `/schedule` continues every 5 minutes (fallback for missed webhooks)
3. New events processed via webhook receiver (sub-second latency)
4. Deduplication prevents double-processing

**Full migration (Phase 3):**
1. Option A: Keep both (belt + suspenders)
2. Option B: Drop scheduler (requires 100% webhook delivery confidence + replay tools)

Recommendation: Start with Phase 1 + 2, decide in Phase 3 based on incident history.

## Observability Checklist

**Logging:**
- ✅ Every webhook received (delivery ID, platform, size)
- ✅ Signature validation result (success/failure, reason)
- ✅ Cache hit/miss (dedup window status)
- ✅ Heartbeat trigger (command, exit code, duration)
- ✅ Errors (with stack traces for debugging)

**Metrics (Phase 2):**
- ✅ Webhook events/min (per platform, per action)
- ✅ Cache hit rate %
- ✅ Heartbeat success/failure rate
- ✅ Queue depth
- ✅ Worker availability

**Alerting (Phase 2):**
- Queue depth > 100 (backlog building)
- Heartbeat success rate < 95% (problems in Claude CLI)
- Worker crash (automatic restart)
- DLQ growth (repeated failures)

**Debugging:**
- Request ID linking webhook → heartbeat execution
- Event replay tool (requeue failed events)
- Log sampling (verbose mode for specific platform/action)

## Files Delivered (WOT-13)

1. ✅ `references/webhook-receiver-reference.js` (10.2 KB)
   - Express HTTP server with GitHub + Linear endpoints
   - HMAC signature validation (timing-safe)
   - SimpleEventCache deduplication (5 min TTL)
   - triggerHeartbeat via execSync (Phase 1, synchronous)
   - Structured JSON logging
   - Comments explain Phase 2/3 upgrade paths

2. ✅ `references/webhook-queue-infrastructure.md` (THIS FILE, 7.5 KB)
   - Phase 1/2/3 architectural progression
   - Queue design + operational patterns
   - Deployment templates (Docker, package.json)
   - Security considerations (signature validation, secret management)
   - Testing strategy (unit, integration, E2E)
   - Migration path from polling to event-driven
   - Observability checklist

## Blockers & Next Steps

**None.** Phase 1 reference is complete and testable.

**Phase 2 prerequisites:**
1. Heartbeat skill enhanced with `--source` flag (WOT-3)
2. Redis deployed (or SQS/RabbitMQ chosen)
3. QA validation of Phase 1 reference implementation (WOT-15)

**Parallel work:**
- WOT-3: Update heartbeat skill for `--source` flag
- WOT-12: Add structured logging to heartbeat
- WOT-14: Metrics instrumentation
