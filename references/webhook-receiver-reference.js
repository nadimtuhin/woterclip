/**
 * WoterClip Webhook Receiver Reference Implementation
 * 
 * Phase 1 reference for HTTP listener + queue infrastructure (WOT-13)
 * 
 * Features:
 * - Receives webhook events from GitHub and Linear
 * - Validates HMAC signatures for both platforms
 * - Deduplicates events via in-memory cache with TTL
 * - Routes validated events to trigger /heartbeat CLI
 * - Structured logging (JSON) for observability
 * 
 * Production Requirements (Phase 2):
 * - Persistent queue (Redis, RabbitMQ, or SQS)
 * - Request ID tracing across platform
 * - Graceful error handling and retries
 * - Health check endpoint
 * - Metrics instrumentation (Prometheus)
 * 
 * Usage:
 *   npm install express crypto dotenv
 *   RECEIVER_TOKEN=secret \
 *   GITHUB_WEBHOOK_SECRET=gh-secret \
 *   LINEAR_WEBHOOK_SECRET=lin-secret \
 *   CLAUDE_CLI_PATH=/path/to/claude \
 *   PORT=3000 \
 *   node webhook-receiver-reference.js
 */

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { execSync } = require('child_process');
const { makeWebhookQueue } = require('./webhook-db');
require('dotenv').config();

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  port: process.env.PORT || 3000,
  receiverToken: process.env.RECEIVER_TOKEN || 'dev-token',
  githubSecret: process.env.GITHUB_WEBHOOK_SECRET || '',
  linearSecret: process.env.LINEAR_WEBHOOK_SECRET || '',
  claudeCliPath: process.env.CLAUDE_CLI_PATH || 'claude',
  targetRepo: process.env.TARGET_REPO || '/Users/nadimtuhin/opensource/woterclip',
  logLevel: process.env.LOG_LEVEL || 'info',
  // SQLite DB path for durable webhook_queue persistence. Defaults to the
  // target repo's WoterClip database.
  dbPath:
    process.env.WOTERCLIP_DB ||
    path.join(
      process.env.TARGET_REPO || '/Users/nadimtuhin/opensource/woterclip',
      '.woterclip',
      'woterclip.db'
    ),
};

// Durable webhook queue (SQLite). Source of truth for dedup + event status;
// the in-memory SimpleEventCache below is a hot-path optimization layered on top.
const webhookQueue = makeWebhookQueue(CONFIG.dbPath);

// ============================================================================
// Event Deduplication Layer (In-Memory Cache)
// ============================================================================

/**
 * SimpleEventCache: Prevents duplicate event processing via time-window deduplication
 * 
 * Design:
 * - Key: platform:event_id (e.g., github:12345, linear:WOT-13)
 * - Value: { timestamp, source, issue_identifier, status: 'queued|processing|done' }
 * - TTL: 5 minutes (webhook provider retries usually within 60s)
 * - On dedup: return cached status instead of requeuing
 * 
 * Phase 2 Upgrade Path:
 * - Replace with Redis cache for distributed deduplication
 * - Add persistent queue (RabbitMQ, SQS) for fault tolerance
 * - Implement exactly-once semantics via idempotency keys
 */
class SimpleEventCache {
  constructor(ttlMs = 5 * 60 * 1000) {
    this.cache = new Map();
    this.ttlMs = ttlMs;
  }

  generateKey(platform, eventId) {
    return `${platform}:${eventId}`;
  }

  has(platform, eventId) {
    const key = this.generateKey(platform, eventId);
    if (!this.cache.has(key)) return false;
    
    const entry = this.cache.get(key);
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  get(platform, eventId) {
    const key = this.generateKey(platform, eventId);
    const entry = this.cache.get(key);
    if (entry && Date.now() - entry.timestamp <= this.ttlMs) {
      return entry;
    }
    this.cache.delete(key);
    return null;
  }

  set(platform, eventId, data) {
    const key = this.generateKey(platform, eventId);
    this.cache.set(key, {
      ...data,
      timestamp: Date.now(),
    });
  }

  // Cleanup: remove expired entries periodically
  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now - entry.timestamp > this.ttlMs) {
        this.cache.delete(key);
      }
    }
  }

  stats() {
    return {
      cacheSize: this.cache.size,
      ttlMs: this.ttlMs,
    };
  }
}

// ============================================================================
// Signature Validation
// ============================================================================

/**
 * validateGitHubSignature
 * 
 * GitHub sends X-Hub-Signature-256: sha256=<hex>
 * We verify: HMAC-SHA256(payload, secret) matches the header value
 * 
 * Security notes:
 * - Use crypto.timingSafeEqual to prevent timing attacks
 * - Reject on any signature mismatch
 * - Log verification failure for audit
 */
function validateGitHubSignature(payload, signature, secret) {
  if (!secret) {
    log('warn', 'GitHub webhook secret not configured', {});
    return false;
  }

  const digest = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
  } catch (err) {
    return false;
  }
}

/**
 * validateLinearSignature
 * 
 * Linear sends X-Linear-Signature: v1,<hex>
 * Linear also sends X-Linear-Signature-Timestamp
 * 
 * Verification:
 * 1. Extract timestamp from header
 * 2. Construct message: timestamp + '.' + raw_payload
 * 3. Compute HMAC-SHA256(message, secret)
 * 4. Compare with header signature
 * 
 * Security notes:
 * - Timestamp prevents replay attacks (validate within ±5 minutes)
 * - Version prefix allows algorithm upgrade (v2, etc.)
 */
function validateLinearSignature(payload, signature, timestamp, secret) {
  if (!secret) {
    log('warn', 'Linear webhook secret not configured', {});
    return false;
  }

  // Validate timestamp to prevent replay attacks
  const signedAt = parseInt(timestamp, 10);
  const now = Date.now();
  const maxAgeMs = 5 * 60 * 1000; // 5 minutes
  
  if (now - signedAt > maxAgeMs) {
    log('warn', 'Webhook signature timestamp too old', { age_ms: now - signedAt });
    return false;
  }

  // Construct message as per Linear spec
  const message = `${timestamp}.${payload}`;
  const digest = 'v1,' + crypto
    .createHmac('sha256', secret)
    .update(message)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature.replace('v1,', '')));
  } catch (err) {
    return false;
  }
}

// ============================================================================
// Event Routers (GitHub & Linear specific)
// ============================================================================

/**
 * routeGitHubEvent
 * 
 * Extracts issue metadata from GitHub webhook and converts to routing command
 * 
 * Supported actions: opened, edited, closed, labeled, unlabeled
 * Returns: { action, issueNumber, title, labels, state }
 */
function routeGitHubEvent(payload) {
  const action = payload.action; // opened, edited, closed, labeled, etc.
  const issue = payload.issue || {};
  const labels = (issue.labels || []).map(l => l.name);
  const state = issue.state; // open, closed

  return {
    action,
    issueNumber: issue.number,
    title: issue.title,
    labels,
    state,
    source: 'github',
  };
}

/**
 * routeLinearEvent
 * 
 * Extracts issue metadata from Linear webhook and converts to routing command
 * 
 * Supported actions: create, update, archive
 * Returns: { action, issueId, title, labels, state }
 */
function routeLinearEvent(payload) {
  const action = payload.action; // create, update, archive
  const data = payload.data || {};
  const labels = (data.labels || []).map(l => l.name);
  const state = data.state ? data.state.name : 'unknown';

  return {
    action,
    issueId: data.id, // e.g., WOT-13
    title: data.title,
    labels,
    state,
    source: 'linear',
  };
}

// ============================================================================
// Trigger /heartbeat via Claude CLI
// ============================================================================

/**
 * triggerHeartbeat
 * 
 * Invokes Claude CLI with /heartbeat command in the target repo
 * 
 * Command format:
 *   claude --cwd <target-repo> /heartbeat --source github --issue-number 13
 *   claude --cwd <target-repo> /heartbeat --source linear --issue-id WOT-13
 * 
 * Phase 2: Replace with API call when Claude Code API is stable
 * 
 * Error handling:
 * - Capture stdout/stderr for logging
 * - Do NOT block receiver (fire-and-forget async in production)
 * - Log exit code for observability
 */
function triggerHeartbeat(source, issueIdentifier, metadata) {
  try {
    const args = [
      '--cwd', CONFIG.targetRepo,
      '/heartbeat',
      '--source', source,
      source === 'github' ? '--issue-number' : '--issue-id',
      issueIdentifier,
    ];

    log('info', 'Triggering heartbeat', {
      command: `${CONFIG.claudeCliPath} ${args.join(' ')}`,
      source,
      issueIdentifier,
      metadata,
    });

    // In Phase 1: synchronous (simple reference)
    // In Phase 2: spawn async subprocess, don't wait
    const result = execSync(`${CONFIG.claudeCliPath} ${args.join(' ')}`, {
      cwd: CONFIG.targetRepo,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    log('info', 'Heartbeat triggered successfully', {
      source,
      issueIdentifier,
      output_preview: result.substring(0, 200),
    });

    return { success: true, output: result };
  } catch (err) {
    log('error', 'Failed to trigger heartbeat', {
      source,
      issueIdentifier,
      error: err.message,
      exitCode: err.status,
    });

    // Phase 2: retry with exponential backoff
    return { success: false, error: err.message };
  }
}

// ============================================================================
// Logging (JSON for structured parsing)
// ============================================================================

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLogLevel = LOG_LEVELS[CONFIG.logLevel] || 1;

function log(level, message, data = {}) {
  if (LOG_LEVELS[level] < currentLogLevel) return;

  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    level,
    message,
    ...data,
  };

  console.log(JSON.stringify(logEntry));
}

// ============================================================================
// Express Setup & Routes
// ============================================================================

const app = express();
const eventCache = new SimpleEventCache(5 * 60 * 1000); // 5 min TTL

// JSON body parser (with raw variant for signature validation)
app.use(express.raw({ type: 'application/json' }));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    cache_stats: eventCache.stats(),
  });
});

// GitHub webhook endpoint
app.post('/webhooks/github', (req, res) => {
  const timestamp = new Date().toISOString();
  const rawPayload = req.body; // Buffer from express.raw()
  const payloadStr = rawPayload.toString('utf-8');
  const signature = req.headers['x-hub-signature-256'];
  const deliveryId = req.headers['x-github-delivery'];

  log('info', 'GitHub webhook received', {
    deliveryId,
    contentLength: rawPayload.length,
  });

  // Validate signature
  if (!validateGitHubSignature(payloadStr, signature, CONFIG.githubSecret)) {
    log('warn', 'GitHub webhook signature validation failed', { deliveryId });
    return res.status(401).json({ error: 'Invalid signature' });
  }

  try {
    const payload = JSON.parse(payloadStr);
    const event = routeGitHubEvent(payload);
    const cacheKey = event.issueNumber.toString();
    // Durable, per-delivery event id (GitHub guarantees X-GitHub-Delivery unique).
    const eventId = `github:${deliveryId}`;
    const eventType = `issues.${event.action}`;

    // Durable dedup: a delivery we've already persisted is a true retry.
    if (deliveryId && webhookQueue.eventExists(eventId)) {
      log('info', 'GitHub webhook deduplicated (db)', { deliveryId, eventId });
      return res.json({ status: 'duplicate', cached: true, eventId });
    }

    // Hot-path dedup: collapse rapid repeat events for the same issue (TTL window).
    if (eventCache.has('github', cacheKey)) {
      const cached = eventCache.get('github', cacheKey);
      log('info', 'GitHub webhook deduplicated', {
        deliveryId,
        issueNumber: event.issueNumber,
        cached_status: cached.status,
      });
      return res.json({ status: cached.status, cached: true });
    }

    // Persist to webhook_queue (status: pending) before triggering.
    if (deliveryId) webhookQueue.enqueue(eventId, 'github', eventType);

    // Mark as queued before triggering (prevent re-trigger within TTL)
    eventCache.set('github', cacheKey, {
      source: 'github',
      issue_identifier: event.issueNumber,
      status: 'queued',
    });

    // Mark triggered, then invoke heartbeat (fire-and-forget in Phase 1).
    if (deliveryId) webhookQueue.markTriggered(eventId);
    const result = triggerHeartbeat('github', event.issueNumber, event);

    // Reflect final status in the durable queue.
    if (deliveryId) {
      if (result.success) webhookQueue.markCompleted(eventId);
      else webhookQueue.markFailed(eventId, result.error || 'heartbeat trigger failed');
    }

    // Update cache status
    eventCache.set('github', cacheKey, {
      source: 'github',
      issue_identifier: event.issueNumber,
      status: result.success ? 'processing' : 'failed',
    });

    res.status(result.success ? 202 : 500).json({
      status: result.success ? 'processing' : 'error',
      deliveryId,
      eventId,
      issueNumber: event.issueNumber,
      ...(result.error && { error: result.error }),
    });
  } catch (err) {
    log('error', 'Failed to process GitHub webhook', {
      deliveryId,
      error: err.message,
    });
    res.status(400).json({ error: 'Failed to process webhook' });
  }
});

// Linear webhook endpoint
app.post('/webhooks/linear', (req, res) => {
  const timestamp = new Date().toISOString();
  const rawPayload = req.body; // Buffer from express.raw()
  const payloadStr = rawPayload.toString('utf-8');
  const signature = req.headers['x-linear-signature'];
  const signatureTimestamp = req.headers['x-linear-signature-timestamp'];

  log('info', 'Linear webhook received', {
    timestamp,
    contentLength: rawPayload.length,
  });

  // Validate signature
  if (!validateLinearSignature(payloadStr, signature, signatureTimestamp, CONFIG.linearSecret)) {
    log('warn', 'Linear webhook signature validation failed', { timestamp });
    return res.status(401).json({ error: 'Invalid signature' });
  }

  try {
    const payload = JSON.parse(payloadStr);
    const event = routeLinearEvent(payload);
    const cacheKey = event.issueId; // e.g., WOT-13
    // Linear has no per-delivery id header; derive a stable id from the signed
    // timestamp + issue so genuine retries (same signature) dedup in the DB.
    const eventId = `linear:${event.issueId}:${signatureTimestamp}`;
    const eventType = `Issue.${event.action}`;

    // Durable dedup: an event id we've already persisted is a true retry.
    if (signatureTimestamp && webhookQueue.eventExists(eventId)) {
      log('info', 'Linear webhook deduplicated (db)', { eventId });
      return res.json({ status: 'duplicate', cached: true, eventId });
    }

    // Hot-path dedup: collapse rapid repeat events for the same issue (TTL window).
    if (eventCache.has('linear', cacheKey)) {
      const cached = eventCache.get('linear', cacheKey);
      log('info', 'Linear webhook deduplicated', {
        issueId: event.issueId,
        cached_status: cached.status,
      });
      return res.json({ status: cached.status, cached: true });
    }

    // Persist to webhook_queue (status: pending) before triggering.
    if (signatureTimestamp) webhookQueue.enqueue(eventId, 'linear', eventType);

    // Mark as queued before triggering
    eventCache.set('linear', cacheKey, {
      source: 'linear',
      issue_identifier: event.issueId,
      status: 'queued',
    });

    // Mark triggered, then invoke heartbeat.
    if (signatureTimestamp) webhookQueue.markTriggered(eventId);
    const result = triggerHeartbeat('linear', event.issueId, event);

    // Reflect final status in the durable queue.
    if (signatureTimestamp) {
      if (result.success) webhookQueue.markCompleted(eventId);
      else webhookQueue.markFailed(eventId, result.error || 'heartbeat trigger failed');
    }

    // Update cache status
    eventCache.set('linear', cacheKey, {
      source: 'linear',
      issue_identifier: event.issueId,
      status: result.success ? 'processing' : 'failed',
    });

    res.status(result.success ? 202 : 500).json({
      status: result.success ? 'processing' : 'error',
      issueId: event.issueId,
      eventId,
      ...(result.error && { error: result.error }),
    });
  } catch (err) {
    log('error', 'Failed to process Linear webhook', {
      error: err.message,
    });
    res.status(400).json({ error: 'Failed to process webhook' });
  }
});

// Periodic cache cleanup
setInterval(() => {
  eventCache.cleanup();
  log('debug', 'Event cache cleanup', eventCache.stats());
}, 60000); // Every minute

// ============================================================================
// Server
// ============================================================================

app.listen(CONFIG.port, () => {
  log('info', 'WoterClip webhook receiver listening', {
    port: CONFIG.port,
    targetRepo: CONFIG.targetRepo,
    endpoints: ['/health', '/webhooks/github', '/webhooks/linear'],
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  log('info', 'Received SIGTERM, shutting down gracefully', {});
  process.exit(0);
});
