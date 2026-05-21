---
description: List all issues
---

# List Issues

Run the **issue-list** sub-procedure from the `issue` skill to display all actionable issues.

This command shows a table with:
- Issue ID (e.g., WOT-42)
- Title
- Persona label (if any)
- State (todo, in_progress, done, etc.)
- Priority (0–4, where 0=None and 1=Urgent)

Issues are queried from the active backend (Linear or SQLite).
