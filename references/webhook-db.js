/**
 * WoterClip Webhook Queue — SQLite Persistence Helper
 *
 * Phase 1 reference (WOT-2). Implements the documented webhook_queue adapter
 * operations (backend-sqlite.md ops 12–16) so the receiver persists events to
 * the database instead of relying solely on the in-memory dedup cache.
 *
 * Why the sqlite3 CLI instead of a node driver:
 *   The WoterClip SQLite adapter contract is defined entirely in terms of
 *   `sqlite3 <db> "<sql>"` invocations (references/backend-sqlite.md). Keeping
 *   this helper on the same CLI path means zero new runtime dependencies and a
 *   1:1 mapping to the documented adapter operations.
 *
 * Usage:
 *   const { makeWebhookQueue } = require('./webhook-db');
 *   const queue = makeWebhookQueue('/path/to/.woterclip/woterclip.db');
 *   if (!queue.eventExists(eventId)) queue.enqueue(eventId, 'github', 'issues.opened');
 *   queue.markTriggered(eventId);
 *   queue.markCompleted(eventId);            // or queue.markFailed(eventId, msg)
 */

const { execFileSync } = require('child_process');

// Escape single quotes for safe interpolation into SQL string literals
// (Tier 2 quoting strategy from references/backend-sqlite.md).
function sqlEscape(value) {
  return String(value).replace(/'/g, "''");
}

function makeWebhookQueue(dbPath) {
  function run(sql) {
    // -batch: no interactive prompts; throws on non-zero exit (constraint errors).
    return execFileSync('sqlite3', ['-batch', dbPath, sql], {
      encoding: 'utf-8',
    });
  }

  return {
    /**
     * Operation 13: webhook_event_exists(event_id)
     * Returns true if the event was already seen (dedup).
     */
    eventExists(eventId) {
      const sql =
        `SELECT COUNT(*) FROM webhook_queue WHERE event_id = '${sqlEscape(eventId)}';`;
      const out = run(sql).trim();
      return parseInt(out, 10) > 0;
    },

    /**
     * Operation 12: enqueue_webhook(event_id, source, event_type)
     * Inserts a pending event. Caller should check eventExists() first to avoid
     * tripping the UNIQUE(event_id) constraint.
     */
    enqueue(eventId, source, eventType) {
      const sql =
        `INSERT INTO webhook_queue(event_id, source, event_type, status) ` +
        `VALUES ('${sqlEscape(eventId)}', '${sqlEscape(source)}', ` +
        `'${sqlEscape(eventType || '')}', 'pending');`;
      run(sql);
    },

    /**
     * Operation 14: mark_webhook_triggered(event_id)
     * Marks an event as triggered (heartbeat invocation started).
     */
    markTriggered(eventId) {
      const sql =
        `UPDATE webhook_queue SET status = 'triggered', ` +
        `triggered_at = datetime('now') WHERE event_id = '${sqlEscape(eventId)}';`;
      run(sql);
    },

    /**
     * Operation 15: mark_webhook_completed(event_id)
     * Marks a triggered event as completed successfully.
     */
    markCompleted(eventId) {
      const sql =
        `UPDATE webhook_queue SET status = 'completed', ` +
        `completed_at = datetime('now') WHERE event_id = '${sqlEscape(eventId)}';`;
      run(sql);
    },

    /**
     * Operation 16: mark_webhook_failed(event_id, error_message)
     * Marks a triggered event as failed with error details.
     */
    markFailed(eventId, errorMessage) {
      const sql =
        `UPDATE webhook_queue SET status = 'failed', ` +
        `completed_at = datetime('now'), ` +
        `error_message = '${sqlEscape(errorMessage || '')}' ` +
        `WHERE event_id = '${sqlEscape(eventId)}';`;
      run(sql);
    },
  };
}

module.exports = { makeWebhookQueue, sqlEscape };
