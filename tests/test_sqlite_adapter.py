"""
SQLite Adapter Unit Tests

Tests the SQL queries and schema for the WoterClip SQLite backend.
Validates that all 11 adapter operations work correctly and that the
database state machine behaves as expected during heartbeat cycles.

Run with: python3 -m pytest tests/test_sqlite_adapter.py -v
"""

import sqlite3
import pytest
import re
import time
from datetime import datetime, timedelta


def load_schema(path="references/backend-sqlite.md"):
    """Extract DDL SQL blocks from the backend-sqlite.md reference file.

    Parses the "Database Schema (DDL)" section and extracts the PRAGMA
    and CREATE TABLE statements. Returns SQL suitable for executescript().
    """
    with open(path) as f:
        content = f.read()

    # Find the "Database Schema (DDL)" section and extract until "### Schema Design Notes"
    ddl_section = re.search(
        r"## Database Schema \(DDL\)(.*?)### Schema Design Notes",
        content,
        re.DOTALL
    )

    if not ddl_section:
        raise ValueError(f"No DDL section found in {path}")

    # From the DDL section, extract the first ```sql...``` block (PRAGMA + CREATE TABLE/INDEX)
    sql_blocks = re.findall(r"```sql\n(.*?)```", ddl_section.group(1), re.DOTALL)

    if not sql_blocks:
        raise ValueError(f"No SQL blocks found in DDL section of {path}")

    return sql_blocks[0]  # Return only the first (schema definition) block


@pytest.fixture
def db():
    """Create in-memory SQLite database with full WoterClip schema.

    Loads schema from references/backend-sqlite.md and initializes
    an in-memory database with all tables and indices. Row factory
    is set to sqlite3.Row for dict-like access. Foreign keys are
    enabled to test constraint enforcement.
    """
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row

    # Enable foreign key constraints (not on by default in SQLite)
    conn.execute("PRAGMA foreign_keys = ON")

    schema_sql = load_schema()
    conn.executescript(schema_sql)

    return conn


# ============================================================================
# Basic Schema and Operations Tests
# ============================================================================

class TestBasicOperations:
    """Test that schema creates correctly and basic CRUD works."""

    def test_schema_creates(self, db):
        """Verify that CREATE TABLE statements create expected tables."""
        tables = {r[0] for r in db.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )}
        assert "issues" in tables, "issues table not created"
        assert "comments" in tables, "comments table not created"

    def test_inbox_query_empty(self, db):
        """Verify inbox_query returns empty list for new database."""
        rows = db.execute("""
            SELECT
                'WOT-' || id AS display_id,
                id,
                title,
                persona,
                priority,
                state,
                state_label
            FROM issues
            WHERE state IN ('todo', 'in_progress') AND state_label IS NULL
            ORDER BY priority ASC, id ASC
            LIMIT 100
        """).fetchall()
        assert rows == [], "Empty database should return no issues"

    def test_create_issue(self, db):
        """Verify issue creation and display_id computation (WOT-N)."""
        db.execute("""
            INSERT INTO issues(title, persona, state, priority)
            VALUES ('Test issue', 'backend', 'todo', 2)
        """)

        row = db.execute("""
            SELECT 'WOT-' || id AS display_id, title, persona, state, priority
            FROM issues WHERE id=1
        """).fetchone()

        assert row["display_id"] == "WOT-1", "Display ID should be WOT-1"
        assert row["title"] == "Test issue"
        assert row["persona"] == "backend"
        assert row["state"] == "todo"
        assert row["priority"] == 2

    def test_state_label_check_constraint(self, db):
        """Verify CHECK constraint on state_label allows only valid values.

        NOTE: The mutual exclusion of working↔blocked is enforced by
        adapter operation logic, not SQL constraints. This test verifies
        that the CHECK constraint rejects invalid values.
        """
        db.execute("INSERT INTO issues(title) VALUES ('A')")

        # Valid: set to working
        db.execute("""
            UPDATE issues SET state_label='working', working_since=datetime('now')
            WHERE id=1
        """)
        row = db.execute("SELECT state_label FROM issues WHERE id=1").fetchone()
        assert row["state_label"] == "working"

        # Valid: set to NULL (unlock)
        db.execute("UPDATE issues SET state_label=NULL WHERE id=1")
        row = db.execute("SELECT state_label FROM issues WHERE id=1").fetchone()
        assert row["state_label"] is None

        # Valid: set to blocked
        db.execute("""
            UPDATE issues SET state_label='blocked', working_since=datetime('now')
            WHERE id=1
        """)
        row = db.execute("SELECT state_label FROM issues WHERE id=1").fetchone()
        assert row["state_label"] == "blocked"

        # Invalid: try to set to invalid value
        with pytest.raises(sqlite3.IntegrityError):
            db.execute("""
                UPDATE issues SET state_label='invalid' WHERE id=1
            """)

    def test_heartbeat_counter(self, db):
        """Verify next_heartbeat_number computes MAX(heartbeat_number)+1."""
        db.execute("INSERT INTO issues(title) VALUES ('A')")

        # Add agent comments with heartbeat numbers
        db.execute("""
            INSERT INTO comments(issue_id, author, body, heartbeat_number)
            VALUES (1, 'agent', 'report 1', 1)
        """)
        db.execute("""
            INSERT INTO comments(issue_id, author, body, heartbeat_number)
            VALUES (1, 'agent', 'report 2', 2)
        """)

        # Next heartbeat number should be 3
        row = db.execute("""
            SELECT COALESCE(MAX(heartbeat_number) + 1, 1) AS next_number
            FROM comments
            WHERE issue_id=1 AND author='agent'
        """).fetchone()
        assert row["next_number"] == 3

        # For a new issue with no comments, should be 1
        db.execute("INSERT INTO issues(title) VALUES ('B')")
        row = db.execute("""
            SELECT COALESCE(MAX(heartbeat_number) + 1, 1) AS next_number
            FROM comments
            WHERE issue_id=2 AND author='agent'
        """).fetchone()
        assert row["next_number"] == 1

    def test_has_new_human_comments(self, db):
        """Verify detection of human comments after last agent comment."""
        db.execute("INSERT INTO issues(title) VALUES ('A')")

        # Insert agent comment with explicit timestamp
        agent_time = datetime.utcnow().isoformat()
        db.execute("""
            INSERT INTO comments(issue_id, author, body, created_at)
            VALUES (1, 'agent', 'Agent report', ?)
        """, (agent_time,))

        # No human comment yet — should return 0
        row = db.execute("""
            SELECT COUNT(*) AS new_human_count
            FROM comments
            WHERE issue_id=1 AND author='human'
            AND created_at > (
                SELECT MAX(created_at)
                FROM comments
                WHERE issue_id=1 AND author='agent'
            )
        """).fetchone()
        assert row["new_human_count"] == 0

        # Add human comment with timestamp slightly later
        time.sleep(0.01)  # Ensure different timestamp
        human_time = datetime.utcnow().isoformat()
        db.execute("""
            INSERT INTO comments(issue_id, author, body, created_at)
            VALUES (1, 'human', 'Human reply', ?)
        """, (human_time,))

        # Now should return 1
        row = db.execute("""
            SELECT COUNT(*) AS new_human_count
            FROM comments
            WHERE issue_id=1 AND author='human'
            AND created_at > (
                SELECT MAX(created_at)
                FROM comments
                WHERE issue_id=1 AND author='agent'
            )
        """).fetchone()
        assert row["new_human_count"] == 1

    def test_sub_issue_parent(self, db):
        """Verify parent_id foreign key relationship for sub-issues."""
        # Create parent
        db.execute("INSERT INTO issues(title) VALUES ('Parent issue')")

        # Create child
        db.execute("""
            INSERT INTO issues(title, parent_id)
            VALUES ('Child issue', 1)
        """)

        # Query child's parent display_id
        row = db.execute("""
            SELECT 'WOT-' || parent_id AS parent_id
            FROM issues WHERE id=2
        """).fetchone()
        assert row["parent_id"] == "WOT-1"

    def test_stale_working_detection(self, db):
        """Verify detection of issues locked in working state too long."""
        # Create issue locked 5 hours ago
        db.execute("""
            INSERT INTO issues(title, state_label, working_since)
            VALUES ('Stale', 'working', datetime('now', '-5 hours'))
        """)

        # Create issue locked 1 hour ago
        db.execute("""
            INSERT INTO issues(title, state_label, working_since)
            VALUES ('Recent', 'working', datetime('now', '-1 hours'))
        """)

        # Find stale (> 4 hours old)
        rows = db.execute("""
            SELECT 'WOT-' || id AS display_id, title
            FROM issues
            WHERE state_label='working'
            AND working_since < datetime('now', '-4 hours')
            ORDER BY id ASC
        """).fetchall()

        assert len(rows) == 1, "Should find exactly 1 stale issue"
        assert rows[0]["display_id"] == "WOT-1"
        assert rows[0]["title"] == "Stale"


# ============================================================================
# Heartbeat State Machine Tests
# ============================================================================

class TestHeartbeatStateMachine:
    """Simulate heartbeat cycle state transitions and DB mutations.

    Tests that the database correctly reflects state changes during
    a typical heartbeat cycle: lock → work → report → done.
    """

    def test_lock_sets_working(self, db):
        """Step 6: Locking an issue sets state_label='working' and working_since."""
        # Create an issue in todo state
        db.execute("""
            INSERT INTO issues(title, state, persona)
            VALUES ('Task', 'todo', 'backend')
        """)

        # Heartbeat Step 6: lock the issue
        db.execute("""
            UPDATE issues
            SET state_label='working', working_since=datetime('now')
            WHERE id=1
        """)

        # Verify locked state
        row = db.execute("""
            SELECT state, state_label, working_since
            FROM issues WHERE id=1
        """).fetchone()

        assert row["state"] == "todo", "State should remain todo (not changed by lock)"
        assert row["state_label"] == "working", "Should be locked as working"
        assert row["working_since"] is not None, "Should have working_since timestamp"

    def test_report_writes_comment(self, db):
        """Step 9: Heartbeat writes agent comment with counter."""
        # Create issue
        db.execute("""
            INSERT INTO issues(title, persona)
            VALUES ('Task', 'backend')
        """)

        # Heartbeat Step 9: save comment (this is heartbeat #1)
        db.execute("""
            INSERT INTO comments(issue_id, author, persona, body, heartbeat_number)
            VALUES (1, 'agent', 'backend', 'Heartbeat #1: Analysis complete', 1)
        """)

        # Verify comment was saved
        row = db.execute("""
            SELECT author, persona, body, heartbeat_number
            FROM comments WHERE issue_id=1
        """).fetchone()

        assert row["author"] == "agent"
        assert row["persona"] == "backend"
        assert "Heartbeat #1" in row["body"]
        assert row["heartbeat_number"] == 1

    def test_done_clears_state_label(self, db):
        """Step 10: Marking done clears state_label and working_since."""
        # Create locked issue
        db.execute("""
            INSERT INTO issues(title, state_label, working_since)
            VALUES ('Task', 'working', datetime('now'))
        """)

        # Heartbeat Step 10: mark done
        db.execute("""
            UPDATE issues
            SET state='done', state_label=NULL, working_since=NULL
            WHERE id=1
        """)

        # Verify done state
        row = db.execute("""
            SELECT state, state_label, working_since
            FROM issues WHERE id=1
        """).fetchone()

        assert row["state"] == "done"
        assert row["state_label"] is None, "Lock should be cleared"
        assert row["working_since"] is None, "working_since should be cleared"

    def test_blocked_replaces_working(self, db):
        """Step 10 (blocked path): Transition from working to blocked."""
        # Create locked issue
        db.execute("""
            INSERT INTO issues(title, state_label, working_since)
            VALUES ('Task', 'working', datetime('now'))
        """)

        # Heartbeat Step 10 (blocked): replace working with blocked
        db.execute("""
            UPDATE issues
            SET state_label='blocked', working_since=NULL
            WHERE id=1
        """)

        # Verify blocked state
        row = db.execute("""
            SELECT state_label, working_since
            FROM issues WHERE id=1
        """).fetchone()

        assert row["state_label"] == "blocked"
        assert row["working_since"] is None, "working_since should be cleared when blocked"


# ============================================================================
# Integration Tests: Multi-Issue Heartbeat Scenarios
# ============================================================================

class TestHeartbeatIntegration:
    """Test realistic heartbeat scenarios with multiple issues."""

    def test_inbox_query_respects_priority_order(self, db):
        """Inbox query should return issues ordered by priority (ascending = urgent first)."""
        # Create issues with different priorities
        db.execute("INSERT INTO issues(title, priority) VALUES ('Urgent', 1)")
        db.execute("INSERT INTO issues(title, priority) VALUES ('Low', 4)")
        db.execute("INSERT INTO issues(title, priority) VALUES ('High', 2)")
        db.execute("INSERT INTO issues(title, priority) VALUES ('Medium', 3)")

        # Query inbox
        rows = db.execute("""
            SELECT 'WOT-' || id AS display_id, priority
            FROM issues
            WHERE state IN ('todo', 'in_progress') AND state_label IS NULL
            ORDER BY priority ASC, id ASC
        """).fetchall()

        priorities = [r["priority"] for r in rows]
        assert priorities == [1, 2, 3, 4], "Should be ordered by priority ascending"

    def test_locked_issues_excluded_from_inbox(self, db):
        """Inbox query should exclude issues with state_label set."""
        # Create issues: one free, one locked
        db.execute("INSERT INTO issues(title, priority) VALUES ('Free', 1)")
        db.execute("""
            INSERT INTO issues(title, priority, state_label, working_since)
            VALUES ('Locked', 1, 'working', datetime('now'))
        """)

        # Query inbox
        rows = db.execute("""
            SELECT 'WOT-' || id AS display_id
            FROM issues
            WHERE state IN ('todo', 'in_progress') AND state_label IS NULL
            ORDER BY priority ASC
        """).fetchall()

        assert len(rows) == 1
        assert rows[0]["display_id"] == "WOT-1", "Only unlocked issue should appear"

    def test_sub_issue_priority_bump(self, db):
        """Child issue should have bumped priority (MAX(1, parent_priority - 1))."""
        # Create parent with priority 3 (medium)
        db.execute("INSERT INTO issues(title, priority) VALUES ('Parent', 3)")

        # Create child with bumped priority
        parent_row = db.execute("SELECT priority FROM issues WHERE id=1").fetchone()
        child_priority = max(1, parent_row["priority"] - 1)
        db.execute(f"""
            INSERT INTO issues(title, priority, parent_id)
            VALUES ('Child', {child_priority}, 1)
        """)

        child_row = db.execute("SELECT priority FROM issues WHERE id=2").fetchone()
        assert child_row["priority"] == 2, "Child should be bumped to high (2)"

        # Test edge case: urgent parent should keep child at urgent
        db.execute("INSERT INTO issues(title, priority) VALUES ('Urgent parent', 1)")
        urgent_priority = max(1, 1 - 1)  # Max(1, 0) = 1
        db.execute(f"""
            INSERT INTO issues(title, priority, parent_id)
            VALUES ('Child of urgent', {urgent_priority}, 3)
        """)

        urgent_child = db.execute("SELECT priority FROM issues WHERE id=4").fetchone()
        assert urgent_child["priority"] == 1, "Child of urgent parent should stay urgent"

    def test_full_heartbeat_cycle(self, db):
        """Simulate complete heartbeat cycle: create → lock → comment → done."""
        # Step 1: Create issue
        db.execute("""
            INSERT INTO issues(title, description, persona, state, priority)
            VALUES ('Fix bug', 'Login timeout', 'backend', 'todo', 2)
        """)

        # Step 2: Fetch inbox (should include this issue)
        row = db.execute("""
            SELECT 'WOT-' || id AS display_id FROM issues
            WHERE state IN ('todo', 'in_progress') AND state_label IS NULL
        """).fetchone()
        assert row["display_id"] == "WOT-1"

        # Step 6: Lock issue
        db.execute("""
            UPDATE issues SET state_label='working', working_since=datetime('now')
            WHERE id=1
        """)

        # Step 7: Get full issue context
        issue = db.execute("""
            SELECT 'WOT-' || id AS display_id, title, persona, state
            FROM issues WHERE id=1
        """).fetchone()
        assert issue["state"] == "todo"
        assert issue["persona"] == "backend"

        # Step 9: Write heartbeat comment
        db.execute("""
            INSERT INTO comments(issue_id, author, persona, body, heartbeat_number)
            VALUES (1, 'agent', 'backend', 'Fixed timeout in login handler', 1)
        """)

        # Step 10: Mark done and unlock
        db.execute("""
            UPDATE issues SET state='done', state_label=NULL
            WHERE id=1
        """)

        # Verify final state
        final = db.execute("""
            SELECT state, state_label FROM issues WHERE id=1
        """).fetchone()
        assert final["state"] == "done"
        assert final["state_label"] is None

        # Verify locked issue is not in inbox anymore
        inbox = db.execute("""
            SELECT COUNT(*) FROM issues
            WHERE state IN ('todo', 'in_progress') AND state_label IS NULL
        """).fetchone()
        assert inbox[0] == 0


# ============================================================================
# Edge Cases and Error Conditions
# ============================================================================

class TestEdgeCases:
    """Test edge cases and boundary conditions."""

    def test_issue_without_persona(self, db):
        """Issues can be created without persona (null)."""
        db.execute("INSERT INTO issues(title) VALUES ('Unrouted')")

        row = db.execute("""
            SELECT persona FROM issues WHERE id=1
        """).fetchone()
        assert row["persona"] is None

    def test_comments_without_heartbeat_number(self, db):
        """Human comments may not have heartbeat_number (null)."""
        db.execute("INSERT INTO issues(title) VALUES ('Issue')")
        db.execute("""
            INSERT INTO comments(issue_id, author, body)
            VALUES (1, 'human', 'User feedback')
        """)

        row = db.execute("""
            SELECT heartbeat_number FROM comments WHERE id=1
        """).fetchone()
        assert row["heartbeat_number"] is None

    def test_parent_id_references_constraint(self, db):
        """Foreign key constraint enforces valid parent_id."""
        # Try to create issue with non-existent parent
        with pytest.raises(sqlite3.IntegrityError):
            db.execute("""
                INSERT INTO issues(title, parent_id)
                VALUES ('Orphan', 999)
            """)

    def test_issue_id_references_in_comments(self, db):
        """Foreign key constraint enforces issue_id exists."""
        with pytest.raises(sqlite3.IntegrityError):
            db.execute("""
                INSERT INTO comments(issue_id, author, body)
                VALUES (999, 'agent', 'Comment on nonexistent issue')
            """)

    def test_default_timestamps(self, db):
        """created_at and updated_at have default timestamp values."""
        db.execute("INSERT INTO issues(title) VALUES ('Test')")

        row = db.execute("""
            SELECT created_at, updated_at FROM issues WHERE id=1
        """).fetchone()

        # Both should be non-null datetime strings
        assert row["created_at"] is not None
        assert row["updated_at"] is not None
        # Both should be parseable as ISO datetime
        datetime.fromisoformat(row["created_at"])
        datetime.fromisoformat(row["updated_at"])

    def test_indices_exist(self, db):
        """Verify indices are created for performance."""
        indices = {r[0] for r in db.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'"
        )}

        expected = {
            'idx_issues_state',
            'idx_issues_state_label',
            'idx_issues_persona',
            'idx_comments_issue',
            'idx_comments_author'
        }
        assert expected.issubset(indices), f"Missing indices: {expected - indices}"


# ============================================================================
# Test Discovery
# ============================================================================

if __name__ == "__main__":
    # Allow running as: python3 tests/test_sqlite_adapter.py
    pytest.main([__file__, "-v"])
