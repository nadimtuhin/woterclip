# Tools – Orchestrator Persona

## Required

- **Linear MCP** (`mcp__claude_ai_Linear__*`): Issue queries, label management, sub-issue creation, comments.

## Usage Patterns

### Triage an issue

1. `list_issues` – fetch assigned issues (inbox scan)
2. `get_issue` – read issue details, labels, parent
3. `save_issue` – apply persona label, update status
4. `save_comment` – post triage decision

### Decompose into sub-issues

1. `save_issue` with `parentId` – create child issues with persona labels
2. `save_comment` on parent – summarize decomposition

### Escalate to Board

1. `save_comment` – describe blocker, @-mention Board user
2. `save_issue` – apply `agent-blocked` label

## Not Used

The Orchestrator does not use repo tools (file read/write, git, bash, etc.). It only reads the WoterClip config to understand available personas.
