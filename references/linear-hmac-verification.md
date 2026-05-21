# Linear Webhook HMAC Verification & Routing

**Date:** 2026-05-21
**Author:** Backend Persona (Cycle 14, Heartbeat 14)
**Linear:** [WOT-14](https://linear.app/wotai/issue/WOT-14/hmac-verification-request-routing-for-linear)
**Depends on:** [WOT-13](https://linear.app/wotai/issue/WOT-13/http-listener-queue-infrastructure) (HTTP listener + queue)

## Overview

This document specifies HMAC-SHA256 signature verification for Linear webhooks and routing verified payloads to a queue system. Complements `references/webhooks-integration.md` with implementation details specific to Linear's webhook signature scheme.

**Goal:** Provide Python/Node.js code patterns for cryptographically validating Linear webhook authenticity and routing events to a persistent queue.

## Linear Webhook Signature Scheme

Linear uses HMAC-SHA256 with the following signature format:

**Headers:**
- `X-Linear-Signature`: `v1,<hex-encoded-signature>`
- `X-Linear-Signature-Timestamp`: Unix timestamp (seconds since epoch)

**Verification Algorithm:**

```
message = {timestamp}.{raw_request_body}
secret = config.webhooks.linear.secret
signature = v1,hexadecimal(HMAC-SHA256(message, secret))
if signature == header_value:
    # Valid – process event
else:
    # Invalid – reject (401 Unauthorized)
```

### Timestamp Validation (Optional)

To prevent replay attacks, validate timestamp is recent (e.g., within last 5 minutes):

```python
import time
from datetime import datetime, timedelta

MAX_AGE_SECONDS = 300  # 5 minutes

timestamp = int(request.headers['X-Linear-Signature-Timestamp'])
current_time = int(time.time())
age = current_time - timestamp

if age > MAX_AGE_SECONDS:
    return 401  # Too old – reject
if age < -60:
    return 401  # Clock skew – reject (from future)
```

## Implementation Patterns

### Pattern 1: Python (Recommended for WoterClip)

**Uses:** `hmac`, `hashlib` (stdlib), minimal dependencies

```python
#!/usr/bin/env python3
"""
Linear webhook HMAC verification module.
Used by webhook receiver to validate Linear webhook signatures.
"""

import hmac
import hashlib
import json
from typing import Tuple

class LinearWebhookVerifier:
    """Verify Linear webhook signatures (HMAC-SHA256)."""
    
    @staticmethod
    def verify(
        raw_body: bytes,
        signature_header: str,
        timestamp_header: str,
        secret: str,
        max_age_seconds: int = 300
    ) -> Tuple[bool, str]:
        """
        Verify Linear webhook signature.
        
        Args:
            raw_body: Raw request body (bytes, not parsed JSON)
            signature_header: Value of X-Linear-Signature header
            timestamp_header: Value of X-Linear-Signature-Timestamp header
            secret: Linear webhook secret from config
            max_age_seconds: Reject signatures older than this (replay protection)
        
        Returns:
            (is_valid: bool, reason: str)
        
        Example:
            is_valid, reason = LinearWebhookVerifier.verify(
                raw_body=request.body,
                signature_header=request.headers['X-Linear-Signature'],
                timestamp_header=request.headers['X-Linear-Signature-Timestamp'],
                secret=os.environ['LINEAR_WEBHOOK_SECRET'],
                max_age_seconds=300
            )
            if not is_valid:
                return 401, {"error": reason}
        """
        
        # Parse signature header (format: "v1,<hex>")
        if not signature_header.startswith('v1,'):
            return False, "Invalid signature format (expected v1,<hex>)"
        
        try:
            provided_sig = signature_header[3:]  # Remove "v1," prefix
        except (IndexError, ValueError):
            return False, "Malformed signature header"
        
        # Validate timestamp
        try:
            timestamp = int(timestamp_header)
        except (ValueError, TypeError):
            return False, "Invalid timestamp format"
        
        import time
        current_time = int(time.time())
        age = current_time - timestamp
        
        if age > max_age_seconds:
            return False, f"Signature too old ({age}s > {max_age_seconds}s)"
        if age < -60:
            return False, f"Signature from future (clock skew: {-age}s)"
        
        # Compute expected signature
        message = f"{timestamp}.{raw_body.decode('utf-8')}"
        expected_sig = hmac.new(
            secret.encode('utf-8'),
            message.encode('utf-8'),
            hashlib.sha256
        ).hexdigest()
        
        # Constant-time comparison (prevent timing attacks)
        is_match = hmac.compare_digest(provided_sig, expected_sig)
        
        if not is_match:
            return False, "Signature mismatch (invalid secret or tampered payload)"
        
        return True, ""
    
    @staticmethod
    def parse_payload(raw_body: bytes) -> dict:
        """
        Parse Linear webhook payload.
        
        Args:
            raw_body: Raw request body
        
        Returns:
            Parsed JSON dict with keys:
            - action: "create", "update", "archive"
            - data: Issue object with id, title, description, state, labels, etc.
            - teamId: Linear team ID
            - userId: User who triggered the event
            - createdAt: ISO-8601 timestamp
        
        Raises:
            json.JSONDecodeError: If payload is not valid JSON
        """
        return json.loads(raw_body.decode('utf-8'))


# Example usage in Flask app
if __name__ == '__main__':
    from flask import Flask, request, jsonify
    import os
    
    app = Flask(__name__)
    verifier = LinearWebhookVerifier()
    
    @app.route('/webhook/linear', methods=['POST'])
    def linear_webhook():
        """Receive Linear webhook and verify signature."""
        
        secret = os.environ.get('LINEAR_WEBHOOK_SECRET')
        if not secret:
            return {"error": "LINEAR_WEBHOOK_SECRET not configured"}, 500
        
        # Validate signature
        is_valid, reason = verifier.verify(
            raw_body=request.get_data(),
            signature_header=request.headers.get('X-Linear-Signature', ''),
            timestamp_header=request.headers.get('X-Linear-Signature-Timestamp', ''),
            secret=secret
        )
        
        if not is_valid:
            print(f"[WEBHOOK] Invalid signature: {reason}")
            return {"error": reason}, 401
        
        # Parse payload
        try:
            payload = verifier.parse_payload(request.get_data())
        except json.JSONDecodeError as e:
            return {"error": f"Invalid JSON: {e}"}, 400
        
        # Extract event metadata
        action = payload.get('action')
        issue_id = payload.get('data', {}).get('id')
        team_id = payload.get('teamId')
        
        print(f"[WEBHOOK] Valid Linear event: action={action}, issue={issue_id}, team={team_id}")
        
        # TODO: Route to queue (WOT-13 dependency)
        # queue.enqueue('process_linear_event', payload)
        
        return {"status": "received"}, 200
    
    app.run(debug=True, port=5000)
```

### Pattern 2: Node.js / Express

**Uses:** `crypto` (stdlib), `express`

```javascript
/**
 * Linear webhook HMAC verification (Node.js / Express)
 * Complements references/webhooks-integration.md with Linear-specific validation.
 */

const crypto = require('crypto');
const express = require('express');
const app = express();

// Middleware to capture raw body (needed for signature verification)
app.use(express.raw({ type: 'application/json' }));

class LinearWebhookVerifier {
  /**
   * Verify Linear webhook signature (HMAC-SHA256).
   * 
   * @param {Buffer} rawBody - Raw request body (bytes)
   * @param {string} signatureHeader - Value of X-Linear-Signature header
   * @param {string} timestampHeader - Value of X-Linear-Signature-Timestamp header
   * @param {string} secret - Linear webhook secret from config
   * @param {number} maxAgeSeconds - Reject signatures older than this (default: 300)
   * @returns {Object} { isValid: boolean, reason: string }
   */
  static verify(rawBody, signatureHeader, timestampHeader, secret, maxAgeSeconds = 300) {
    // Parse signature header (format: "v1,<hex>")
    if (!signatureHeader || !signatureHeader.startsWith('v1,')) {
      return { isValid: false, reason: 'Invalid signature format (expected v1,<hex>)' };
    }
    
    const providedSig = signatureHeader.slice(3);
    
    // Validate timestamp
    const timestamp = parseInt(timestampHeader, 10);
    if (isNaN(timestamp)) {
      return { isValid: false, reason: 'Invalid timestamp format' };
    }
    
    const currentTime = Math.floor(Date.now() / 1000);
    const age = currentTime - timestamp;
    
    if (age > maxAgeSeconds) {
      return { isValid: false, reason: `Signature too old (${age}s > ${maxAgeSeconds}s)` };
    }
    if (age < -60) {
      return { isValid: false, reason: `Signature from future (clock skew: ${-age}s)` };
    }
    
    // Compute expected signature
    const message = `${timestamp}.${rawBody.toString('utf-8')}`;
    const expectedSig = crypto
      .createHmac('sha256', secret)
      .update(message)
      .digest('hex');
    
    // Constant-time comparison
    const isMatch = crypto.timingSafeEqual(
      Buffer.from(providedSig),
      Buffer.from(expectedSig)
    );
    
    if (!isMatch) {
      return { isValid: false, reason: 'Signature mismatch (invalid secret or tampered payload)' };
    }
    
    return { isValid: true, reason: '' };
  }
  
  /**
   * Parse Linear webhook payload.
   * 
   * @param {Buffer} rawBody - Raw request body
   * @returns {Object} Parsed JSON with action, data, teamId, userId, createdAt
   * @throws {Error} If payload is not valid JSON
   */
  static parsePayload(rawBody) {
    return JSON.parse(rawBody.toString('utf-8'));
  }
}

// Example webhook endpoint
app.post('/webhook/linear', (req, res) => {
  const secret = process.env.LINEAR_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[WEBHOOK] LINEAR_WEBHOOK_SECRET not configured');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }
  
  // Verify signature
  const { isValid, reason } = LinearWebhookVerifier.verify(
    req.body,  // Raw body
    req.headers['x-linear-signature'],
    req.headers['x-linear-signature-timestamp'],
    secret
  );
  
  if (!isValid) {
    console.log(`[WEBHOOK] Invalid signature: ${reason}`);
    return res.status(401).json({ error: reason });
  }
  
  // Parse payload
  let payload;
  try {
    payload = LinearWebhookVerifier.parsePayload(req.body);
  } catch (e) {
    console.log(`[WEBHOOK] Invalid JSON: ${e.message}`);
    return res.status(400).json({ error: `Invalid JSON: ${e.message}` });
  }
  
  // Extract event metadata
  const action = payload.action;
  const issueId = payload.data?.id;
  const teamId = payload.teamId;
  
  console.log(`[WEBHOOK] Valid Linear event: action=${action}, issue=${issueId}, team=${teamId}`);
  
  // TODO: Route to queue (WOT-13 dependency)
  // await queue.enqueue('process_linear_event', payload);
  
  return res.status(200).json({ status: 'received' });
});

module.exports = { LinearWebhookVerifier, app };
```

## Webhook Routing (Queue Integration)

Once signature verification passes, route the event to a queue system (blocks on WOT-13):

### Queue Interface (Generic)

```python
"""
Abstract queue interface (implemented by WOT-13).
Provides deduplication, persistence, and ordering.
"""

class WebhookQueue:
    def enqueue(self, event_type: str, payload: dict, dedup_key: str = None) -> str:
        """
        Enqueue a verified webhook event.
        
        Args:
            event_type: "linear_issue_created", "linear_issue_updated", etc.
            payload: Parsed webhook payload from Linear
            dedup_key: Unique key for deduplication (Linear's X-Linear-Webhook-ID header)
        
        Returns:
            job_id: Unique identifier for the queued job
        
        Note:
            - If dedup_key is provided and already queued, returns existing job_id
            - Queue persists across receiver restarts (SQLite, Redis, etc.)
            - Processor polls queue independently (decouples webhook receiver from heartbeat)
        """
        pass
    
    def dequeue(self, limit: int = 1) -> List[dict]:
        """
        Dequeue unprocessed events for heartbeat worker.
        
        Returns:
            List of { job_id, event_type, payload, created_at, retry_count }
        """
        pass
    
    def ack(self, job_id: str) -> bool:
        """Mark job as processed."""
        pass
    
    def nack(self, job_id: str, reason: str) -> bool:
        """Mark job as failed (will be retried)."""
        pass
```

### Routing Strategy

After HMAC verification:

1. **Extract deduplication key** from Linear event:
   ```python
   dedup_key = request.headers.get('X-Linear-Webhook-ID')  # Linear delivery ID
   ```

2. **Enqueue to job queue**:
   ```python
   queue.enqueue(
       event_type=f"linear_{payload['action']}",  # "linear_create", "linear_update", etc.
       payload=payload,
       dedup_key=dedup_key
   )
   ```

3. **Return 200 immediately**:
   ```python
   return { "status": "queued", "job_id": job_id }, 200
   ```

Heartbeat (Step 3 of heartbeat skill) processes queued events, maps to issues, and updates state.

## Testing Strategy

See `WOT-15: Integration tests for Linear webhooks`.

### Unit Tests (Pre-WOT-13)

```python
import pytest
from linear_hmac_verification import LinearWebhookVerifier

class TestLinearHmacVerification:
    
    def test_valid_signature(self):
        """Verify a correctly-signed payload."""
        secret = "test-secret"
        timestamp = "1621234567"
        payload = b'{"action":"create","data":{"id":"WOT-1"}}'
        
        message = f"{timestamp}.{payload.decode('utf-8')}"
        signature = hmac.new(
            secret.encode(), message.encode(), hashlib.sha256
        ).hexdigest()
        
        is_valid, reason = LinearWebhookVerifier.verify(
            raw_body=payload,
            signature_header=f"v1,{signature}",
            timestamp_header=timestamp,
            secret=secret
        )
        
        assert is_valid is True
        assert reason == ""
    
    def test_invalid_signature(self):
        """Reject a tampered payload."""
        is_valid, reason = LinearWebhookVerifier.verify(
            raw_body=b'{"data":"tampered"}',
            signature_header="v1,badbadbadbad",
            timestamp_header="1621234567",
            secret="test-secret"
        )
        
        assert is_valid is False
        assert "Signature mismatch" in reason
    
    def test_stale_signature(self):
        """Reject a signature older than max_age."""
        old_timestamp = int(time.time()) - 400  # 400 seconds old
        
        is_valid, reason = LinearWebhookVerifier.verify(
            raw_body=b'{"action":"create"}',
            signature_header="v1,fake",
            timestamp_header=str(old_timestamp),
            secret="test-secret",
            max_age_seconds=300
        )
        
        assert is_valid is False
        assert "too old" in reason.lower()
```

## Integration with WoterClip Config

Update `.woterclip/config.yaml` template to include HMAC settings:

```yaml
webhooks:
  enabled: true
  linear:
    # Secret from Linear workspace settings > Webhooks > Copy secret
    secret: "${LINEAR_WEBHOOK_SECRET}"
    # Events to subscribe to
    events:
      - Issue.created
      - Issue.updated
      - Issue.archived
    # Linear team to monitor
    team: "wotai"
    # Receiver endpoint (external service, set up separately)
    receiver_url: "https://your-webhook-receiver.example.com/webhook/linear"
```

## Files Created

- ✅ `references/linear-hmac-verification.md` (this file)

## Files Modified

- ⏳ `references/webhook-config-template.yaml` (add HMAC example secret)
- ⏳ `.woterclip/config.yaml` (add Linear webhook secret during init)

## Next Steps (Blocked by WOT-13)

1. WOT-13 team: Implement HTTP listener + queue infrastructure
   - Python/Express webhook receiver skeleton
   - SQLite-backed job queue with deduplication
   - Receiver ↔ Heartbeat integration

2. WOT-14 continuation: Integrate HMAC verification with queue
   - Instantiate LinearWebhookVerifier in receiver
   - Route verified payloads to queue
   - End-to-end test (Linear event → queue → heartbeat processes issue)

3. WOT-15: Integration tests
   - Mock Linear webhook payloads
   - Test signature validation with valid/invalid secrets
   - Test timestamp edge cases (old, future, missing)
   - Test deduplication (same event, different delivery attempts)

## References

- [Linear Webhooks Documentation](https://developers.linear.app/docs/graphql/webhooks)
- [HMAC-SHA256 Best Practices](https://en.wikipedia.org/wiki/HMAC)
- [Webhook Security (OWASP)](https://owasp.org/www-community/attacks/Timing_attack)
- [Python HMAC Module](https://docs.python.org/3/library/hmac.html)
- [Node.js Crypto Module](https://nodejs.org/api/crypto.html)
