# WoterClip Persona Design Guide

## Overview

This guide provides architectural documentation for the WoterClip custom persona system. It explains how to design, create, and validate custom personas that extend WoterClip's agent orchestration capabilities without modifying core system code.

**Status:** Architecture specification for custom persona creation system (WOT-8, cycle #41)
**Project Goal:** Build a flexible agent orchestration platform for Claude

## Design Principles

### 1. Three-File Persona Architecture

Each persona is a self-contained directory with exactly three files:

```
.woterclip/personas/{persona-label}/
├── SOUL.md          # Identity & behavioral directives (TO Claude)
├── TOOLS.md         # Capabilities & tool documentation (FOR Claude)
└── config.yaml      # Runtime configuration (FOR system)
```

This structure ensures:
- **Behavioral clarity**: SOUL.md defines WHO the persona is
- **Capability transparency**: TOOLS.md defines WHAT the persona can do
- **Runtime determinism**: config.yaml defines HOW the persona executes

### 2. Label-Driven Routing

Personas are discovered and routed via labels:
- Issue label → `.woterclip/config.yaml` `personas` map → persona directory
- One persona label per issue (exclusive routing)
- Special case: Orchestrator persona has `is_default: true` (fallback for unlabeled issues)

### 3. Hierarchical Escalation

Persona hierarchy prevents circular escalations:
- Worker personas (Backend, Frontend, Infra) → Architect
- Architect → CEO
- CEO → Board (human escalation, out of system)
- Default: Workers escalate to Architect, Architect escalates to CEO

### 4. Configuration-Driven Runtime

Runtime behavior is determined by persona `config.yaml`, NOT hardcoded:
- Model selection (opus, sonnet, haiku)
- Thinking effort (high, medium, low)
- Max turns (300, 200, 100)
- Required tools (dynamic MCP tool allowlist)
- Optional goal context (persona-specific and project-level)

## Persona File Specifications

### SOUL.md Structure

**Purpose:** Identity injection - written as directives TO Claude, shaping behavior and personality.

**Required sections:**

1. **Identity** (1–2 sentences)
   - Role title and primary responsibility
   - Example: "You are the Backend Architect. Your role is to review backend architectural decisions and ensure scalability, reliability, and adherence to best practices."

2. **Technical Posture** (5–7 principles)
   - Core values and approach to work
   - Example for Backend Architect:
     - "Think in terms of systems: scalability, fault tolerance, and observability first"
     - "Understand the business context before recommending solutions"
     - "Prefer incremental refactoring over rewrites"
     - "Prioritize backward compatibility and safe migrations"
     - "Document architectural decisions in ADRs (Architecture Decision Records)"

3. **Voice and Tone**
   - Communication style: collaborative, direct, analytical, encouraging, etc.
   - Specificity: "You speak with calm authority. Explain trade-offs clearly. Avoid jargon unless necessary."

4. **Working Style**
   - How to approach tasks and problems
   - When to ask questions vs. decide independently
   - When to escalate to CEO or Board

5. **Boundaries** (What this persona does NOT do)
   - Explicit scope limitations
   - Reference other personas for out-of-scope work
   - Example: "Do NOT write implementation code. Delegate implementation to Backend/Frontend workers."

6. **Quality Checklist** (Pre-completion checks)
   - 5–10 items the persona verifies before marking work complete
   - Example: "Has this ADR been reviewed by relevant stakeholders?" "Are there backward compatibility concerns?" "Is this decision documented in the architecture wiki?"

**Writing guidelines:**
- Use imperative mood: "Think in systems..." not "You should think..."
- Write as instructions TO Claude, not about Claude
- Keep length: 800–1,200 words

### TOOLS.md Structure

**Purpose:** Capability documentation - explains which tools are available and how to use them.

**Required sections:**

1. **Required Tools** (with descriptions)
   - List with `mcp__` prefix (e.g., `mcp__claude_ai_Linear`)
   - Brief description of usage
   - Example:
     ```
     - `mcp__claude_ai_Linear` — Create issues, update fields, read comments
       - Use to create sub-issues for architectural review tasks
       - Use to update issue status and labels
     ```

2. **Common Usage Patterns**
   - Real-world examples of tool usage for this persona's role
   - If Backend Architect: "Create a sub-issue for performance audit"
   - If QA: "Run end-to-end test suites via Chrome DevTools"

3. **Optional Tools** (recommended additions)
   - Tools the user might add later without breaking the system
   - Example: "For load testing, consider adding `mcp__playwright_playwright` to optional tools"

4. **Tool Preconditions**
   - Prerequisites for using required tools
   - Example: "Linear MCP requires Linear workspace configured in `.claude/settings.json`"

**Writing guidelines:**
- Keep concise: focus on practical usage
- Use code blocks for tool calls
- Reference backend-specific differences (Linear vs. SQLite)

### config.yaml Schema

**Purpose:** Runtime configuration - machine-readable rules for execution.

**Required fields:**

```yaml
# Identity & routing
name: "Backend Architect"               # Display name (used in logging)
role: "architect"                        # Role type: engineer, orchestrator, analyst, custom
label: "backend-architect"               # Linear/reference label (unique across personas)
escalates_to: "ceo"                      # Escalation target on blockers/ambiguity

# Execution environment
runtime:
  model: "opus"                          # claude-opus-4-1 (most capable)
  thinking_effort: "high"                # high, medium, low (for extended thinking)
  max_turns: 300                         # Max conversation turns before stopping
  enable_chrome: false                   # Enable Chrome DevTools MCP
  timeout: 0                             # 0 = no timeout, or milliseconds

# Tools & capabilities
required_tools:
  - "mcp__claude_ai_Linear"
  - "mcp__plugin_playwright_playwright"  # Optional: for testing

# Contextual goals (optional)
goal: |
  Focus on architectural consistency. Review designs for scalability concerns.
  Document decisions in ADRs. Escalate to CEO only if business strategy is unclear.

# Backend-specific config
is_default: false                        # Set true only for Orchestrator persona
```

**Field reference:**

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `name` | string | required | Display name for logging |
| `role` | enum | required | `engineer`, `orchestrator`, `analyst`, or custom |
| `label` | string | required | Unique; used for routing and storage |
| `escalates_to` | string | `"ceo"` | Persona label to escalate to |
| `runtime.model` | enum | `"sonnet"` | `opus`, `sonnet`, `haiku` |
| `runtime.thinking_effort` | enum | `"medium"` | `high` (for opus), `medium`, `low` |
| `runtime.max_turns` | int | 200 | Typical: opus=300, sonnet=200, haiku=100 |
| `runtime.enable_chrome` | bool | false | Required for test/validation personas |
| `runtime.timeout` | int | 0 | Milliseconds; 0 = no timeout |
| `required_tools` | list | `[]` | MCP tool prefixes to enable |
| `goal` | string | null | Optional persona-specific goal context |
| `is_default` | bool | false | Only Orchestrator should have `true` |

## Custom Persona Creation Workflow

### Step 1: Understand Your Use Case

Before creating a persona, answer:
- **Who?** What role does this agent play? (e.g., "Release Manager", "Data Scientist")
- **What?** What types of issues should route to this persona? (e.g., "Issues labeled `release`")
- **How?** What's their decision-making process? (e.g., "Check CI status, coordinate rollout")
- **Escalate?** When should they escalate? (e.g., "When release involves database migration")

### Step 2: Use the `/persona-create` Skill

WoterClip provides an interactive skill to scaffold a new persona:

```bash
/persona-create
```

**Interactive prompts:**

1. **Name** — Display name (e.g., "Release Manager")
2. **Role** — Role type (engineer, orchestrator, analyst, custom)
3. **Label** — Unique label for issue routing (e.g., `release-manager`)
4. **Escalates to** — Which persona handles escalations (default: `ceo`)
5. **Model** — Runtime model based on complexity
6. **Required tools** — Additional MCPs beyond Linear

The skill generates:
- Skeleton SOUL.md (for you to customize)
- Skeleton TOOLS.md (populated with required tools)
- Skeleton config.yaml (with runtime defaults)

### Step 3: Customize SOUL.md

Edit `.woterclip/personas/{label}/SOUL.md`:
- Replace skeleton identity with concrete behavioral directives
- Write 5–7 specific principles for this role
- Define explicit boundaries and escalation triggers
- Add role-specific quality checklist

**Example: Release Manager persona**

```markdown
## Identity
You are the Release Manager. Your role is to coordinate releases, manage CI/CD pipelines, 
and ensure safe rollouts to production.

## Technical Posture
- Prioritize safety over speed. Always verify CI/CD status before proceeding.
- Understand the rollback plan before releasing. No rollout without escape routes.
- Coordinate with Backend/Frontend architects on breaking changes.
- Document release notes and communicate changes to stakeholders.
- Escalate to CEO if release involves major version bumps or deprecations.

## Voice and Tone
You speak with calm authority. You explain risks clearly and propose mitigations.
You are conservative: "When in doubt, delay and consult." You celebrate successful 
releases but never take unnecessary risks.

## Boundaries
Do NOT implement code. Do NOT approve architecture decisions (escalate to Architect).
Do NOT communicate directly with customers (escalate to CEO/Board).
```

### Step 4: Customize TOOLS.md

Edit `.woterclip/personas/{label}/TOOLS.md`:
- Document which tools this persona uses and how
- Add role-specific usage patterns
- Link to backend adapter documentation (e.g., `references/backend-linear.md`)

**Example: Release Manager persona**

```markdown
## Required Tools
- `mcp__claude_ai_Linear` — Read/update issues, add comments
- `mcp__plugin_playwright_playwright` — Verify UI in production

## Common Usage Patterns
- Query issues labeled `release` to find pending releases
- Create sub-issues for each stage: "Stage 1: QA Sign-off", "Stage 2: Staging Rollout"
- Post progress updates as comments linking to CI/CD logs
- Use Playwright to test critical user flows in production
```

### Step 5: Customize config.yaml

Edit `.woterclip/personas/{label}/config.yaml`:
- Set appropriate runtime model (opus for strategic roles, sonnet for workers)
- List all required tools
- Add role-specific goal if needed

**Example: Release Manager persona**

```yaml
name: "Release Manager"
role: "engineer"
label: "release-manager"
escalates_to: "ceo"

runtime:
  model: "sonnet"
  thinking_effort: "medium"
  max_turns: 200
  enable_chrome: true          # Need to verify UI changes
  timeout: 0

required_tools:
  - "mcp__claude_ai_Linear"
  - "mcp__plugin_playwright_playwright"

goal: |
  Coordinate safe releases. Check CI/CD status. Create sub-issues for each release stage.
  Escalate to CEO if this involves a major version or customer-facing deprecation.
```

### Step 6: Register in config.yaml

Add the persona to `.woterclip/config.yaml` under `personas`:

```yaml
personas:
  # ... existing personas ...
  release-manager:
    path: "personas/release-manager"
    label: "release-manager"
```

### Step 7: Validate (If Using SQLite Backend)

No additional validation needed. The heartbeat will auto-discover the persona at next run.

### Step 8: Validate (If Using Linear Backend)

Run `/persona-list` to verify the persona is registered and its label is available in Linear.

## Validation Rules

### SOUL.md Validation

- Must be valid Markdown
- Must have sections: Identity, Technical Posture, Voice and Tone, Working Style, Boundaries, Quality Checklist
- Must be 800–1,200 words
- Must use imperative mood ("Think...", "Do...", "Escalate...")
- Must NOT reference hardcoded file paths (use `${CLAUDE_PLUGIN_ROOT}`)

### TOOLS.md Validation

- Must be valid Markdown
- Must list all tools used in SOUL.md
- All tools must start with `mcp__` (MCP convention)
- Must include usage patterns relevant to the persona's role

### config.yaml Validation

- Must be valid YAML
- Required fields: `name`, `role`, `label`, `escalates_to`, `runtime`
- `runtime.model` must be one of: `opus`, `sonnet`, `haiku`
- `runtime.thinking_effort` must be one of: `high`, `medium`, `low`
- `label` must be unique across all personas (checked at init)
- `escalates_to` must reference an existing persona

### File Completeness

- All three files must exist in `.woterclip/personas/{label}/`
- No additional files in persona directory (keep it clean)

## Backend Differences

### SQLite Backend

**Persona creation:**
- No Linear label creation (labels are free-form strings)
- All personas work immediately after file creation
- No rate limiting or API concerns

**Validation:**
- Basic YAML and Markdown validation only
- No Linear API checks

### Linear Backend

**Persona creation:**
- Label must be created in Linear workspace (via `/persona-create` skill)
- Label must be unique across team
- Label appears in "Issue Labels" dropdown

**Validation:**
- Verify label exists via `mcp__claude_ai_Linear__list_issue_labels`
- Verify Linear MCP is configured before creating persona
- Check for label collisions

## Advanced Patterns

### Goal Injection

Personas can receive optional goal context to guide behavior without code changes.

**Priority order** (highest to lowest):
1. Persona-specific goal (from `config.yaml`)
2. Project-level goal (from root `config.yaml`)
3. No goal (persona relies on SOUL.md alone)

**Usage:**

In heartbeat Step 7 (Understand Context), if a goal is set:

```
**Persona goal:** {goal from config.yaml}
```

**Example:**

```yaml
# In .woterclip/personas/security-auditor/config.yaml
goal: |
  Audit for security vulnerabilities. Prioritize: (1) injection attacks, (2) auth bypasses,
  (3) data exposure. Escalate to CEO if you find critical vulnerabilities.
```

### Hierarchy Best Practices

**Recommended structure:**

```
Board (human) ← CEO ← Architect ← Workers (Backend, Frontend, Infra, QA, etc.)
```

**Rationale:**
- Workers focus on implementation details
- Architect reviews for structural concerns (ADRs, scalability, consistency)
- CEO handles strategy, prioritization, and business decisions
- Board (human) is final escalation for tie-breaking

**Anti-pattern:**
- Circular escalations (A → B, B → A)
- Too many escalation levels (Persona → CEO → Board → External → Board → CEO)
- Workers escalating directly to Board (skip architectural review)

### Persona Combinations

Some use cases benefit from multiple personas for different aspects of the same work:

**Example: Database migration project**

- Issue labeled `architect` → Architect persona designs schema
- Issue labeled `backend` → Backend persona implements migration
- Issue labeled `qa` → QA persona tests migration safety

**Routing:**
```yaml
personas:
  architect:
    path: "personas/architect"
    label: "architect"
  backend:
    path: "personas/backend"
    label: "backend"
  qa:
    path: "personas/qa"
    label: "qa"
```

## Common Persona Templates

### Engineer (Worker)

**Use case:** Implementation, code review, testing

**Template:**
```yaml
name: "Backend Engineer"
role: "engineer"
escalates_to: "architect"
runtime:
  model: "sonnet"
  thinking_effort: "medium"
  max_turns: 200
required_tools:
  - "mcp__claude_ai_Linear"
```

### Analyst (Research/Planning)

**Use case:** Investigation, analysis, documentation

**Template:**
```yaml
name: "Research Analyst"
role: "analyst"
escalates_to: "ceo"
runtime:
  model: "opus"
  thinking_effort: "high"
  max_turns: 300
required_tools:
  - "mcp__claude_ai_Linear"
```

### Orchestrator (Default/Routing)

**Use case:** Triage, routing, basic coordination (system-provided)

**Note:** WoterClip ships with a default Orchestrator persona. Do NOT create custom Orchestrators unless replacing the system default.

## Troubleshooting

### Persona Not Discovered

**Problem:** Heartbeat doesn't route issues to new persona.

**Solution:**
1. Verify `.woterclip/config.yaml` includes the persona in `personas` map
2. Verify label matches exactly (case-sensitive)
3. Run `/persona-list` to see all registered personas
4. If using Linear: verify label exists in Linear workspace

### Escalation Chain Errors

**Problem:** Persona escalation leads to missing persona.

**Solution:**
1. Check `escalates_to` field in `config.yaml`
2. Verify target persona exists and is registered
3. Audit escalation chain: `A → B → C → CEO` (no cycles)

### Tool Not Available

**Problem:** Persona tries to use tool but gets "required tool not found".

**Solution:**
1. Verify tool name starts with `mcp__`
2. Verify tool is listed in `required_tools` in `config.yaml`
3. If using Linear: verify MCP is configured in Claude Code
4. Restart Claude Code session after modifying config

### SOUL.md/TOOLS.md Not Loaded

**Problem:** Persona behavior doesn't match SOUL.md directives.

**Solution:**
1. Verify file is valid Markdown (no syntax errors)
2. Check file is in correct path: `.woterclip/personas/{label}/SOUL.md`
3. Heartbeat loads files at runtime. If changed: re-run heartbeat
4. For debugging: request persona dump in issue comment

## Integration Checklist

Before deploying a new custom persona to production:

- [ ] SOUL.md written (800–1,200 words, valid Markdown)
- [ ] TOOLS.md documents all required tools
- [ ] config.yaml is valid YAML with all required fields
- [ ] Label is unique across all personas
- [ ] Escalation target exists and is registered
- [ ] If Linear backend: label created in workspace
- [ ] All three files are in `.woterclip/personas/{label}/`
- [ ] Persona registered in `.woterclip/config.yaml`
- [ ] `/persona-list` shows new persona
- [ ] Test: assign issue with persona label, run `/heartbeat`
- [ ] Verify persona processes issue correctly

## Future Extensions

### Phase 2: Persona Templates

Pre-built templates for common roles:
- Release Manager
- Data Scientist
- Security Auditor
- Product Manager
- DevOps Engineer

### Phase 3: Persona Composition

Allow personas to compose behaviors from multiple role templates:
```yaml
composed_of:
  - "engineer"
  - "security-focused"
  - "documentation-heavy"
```

### Phase 4: Persona Versioning

Support persona versioning for safe updates:
```yaml
version: "1.2.0"
breaking_changes:
  - "Changed required tools"
  - "Updated model to opus"
```

## References

- **Architecture spec:** `docs/specs/2026-03-25-woterclip-design.md`
- **Backend adapters:** `references/backend-linear.md`, `references/backend-sqlite.md`
- **Persona creation skill:** `skills/persona-create/SKILL.md`
- **Heartbeat skill:** `skills/heartbeat/SKILL.md`
- **Label conventions:** `references/label-conventions.md`

---

**Document ID:** persona-design-guide.md
**Last updated:** 2026-05-21
**Cycle:** WOT-8 (#41)
