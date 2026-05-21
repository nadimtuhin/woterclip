---
name: heartbeat
description: This skill should be used when the user asks to "run a heartbeat", "run the agent loop", "process Linear issues", "check for work", or runs the /heartbeat command. Executes the WoterClip heartbeat — picks up issues, resolves personas, does work, and reports back. Adapter-agnostic: delegates all issue operations to backend-specific adapters (Linear or SQLite).
version: 0.2.0
---

# WoterClip Heartbeat (Adapter Pattern)

Execute the WoterClip heartbeat cycle: pick up issues, resolve the right persona, do the work, and report back with structured comments. This skill is backend-agnostic; it delegates all issue operations (inbox queries, state changes, comments) to backend-specific adapter reference files.

**Arguments:**
- `--dry-run` — Show what would be picked up without doing work
- `--persona <name>` — Only pick issues matching a specific persona

**Adapter Reference files** (consulted dynamically during execution):
- `.woterclip/config.yaml` contains `backend: linear` or `backend: sqlite`
- Load appropriate adapter: `${CLAUDE_PLUGIN_ROOT}/references/backend-linear.md` or `${CLAUDE_PLUGIN_ROOT}/references/backend-sqlite.md`
- All operations (inbox_query, get_issue, set_state_label, save_comment, etc.) are invoked via adapter patterns
- Comment formatting: `${CLAUDE_PLUGIN_ROOT}/references/comment-format.md`

## Step 1: Load Config & Lock

1. Read `.woterclip/config.yaml`. If missing, stop and instruct the user to run `/woterclip-init`.
2. **Check and validate config version:**
   - If `version: 1` detected (old Linear-only format), perform migration:
     - Back up config: `cp .woterclip/config.yaml .woterclip/config.yaml.bak`
     - Add field: `backend: linear` (preserving existing Linear behavior)
     - Update `version: 2`
     - Save and log: "Migrated config from v1 to v2 (backend: linear)"
   - If `version: 2` and `backend` field missing, stop: "Config v2 requires backend field. Run /woterclip-init to scaffold."
3. **Load appropriate adapter reference:**
   - If `backend: sqlite` → open `${CLAUDE_PLUGIN_ROOT}/references/backend-sqlite.md` in mental context
   - If `backend: linear` → open `${CLAUDE_PLUGIN_ROOT}/references/backend-linear.md` in mental context
4. Check for lockfile at `.woterclip/.heartbeat-lock`.
   - If lockfile exists and is **less than** `stale_lock_hours` old → stop with message: "Previous heartbeat still active. Skipping."
   - If lockfile exists and is **older than** `stale_lock_hours` → delete it, log: "Cleaned stale lockfile."
   - If no lockfile → proceed.
5. Create lockfile with current ISO timestamp.
6. **On any exit path** (success, error, or early return), **always delete the lockfile**.

Check quiet hours: if `quiet_hours.enabled` and current time is within the quiet window:
- `behavior: "skip"` → delete lockfile and exit with message: "Quiet hours active. Skipping."
- `behavior: "triage-only"` → proceed but only load Orchestrator persona (skip worker personas in step 4).

## Step 2: Check Inbox

1. **Invoke adapter operation `inbox_query()`:**
   - The adapter reference shows the implementation: Linear backend uses `list_issues(assignee="me")`; SQLite uses specific SQL query
   - See the open adapter reference for the exact implementation
2. **Client-side filtering** (same for both backends):
   - **Keep** only issues with status "In Progress" or "Todo" (or equivalent state)
   - **Skip** issues without a persona label (unless Orchestrator is default and issue has no label)
   - **Skip** `agent-blocked` issues **unless** new human comments exist since last agent comment
     - Use adapter operation `has_new_human_comments(display_id)` to check
3. **Sort results** (same for both backends):
   - Primary: status — In Progress before Todo
   - Secondary: priority — Urgent > High > Medium > Low > None
4. **Detect and clean stale locks** via adapter operation `detect_stale_working(hours)`:
   - If issue has `agent-working` but no heartbeat comment within `stale_lock_hours`, clean it:
     - Invoke `set_state_label(display_id, NULL)` to unlock
     - Post cleanup comment via `save_comment()` explaining stale cleanup

## Step 3: Pick Issue

1. If `--persona <name>` flag is set, filter to only issues matching that persona's label.
2. Pick the first issue from the sorted inbox.
3. If `--dry-run`, report what would be picked and exit:
   ```
   Dry run — would pick:
     WOT-XX [backend] "Issue title" (In Progress, High)
   Queue:
     WOT-YY [frontend] "Other issue" (Todo, Medium)
   ```
4. If no issues match → delete lockfile and exit: "No issues in queue. Heartbeat complete."

## Step 4: Resolve Persona

1. Use adapter operation `get_issue(display_id)` to fetch full issue record.
2. Read the issue's labels/persona field. Find the persona label by matching against the `personas` map in config.
3. If no persona label found → load the persona with `is_default: true` (typically Orchestrator).
4. Load persona files from `.woterclip/<persona.path>/`:
   - `SOUL.md` → inject into context as identity instructions
   - `TOOLS.md` → inject into context as tool guidance
   - `config.yaml` → read runtime settings

Apply runtime config from persona's `config.yaml`:
- `model` — note the target model (informational; cannot switch mid-session)
- `thinking_effort` — apply if supported
- `max_turns` — respect as work budget
- `enable_chrome` — note for browser-dependent tasks

## Step 5: Validate Tools

Read `required_tools` from persona config. For each entry, verify the tool prefix is available:
- `mcp__claude_ai_Linear` should match any tool starting with `mcp__claude_ai_Linear__`
- If a required tool prefix has **no matching tools** available → stop work on this issue immediately
  - Post a blocked comment naming the missing tool via adapter `save_comment()`
  - Apply `agent-blocked` label via adapter `set_state_label(display_id, 'blocked')`
  - Remove `agent-working` if present (same `set_state_label` call)
  - Proceed to step 11 (next issue)

## Step 6: Lock Issue

1. Use adapter operation `get_issue(display_id)` to read current labels/state.
2. If `agent-working` is already present (from a previous heartbeat on same issue), proceed without re-locking.
3. Otherwise, invoke adapter operation `set_state_label(display_id, 'working')` to lock.

## Step 7: Understand Context

1. Use adapter operations:
   - `get_issue(display_id)` — read title, description, persona, full issue record
   - `list_comments(display_id)` — fetch all comments, ordered chronologically
2. If the issue has a parent, use `get_issue(parent_id)` to fetch parent context.
3. Identify new comments since the last heartbeat (look for comments after the last WoterClip-formatted comment).
4. **Parse heartbeat counter** via adapter operation `next_heartbeat_number(display_id)`:
   - Returns `N` where last agent comment was `Heartbeat #N`
   - Next comment will be `#N+1`
   - If no prior heartbeat, returns `1`

## Step 8: Do Work

Follow the persona's SOUL.md instructions. This step varies by persona:

**Orchestrator persona:** Triage the issue – apply persona labels, create sub-issues, or escalate. Never write code.

**CEO persona:** Make strategic decisions – prioritization, scope, architecture, coordination. Never write code.

**Worker personas (backend, frontend, etc.):**
- Use repo tools (Read, Write, Edit, Bash, Grep, Glob) to implement changes
- For large scope: create sub-issues via adapter operation `create_sub_issue(parent_id, fields)`
- For small scope: work directly, use internal tasks to track progress
- Commit changes with descriptive conventional commit messages
- Respect `max_turns` from persona config as a work budget

**If adapter becomes unavailable mid-work:** Stop immediately. Leave `agent-working` label in place (will be cleaned as stale on next heartbeat). Delete lockfile and exit with error log.

## Step 9: Report

Post a structured comment via adapter operation `save_comment(display_id, body, heartbeat_number, persona)`.

Follow the comment format from `${CLAUDE_PLUGIN_ROOT}/references/comment-format.md`:
- Include `Heartbeat #N` counter (from `next_heartbeat_number()` in step 7)
- Include timestamp and duration
- Include persona name in footer
- List commits with SHAs, sub-issues created, and next steps
- For blocked status: name who needs to act
  - Use `board.user_name` from config if set
  - Fallback: use `linear.user_name` (for backwards compat with v1 configs)

Append heartbeat metadata to `.woterclip/heartbeat-log.jsonl`:
```json
{"heartbeat": N, "timestamp": "ISO", "issue": "WOT-XX", "persona": "name", "duration_sec": N, "status": "in_progress|completed|blocked", "actions": ["description"]}
```

## Step 10: Update State

Use adapter operation `get_issue(display_id)` to read current state, then update via adapter operations:

| Outcome | Adapter Operations |
|---------|-------------------|
| **Completed** | `set_state_label(display_id, NULL)` to unlock, then `update_state(display_id, 'done')` |
| **Blocked** | `set_state_label(display_id, 'blocked')` to replace working lock |
| **More work needed** | Keep `agent-working` label; no update needed |

**For blocked issues:** Check if human has provided new direction via adapter operation `has_new_human_comments()`. If yes, agent should wake up on next heartbeat and continue. If no, issue stays blocked until next human input.

## Step 11: Next Issue or Exit

1. If issues worked this heartbeat < `max_issues_per_heartbeat`, return to **Step 2** to pick the next issue.
2. Otherwise, delete lockfile and exit.
3. If 0 todo issues remain in queue, suggest pausing the schedule.
4. If 3+ issues are blocked, suggest Board attention rather than more heartbeats.

---

## Adapter Operations Reference

This skill uses 11 named adapter operations. The implementation is backend-specific (Linear MCP vs SQLite queries), but the operation signatures are identical. Always invoke by operation name; the adapter reference file provides the full implementation details.

**List of all operations invoked by this skill:**

1. **inbox_query()** — Fetch ordered queue of actionable issues (Step 2)
2. **get_issue(display_id)** — Fetch full issue record (Steps 4, 7, 10)
3. **set_state_label(display_id, label)** — Lock/unlock/block issues (Steps 2, 5, 6, 10)
4. **has_new_human_comments(display_id)** — Check for human input (Step 2)
5. **detect_stale_working(hours)** — Find orphaned locks (Step 2)
6. **list_comments(display_id)** — Fetch all comments on issue (Step 7)
7. **next_heartbeat_number(display_id)** — Derive counter for next heartbeat (Step 7)
8. **create_sub_issue(parent_id, fields)** — Create child issues (Step 8)
9. **save_comment(display_id, body, heartbeat_number, persona)** — Write agent report (Steps 2, 5, 9)
10. **update_state(display_id, new_state)** — Change issue lifecycle state (Step 10)
11. **save_issue(fields)** — Create or update issues (not used in heartbeat, but referenced for context)

When you reach a step that says "invoke adapter operation X", consult the open adapter reference file for that operation's implementation. The reference shows the exact MCP tool call (for Linear) or SQL query (for SQLite). Execute the operation as documented, interpreting the result according to the adapter's semantics.

---

## Backend Differences & Compatibility

### Linear Backend

- Uses Linear MCP tools (`mcp__claude_ai_Linear__*`) for all operations.
- Issues identified by display keys (e.g., `WOT-42`).
- Labels are strings managed via read-modify-write pattern.
- State transitions use Linear's defined workflow states (Todo, In Progress, In Review, Done, etc.).
- Heartbeat counter derived from comment body text matching `Heartbeat #N`.

### SQLite Backend

- Uses local SQLite database (`.woterclip/woterclip.db`).
- Issues identified by auto-incremented internal IDs, displayed as `WOT-N`.
- State tracking via `state_label` column (NULL, 'working', 'blocked').
- Lifecycle state stored separately (`state` column: backlog, todo, in_progress, in_review, done, canceled).
- Heartbeat counter stored in `comments.heartbeat_number` column.
- Supports concurrent heartbeats via WAL mode and busy timeouts.

**Key compatibility note:** Both backends track the same logical state. Migration from v1 (Linear-only) to v2 (dual-backend) sets `backend: linear` to preserve existing behavior.

---

## Error Handling & Recovery

- **Stale locks:** Detected in Step 2, cleaned automatically. Agent resumes on next heartbeat.
- **Missing tools:** Detected in Step 5, issue marked as `agent-blocked`. Board escalation required.
- **Adapter unavailability:** Detected mid-work (Step 8). Leave lock in place, delete lockfile, exit with error. Next heartbeat will clean stale lock.
- **Config migration:** Automatic on first v1→v2 detection. Backup created; operator can restore if needed.
- **Lockfile conflicts:** If heartbeat is already running, exit immediately. Operator can force-clean if stale (older than `stale_lock_hours`).

---

## Integration with Config & Personas

The heartbeat skill reads from `.woterclip/config.yaml`, which specifies:
- `backend` — "linear" or "sqlite"
- `personas` — map of label → persona path
- `is_default` — which persona handles unlabeled issues
- `quiet_hours` — optional quiet window configuration
- `stale_lock_hours` — threshold for orphaned lock detection
- `max_issues_per_heartbeat` — max issues to work before exiting
- `max_parallel` — max concurrent heartbeats (advisory for future parallel work)

Each persona's `config.yaml` specifies:
- `required_tools` — tool prefixes required for this persona to run
- `max_turns` — work budget for this heartbeat cycle
- `model` — target model (informational)
- `thinking_effort` — thinking tokens (if supported)

The heartbeat enforces persona boundaries and tool availability at Step 5, ensuring work can proceed safely.
