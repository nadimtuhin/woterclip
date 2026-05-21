# Webhook Integration Reference

**Date:** 2026-05-21
**Author:** Backend Persona (Cycle 12, Heartbeat 12)
**Linear:** [WOT-2](https://linear.app/wotai/issue/WOT-2/implement-webhook-integrations-for-github-and-linear)

## Overview

This document defines webhook integration patterns for WoterClip, enabling real-time triggers for heartbeat runs and issue state synchronization across GitHub and Linear.

**Goal:** Replace polling-based heartbeat scheduling with event-driven triggers.

## Architecture

### Current State (Polling Model)

```
Claude Code /schedule (poll every N minutes)
  → /heartbeat skill
    → Load config
    → Check Linear inbox
    → Process issues
    → Update Linear
```

**Limitations:**
- Latency: up to N minutes before issue appears in agent inbox
- Wasted cycles: checks when no changes exist
- Coupling: heartbeat runs on fixed schedule, not event-driven

### Proposed State (Event-Driven Model)

```
GitHub / Linear
  → Webhook Event (issue created/updated/closed)
    → Webhook Receiver (HTTP endpoint)
      → Validate signature
      → Extract event metadata
      → Trigger /heartbeat via Claude Code CLI or API
        → Load config
        → Check inbox (filtered by event source)
        → Process relevant issues
        → Update state
```

**Benefits:**
- Sub-second latency: responds to changes immediately
- Efficiency: processes only affected issues
- Flexibility: can prioritize urgent events over background poll

## Implementation Strategy

WoterClip webhook support requires:

1. **Webhook Receiver** – HTTP endpoint (outside Claude Code plugin scope)
2. **Event Schema** – Standardized event format (GitHub + Linear)
3. **Signature Validation** – HMAC-SHA256 for security
4. **Trigger Adapter** – Convert webhook → `/heartbeat` invocation
5. **Config Extension** – Add webhook settings to `.woterclip/config.yaml`

## Webhook Receivers

Two patterns exist:

### Pattern A: Centralized Receiver (Shared Infrastructure)

```
+--------------------+     +-------------------+     +-----------------+
| GitHub / Linear    |     | Webhook Receiver  |     | Claude Code App |
| (sends events)     | --> | (validates,       | --> | (runs /heartbeat)|
|                    |     |  queues, routes)  |     |                 |
+--------------------+     +-------------------+     +-----------------+
                               (AWS Lambda,
                            Cloud Run, Node.js,
                             Express, FastAPI)
```

**Pros:**
- Single shared endpoint for all repos
- Deduplication and batching possible
- Infrastructure-agnostic

**Cons:**
- Requires external hosting
- Additional secrets management (webhook token, receiver URL)
- Operational burden

### Pattern B: Repo-Specific Receiver (Future)

When Claude Code supports background listeners:

```
+--------------------+     +--------------------+
| GitHub / Linear    |     | Claude Code Plugin |
| (sends events)     | --> | (listens, validates,|
|                    |     |  triggers /heartbeat)|
+--------------------+     +--------------------+
```

Currently not possible (Claude Code is foreground-only).

## Event Schemas

### GitHub Webhook Events

**Event:** `issues.opened`, `issues.edited`, `issues.closed`

```json
{
  "action": "opened",
  "issue": {
    "number": 42,
    "title": "Fix login flow",
    "labels": [
      { "name": "backend" }
    ],
    "body": "Users cannot sign in...",
    "state": "open"
  },
  "repository": {
    "name": "woterclip",
    "owner": {
      "login": "wotai-dev"
    }
  }
}
```

**Mapping to WoterClip:**
- `issue.labels[*].name` → personas (e.g., `backend`, `ceo`)
- `issue.number` → issue ID (if synced to Linear)
- `issue.state` → Linear state mapping (see `references/status-mapping.md`)
- `issue.body` → description

### Linear Webhook Events

**Event:** `Issue.created`, `Issue.updated`, `Issue.archived`

```json
{
  "action": "create",
  "data": {
    "id": "WOT-2",
    "title": "Implement webhook integrations",
    "description": "Add webhook support...",
    "labels": [
      { "name": "backend" }
    ],
    "state": {
      "name": "In Progress"
    }
  },
  "teamId": "wotai",
  "userId": "user-123"
}
```

**Mapping to WoterClip:**
- `data.id` → issue ID
- `data.labels[*].name` → personas
- `data.state.name` → state (mapped via `status-mapping.md`)

## Signature Validation

### GitHub

**Header:** `X-Hub-Signature-256`
**Format:** `sha256=<hex>`

```bash
# Pseudocode
secret = config.webhooks.github.secret
payload = raw_request_body
signature = "sha256=" + hexadecimal(HMAC-SHA256(payload, secret))
if signature == header_value:
    # Valid
else:
    # Reject (401)
```

### Linear

**Header:** `X-Linear-Signature`
**Format:** `v1,<hex>`

```bash
# Pseudocode
secret = config.webhooks.linear.secret
payload = raw_request_body
timestamp = header "X-Linear-Signature-Timestamp"
message = timestamp + "." + payload
signature = "v1," + hexadecimal(HMAC-SHA256(message, secret))
if signature == header_value:
    # Valid
else:
    # Reject (401)
```

## Config Extension

Add to `.woterclip/config.yaml`:

```yaml
webhooks:
  enabled: true
  # GitHub webhook
  github:
    secret: "${GITHUB_WEBHOOK_SECRET}"  # From environment or Linear secret
    events:
      - issues.opened
      - issues.edited
      - issues.closed
    repo_mapping:
      # Map GitHub repo to Linear team/project
      "woterclip": "wotai/woterclip"
  # Linear webhook
  linear:
    secret: "${LINEAR_WEBHOOK_SECRET}"
    events:
      - Issue.created
      - Issue.updated
      - Issue.archived
    team: "wotai"
```

## Trigger Adapter (Receiver Implementation)

The webhook receiver (external service) must:

1. **Receive** the webhook event via POST
2. **Validate** signature (GitHub or Linear)
3. **Extract** relevant fields (issue ID, persona label, action)
4. **Invoke** Claude Code heartbeat via:
   - Option A: CLI subprocess (if receiver runs on same machine)
   - Option B: Claude Code API call (future, when API stabilizes)
   - Option C: Queue for later processing (decouple receiver from Claude)

### Example: Node.js / Express Receiver

```javascript
const express = require('express');
const crypto = require('crypto');
const app = express();

app.use(express.raw({ type: 'application/json' }));

app.post('/webhook/github', (req, res) => {
  const signature = req.headers['x-hub-signature-256'];
  const payload = req.body;
  
  // Validate
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  const expectedSig = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  
  if (!crypto.timingSafeEqual(signature, expectedSig)) {
    return res.status(401).send('Unauthorized');
  }
  
  // Parse
  const event = JSON.parse(payload);
  const issueNumber = event.issue.number;
  const label = event.issue.labels[0]?.name || 'orchestrator';
  
  // Trigger heartbeat
  // TODO: Replace with Claude Code API when available
  console.log(`Received GitHub issue #${issueNumber}, label: ${label}`);
  
  res.status(200).send('OK');
});

app.listen(3000);
```

## Integration Points

### 1. During `/woterclip-init`

Prompt user:
```
Enable webhooks? (y/n)
  GitHub webhook secret: ________
  Linear webhook secret: ________
```

Add webhook config to generated `.woterclip/config.yaml`.

### 2. During `/heartbeat`

If invoked via webhook:
- Accept optional `--source github` or `--source linear` flag
- Filter inbox to only issues matching webhook event
- Prioritize affected issue over others

Example:
```bash
/heartbeat --source github --issue-number 42
```

### 3. New Command (Future)

```bash
/webhook-setup
  - Display webhook URLs (receiver endpoint must be configured externally)
  - Generate secrets
  - Test connectivity
```

## Security Considerations

1. **Signature Validation** – Always validate HMAC before processing
2. **Secret Rotation** – Rotate webhook secrets periodically
3. **Rate Limiting** – Queue rapid events; don't spawn heartbeat per event
4. **Scope** – Only process issues matching configured team/project
5. **Logging** – Log all webhook events for audit trail

## Edge Cases

### Duplicate Events

GitHub and Linear may resend webhooks on timeout. Solution:
- Cache event ID (GitHub provides `X-GitHub-Delivery` header)
- Receiver deduplicates before triggering heartbeat

### Stale Events

If a webhook arrives after heartbeat already processed the issue:
- Heartbeat will detect no new changes
- Posts "no changes" comment
- Safe and idempotent

### Receiver Unavailable

If webhook receiver is offline:
- GitHub / Linear retry (typically 5 times over 24 hours)
- Fall back to polling heartbeat
- Operator sees webhook failures in Linear webhook delivery logs

## Implementation Roadmap

### Phase 1 (Current – WOT-2)
- Define webhook schemas (GitHub + Linear)
- Specify signature validation
- Document config extension
- Create this reference doc

### Phase 2 (WOT-11 or later)
- Implement example receiver (Node.js / Express)
- Add webhook config to init skill
- Update `/heartbeat` to accept `--source` flag
- End-to-end test (GitHub → receiver → `/heartbeat`)

### Phase 3 (Future)
- Receiver deployment template (Docker, AWS Lambda)
- Web UI for webhook management
- Event history and analytics
- Replay failed events

## Related Tasks

- **WOT-2:** Implement webhook integrations (this task)
- **WOT-14:** Add observability and metrics (webhook event counts, latencies)
- **WOT-12:** Build web dashboard (webhook status, delivery history)

## References

- [GitHub Webhooks Documentation](https://docs.github.com/en/developers/webhooks-and-events/webhooks)
- [Linear Webhooks Documentation](https://developers.linear.app/docs/graphql/webhooks)
- [HMAC-SHA256 Security Best Practices](https://en.wikipedia.org/wiki/HMAC)
