# Webhook Event Routing Reference

**Date:** 2026-05-21  
**Author:** Backend Persona (Cycle 41, Heartbeat 41)  
**Linear:** [WOT-2](https://linear.app/wotai/issue/WOT-2/implement-webhook-integrations-for-github-and-linear)

## Overview

This document defines how webhook events from GitHub and Linear are routed to WoterClip's heartbeat system for event-driven processing.

## Event Routing Strategy

### Routing Decision Tree

```
Webhook Event
  ↓
Parse Event Payload
  ↓
  ├─ Source = GitHub?
  │   ├─ Action = opened/edited → Extract labels → Map to persona
  │   ├─ Action = closed → Map to "done" state
  │   └─ Action = labeled/unlabeled → Extract new labels → Update persona
  │
  ├─ Source = Linear?
  │   ├─ Action = create → Extract labels → Map to persona
  │   ├─ Action = update → Extract state/labels → Update persona or state
  │   └─ Action = archive → Map to "done" state
  │
  └─ Unmapped Event → Log as unhandled, return 200 OK (non-blocking)

Route to Heartbeat with Context
  ↓
/heartbeat --source {github|linear} --issue-{number|id} [--priority HIGH]
  ↓
Heartbeat processes issue with persona from label
```

## GitHub Event Routing

### Issue Events

**Event: `issues.opened`**

```json
{
  "action": "opened",
  "issue": {
    "number": 42,
    "title": "Implement webhook support",
    "body": "Add webhook integration for GitHub and Linear...",
    "labels": [
      { "name": "backend" },
      { "name": "feature" }
    ],
    "assignee": { "login": "alice" },
    "state": "open"
  },
  "repository": {
    "name": "woterclip",
    "owner": { "login": "wotai-dev" }
  }
}
```

**Routing:**
- Extract `issue.labels[0].name` → persona label (e.g., `backend`)
- Extract `issue.number` → GitHub issue number
- Map GitHub issue number to Linear issue ID (if synced)
- Trigger: `/heartbeat --source github --issue-number 42`

**Processing:**
- Heartbeat loads `backend` persona
- Persona processes GitHub issue (create Linear issue if needed, or sync)
- Update issue state based on persona work

---

**Event: `issues.edited`**

```json
{
  "action": "edited",
  "issue": {
    "number": 42,
    "title": "Implement webhook support (updated)",
    "body": "Add webhook integration...",
    "labels": [{ "name": "backend" }],
    "state": "open"
  }
}
```

**Routing:**
- Extract `issue.number` → GitHub issue number
- Trigger: `/heartbeat --source github --issue-number 42 --priority HIGH`
- Add `--priority HIGH` for edits (owner changed task, likely urgent)

**Processing:**
- Heartbeat checks if labels changed
- If persona label changed, re-route to new persona
- Update Linear issue description from GitHub

---

**Event: `issues.closed`**

```json
{
  "action": "closed",
  "issue": {
    "number": 42,
    "title": "Implement webhook support",
    "state": "closed",
    "labels": [{ "name": "backend" }]
  }
}
```

**Routing:**
- Extract `issue.number` → GitHub issue number
- Trigger: `/heartbeat --source github --issue-number 42`

**Processing:**
- Heartbeat maps GitHub state `closed` → Linear state `done`
- Updates issue state in Linear to match GitHub

---

**Event: `issues.labeled` / `issues.unlabeled`**

```json
{
  "action": "labeled",
  "issue": {
    "number": 42,
    "labels": [
      { "name": "backend" },
      { "name": "urgent" }
    ]
  },
  "label": { "name": "urgent" }
}
```

**Routing:**
- Extract `issue.number` → GitHub issue number
- Extract first persona label from `issue.labels[*].name` (e.g., `backend`)
- Trigger: `/heartbeat --source github --issue-number 42`

**Processing:**
- Heartbeat checks if persona label changed
- If new label added (e.g., `urgent`), update issue priority
- If label removed, update Linear issue accordingly

---

### Issue Comment Events

**Event: `issue_comment.created`**

```json
{
  "action": "created",
  "issue": {
    "number": 42,
    "title": "Implement webhook support",
    "labels": [{ "name": "backend" }]
  },
  "comment": {
    "id": 12345,
    "user": { "login": "alice" },
    "body": "Can this be done by Friday?",
    "created_at": "2026-05-21T10:00:00Z"
  },
  "repository": { "name": "woterclip" }
}
```

**Routing:**
- Extract `issue.number` → GitHub issue number
- Extract persona label → route to appropriate persona
- Trigger: `/heartbeat --source github --issue-number 42`

**Processing:**
- Heartbeat syncs comment to Linear issue as comment
- If comment mentions blocking condition, may escalate to CEO persona

---

## Linear Event Routing

### Issue Events

**Event: `Issue.created`**

```json
{
  "action": "create",
  "type": "Issue",
  "data": {
    "id": "WOT-42",
    "title": "Implement webhook support",
    "description": "Add webhook integration for GitHub and Linear...",
    "state": { "name": "Backlog" },
    "priority": { "priority": 2 },
    "labels": [
      { "name": "backend" }
    ],
    "assignee": { "id": "user-123", "name": "Alice" },
    "team": { "name": "wotai" }
  },
  "teamId": "wotai",
  "userId": "user-123"
}
```

**Routing:**
- Extract `data.id` → Linear issue ID (e.g., `WOT-42`)
- Extract `data.labels[0].name` → persona label (e.g., `backend`)
- Trigger: `/heartbeat --source linear --issue-id WOT-42`

**Processing:**
- Heartbeat loads `backend` persona
- Persona processes issue (may create sub-issues, QA issues, etc.)
- Post comment with status

---

**Event: `Issue.updated`**

```json
{
  "action": "update",
  "type": "Issue",
  "data": {
    "id": "WOT-42",
    "title": "Implement webhook support",
    "state": { "name": "In Progress" },
    "labels": [{ "name": "backend" }],
    "updatedAt": "2026-05-21T10:30:00Z"
  },
  "teamId": "wotai",
  "userId": "user-123",
  "changedFields": ["state", "title"]
}
```

**Routing:**
- Extract `data.id` → Linear issue ID
- Check `changedFields`:
  - If state changed → may trigger completion workflow
  - If labels changed → may re-route to new persona
  - If assignee changed → may escalate or change priority
- Trigger: `/heartbeat --source linear --issue-id WOT-42`

**Processing:**
- Heartbeat checks what changed
- If persona label changed, route to new persona
- If state changed to "In Progress", alert assigned persona
- If state changed to "Done", archive and post summary

---

**Event: `Issue.archived`**

```json
{
  "action": "archive",
  "type": "Issue",
  "data": {
    "id": "WOT-42",
    "title": "Implement webhook support",
    "state": { "name": "Done" },
    "labels": [{ "name": "backend" }]
  },
  "teamId": "wotai",
  "userId": "user-123"
}
```

**Routing:**
- Extract `data.id` → Linear issue ID
- Trigger: `/heartbeat --source linear --issue-id WOT-42`

**Processing:**
- Heartbeat maps Linear "Done" state to `done`
- Archives issue in local database
- Posts completion comment with final status

---

## Persona Label Mapping

**GitHub & Linear both support labels → persona mapping:**

| Label | Persona | Behavior |
|-------|---------|----------|
| `backend` | Backend Worker | Implement backend features, APIs, infrastructure |
| `frontend` | Frontend Worker | Implement UI, pages, components |
| `architect` | Architect | Review designs, approve architecture decisions |
| `qa` | QA Tester | Test acceptance criteria, validate implementation |
| `ceo` | CEO | Strategic decisions, roadmap, escalations |
| (none) | Orchestrator | Default router for unlabeled issues |

**Routing Rules:**

1. **Single Persona Per Issue** – Use first label in `labels[*]` array
2. **Case Insensitive** – `Backend` = `backend` = `BACKEND`
3. **Default to Orchestrator** – If no persona label, use orchestrator (default router)
4. **Label Changes** – If persona label added/removed, re-route:
   - Old persona: "Reassigned to {new_persona}, closing"
   - New persona: "Picked up from {old_persona}"

---

## Event Priority Hints

**High Priority Events** (priority flag passed to heartbeat):

- `issues.edited` (owner changed task, likely urgent)
- `issue_comment.created` with keywords: "urgent", "blocking", "ASAP", "critical"
- Linear: `priority.priority` < 3 (Urgent or High)
- Linear: `state.name` == "In Progress" (already being worked on)

**Normal Priority Events:**

- `issues.opened` (new issue, normal backlog priority)
- `Issue.created` (new issue, normal priority)
- Issue comment without priority keywords

**Deferred Events** (can batch or queue):

- `issues.labeled` / `issues.unlabeled` (metadata, not blocking)
- `issue_comment.created` (discussion, not blocking work)

---

## Cross-Platform Synchronization

### GitHub ↔ Linear Sync

**Bidirectional Mapping:**

```
GitHub Issue #42
  ├─ Title: "Implement webhook support"
  ├─ State: "open" → Linear "In Progress"
  ├─ Labels: ["backend"] → Linear persona "backend"
  ├─ Comments: → Linear issue comments
  └─ Assignee: → Linear assignee

Linear Issue WOT-42
  ├─ Title: "Implement webhook integrations"
  ├─ State: "In Progress" → GitHub "open"
  ├─ Labels: ["backend"] → GitHub "backend" label
  ├─ Comments: → GitHub issue comments
  └─ Assignee: → GitHub assignee
```

**Sync Rules:**

1. **State Mapping:**
   - GitHub: `open` ↔ Linear: `In Progress`, `Todo`
   - GitHub: `closed` ↔ Linear: `Done`, `Canceled`

2. **Comment Sync:**
   - GitHub comment → Add to Linear issue comments
   - Linear comment → May post to GitHub PR or issue (future)

3. **Label Sync:**
   - GitHub label → Linear label (with namespace, e.g., `github:backend`)
   - Linear label → GitHub label (strip namespace)

4. **Avoid Ping-Pong:**
   - Receiver deduplicates events (5-min TTL)
   - Heartbeat checks if state actually changed before updating

---

## Unhandled Events (Graceful Degradation)

Events that WoterClip doesn't process are logged but don't fail:

```javascript
const UNHANDLED_EVENTS = [
  'issues.reopened',        // Will process as issue.edited
  'issue_comment.edited',   // Not critical, ignore
  'issue_comment.deleted',  // Not critical, ignore
  'pull_request.*',         // GitHub PRs not in scope
  'Issue.removed',          // Not a standard Linear event
];

// Receiver logs unhandled events for awareness
if (UNHANDLED_EVENTS.includes(eventType)) {
  log('info', 'Unhandled webhook event', { 
    event_type: eventType,
    source: 'github|linear',
    note: 'Not yet integrated, can be added if needed'
  });
  return res.status(200).json({ status: 'acknowledged' });
}
```

---

## Testing Event Routing

### Manual Testing

**Test GitHub webhook payload:**

```bash
# 1. Create test payload (issues.opened)
PAYLOAD='{"action":"opened","issue":{"number":42,"title":"Test","labels":[{"name":"backend"}],"state":"open"}}'

# 2. Compute signature
SECRET="test-secret"
SIGNATURE="sha256=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" -hex | cut -d' ' -f2)"

# 3. POST to receiver
curl -X POST http://localhost:3000/webhooks/github \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: $SIGNATURE" \
  -H "X-GitHub-Delivery: test-123" \
  -d "$PAYLOAD"

# 4. Verify in database
sqlite3 .woterclip/woterclip.db \
  "SELECT * FROM webhook_queue WHERE event_id LIKE 'github%' ORDER BY id DESC LIMIT 1;"
```

**Test Linear webhook payload:**

```bash
# 1. Create test payload (Issue.created)
PAYLOAD='{"action":"create","data":{"id":"WOT-42","title":"Test","labels":[{"name":"backend"}],"state":{"name":"In Progress"}}}'

# 2. Compute signature (with timestamp)
SECRET="test-secret"
TIMESTAMP=$(date +%s)
MESSAGE="$TIMESTAMP.$PAYLOAD"
SIGNATURE="v1,$(echo -n "$MESSAGE" | openssl dgst -sha256 -hmac "$SECRET" -hex | cut -d' ' -f2)"

# 3. POST to receiver
curl -X POST http://localhost:3000/webhooks/linear \
  -H "Content-Type: application/json" \
  -H "X-Linear-Signature: $SIGNATURE" \
  -H "X-Linear-Signature-Timestamp: $TIMESTAMP" \
  -d "$PAYLOAD"

# 4. Verify in database
sqlite3 .woterclip/woterclip.db \
  "SELECT * FROM webhook_queue WHERE source='linear' ORDER BY id DESC LIMIT 1;"
```

---

## Related Issues

- **WOT-2:** This task – webhook event routing implementation
- **WOT-15:** E2E test suite for webhook → heartbeat flow
- **WOT-22:** Add metrics and observability to webhook processing
- **WOT-23:** Webhook event replay API (recovery from failures)

## References

- `references/webhooks-integration.md` – Overall webhook architecture
- `references/webhook-receiver-reference.js` – HTTP listener implementation
- `references/webhook-queue-infrastructure.md` – Queue design and Phase 2/3 roadmap
- `skills/webhook-handler/SKILL.md` – Deployment and usage guide
