# WoterClip: Getting Started Guide

Welcome to WoterClip! This guide will help you get up and running in 5 minutes.

## What is WoterClip?

WoterClip is a Claude Code plugin that enables **multi-persona agent orchestration**. One Claude instance wears different "hats" (personas) based on issue labels and handles work automatically through a heartbeat cycle.

Use WoterClip when you want:
- Automated issue triage and routing by persona (CEO, Backend, Frontend, QA, etc.)
- Hands-off task processing with heartbeat cycles
- Per-issue concurrency (multiple issues processed in parallel)
- Flexible backends (Linear cloud or local SQLite)

## Quick Setup (5 minutes)

### 1. Install the plugin
```bash
claude --plugin-dir /path/to/woterclip
```

### 2. Initialize your repo
```bash
/woterclip-init
```

This scaffolds `.woterclip/` with:
- `config.yaml` — heartbeat settings and persona routing
- `personas/` — persona templates (CEO, Backend, Frontend, QA, etc.)
- `woterclip.db` — local SQLite database (if using sqlite backend)

**During init, you'll set:**
- Backend: `sqlite` (recommended) or `linear` (cloud)
- Project goal: A 1–2 sentence strategic direction (optional)
- Per-persona goals: Context for each persona (optional)

### 3. Create or label an issue
- Create an issue in your repo (SQLite) or Linear
- Add a label matching a persona: `ceo`, `backend`, `frontend`, `qa`, `architect`, etc.
- Issues without a label go to the **Orchestrator** (default triager)

### 4. Trigger the heartbeat
```bash
/heartbeat
```

This runs one cycle:
1. Loads config
2. Picks up to `max_issues_per_heartbeat` unlocked issues
3. Routes each to the matching persona
4. Persona reads the issue, writes a comment, updates state
5. Adds comment to SQLite and marks done/in_review/blocked
6. Cleans up orphaned locks and exits

## Basic Workflow

### For team members (humans)

1. **Create an issue** with title, description, and acceptance criteria
2. **Label it** with a persona name (`ceo`, `backend`, etc.)
3. **Wait** – the heartbeat picks it up automatically
4. **Review** – persona writes comments explaining what they did
5. **Accept or escalate** – if something is wrong, add a comment and re-run `/heartbeat`

### For agents (personas)

Each persona reads:
- **Issue title and description** (context)
- **Persona SOUL.md** (identity and boundaries)
- **Persona TOOLS.md** (available operations)
- **Config goals** (project goal + persona goal, if set)

Then they:
1. Understand the context
2. Do their work (write code, review, triage, etc.)
3. Write a comment explaining what happened
4. Update the issue state: `done`, `in_review`, or `blocked`
5. Exit

If blocked (missing info, unclear requirement, external blocker), they add a comment and leave the issue in `blocked` state.

## Key Concepts

### Labels = State Machine
- Issue labeled with persona name → that persona works it
- Persona updates state and adds `agent-working` or `agent-blocked` label
- Unlabeled issues go to **Orchestrator** (default)

### Heartbeat = Loop
Each `/heartbeat` is one cycle. You can run it manually or on a schedule:
```bash
# Manual
/heartbeat

# Automated (every 15 minutes, in the background)
/schedule heartbeat "*/15 * * * *"
```

### Personas = Roles
The default personas are:

| Persona | Label | Role |
|---------|-------|------|
| **Orchestrator** | (none) | Triage and route new issues |
| **CEO** | `ceo` | Strategy, prioritization, scope decisions |
| **Backend** | `backend` | API, database, business logic |
| **Frontend** | `frontend` | UI, styling, client-side logic |
| **Architect** | `architect` | Design review, ADRs, structure |
| **QA** | `qa` | Testing, validation, acceptance |

### Backends = Storage
- **SQLite** (default) – local database, no auth needed, up to 2+ parallel issues
- **Linear** – cloud API, rate-limited (max 1 parallel), requires API key

Set in `config.yaml`:
```yaml
backend: sqlite  # or 'linear'
```

## Troubleshooting

### Heartbeat never picks up my issue
- **Check labels:** Is the issue labeled with a persona name?
- **Check lock:** Is `.woterclip/.heartbeat-lock` stale? (Delete it to force a new run)
- **Check state:** Is the issue in `todo` or `backlog`? Heartbeat only picks up unstarted work.
- **Check config:** Is `max_issues_per_heartbeat` set to at least 1?

### Persona didn't write a comment
- **Check heartbeat logs:** Run `/heartbeat` manually and look for errors
- **Check config:** Does the persona exist in `config.yaml` → `personas`?
- **Check SOUL/TOOLS:** Do the persona files have valid frontmatter (`name` and `description`)?

### Issue stuck in `agent-working` forever
- **Stale lock:** If `.woterclip/.heartbeat-lock` is older than `heartbeat.stale_lock_hours`, it's considered stale. Delete it.
- **Crashed agent:** If a persona crashed mid-work, delete the lock and re-run `/heartbeat`

### Too many issues per heartbeat
- Reduce `max_issues_per_heartbeat` in `config.yaml`
- Or set `max_parallel: 1` to process one issue at a time (slower but safer)

## Next Steps

1. **Read the design spec:** `docs/specs/2026-03-25-woterclip-design.md`
2. **Understand personas:** Each persona has `SOUL.md` (identity) and `TOOLS.md` (capabilities)
3. **Customize goals:** Set project and per-persona goals during `/woterclip-init`
4. **Automate:** Use `/schedule` to run `/heartbeat` on a cron schedule

## Tips

- **Label early, label often** – Labels are how work gets routed. Relabel issues anytime to change persona assignment.
- **Write clear descriptions** – Personas read the full issue. Good context = better decisions.
- **Review comments** – Personas explain their reasoning. Use those comments to improve the system.
- **Keep it simple** – Start with 2–3 personas. Add more once you have a working baseline.
- **Watch the logs** – Each heartbeat cycle writes to `.woterclip/.heartbeat-log`. Check it for clues if something breaks.

---

**Questions?** Check `docs/` or the CLAUDE.md in this repo for more depth.
