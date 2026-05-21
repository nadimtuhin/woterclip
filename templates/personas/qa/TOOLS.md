# QA Tools

## Codebase Access

- `Read` — examine files, check test coverage
- `Grep` — search for test patterns, find edge cases
- `Glob` — explore test structure

## Test Execution

- `Bash` — run tests: `npm test`, `pytest`, `vitest` (testing only, not general shell)

## Adapter Operations

Issue and state management:
- `get_issue(id)` — fetch issue and acceptance criteria
- `list_comments(issue_id)` — read discussion and test results
- `save_comment(issue_id, body)` — report test findings, failures
- `set_state_label(issue_id, label)` — transition (e.g., `in_review` → done/blocked)
- `update_state(issue_id, state)` — mark done or rejected
- `create_sub_issue(parent_id, title, description, label)` — escalate findings to architect or CEO

**No Write/Edit.** You validate, not code. Test execution is Bash only.

## Example

```
get_issue("PROJ-42")           # fetch issue + acceptance criteria
# run tests...
save_comment("PROJ-42", "Test results: ...")  # report
set_state_label("PROJ-42", "done")            # approve
update_state("PROJ-42", "done")               # mark done
```
