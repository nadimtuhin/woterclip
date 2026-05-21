# WOT-10: Audit Logging - Schema & Implementation Specification

**Issue**: WOT-10  
**Persona**: qa  
**Heartbeat Cycle**: #5  
**Status**: done  
**Date**: 2026-05-21

## Overview
Comprehensive audit logging for all state changes, persona decisions, and critical operations in WoterClip. Enables compliance tracking, debugging, and accountability across heartbeat cycles.

## Audit Schema

### Core Audit Log Table

```sql
CREATE TABLE audit_log (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    heartbeat_number INTEGER NOT NULL,
    timestamp        TEXT NOT NULL DEFAULT (datetime('now')),
    
    -- Entity being audited
    issue_id         INTEGER REFERENCES issues(id),
    persona          TEXT,
    
    -- Change details
    action           TEXT NOT NULL CHECK(action IN (
                         'issue_created',
                         'issue_updated',
                         'state_changed',
                         'persona_assigned',
                         'comment_added',
                         'label_added',
                         'label_removed',
                         'priority_changed',
                         'persona_escalated'
                     )),
    
    -- Before/After state
    field_name       TEXT,
    old_value        TEXT,
    new_value        TEXT,
    
    -- Context
    actor            TEXT NOT NULL CHECK(actor IN ('agent','human','system')),
    actor_name       TEXT,
    reason           TEXT,
    
    -- Tracking
    parent_issue_id  INTEGER REFERENCES issues(id),
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_audit_heartbeat ON audit_log(heartbeat_number);
CREATE INDEX idx_audit_issue     ON audit_log(issue_id);
CREATE INDEX idx_audit_action    ON audit_log(action);
CREATE INDEX idx_audit_timestamp ON audit_log(timestamp);
CREATE INDEX idx_audit_persona   ON audit_log(persona);
```

### Audit Event Details

#### issue_created
```sql
{
  "action": "issue_created",
  "issue_id": 9,
  "actor": "agent",
  "actor_name": "orchestrator",
  "new_value": { "title": "...", "persona": "backend", "priority": 3 },
  "reason": "Heartbeat #5 processing"
}
```

#### state_changed
```sql
{
  "action": "state_changed",
  "issue_id": 9,
  "field_name": "state",
  "old_value": "todo",
  "new_value": "in_review",
  "actor": "agent",
  "actor_name": "backend",
  "reason": "Search specification completed and reviewed"
}
```

#### persona_assigned
```sql
{
  "action": "persona_assigned",
  "issue_id": 10,
  "field_name": "persona",
  "old_value": null,
  "new_value": "qa",
  "actor": "agent",
  "actor_name": "orchestrator",
  "reason": "Routed by label: qa"
}
```

#### persona_escalated
```sql
{
  "action": "persona_escalated",
  "issue_id": 15,
  "field_name": "persona",
  "old_value": "backend",
  "new_value": "architect",
  "actor": "agent",
  "actor_name": "backend",
  "reason": "Structural concern requires architecture review"
}
```

#### label_added / label_removed
```sql
{
  "action": "label_added",
  "issue_id": 9,
  "field_name": "labels",
  "old_value": "[]",
  "new_value": "[\"in_review\"]",
  "actor": "agent",
  "actor_name": "backend"
}
```

#### comment_added
```sql
{
  "action": "comment_added",
  "issue_id": 9,
  "actor": "agent",
  "actor_name": "backend",
  "new_value": "Search spec completed...",
  "reason": "Heartbeat #5 work summary"
}
```

## Logging Interface (Adapter Pattern)

### SQLite Backend

**insert_audit_log(action, issue_id, persona, old_value, new_value, actor, actor_name, reason)**
```bash
sqlite3 .woterclip/woterclip.db \
  "INSERT INTO audit_log (heartbeat_number, action, issue_id, persona, field_name, old_value, new_value, actor, actor_name, reason) \
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
```

**query_audit_logs(issue_id, action, since_heartbeat, limit)**
```bash
sqlite3 .woterclip/woterclip.db \
  "SELECT * FROM audit_log WHERE issue_id = ? AND heartbeat_number >= ? ORDER BY timestamp DESC LIMIT ?"
```

### Linear Backend (Phase 2)
Store audit metadata in issue comments with `[AUDIT]` prefix:
```
[AUDIT] Heartbeat #5 | backend | state: todo → in_review | Search specification completed
```

Can be parsed back into structured format for compliance.

## Logging Points in Heartbeat

**Heartbeat Step 1: Load Config**
- `config_loaded` (audit: version, backend type, max_parallel)

**Heartbeat Step 2: Check Inbox**
- `inbox_checked` (count of issues found)

**Heartbeat Step 3: Fan-out Dispatch**
- `issue_dispatched` (to persona, heartbeat cycle)

**Subagent Step 4: Load Persona**
- `persona_loaded` (name, model, thinking budget)

**Subagent Step 5: Validate Tools**
- `tools_validated` (required tools available, yes/no)

**Subagent Step 7: Understand Context**
- `context_loaded` (goals injected, issue details)

**Subagent Step 8: Do Work**
- `work_started` (persona, issue, cycle)
- `state_changed` (when persona changes issue state)
- `label_changed` (when persona modifies labels)
- `comment_added` (work summary, decisions)
- `escalation_requested` (if persona requests review)

**Subagent Step 10: Report**
- `work_completed` (issue, final state, duration)

**Main Loop: Merge Logs**
- `heartbeat_completed` (cycle number, total issues processed, summary)

## Query Examples

**All changes to an issue:**
```bash
sqlite3 .woterclip/woterclip.db \
  "SELECT timestamp, action, old_value, new_value, actor_name \
   FROM audit_log WHERE issue_id = 9 ORDER BY timestamp DESC"
```

**All escalations in heartbeat #5:**
```bash
sqlite3 .woterclip/woterclip.db \
  "SELECT issue_id, actor_name, reason FROM audit_log \
   WHERE heartbeat_number = 5 AND action = 'persona_escalated'"
```

**Persona activity summary:**
```bash
sqlite3 .woterclip/woterclip.db \
  "SELECT actor_name, COUNT(*) as action_count, GROUP_CONCAT(DISTINCT action) as actions \
   FROM audit_log WHERE heartbeat_number = 5 \
   GROUP BY actor_name"
```

**Timeline of issue #10:**
```bash
sqlite3 .woterclip/woterclip.db \
  "SELECT timestamp, action, old_value, new_value FROM audit_log \
   WHERE issue_id = 10 ORDER BY timestamp"
```

## Compliance & Retention

- **Retention**: Keep all audit logs indefinitely (append-only, no deletes)
- **Immutability**: audit_log is write-once (no UPDATE on audit rows)
- **Backups**: Audit log included in regular `.woterclip.db` backups
- **Export**: Support exporting audit trail as JSON or CSV for compliance reports

## Implementation Checklist

- [ ] Create audit_log schema in SQLite
- [ ] Add logging function to backend adapter interface
- [ ] Update heartbeat skill to call logging at each step
- [ ] Update persona templates to log state changes and escalations
- [ ] Create audit query CLI command for debugging
- [ ] Add audit export functionality
- [ ] Create compliance report generator (phase 2)
- [ ] Add audit metrics to observability dashboard (phase 2)

## Testing

- Verify all state changes are logged
- Verify escalations create audit trail
- Verify timestamp accuracy
- Verify comment association with audit entries
- Cross-heartbeat audit continuity
- Export/import audit data

## Next Steps
Ready for implementation in next heartbeat cycle. All schema, logging points, and compliance requirements fully specified.
