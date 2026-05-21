# Contributing to WoterClip

Thanks for your interest in contributing! WoterClip is a Claude Code plugin for agent orchestration with persona-based task routing.

## Quick Start

1. **Fork & clone** the repository
2. **Read** `CLAUDE.md` — project architecture and conventions
3. **Test locally** — `claude --plugin-dir /path/to/woterclip`

## Development

### No build system
WoterClip is markdown + YAML — no compilation, no dependencies.

### Structure
- `skills/` — executable procedures (SKILL.md files)
- `commands/` — user-facing commands
- `agents/` — persona definitions
- `templates/` — scaffold files for `/woterclip-init`
- `references/` — backend adapters and documentation
- `docs/` — design specs and guides

### Making changes

1. **Edit markdown/YAML files** directly
2. **Test in Claude Code** — `claude --plugin-dir /path/to/woterclip`
3. **Validate** — run `python3 -c "import yaml; yaml.safe_load(open('file.yaml'))"` for YAML files
4. **Commit** — follow conventional commits (`feat:`, `fix:`, `docs:`)

### Adding new personas

1. Create `templates/personas/{name}/` with:
   - `SOUL.md` (identity instructions)
   - `TOOLS.md` (available tools)
   - `config.yaml` (runtime config: model, thinking_effort, max_turns)

2. Update `templates/config.yaml` to include the new persona
3. Document in `docs/` if introducing new behavior

## Code Style

- **Skills** — imperative form ("Read the config")
- **SOUL.md** — identity directives to Claude
- **Comments** — only for non-obvious WHY, not WHAT
- **Config** — use YAML, not JSON

## Testing

Run automated checks:
```bash
python3 -m pytest tests/ -v
bash scripts/validate.sh
```

Manual testing:
```bash
mkdir /tmp/wot-test && cd /tmp/wot-test && git init
claude --plugin-dir /path/to/woterclip
/woterclip-init
```

## Reporting Issues

Include:
- WoterClip version (`/woterclip version` or git commit)
- Backend used (Linear or SQLite)
- Steps to reproduce
- Expected vs. actual behavior
- `.woterclip/config.yaml` (redact secrets)

## Architecture Questions?

See `docs/specs/2026-03-25-woterclip-design.md` for design decisions and trade-offs.

## License

By contributing, you agree your changes are licensed under MIT (see LICENSE).
