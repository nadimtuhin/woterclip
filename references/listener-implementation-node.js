/**
 * WoterClip HTTP Listener + Queue Infrastructure
 * Node.js/Express Implementation (Phase 1 MVP)
 * 
 * Usage:
 *   npm install express uuid
 *   node listener-implementation-node.js
 * 
 * Configuration via environment variables:
 *   WEBHOOK_LISTENER_PORT=3000 (default)
 *   CLAUDE_PLUGIN_ROOT=/path/to/woterclip
 *   NODE_ENV=production (optional)
 */

const express = require('express');
const { spawn } = require('child_process');
const path = require('path');

// Configuration
const PORT = parseInt(process.env.WEBHOOK_LISTENER_PORT || '3000', 10);
const HOST = '0.0.0.0';
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_QUEUE_DEPTH = 100;
const REQUEST_TIMEOUT_MS = 5000;
const MAX_PAYLOAD_SIZE = '10mb';

// Global state
const dedupCache = new Map();
const queue = [];

// Initialize Express app
const app = express();
app.use(express.json({ limit: MAX_PAYLOAD_SIZE }));

// ============================================================================
// Middleware
// ============================================================================

// Request logging (minimal)
app.use((req, res, next) => {
  const startTime = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    if (req.method === 'POST' && req.path === '/webhooks') {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
    }
  });
  next();
});

// Request timeout
app.use((req, res, next) => {
  req.setTimeout(REQUEST_TIMEOUT_MS, () => {
    res.status(408).json({ error: 'Request timeout' });
  });
  next();
});

// ============================================================================
// Routes
// ============================================================================

/**
 * GET /health
 * Health check endpoint for monitoring
 */
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime_ms: Math.round(process.uptime() * 1000),
    queue_depth: queue.length,
    timestamp: new Date().toISOString()
  });
});

/**
 * POST /webhooks
 * Main webhook endpoint
 * 
 * Request body:
 *   {
 *     "source": "github" | "linear",
 *     "event_id": "unique-event-identifier",
 *     "event_type": "issues.opened" | "issues.updated" | etc.,
 *     "payload": { ... source-specific payload ... }
 *   }
 * 
 * Responses:
 *   202 Accepted - Event queued
 *   400 Bad Request - Invalid input
 *   409 Conflict - Duplicate event
 *   413 Payload Too Large - Payload exceeds limit
 *   500 Internal Server Error - Server failure
 */
app.post('/webhooks', async (req, res) => {
  try {
    const { source, event_id, event_type, payload } = req.body;

    // Validation
    const validation = validateWebhookRequest({ source, event_id, event_type, payload });
    if (!validation.valid) {
      return res.status(validation.statusCode).json({ error: validation.error });
    }

    // Check queue depth
    if (queue.length >= MAX_QUEUE_DEPTH) {
      return res.status(503).json({
        error: 'Queue full',
        queue_depth: queue.length,
        max_queue_depth: MAX_QUEUE_DEPTH
      });
    }

    // Deduplication check
    const cacheKey = `${source}:${event_id}`;
    if (dedupCache.has(cacheKey)) {
      const cached = dedupCache.get(cacheKey);
      return res.status(409).json({
        status: 'deduplicated',
        event_id,
        source,
        first_seen_at: cached.received_at
      });
    }

    // Mark as seen
    const cacheEntry = {
      received_at: new Date().toISOString(),
      source,
      event_type
    };
    dedupCache.set(cacheKey, cacheEntry);

    // Lazy TTL cleanup (10% of requests)
    if (Math.random() < 0.1) {
      const now = Date.now();
      for (const [key, entry] of dedupCache.entries()) {
        if (now - new Date(entry.received_at).getTime() > DEDUP_TTL_MS) {
          dedupCache.delete(key);
        }
      }
    }

    // Enqueue event
    const queueEntry = {
      event_id,
      source,
      event_type,
      status: 'pending',
      queued_at: new Date().toISOString(),
      triggered_at: null,
      error: null
    };
    queue.push(queueEntry);

    // Send 202 Accepted immediately
    res.status(202).json({
      status: 'queued',
      event_id,
      source,
      queue_depth: queue.length,
      expected_trigger_delay_ms: 100
    });

    // Async trigger (non-blocking, fire-and-forget)
    setImmediate(() => {
      triggerHeartbeat(source, event_id, queueEntry);
    });

  } catch (err) {
    console.error('[/webhooks] Unexpected error:', err);
    res.status(500).json({
      error: 'Internal server error',
      message: err.message
    });
  }
});

/**
 * GET /metrics
 * Monitoring metrics endpoint
 */
app.get('/metrics', (req, res) => {
  const pending = queue.filter(e => e.status === 'pending').length;
  const triggered = queue.filter(e => e.status === 'triggered').length;
  const failed = queue.filter(e => e.status === 'failed').length;

  res.status(200).json({
    timestamp: new Date().toISOString(),
    queue: {
      total: queue.length,
      pending,
      triggered,
      failed,
      max_depth: MAX_QUEUE_DEPTH
    },
    dedup_cache: {
      size: dedupCache.size,
      ttl_hours: DEDUP_TTL_MS / (60 * 60 * 1000)
    },
    uptime_ms: Math.round(process.uptime() * 1000)
  });
});

/**
 * DELETE /admin/dedup-cache
 * Admin endpoint: clear deduplication cache (testing/debugging only)
 */
app.delete('/admin/dedup-cache', (req, res) => {
  const oldSize = dedupCache.size;
  dedupCache.clear();
  res.status(200).json({
    status: 'cleared',
    old_size: oldSize,
    new_size: dedupCache.size
  });
});

/**
 * DELETE /admin/queue
 * Admin endpoint: clear event queue (testing/debugging only)
 */
app.delete('/admin/queue', (req, res) => {
  const oldSize = queue.length;
  const clearedEvents = [...queue];
  queue.length = 0;
  res.status(200).json({
    status: 'cleared',
    old_size: oldSize,
    new_size: queue.length,
    cleared_events: clearedEvents.slice(0, 10) // First 10 for reference
  });
});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Validate webhook request
 */
function validateWebhookRequest({ source, event_id, event_type, payload }) {
  // Check source
  if (!source || !['github', 'linear'].includes(source)) {
    return {
      valid: false,
      statusCode: 400,
      error: 'Invalid or missing source (must be "github" or "linear")'
    };
  }

  // Check event_id
  if (!event_id || typeof event_id !== 'string' || event_id.trim() === '') {
    return {
      valid: false,
      statusCode: 400,
      error: 'Invalid or missing event_id (must be non-empty string)'
    };
  }

  // Check event_type (optional but recommended)
  if (event_type && typeof event_type !== 'string') {
    return {
      valid: false,
      statusCode: 400,
      error: 'Invalid event_type (must be string)'
    };
  }

  // Check payload
  if (payload === undefined || payload === null) {
    return {
      valid: false,
      statusCode: 400,
      error: 'Invalid or missing payload (must be object)'
    };
  }
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      valid: false,
      statusCode: 400,
      error: 'Invalid payload (must be object, not array)'
    };
  }

  return { valid: true };
}

/**
 * Trigger /heartbeat via subprocess
 * Spawns: claude --plugin-dir /path/to/woterclip /heartbeat --source {source} --event-id {event_id}
 */
function triggerHeartbeat(source, event_id, queueEntry) {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || '/path/to/woterclip';
  const args = [
    '--plugin-dir',
    pluginRoot,
    '/heartbeat',
    '--source',
    source,
    '--event-id',
    event_id
  ];

  console.log(`[Trigger] Spawning heartbeat: claude ${args.join(' ')}`);

  const proc = spawn('claude', args, {
    detached: true,  // Allow parent to exit independently
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000   // 30 second timeout
  });

  // Mark as triggered
  queueEntry.status = 'triggered';
  queueEntry.triggered_at = new Date().toISOString();

  // Error handling
  proc.on('error', (err) => {
    queueEntry.status = 'failed';
    queueEntry.error = err.message;
    console.error(`[${event_id}] Trigger error: ${err.message}`);
  });

  proc.on('exit', (code, signal) => {
    if (code !== 0 && queueEntry.status === 'triggered') {
      queueEntry.status = 'failed';
      queueEntry.error = `Process exited with code ${code}${signal ? ` (signal: ${signal})` : ''}`;
      console.error(`[${event_id}] Process failed: exit code ${code}`);
    } else if (code === 0) {
      queueEntry.status = 'completed';
      console.log(`[${event_id}] Trigger completed successfully`);
    }
  });

  // Collect output (optional, for debugging)
  let stdout = '', stderr = '';
  proc.stdout?.on('data', (data) => {
    stdout += data.toString();
    if (stdout.length > 1024) stdout = stdout.slice(-1024); // Keep last 1KB
  });
  proc.stderr?.on('data', (data) => {
    stderr += data.toString();
    if (stderr.length > 1024) stderr = stderr.slice(-1024);
  });

  // Unref to not keep parent alive
  proc.unref();
}

// ============================================================================
// Server Lifecycle
// ============================================================================

const server = app.listen(PORT, HOST, () => {
  console.log(`[Listener] Started on http://${HOST}:${PORT}`);
  console.log(`[Listener] Plugin root: ${process.env.CLAUDE_PLUGIN_ROOT || '/path/to/woterclip'}`);
  console.log(`[Listener] Dedup TTL: ${DEDUP_TTL_MS / (60 * 60 * 1000)} hours`);
  console.log(`[Listener] Max queue depth: ${MAX_QUEUE_DEPTH}`);
  console.log(`[Listener] Health check: GET /health`);
  console.log(`[Listener] Metrics: GET /metrics`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Listener] SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('[Listener] Server closed');
    
    // Flush pending queue (could enqueue remaining events or log)
    console.log(`[Listener] Queue at shutdown: ${queue.length} events`);
    const pending = queue.filter(e => e.status === 'pending');
    if (pending.length > 0) {
      console.log(`[Listener] WARNING: ${pending.length} pending events not triggered`);
    }
    
    process.exit(0);
  });

  // Force exit after 10 seconds
  setTimeout(() => {
    console.error('[Listener] Forced shutdown after 10s');
    process.exit(1);
  }, 10000);
});

// ============================================================================
// Export for testing
// ============================================================================

module.exports = { app, dedupCache, queue };
