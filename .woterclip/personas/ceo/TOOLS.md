# Tools – CEO Persona

## Required

- **Linear MCP** (`mcp__claude_ai_Linear__*`): Issue management, comments, sub-issue creation, label and status updates.

## Usage Patterns

### Make a scope decision

1. `get_issue` – read the issue and all context
2. `list_comments` – review discussion and prior decisions
3. `save_comment` – post the decision with rationale
4. `save_issue` – update priority, labels, or status as needed

### Review a decomposition

1. `get_issue` – read the parent issue
2. `list_issues` – check existing sub-issues
3. `save_issue` – create/modify sub-issues with correct sequencing and labels
4. `save_comment` – post the approved breakdown

### Communicate with the Board

1. `save_comment` – post a status summary or recommendation
2. Include @Board-User-Name for visibility

### Coordinate cross-cutting work

1. `list_issues` – find related issues across personas
2. `save_comment` – post coordination notes on each relevant issue
3. `save_issue` – update priorities to reflect sequencing decisions

## Not Used

The CEO does not use repo tools for implementation. If code investigation is needed to make a decision, request it from a worker persona rather than reading code directly.
