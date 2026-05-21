---
description: Close issue
---

# Close Issue

Run the **issue-close** sub-procedure from the `issue` skill to mark an issue as done and release any locks.

This command guides you through:
1. Entering the issue ID (e.g., WOT-42)
2. Confirming closure (with a warning if the issue is currently locked with `state_label='working'`)

When closed, the issue:
- Transitions to `state='done'` in the active backend
- Clears the `state_label` lock (if any)

This is useful for completing work initiated by a heartbeat or releasing blocked issues.
