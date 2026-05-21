# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

WoterClip is a **Claude Code plugin** (no runtime code — entirely markdown/YAML). It provides agent orchestration with persona-based task routing and pluggable backends (Linear cloud or local SQLite). A single Claude instance wears different "hats" (personas) based on issue labels.

**Design spec:** `docs/specs/2026-03-25-woterclip-design.md`
**Implementation plan:** `docs/specs/2026-03-25-woterclip-implementation-plan.md`
**Linear:** WotAI workspace, WoterClip project

## Architecture

### Two-level structure

1. **Plugin** (this repo) — ships commands, skills, agents, references, and persona templates. Installed via `claude plugin add`.
2. **Per-repo scaffold** (`.woterclip/`) — created by `/woterclip-init` in target repos. Contains `config.yaml`, persona directories, heartbeat log, and lockfile.

### Adapter pattern (dual-backend design)

WoterClip supports two backends via the adapter pattern. `config.backend` in the scaffold selects which:
- **Linear** (cloud-based MCP) — `references/backend-linear.md` defines operations via Linear API
- **SQLite** (local database via Bash) — `references/backend-sqlite.md` defines operations via shell commands

Both provide 11 identical named operations (create issue, list issues, update, close, etc.), allowing seamless backend swapping without changing persona code.

### Core loop

```
/heartbeat → Load Config → Check Inbox (via adapter) → Fan-out Dispatch (up to max_parallel issues)
  → Subagents (each: Resolve Persona → Validate Tools → Lock → Understand Context + Goals → Do Work → Report → Update State)
  → Orphan Cleanup → Merge Logs → Exit
```

The heartbeat is a **skill** (`skills/heartbeat/SKILL.md`), not code. Claude follows it as a procedure using backend adapter tools and repo tools.

### Concurrency model (max_parallel)

Heartbeat processes multiple issues simultaneously via subagent dispatch:
- **Linear backend:** `max_parallel: 1` (default, rate-limit safe). Override at risk of 429 errors.
- **SQLite backend:** `max_parallel: 2+` (WAL-safe, no rate limits).

Step 3 spawns one subagent per issue (up to max_parallel), each running Steps 4–10 independently. Subagents load persona files themselves, ensuring parallel and serial flows are isomorphic. After all complete, main loop runs orphan cleanup (detect crashed subagents) and merges temp logs.

### Persona system

Each persona = directory with 3 files:
- `SOUL.md` — identity injected into Claude's context (shapes behavior)
- `TOOLS.md` — available tools and usage patterns (shapes capabilities)
- `config.yaml` — machine-readable runtime config (model, thinking effort, max turns, required tools)

Routing: Issue label → `personas` map in config.yaml → persona directory.

### Persona hierarchy

- **Board** (human) – ultimate escalation target
- **CEO** persona – strategy, prioritization, roadmap (label: `ceo`). Escalation target for worker ambiguity.
- **Architect** persona – architecture review, ADRs, design decisions (label: `architect`). Escalation for structural concerns.
- **QA** persona – test validation, acceptance criteria (label: `qa`). Adversarial tester, escalates to architect.
- **Orchestrator** persona – mechanical triage/routing, default for unlabeled issues (label: none, `is_default: true`)
- **Worker personas** (Backend, Frontend, etc.) – implementation. Create architect/QA sub-issues on-demand (not mandatory).

### Goal injection

Personas receive optional context goals to guide behavior:
- **Priority:** Persona goal (from `.woterclip/personas/{name}/config.yaml`) > project goal (from root `config.yaml`) > none
- **Injected in Step 7:** "**Persona goal:** ..." or "**Project goal:** ..." prepended to work context if set
- **Set during init:** `/woterclip-init` prompts for project-level and per-persona goals (optional)

Goals shape persona priorities without requiring code changes.

### Key conventions

- **Labels are the state machine.** `agent-working` and `agent-blocked` are mutually exclusive. Labels managed via read-modify-write.
- **Heartbeat counter derived from comments**, not stored locally. Parse last `Heartbeat #N` from issue comments.
- **Lockfile** (`.woterclip/.heartbeat-lock`) prevents concurrent heartbeats. Deleted on every exit.
- **`${CLAUDE_PLUGIN_ROOT}`** — use for all intra-plugin path references. Never hardcode paths.
- **Templates use `{{USER_NAME}}` and `{{TEAM}}`** — replaced when scaffolding.
- **On-demand review:** Workers create architect/QA sub-issues when needed (judgment call in SOUL.md), not automatic.

## Plugin Component Map

| Type | Location | Purpose/Auto-discovery |
|------|----------|----------------------|
| Manifest | `.claude-plugin/plugin.json` | Required entry point |
| Commands | `commands/*.md` | Discovered by filename |
| Skills | `skills/*/SKILL.md` | Discovered by SKILL.md presence |
| Agents | `agents/*.md` | Discovered by filename |
| Hooks | `hooks/hooks.json` | Convention-based |
| References | `references/` | Backend adapters, tool docs |
| Scripts | `scripts/` | Validation (YAML, frontmatter) |

## Commands

| Command | Purpose |
|---------|---------|
| `/woterclip-init` | Scaffold `.woterclip/` in target repo |
| `/heartbeat` | Main loop: check inbox, pick issue, route to persona |
| `/issue-add` | Create new issue in backend |
| `/issue-list` | List issues filtered by status |
| `/issue-edit` | Update issue fields |
| `/issue-close` | Close/resolve issue |

## Working on This Repo

This repo has no build system, no tests, no dependencies. "Development" means editing markdown and YAML files.

**To test the plugin locally:** `claude --plugin-dir /path/to/woterclip`

**Validation checklist:**
- YAML files parse cleanly (`python3 -c "import yaml; yaml.safe_load(open('file.yaml'))"`)
- SKILL.md files have valid frontmatter (`name` and `description` fields)
- Command .md files have valid frontmatter (`description` field)
- Agent .md files have valid frontmatter (`description` field)
- All file references resolve (e.g., `${CLAUDE_PLUGIN_ROOT}/references/`)

## Editing Guidelines

- **Skills use imperative form** — "Read the config" not "You should read"
- **Skill descriptions use third person** — "This skill should be used when..."
- **SKILL.md target: 1,500–2,000 words.** Detailed content goes in `references/`
- **Persona SOUL.md are instructions TO Claude** — write as identity directives
- **Config schema changes:** bump `version` in `templates/config.yaml` + update init skill migration logic
- **One persona label per issue** — system assumes exclusive labeling

## MCP Tools: code-review-graph

IMPORTANT: Use code-review-graph MCP tools BEFORE Grep/Glob/Read to explore codebase. Faster, cheaper, with structural context.

### When to use graph tools first

- **Exploring:** `semantic_search_nodes` or `query_graph` instead of Grep
- **Impact:** `get_impact_radius` instead of manual tracing
- **Review:** `detect_changes` + `get_review_context` instead of reading files
- **Relationships:** `query_graph` with callers_of/callees_of/imports_of/tests_for
- **Architecture:** `get_architecture_overview` + `list_communities`

Fall back to Grep/Glob/Read only when graph doesn't cover the need.
