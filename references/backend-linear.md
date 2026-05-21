# Linear Backend Adapter Operations

This reference documents the 11 core operations used by WoterClip to interact with Linear via the Linear MCP tools. Each operation maps directly to Linear MCP tool calls and is extracted from existing patterns in `skills/heartbeat/SKILL.md` and `skills/status/SKILL.md`.

## 1. inbox_query() — List assigned issues

**Purpose:** Fetch all issues assigned to the current user, filtering inbox candidates.

**MCP Tool:** `mcp__claude_ai_Linear__list_issues`

**Parameters:**
- `assignee: "me"` — current user's assigned issues
- `includeArchived: false` — only active issues

**Context from heartbeat (Step 2):**
Call `mcp__claude_ai_Linear__list_issues` with filter for assigned issues (`assignee: "me"`). Client-side filtering then:
- Keep only issues with status "In Progress" or "Todo"
- Skip issues without a persona label (unless Orchestrator is default)
- Skip `agent-blocked` issues unless new human comments exist

**Example usage:**
```
Call mcp__claude_ai_Linear__list_issues with assignee="me"
Apply client-side filters for status, labels, human comments
Sort by status (In Progress > Todo) then priority (Urgent > High > Medium > Low)
Return first issue as next candidate
```

---

## 2. get_issue(display_id) — Fetch full issue record

**Purpose:** Read a single issue's complete data: title, description, labels, status, priority, comments, parent link.

**MCP Tool:** `mcp__claude_ai_Linear__get_issue`

**Parameters:**
- `id` — issue ID or key (e.g., `WOT-42`)
- `includeRelations: true` — fetch parent/child references
- `includeCustomerNeeds: false` — skip unneeded fields

**Context from heartbeat:**
- Step 6: "Call `mcp__claude_ai_Linear__get_issue` to read the issue's current labels."
- Step 7: "Read issue title, description, and all comments via `mcp__claude_ai_Linear__get_issue` and `mcp__claude_ai_Linear__list_comments`."
- Step 10: "Read the issue's current labels via `mcp__claude_ai_Linear__get_issue`, then update based on outcome"

**Example usage:**
```
get_issue("WOT-42")
→ { id, key, title, description, labels: [...], status, priority, comments_count, parent_id, ... }
Used in label read-modify-write cycles and context gathering
```

---

## 3. save_issue(fields) — Create or update issue

**Purpose:** Create a new issue or update an existing issue's fields (labels, status, title, description, parent link).

**MCP Tool:** `mcp__claude_ai_Linear__save_issue`

**Parameters:**
- `id` (optional) — if provided, updates existing; if omitted, creates new
- `title` — issue title (required for create)
- `team` — team ID (required for create)
- `description` — markdown body
- `labels` — array of label IDs (for read-modify-write operations)
- `status` — state name or ID
- `priority` — 0–4 (None, Urgent, High, Medium, Low)
- `parentId` (optional) — parent issue ID for subtasks

**Context from heartbeat:**
- Step 6: "Otherwise, append `agent-working` to the labels array and call `mcp__claude_ai_Linear__save_issue` with the full label set."
- Step 8: "For large scope: create Linear sub-issues via `mcp__claude_ai_Linear__save_issue` with `parentId` set to current issue, `team` from config, and appropriate persona labels"

**Example usage:**
```
// Append label (read-modify-write)
current_labels = get_issue("WOT-42").labels
current_labels.append("agent-working")
save_issue(id="WOT-42", labels=current_labels)

// Create sub-issue
save_issue(title="Sub-task", team="WOT", parentId="WOT-42", labels=["backend"])
```

---

## 4. create_sub_issue(parent_id, fields) — Create child issue

**Purpose:** Create a child issue linked to a parent issue (subtask relationship).

**MCP Tool:** `mcp__claude_ai_Linear__save_issue` with `parentId` parameter

**Parameters:**
- `parentId` — parent issue ID (e.g., `WOT-42`)
- `title` — subtask title (required)
- `team` — team ID (required, from config)
- `labels` — persona label(s) for routing
- `description` — optional context
- `priority` — optional, inherit or explicit

**Context from heartbeat (Step 8):**
"For large scope: create Linear sub-issues via `mcp__claude_ai_Linear__save_issue` with `parentId` set to current issue, `team` from config, and appropriate persona labels"

**Example usage:**
```
save_issue(
  title="Implement database schema",
  team="WOT",
  parentId="WOT-42",
  labels=["backend"]
)
→ Returns new sub-issue WOT-43
```

---

## 5. list_comments(display_id) — Fetch comments for issue

**Purpose:** Retrieve all comments on an issue, used to detect new human input and parse heartbeat counters.

**MCP Tool:** `mcp__claude_ai_Linear__list_comments`

**Parameters:**
- `issueId` — issue ID or key (e.g., `WOT-42`)
- `limit` — max results (default: 50)
- `orderBy` — sort order (default: createdAt ascending)

**Context from heartbeat:**
- Step 2: "Skip `agent-blocked` issues unless new human comments exist since the last agent comment (check via `mcp__claude_ai_Linear__list_comments`)"
- Step 7: "Identify new comments since the last heartbeat (look for comments after the last WoterClip-formatted comment). Parse heartbeat counter: find the last comment matching `Heartbeat #N` pattern."

**Example usage:**
```
list_comments("WOT-42")
→ [ { id, body, user, createdAt }, ... ]

// Detect new human comments
agent_comment_idx = find last comment with "Heartbeat #"
new_comments = comments[agent_comment_idx+1:]
has_human_input = new_comments.any(c => c.user != "WoterClip Agent")
```

---

## 6. save_comment(display_id, body, heartbeat_num, persona) — Append comment

**Purpose:** Post a structured heartbeat comment on an issue, including status, commits, next steps, and agent metadata.

**MCP Tool:** `mcp__claude_ai_Linear__save_comment`

**Parameters:**
- `issueId` — issue ID or key (e.g., `WOT-42`)
- `body` — markdown comment body (must include `Heartbeat #N` pattern)
- No direct heartbeat_num/persona parameters; encode in body

**Context from heartbeat (Step 9):**
"Post a structured comment on the Linear issue via `mcp__claude_ai_Linear__save_comment`. Follow the comment format from `${CLAUDE_PLUGIN_ROOT}/references/comment-format.md`:
- Include `Heartbeat #N` counter (incremented from step 7)
- Include timestamp and duration
- Include persona name in footer
- List commits with SHAs, sub-issues created, and next steps
- For blocked status: name who needs to act (Board user from config `linear.user_name`)"

**Example usage:**
```
body = """
Heartbeat #3
Status: In Progress
Duration: 4m 23s
Commits: feat: add auth endpoint (abc123d)
Blocked: Waiting for design review — @Alex Kim
— *Orchestrator*
"""
save_comment(issueId="WOT-42", body=body)
```

---

## 7. set_state_label(display_id, label) — Set working/blocked/null label

**Purpose:** Apply or remove the agent state labels (`agent-working`, `agent-blocked`) via read-modify-write pattern.

**MCP Tool:** `mcp__claude_ai_Linear__save_issue` (with labels parameter)

**Parameters:**
- `id` — issue ID (e.g., `WOT-42`)
- `labels` — new label array (computed by read-modify-write)

**Context from heartbeat:**
- Step 2: "Detect stale `agent-working` labels: if an issue has `agent-working` but no heartbeat comment within `stale_lock_hours`, clean the stale label (remove `agent-working`, post cleanup comment)."
- Step 5: "Apply `agent-blocked` label (read-modify-write). Remove `agent-working` if present."
- Step 6: "append `agent-working` to the labels array and call `mcp__claude_ai_Linear__save_issue` with the full label set."
- Step 10: "Read the issue's current labels via `mcp__claude_ai_Linear__get_issue`, then update based on outcome:
  - **Completed**: Remove `agent-working`
  - **Blocked**: Remove `agent-working`, add `agent-blocked`
  - **More work needed**: Keep `agent-working`"

**Example usage:**
```
// Add agent-working
current_labels = get_issue("WOT-42").labels
if "agent-working" not in current_labels:
  current_labels.append("agent-working")
  save_issue(id="WOT-42", labels=current_labels)

// Remove agent-working, add agent-blocked
current_labels = get_issue("WOT-42").labels
current_labels.discard("agent-working")
current_labels.append("agent-blocked")
save_issue(id="WOT-42", labels=current_labels)
```

---

## 8. update_state(display_id, state) — Change issue status

**Purpose:** Transition an issue to a new workflow state (e.g., Done, In Review, Todo).

**MCP Tool:** `mcp__claude_ai_Linear__save_issue` (with status parameter)

**Parameters:**
- `id` — issue ID (e.g., `WOT-42`)
- `status` — state name (e.g., "Done", "In Review") or state ID

**Context from heartbeat (Step 10):**
"Read the issue's current labels via `mcp__claude_ai_Linear__get_issue`, then update based on outcome:
- **Completed** | Remove `agent-working` | Move to Done (or In Review if PR opened)
- **Blocked** | Remove `agent-working`, add `agent-blocked` | Keep In Progress
- **More work needed** | Keep `agent-working` | Keep In Progress"

**Example usage:**
```
// Mark completed
save_issue(id="WOT-42", status="Done")

// Mark for review (if PR opened)
save_issue(id="WOT-42", status="In Review")
```

---

## 9. has_new_human_comments(display_id) — Boolean check for human input

**Purpose:** Determine if an issue has new comments from humans since the last agent heartbeat (used to unblock `agent-blocked` issues).

**MCP Tool:** `mcp__claude_ai_Linear__list_comments`

**Parameters:**
- `issueId` — issue ID (e.g., `WOT-42`)

**Computed logic (not a direct tool):**
1. Call `list_comments(issueId)`
2. Find the last comment matching the heartbeat pattern (`Heartbeat #N`)
3. Check if any comments after that are from non-agent users
4. Return boolean

**Context from heartbeat (Step 2):**
"Skip `agent-blocked` issues unless new human comments exist since the last agent comment (check via `mcp__claude_ai_Linear__list_comments`)"

**Example usage:**
```
comments = list_comments("WOT-42")
last_agent_idx = find_last(comments, c => c.body contains "Heartbeat #")
has_new_human = comments[last_agent_idx+1:].any(c => c.user != "WoterClip Agent")
return has_new_human
```

---

## 10. detect_stale_working(hours) — Find issues locked too long

**Purpose:** Identify issues with `agent-working` label but no heartbeat comment within a threshold duration, indicating a stale lock.

**MCP Tool:** `mcp__claude_ai_Linear__list_issues` + `mcp__claude_ai_Linear__list_comments`

**Parameters:**
- `stale_lock_hours` — threshold from config (e.g., 24 hours)
- `assignee: "me"` — current user

**Computed logic (not a direct tool):**
1. Call `list_issues(assignee="me")`
2. Filter for issues with `agent-working` label
3. For each, call `list_comments(issueId)`
4. Find last comment matching `Heartbeat #N` pattern
5. If last heartbeat is older than `stale_lock_hours`, flag as stale
6. Return list of stale issue IDs

**Context from heartbeat (Step 2):**
"Detect stale `agent-working` labels: if an issue has `agent-working` but no heartbeat comment within `stale_lock_hours`, clean the stale label (remove `agent-working`, post cleanup comment)."

**Example usage:**
```
stale_issues = []
for issue in list_issues(assignee="me"):
  if "agent-working" in issue.labels:
    comments = list_comments(issue.id)
    last_heartbeat_time = extract_heartbeat_timestamp(comments)
    if now - last_heartbeat_time > hours(24):
      stale_issues.append(issue.id)
return stale_issues
```

---

## 11. next_heartbeat_number(display_id) — Derive next heartbeat counter

**Purpose:** Parse the last heartbeat comment to determine the next heartbeat counter (`N+1`), or return `1` if none found.

**MCP Tool:** `mcp__claude_ai_Linear__list_comments`

**Parameters:**
- `issueId` — issue ID (e.g., `WOT-42`)

**Computed logic (not a direct tool):**
1. Call `list_comments(issueId)`
2. Search comments in reverse order for pattern `Heartbeat #N`
3. Extract `N` from the first match found
4. Return `N + 1`, or `1` if no match

**Context from heartbeat (Step 7):**
"Parse heartbeat counter: find the last comment matching `Heartbeat #N` pattern. Next comment will be `#N+1`. If none found, start at `#1`."

**Example usage:**
```
comments = list_comments("WOT-42")
for comment in reversed(comments):
  match = re.search(r"Heartbeat #(\d+)", comment.body)
  if match:
    return int(match.group(1)) + 1
return 1  // No prior heartbeat found
```

---

## Reference: Read-Modify-Write Pattern for Labels

Many operations above rely on a common pattern for safe label updates:

```
1. get_issue(issue_id)  → read current label array
2. Modify array (append, remove, etc.)
3. save_issue(id=issue_id, labels=modified_array)  → write full set
```

This ensures atomicity and prevents losing labels modified concurrently. Always use this pattern when updating labels.

---

## Reference: Comment Format Pattern

Heartbeat comments must follow the structure from `references/comment-format.md` and include:
- `Heartbeat #N` — counter line (required for parsing by operations 9, 10, 11)
- Timestamp and duration
- Persona name in footer
- Action list (commits, sub-issues, next steps)
- Escalation name (@user) if blocked

Detailed template: `${CLAUDE_PLUGIN_ROOT}/references/comment-format.md`
