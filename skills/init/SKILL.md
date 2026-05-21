---
name: woterclip-init
description: This skill should be used when the user asks to "initialize woterclip", "set up woterclip", "woterclip init", "configure woterclip for this repo", or runs the /woterclip-init command. Scaffolds a repo with WoterClip config, persona directories, and backend-specific setup (SQLite database or Linear labels).
version: 0.1.0
---

# WoterClip Initialization

Initialize WoterClip in the current repository. This creates the `.woterclip/` directory with config, persona templates, and backend-specific setup (SQLite database for local operation, or Linear labels for cloud operation).

## Prerequisites

No MCP is strictly required at the start. Backend choice (Step 0) determines which setup is needed.

## Initialization Procedure

### Step 0: Choose Backend

Prompt the user:

```
Choose backend for this repo:
  1) SQLite (local, file-based – default)
  2) Linear (cloud-based, requires Linear MCP)

Enter choice [1]: 
```

If the user enters "2" (Linear), proceed with Linear backend.
If the user enters "1", blank, or any other input, proceed with SQLite backend. Set `backend = "sqlite"`.

### Step 1: Conditional Setup Based on Backend

#### If backend = linear:

1. Check that `mcp__claude_ai_Linear__list_teams` is callable
2. If not available, stop and instruct the user to connect Linear MCP first:
   - Add Linear MCP to `.mcp.json` or global MCP config
   - Restart Claude Code session
   - Re-run `/woterclip-init`
3. Call `mcp__claude_ai_Linear__list_teams` to fetch available teams
4. Call `mcp__claude_ai_Linear__list_users` to identify the current user
5. Present findings and ask the user to confirm:
   - Which **team** to use (if multiple teams exist)
   - Their **display name** for @-mentions in comments (pre-filled from Linear)

#### If backend = sqlite:

- Skip all Linear MCP checks
- Prompt for user's display name for use in heartbeat comments (e.g., "Nick, Alex, Morgan")
- Proceed to Step 3 (DB Creation) instead of Step 2

### Step 2: Choose Persona Preset (Linear only; skip for SQLite)

Ask the user which persona set to scaffold:

| Preset | Personas Created |
|--------|-----------------|
| **engineering** (default) | Orchestrator, CEO, Backend, Frontend |
| **full** | Orchestrator, CEO, Backend, Frontend, Infra, QA |
| **minimal** | Orchestrator, CEO only |
| **custom** | Orchestrator, CEO + user-specified personas |

For "custom", ask the user to name each persona and its Linear label.

### Step 3: Database or Label Creation (Backend-Specific)

#### If backend = sqlite:

1. Read the SQLite DDL from `${CLAUDE_PLUGIN_ROOT}/references/backend-sqlite.md`
2. Extract the SQL block (from the first ```sql to the closing ```)
3. Create the database and schema:
   ```bash
   sqlite3 .woterclip/woterclip.db < ddl.sql
   ```
   where `ddl.sql` is the extracted DDL content
4. Add `.woterclip/woterclip.db` to `.gitignore` (append if the file exists)
5. Log: "SQLite database created at `.woterclip/woterclip.db`"

#### If backend = linear:

Create the WoterClip label group and child labels in Linear:

1. Call `mcp__claude_ai_Linear__create_issue_label` to create the parent group label named after `labels.group` (default: "WoterClip")
2. Create child labels under this group:
   - `agent-working` — state label for active work
   - `agent-blocked` — state label for blocked issues
   - One label per persona that has a non-null label (e.g., `backend`, `frontend`)

Use `mcp__claude_ai_Linear__list_issue_labels` first to check if labels already exist. Skip creation for any label that already exists.

**Important:** The Linear MCP's `create_issue_label` accepts `name`, `color`, and optionally `parentId` (for grouping under a parent label). Fetch the parent group label's ID after creating it, then pass it as `parentId` for child labels.

### Step 4: Scaffold Config & Personas

1. Create the directory structure:
   ```
   .woterclip/
   ├── config.yaml
   └── personas/
       ├── orchestrator/
       │   ├── SOUL.md
       │   ├── TOOLS.md
       │   └── config.yaml
       ├── ceo/
       │   ├── SOUL.md
       │   ├── TOOLS.md
       │   └── config.yaml
       ├── backend/          (if selected)
       │   ├── SOUL.md
       │   ├── TOOLS.md
       │   └── config.yaml
       └── frontend/         (if selected)
           ├── SOUL.md
           ├── TOOLS.md
           └── config.yaml
   ```

2. Copy templates from the plugin's `templates/` directory:
   - Read each template file from `${CLAUDE_PLUGIN_ROOT}/templates/`
   - Replace `{{USER_NAME}}` with the user's display name
   - Replace `{{TEAM}}` with the selected team name (for Linear) or empty string (for SQLite)
   - Write to `.woterclip/`

3. Update `config.yaml`:
   - Set `backend: sqlite` or `backend: linear` based on Step 0 choice
   - Update the `personas` section to match the selected preset — remove entries for personas that weren't scaffolded

4. **If backend = sqlite: Append Backend Note to each persona's TOOLS.md**

   For each persona directory in `.woterclip/personas/*/TOOLS.md`, append this block at the end:

   ```markdown
   ## Backend Note

   This repo uses the **sqlite** backend. Ignore Linear MCP patterns in this file.

   For all issue operations, use the Bash tool:

   ```bash
   sqlite3 .woterclip/woterclip.db "SQL"
   ```

   Consult `${CLAUDE_PLUGIN_ROOT}/references/backend-sqlite.md` for operation patterns and the complete adapter contract.
   ```

   (Use the exact formatting above to maintain consistency.)

### Step 5: Offer Schedule Setup

Ask the user if they want to set up a recurring heartbeat:

- **Yes** → Suggest: `/schedule 30m /heartbeat` and explain cadence options
- **Not now** → Explain they can run `/heartbeat` manually or set up `/schedule` later

### Step 6: Print Summary

Display what was created. Format depends on backend:

#### If backend = sqlite:

```
WoterClip initialized (SQLite backend)!

Database created:
  ✓ .woterclip/woterclip.db
  ✓ .gitignore updated

Config: .woterclip/config.yaml
Personas:
  ✓ orchestrator → default (no label)
  ✓ ceo          → no label (sqlite backend)
  ✓ backend      → no label (sqlite backend)
  ✓ frontend     → no label (sqlite backend)

Next steps:
  1. Review .woterclip/config.yaml
  2. Customize persona SOUL.md files for your project
  3. Run /heartbeat or /schedule 30m /heartbeat
```

#### If backend = linear:

```
WoterClip initialized (Linear backend)!

Linear labels created:
  ✓ WoterClip (group)
  ✓ agent-working
  ✓ agent-blocked
  ✓ backend
  ✓ frontend

Config: .woterclip/config.yaml
Personas:
  ✓ orchestrator → default (no label)
  ✓ ceo          → "ceo" label
  ✓ backend      → "backend" label
  ✓ frontend     → "frontend" label

Next steps:
  1. Review .woterclip/config.yaml
  2. Customize persona SOUL.md files for your project
  3. Run /heartbeat or /schedule 30m /heartbeat
```

## Error Handling

| Error | Response |
|-------|----------|
| Linear MCP not available (Linear backend selected) | Stop. Print setup instructions for connecting Linear MCP. |
| No teams found (Linear backend) | Stop. Ask user to verify Linear workspace access. |
| Label creation fails (Linear backend) | Log the error, continue with remaining labels, report at end. |
| SQLite DB creation fails (SQLite backend) | Stop. Print DDL extraction or sqlite3 error. |
| `.woterclip/` already exists | Ask user: overwrite, merge, or cancel. Default to merge (skip existing files). |
| Template file missing from plugin | Log warning, create a minimal placeholder, continue. |

## Re-initialization

If `.woterclip/config.yaml` already exists:

1. Read the existing config
2. Ask the user: **overwrite** (fresh start), **merge** (add missing personas only), or **cancel**
3. For merge: only create persona directories and labels (or DB) that don't exist yet
4. For overwrite: back up existing config to `config.yaml.bak` before writing
5. If backend changes (sqlite ↔ linear), ask user to confirm they want to switch backends
