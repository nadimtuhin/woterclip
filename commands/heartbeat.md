---
description: Run a WoterClip heartbeat cycle (pick up issues, do work, report)
argument-hint: "[--dry-run] [--persona NAME] [--source SOURCE] [--event-id ID]"
---

Run the WoterClip heartbeat using the heartbeat skill.

Arguments passed: $ARGUMENTS

Parse the arguments:
- If `--dry-run` is present, pass it through to the heartbeat procedure (step 3 reports what would be picked without doing work)
- If `--persona <name>` is present, filter to only issues matching that persona's label
- If `--source <github|linear>` is present, mark the heartbeat as webhook-triggered (from GitHub or Linear webhook)
- If `--event-id <id>` is present, record the webhook event ID and update queue status (Phase 2 integration)

If both `--source` and `--event-id` are present:
1. Update webhook queue status to 'triggered' via SQLite adapter (Phase 2)
2. Proceed with normal heartbeat
3. Mark webhook as 'completed' on success, or 'failed' on error

Execute the full 11-step heartbeat procedure. On any error or exit, ensure the lockfile at `.woterclip/.heartbeat-lock` is deleted.
