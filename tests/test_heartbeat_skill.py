"""
Heartbeat Skill Refactoring Tests

Tests that the refactored heartbeat skill (0.2.0) correctly implements
the adapter pattern: no inline Linear MCP calls, all operations delegated
to adapter references, v1→v2 migration supported, and board.user_name
fallback implemented.

Run with: python3 -m pytest tests/test_heartbeat_skill.py -v
"""

import re
import os


def read_skill_file(path="skills/heartbeat/SKILL.md"):
    """Read the heartbeat SKILL.md file."""
    with open(path) as f:
        return f.read()


class TestHeartbeatSkillAdapter:
    """Test that heartbeat skill correctly uses adapter pattern."""

    def test_all_operations_referenced(self):
        """
        Test 1: All 11 adapter operations are mentioned in the skill.

        Validates that the refactored skill references all required operations
        from the adapter reference files. The 11 operations are:
        1. inbox_query
        2. get_issue
        3. set_state_label
        4. has_new_human_comments
        5. detect_stale_working
        6. list_comments
        7. next_heartbeat_number
        8. create_sub_issue
        9. save_comment
        10. update_state
        11. save_issue (for reference context)
        """
        skill = read_skill_file()

        operations = [
            "inbox_query",
            "get_issue",
            "set_state_label",
            "has_new_human_comments",
            "detect_stale_working",
            "list_comments",
            "next_heartbeat_number",
            "create_sub_issue",
            "save_comment",
            "update_state",
            "save_issue",  # documented for context
        ]

        for operation in operations:
            assert operation in skill, (
                f"Operation '{operation}' not mentioned in heartbeat skill. "
                f"Skill should reference all 11 adapter operations."
            )

    def test_no_inline_linear_calls(self):
        """
        Test 2: No inline Linear MCP tool calls in the skill.

        Validates that the skill does NOT contain actual MCP tool invocations
        like `mcp__claude_ai_Linear__list_issues(...)` or
        `mcp__claude_ai_Linear__get_issue(...)`. All Linear-specific logic
        should be in the backend-linear.md adapter reference. This ensures
        the skill remains backend-agnostic.
        """
        skill = read_skill_file()

        # Pattern: mcp__claude_ai_Linear__<anything>( with content after it
        # But exclude lines that are explaining tool names (e.g., "should match")
        inline_calls = re.findall(
            r"mcp__claude_ai_Linear__\w+\([^)]*\)",
            skill
        )

        # Should have zero inline calls (invocations with parentheses and args)
        assert len(inline_calls) == 0, (
            f"Found inline Linear MCP calls: {inline_calls}. "
            f"All MCP calls should be routed through adapter operations. "
            f"Move implementation to backend-linear.md."
        )

    def test_migration_mentioned(self):
        """
        Test 3: v1→v2 migration logic is documented.

        Validates that the skill mentions handling of v1 configs (Linear-only,
        no backend field) and automatic migration to v2 (with backend field).
        Migration should:
        - Detect version: 1
        - Backup config to .bak
        - Add backend: linear
        - Update version to 2
        """
        skill = read_skill_file()

        migration_keywords = [
            "version: 1",
            "migration",
            "config.yaml.bak",
            "backend: linear",
            "version: 2",
        ]

        for keyword in migration_keywords:
            assert keyword in skill, (
                f"Migration keyword '{keyword}' not found in heartbeat skill. "
                f"Skill must document v1→v2 config migration."
            )

    def test_board_user_fallback_mentioned(self):
        """
        Test 4: board.user_name fallback documented.

        Validates that the skill mentions using board.user_name for blocked
        issue escalation, with fallback to linear.user_name for backwards
        compatibility with v1 configs that don't have board.user_name.
        """
        skill = read_skill_file()

        assert "board.user_name" in skill, (
            "board.user_name not mentioned in heartbeat skill. "
            "Should be used for blocked issue escalation (Step 9)."
        )

        assert "linear.user_name" in skill, (
            "linear.user_name fallback not mentioned. "
            "Should be used when board.user_name not set (backwards compat)."
        )

        assert "fallback" in skill.lower() or "compat" in skill.lower(), (
            "Fallback or compatibility strategy not explained. "
            "Should explain that linear.user_name is fallback for v1 configs."
        )


class TestHeartbeatSkillVersion:
    """Test that skill metadata is correct."""

    def test_skill_version_bumped(self):
        """Verify that skill version is bumped to 0.2.0."""
        skill = read_skill_file()

        assert "version: 0.2.0" in skill, (
            "Skill version should be bumped to 0.2.0 for adapter pattern refactor. "
            "Check frontmatter ---version: 0.2.0---"
        )

    def test_skill_description_mentions_adapter(self):
        """Verify that skill description mentions adapter pattern."""
        skill = read_skill_file()

        # Extract frontmatter (content between --- markers)
        frontmatter_match = re.search(r'^---\n(.*?)\n---', skill, re.MULTILINE | re.DOTALL)
        assert frontmatter_match, "Skill frontmatter not found"

        frontmatter = frontmatter_match.group(1)

        # Check that description field exists and contains "adapter"
        assert "description:" in frontmatter, "Skill description field missing"
        assert "Adapter-agnostic" in skill or "adapter" in skill.lower(), (
            "Skill should mention 'adapter' pattern in description or content. "
            "Indicates backend-agnostic design."
        )


class TestHeartbeatSkillStructure:
    """Test overall skill structure and completeness."""

    def test_skill_has_all_steps(self):
        """Verify all 11 heartbeat steps are documented."""
        skill = read_skill_file()

        for step_num in range(1, 12):
            step_marker = f"## Step {step_num}:"
            assert step_marker in skill, (
                f"Step {step_num} not found in skill. "
                f"All 11 steps must be documented."
            )

    def test_adapter_reference_section_present(self):
        """Verify that adapter operations reference section exists."""
        skill = read_skill_file()

        assert "Adapter Operations Reference" in skill, (
            "Skill should have section documenting all 11 adapter operations. "
            "Should list operation names and steps where each is used."
        )

    def test_backend_differences_documented(self):
        """Verify that Linear vs SQLite differences are documented."""
        skill = read_skill_file()

        assert "Backend Differences" in skill or "backend" in skill.lower(), (
            "Skill should document differences between Linear and SQLite backends. "
            "Should explain how each backend implements the adapter operations."
        )


class TestAdapterReferenceLinks:
    """Test that adapter reference files are correctly referenced."""

    def test_adapter_references_are_valid_paths(self):
        """Verify that adapter reference paths are correct."""
        skill = read_skill_file()

        # Should reference both adapter files by path
        assert "backend-sqlite.md" in skill, (
            "Skill should reference backend-sqlite.md adapter. "
            "Should be at ${CLAUDE_PLUGIN_ROOT}/references/backend-sqlite.md"
        )

        assert "backend-linear.md" in skill, (
            "Skill should reference backend-linear.md adapter. "
            "Should be at ${CLAUDE_PLUGIN_ROOT}/references/backend-linear.md"
        )

    def test_claude_plugin_root_used_for_references(self):
        """Verify that ${CLAUDE_PLUGIN_ROOT} is used for all file references."""
        skill = read_skill_file()

        # Should use ${CLAUDE_PLUGIN_ROOT} for all references
        assert "${CLAUDE_PLUGIN_ROOT}/references/" in skill, (
            "Skill should use ${CLAUDE_PLUGIN_ROOT} for all reference paths. "
            "Never hardcode plugin directory paths."
        )

        # Verify at least one reference uses the pattern
        plugin_root_refs = re.findall(
            r"\$\{CLAUDE_PLUGIN_ROOT\}/references/[\w-]+\.md",
            skill
        )
        assert len(plugin_root_refs) >= 2, (
            "Should reference at least 2 adapter files with ${CLAUDE_PLUGIN_ROOT}. "
            f"Found: {plugin_root_refs}"
        )


class TestHeartbeatSkillConcurrency:
    """Test that heartbeat skill documents concurrency/parallelism features."""

    def test_max_parallel_mentioned(self):
        """heartbeat SKILL.md mentions max_parallel"""
        skill = read_skill_file()
        assert "max_parallel" in skill, (
            "'max_parallel' not found in heartbeat skill. "
            "Skill should document the max_parallel concurrency config."
        )

    def test_parallel_dispatch_mentioned(self):
        """heartbeat SKILL.md mentions subagent dispatch or fan-out"""
        skill = read_skill_file()
        assert any(term in skill for term in ("dispatch", "fan-out", "subagent")), (
            "No parallel dispatch term ('dispatch', 'fan-out', 'subagent') found in heartbeat skill. "
            "Skill should document how issues are dispatched to subagents concurrently."
        )

    def test_orphan_cleanup_mentioned(self):
        """heartbeat SKILL.md mentions orphan cleanup"""
        skill = read_skill_file()
        assert any(term in skill for term in ("orphan", "cleanup")), (
            "No orphan/cleanup term found in heartbeat skill. "
            "Skill should document orphan subagent cleanup logic."
        )


if __name__ == "__main__":
    import pytest
    pytest.main([__file__, "-v"])
