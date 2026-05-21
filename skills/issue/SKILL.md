---
name: issue
description: This skill should be used when the user asks to "create an issue", "list issues", "edit an issue", "close an issue", or runs the /issue-add, /issue-list, /issue-edit, or /issue-close commands. Provides issue CRUD operations via backend adapters (Linear or SQLite).
version: 0.2.0
---

# Issue CRUD Operations

Manage issues in WoterClip via backend-agnostic adapter operations. This skill provides four sub-procedures for creating, listing, editing, and closing issues. All operations delegate to the active backend (Linear MCP or SQLite) via adapter patterns.

**Adapter Reference files** (consulted dynamically):
- Load from `.woterclip/config.yaml` which contains `backend: linear` or `backend: sqlite`
- Consult `${CLAUDE_PLUGIN_ROOT}/references/backend-linear.md` or `${CLAUDE_PLUGIN_ROOT}/references/backend-sqlite.md`
- Invoke adapter operations by name: `save_issue()`, `inbox_query()`, `update_state()`, `set_state_label()`, `get_issue()`

---

## Sub-Procedure: issue-add

**Purpose:** Create a new issue with user-provided metadata.

**Steps:**

1. **Load Config**
   - Read `.woterclip/config.yaml`
   - Extract `backend` field (must be `linear` or `sqlite`)
   - Load the appropriate adapter reference file into mental context

2. **Gather User Input**
   - Prompt for issue title (required, must not be empty)
   - Prompt for persona (display list of available personas from `config.personas`)
     - User may select a persona or leave blank (nullable)
   - Prompt for priority (0–4, default 0)
     - 0 = None, 1 = Urgent, 2 = High, 3 = Medium, 4 = Low

3. **Validate Input**
   - Title: must not be empty or whitespace-only
   - Persona: if provided, must exist in `config.personas` map
   - Priority: must be integer 0–4

4. **Create Issue via Adapter**
   - Invoke adapter operation `save_issue(fields)` with:
     - `title` = user-provided title
     - `description` = empty string (user can edit later)
     - `persona` = selected persona or NULL
     - `state` = 'todo'
     - `priority` = user-provided or 0
   - Capture returned issue ID

5. **Return Success**
   - Display the created issue's `display_id` (e.g., "WOT-42")
   - Confirm: "Created issue {display_id}: {title}"

---

## Sub-Procedure: issue-list

**Purpose:** Display all issues with key metadata.

**Steps:**

1. **Load Config**
   - Read `.woterclip/config.yaml`
   - Load the appropriate adapter reference

2. **Query Issues**
   - Invoke adapter operation `inbox_query()` to fetch all actionable issues
   - (Note: `inbox_query()` returns todo + in_progress issues, not locked or done)

3. **Display Results**
   - Present in table format with columns:
     - `display_id` (e.g., WOT-42)
     - `title`
     - `persona` (or blank if none)
     - `state` (todo, in_progress, done, etc.)
     - `priority` (numeric or mapped to label: 0=None, 1=Urgent, 2=High, 3=Medium, 4=Low)
   - If no issues, display: "No actionable issues."

---

## Sub-Procedure: issue-edit

**Purpose:** Update an existing issue's metadata.

**Steps:**

1. **Load Config**
   - Read `.woterclip/config.yaml`
   - Load the appropriate adapter reference

2. **Gather Input**
   - Prompt for issue ID (e.g., "WOT-42")
   - Prompt for fields to edit (multi-select or separate prompts):
     - Title (optional)
     - Description (optional)
     - Persona (optional, select from config.personas or leave blank)
     - Priority (optional, 0–4)

3. **Validate & Fetch Current Issue**
   - Invoke adapter operation `get_issue(display_id)` to fetch current state
   - If issue not found, display error and return

4. **Update via Adapter**
   - Build updated fields dict with provided values
   - Invoke adapter operation `save_issue(fields)` with issue ID + updated fields
   - Only include fields that the user provided (sparse update)

5. **Return Confirmation**
   - Display: "Updated issue {display_id}"
   - Show which fields were changed

---

## Sub-Procedure: issue-close

**Purpose:** Close an issue and clean up its state.

**Steps:**

1. **Load Config**
   - Read `.woterclip/config.yaml`
   - Load the appropriate adapter reference

2. **Gather Input**
   - Prompt for issue ID (e.g., "WOT-42")

3. **Fetch Issue**
   - Invoke adapter operation `get_issue(display_id)` to read current state
   - If issue not found, display error and return
   - Note the current `state_label` field

4. **Warn if Locked**
   - If `state_label == 'working'`, display warning:
     ```
     ⚠ This issue is currently locked (state_label='working').
     Closing it will release the lock. Proceed? (y/n)
     ```
   - If user declines, return without changes

5. **Close Issue via Adapter**
   - Invoke adapter operation `update_state(display_id, 'done')` to set state to done
   - Invoke adapter operation `set_state_label(display_id, NULL)` to clear working/blocked lock
   - Order: first update_state, then set_state_label

6. **Return Confirmation**
   - Display: "Closed issue {display_id}: {title}"

---

## Adapter Operations Used

This skill invokes the following named adapter operations (see backend reference for implementation):

1. **save_issue(fields)** — Create or update issue (issue-add, issue-edit)
2. **inbox_query()** — Fetch all actionable issues (issue-list)
3. **get_issue(display_id)** — Fetch full issue record (issue-edit, issue-close)
4. **update_state(display_id, new_state)** — Change lifecycle state to done (issue-close)
5. **set_state_label(display_id, label)** — Lock/unlock issue (issue-close)

When each sub-procedure invokes an adapter operation, consult the open adapter reference file for the operation's exact implementation. The reference shows the Linear MCP call or SQLite query. Execute as documented in the adapter.

---

## Config Schema Notes

The config.yaml must include:

```yaml
backend: linear | sqlite
personas:
  orchestrator:
    label: null
    path: personas/orchestrator
    is_default: true
  ceo:
    label: ceo
    path: personas/ceo
  backend:
    label: backend
    path: personas/backend
  # ... etc.
```

The `issue-add` sub-procedure reads from `personas` to populate the selection list.

---

## Backend Differences

**Linear backend:**
- `save_issue()` creates a Linear issue via MCP and returns the issue key (e.g., "WOT-42")
- `inbox_query()` queries Linear for issues assigned to the current user
- State and labels are stored in Linear's status and label fields

**SQLite backend:**
- `save_issue()` inserts a row into the `issues` table and returns the auto-increment ID
- `display_id` is computed as `'WOT-' || id`
- `inbox_query()` queries the SQLite database for todo/in_progress issues
- State and labels are stored in the `state` and `state_label` columns

Both backends present the same operation interface to the caller.
