# TOOLS.md — Backlog Groomer Tools

## Codebase Reading (understanding scope and context)

- **Read** — Read source files to understand impact (e.g., how many handlers call a failing API endpoint?)
- **Grep** — Search for patterns (e.g., "find all TODOs", "which tests cover this module?")
- **Glob** — List files to understand scope (e.g., "how many frontend components exist?")

## Adapter Operations (managing backlog state)

All operations from the backend adapter (Linear or SQLite):

1. **inbox_query()** — Fetch new/unprocessed issues
2. **get_issue(id)** — Read full issue record (context, links, comments)
3. **save_issue(fields)** — Create or update issues (title, description, priority, labels, state)
4. **create_sub_issue(parent_id, fields)** — Create child issues (decomposition)
5. **list_comments(id)** — Read comments and feedback
6. **save_comment(id, body)** — Post grooming notes or suggestions
7. **set_state_label(id, label)** — Set agent state (not used in grooming, but available)
8. **update_state(id, state)** — Change issue lifecycle state (e.g., "backlog" → "todo")
9. **get_issue(id) + save_issue() pattern** — Read-modify-write for label updates

## NOT Available

- **Write/Edit** — Do not modify source code
- **Bash execution** — Do not run scripts or tests
- Deployment or PR merge tools

## Typical Grooming Workflow

```
1. inbox_query() → fetch unprocessed issues
2. For each issue:
   a. get_issue(id) → read context, current state
   b. Assess clarity, scope, routing, dependencies
   c. save_comment() → post grooming suggestion if needed
   d. save_issue() → apply labels, update priority, decompose
   e. create_sub_issue() → create breakdowns for complex work
3. list_comments() → check for clarifications from humans
4. update_state() → move to "ready" if criteria met
```

## Example Operations

```
# Get new issues
issues = inbox_query()

# Read an issue for assessment
issue = get_issue("WOT-42")
comments = list_comments("WOT-42")

# Apply labels (read-modify-write)
labels = issue.labels
labels.append("backend")
save_issue(id="WOT-42", labels=labels)

# Post grooming note
save_comment(id="WOT-42", body="""
Grooming feedback:
- Needs acceptance criteria (how do we know this is done?)
- Suggested split: Data migration in WOT-99, API in WOT-100
— *Backlog Groomer*
""")

# Create sub-issue
create_sub_issue(
  parent_id="WOT-42",
  title="Data migration for payments",
  description="Backfill existing transactions",
  labels=["backend"],
  priority=2  # High
)

# Mark issue as ready (if criteria met)
update_state(id="WOT-42", state="ready")
```

## Context: Backend Integration

Consult `${CLAUDE_PLUGIN_ROOT}/references/backend-linear.md` or `backend-sqlite.md` for full operation signatures and error handling.
