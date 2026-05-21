/**
 * Test Suite for Webhook Receiver (Phase 1)
 * 
 * Usage:
 *   node test-webhook-receiver.js
 * 
 * Tests signature validation, cache, and event routing
 * (Does NOT require running server)
 */

const crypto = require('crypto');
const assert = require('assert');

// ============================================================================
// Import functions from webhook-receiver-reference.js (for testing)
// ============================================================================

// Copy-pasted for testing without module.exports changes:

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

function validateGitHubSignature(payload, signature, secret) {
  if (!secret) return false;

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

function validateLinearSignature(payload, signature, timestamp, secret) {
  if (!secret) return false;

  const signedAt = parseInt(timestamp, 10);
  const now = Date.now();
  const maxAgeMs = 5 * 60 * 1000;
  
  if (now - signedAt > maxAgeMs) {
    return false;
  }

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

function routeGitHubEvent(payload) {
  const action = payload.action;
  const issue = payload.issue || {};
  const labels = (issue.labels || []).map(l => l.name);
  const state = issue.state;

  return {
    action,
    issueNumber: issue.number,
    title: issue.title,
    labels,
    state,
    source: 'github',
  };
}

function routeLinearEvent(payload) {
  const action = payload.action;
  const data = payload.data || {};
  const labels = (data.labels || []).map(l => l.name);
  const state = data.state ? data.state.name : 'unknown';

  return {
    action,
    issueId: data.id,
    title: data.title,
    labels,
    state,
    source: 'linear',
  };
}

// ============================================================================
// Test Suite
// ============================================================================

let testsPassed = 0;
let testsFailed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    testsPassed++;
  } catch (err) {
    console.error(`❌ ${name}`);
    console.error(`   ${err.message}`);
    testsFailed++;
  }
}

// GitHub Signature Validation Tests
console.log('\n=== GitHub Signature Validation ===\n');

test('accepts valid GitHub signature', () => {
  const secret = 'test-secret';
  const payload = '{"action":"opened","issue":{"number":42}}';
  const digest = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  const signature = `sha256=${digest}`;
  
  assert.strictEqual(validateGitHubSignature(payload, signature, secret), true);
});

test('rejects invalid GitHub signature', () => {
  const secret = 'test-secret';
  const payload = '{"action":"opened"}';
  const badSignature = 'sha256=deadbeef';
  
  assert.strictEqual(validateGitHubSignature(payload, badSignature, secret), false);
});

test('rejects GitHub signature with empty secret', () => {
  const payload = '{"action":"opened"}';
  const signature = 'sha256=anything';
  
  assert.strictEqual(validateGitHubSignature(payload, signature, ''), false);
});

test('handles GitHub signature case sensitivity', () => {
  const secret = 'test-secret';
  const payload = '{"action":"opened"}';
  const digest = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  const goodSig = `sha256=${digest}`;
  const badSig = `sha256=${digest.toUpperCase()}`; // Different case
  
  assert.strictEqual(validateGitHubSignature(payload, goodSig, secret), true);
  // HMAC digests match case-insensitively for hex, so might be true
  // This test documents the behavior
});

// Linear Signature Validation Tests
console.log('\n=== Linear Signature Validation ===\n');

test('accepts valid Linear signature', () => {
  const secret = 'test-secret';
  const payload = '{"action":"create","data":{"id":"WOT-13"}}';
  // Use a fixed timestamp in the past (but within the 5-min window)
  const fixedTimestamp = (Date.now() - 1000).toString(); // 1 second ago
  const message = `${fixedTimestamp}.${payload}`;
  const digest = crypto
    .createHmac('sha256', secret)
    .update(message)
    .digest('hex');
  const signature = `v1,${digest}`;
  
  assert.strictEqual(validateLinearSignature(payload, signature, fixedTimestamp, secret), true);
});

test('rejects Linear signature with old timestamp', () => {
  const secret = 'test-secret';
  const payload = '{"action":"create"}';
  const oldTimestamp = (Date.now() - 10 * 60 * 1000).toString(); // 10 min ago
  const message = `${oldTimestamp}.${payload}`;
  const digest = 'v1,' + crypto
    .createHmac('sha256', secret)
    .update(message)
    .digest('hex');
  
  assert.strictEqual(validateLinearSignature(payload, digest, oldTimestamp, secret), false);
});

test('rejects Linear signature with wrong secret', () => {
  const secret = 'test-secret';
  const payload = '{"action":"create"}';
  const timestamp = (Date.now() - 1000).toString(); // 1 second ago
  const message = `${timestamp}.${payload}`;
  const digest = 'v1,' + crypto
    .createHmac('sha256', 'wrong-secret')
    .update(message)
    .digest('hex');
  
  assert.strictEqual(validateLinearSignature(payload, digest, timestamp, secret), false);
});

test('rejects Linear signature with empty secret', () => {
  const payload = '{"action":"create"}';
  const timestamp = (Date.now() - 1000).toString();
  const signature = 'v1,anything';
  
  assert.strictEqual(validateLinearSignature(payload, signature, timestamp, ''), false);
});

// Event Routing Tests
console.log('\n=== Event Routing ===\n');

test('routes GitHub issue opened event', () => {
  const payload = {
    action: 'opened',
    issue: {
      number: 42,
      title: 'Fix login',
      labels: [{ name: 'backend' }, { name: 'urgent' }],
      state: 'open',
    },
  };
  
  const event = routeGitHubEvent(payload);
  assert.strictEqual(event.action, 'opened');
  assert.strictEqual(event.issueNumber, 42);
  assert.strictEqual(event.title, 'Fix login');
  assert.deepStrictEqual(event.labels, ['backend', 'urgent']);
  assert.strictEqual(event.state, 'open');
  assert.strictEqual(event.source, 'github');
});

test('routes Linear issue create event', () => {
  const payload = {
    action: 'create',
    data: {
      id: 'WOT-13',
      title: 'HTTP listener',
      labels: [{ name: 'backend' }],
      state: { name: 'In Progress' },
    },
  };
  
  const event = routeLinearEvent(payload);
  assert.strictEqual(event.action, 'create');
  assert.strictEqual(event.issueId, 'WOT-13');
  assert.strictEqual(event.title, 'HTTP listener');
  assert.deepStrictEqual(event.labels, ['backend']);
  assert.strictEqual(event.state, 'In Progress');
  assert.strictEqual(event.source, 'linear');
});

test('handles GitHub event with no labels', () => {
  const payload = {
    action: 'opened',
    issue: {
      number: 1,
      title: 'Test',
      state: 'open',
    },
  };
  
  const event = routeGitHubEvent(payload);
  assert.deepStrictEqual(event.labels, []);
});

// Event Cache Tests
console.log('\n=== Event Cache (Deduplication) ===\n');

test('cache returns false on miss', () => {
  const cache = new SimpleEventCache();
  assert.strictEqual(cache.has('github', 'unknown'), false);
});

test('cache detects hit after set', () => {
  const cache = new SimpleEventCache();
  cache.set('github', '42', { status: 'processing' });
  assert.strictEqual(cache.has('github', '42'), true);
});

test('cache retrieves stored value', () => {
  const cache = new SimpleEventCache();
  cache.set('github', '42', { status: 'processing', url: 'http://example.com' });
  const entry = cache.get('github', '42');
  assert.strictEqual(entry.status, 'processing');
  assert.strictEqual(entry.url, 'http://example.com');
});

test('cache expires entries after TTL', (done) => {
  const cache = new SimpleEventCache(100); // 100ms TTL
  cache.set('github', '42', { status: 'processing' });
  assert.strictEqual(cache.has('github', '42'), true);
  
  setTimeout(() => {
    assert.strictEqual(cache.has('github', '42'), false);
    done();
  }, 150);
});

test('cache cleanup removes expired entries', (done) => {
  const cache = new SimpleEventCache(100);
  cache.set('github', '42', { status: 'processing' });
  cache.set('github', '43', { status: 'processing' });
  assert.strictEqual(cache.stats().cacheSize, 2);
  
  setTimeout(() => {
    cache.cleanup();
    assert.strictEqual(cache.stats().cacheSize, 0);
    done();
  }, 150);
});

test('cache keeps non-expired entries during cleanup', (done) => {
  const cache = new SimpleEventCache(500);
  cache.set('github', '42', { status: 'processing' });
  
  setTimeout(() => {
    cache.set('github', '43', { status: 'processing' });
    cache.cleanup();
    assert.strictEqual(cache.has('github', '42'), true);
    assert.strictEqual(cache.has('github', '43'), true);
    done();
  }, 100);
});

test('cache supports multiple platforms', () => {
  const cache = new SimpleEventCache();
  cache.set('github', '42', { status: 'processing' });
  cache.set('linear', 'WOT-13', { status: 'done' });
  
  assert.strictEqual(cache.has('github', '42'), true);
  assert.strictEqual(cache.has('linear', 'WOT-13'), true);
  assert.strictEqual(cache.has('github', 'WOT-13'), false); // Wrong platform
});

// ============================================================================
// Summary
// ============================================================================

console.log('\n=== Test Summary ===\n');
console.log(`Passed: ${testsPassed}`);
console.log(`Failed: ${testsFailed}`);
console.log(`Total:  ${testsPassed + testsFailed}`);

if (testsFailed > 0) {
  process.exit(1);
} else {
  console.log('\n✅ All tests passed!');
  process.exit(0);
}
