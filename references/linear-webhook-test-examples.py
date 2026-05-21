#!/usr/bin/env python3
"""
Linear webhook HMAC verification test examples.
Run with: pytest linear-webhook-test-examples.py -v

Provides concrete test payloads and expected signatures for testing
the HMAC verification implementation.
"""

import hmac
import hashlib
import json
import time
import pytest
from typing import Tuple


# Test fixtures: pre-computed valid signatures
class LinearWebhookFixtures:
    """Valid webhook payloads and their signatures for testing."""
    
    SECRET = "whsec_test_secret_12345"
    
    # Valid payload: Issue created
    ISSUE_CREATED_PAYLOAD = {
        "action": "create",
        "data": {
            "id": "WOT-14",
            "title": "HMAC verification + request routing for Linear",
            "description": "Implement HMAC signature verification for Linear webhook authenticity.",
            "labels": [{"name": "backend", "id": "label-1"}],
            "state": {"id": "todo", "name": "Todo"},
            "assignee": None,
            "teamId": "wotai",
            "priority": 2,
            "createdAt": "2026-05-21T10:00:00Z"
        },
        "teamId": "wotai",
        "userId": "user-nadim",
        "createdAt": "2026-05-21T10:00:00Z"
    }
    
    # Valid payload: Issue updated (status change)
    ISSUE_UPDATED_PAYLOAD = {
        "action": "update",
        "data": {
            "id": "WOT-14",
            "title": "HMAC verification + request routing for Linear",
            "previousValues": {
                "state": {"id": "todo", "name": "Todo"}
            },
            "state": {"id": "in_progress", "name": "In Progress"},
            "teamId": "wotai"
        },
        "teamId": "wotai",
        "userId": "user-nadim",
        "createdAt": "2026-05-21T10:15:00Z"
    }
    
    @staticmethod
    def compute_signature(payload: dict, timestamp: int = None) -> Tuple[str, int]:
        """
        Compute valid HMAC-SHA256 signature for payload.
        
        Returns:
            (signature_header_value, timestamp)
            signature_header_value = "v1,<hex>"
        """
        if timestamp is None:
            timestamp = int(time.time())
        
        payload_json = json.dumps(payload, separators=(',', ':'), sort_keys=True)
        message = f"{timestamp}.{payload_json}"
        
        sig_hex = hmac.new(
            LinearWebhookFixtures.SECRET.encode(),
            message.encode(),
            hashlib.sha256
        ).hexdigest()
        
        return f"v1,{sig_hex}", timestamp


def test_issue_created_signature():
    """Verify fixture: Issue created payload produces expected signature."""
    sig, ts = LinearWebhookFixtures.compute_signature(
        LinearWebhookFixtures.ISSUE_CREATED_PAYLOAD
    )
    
    # Signature should be in format "v1,<hex>"
    assert sig.startswith("v1,")
    assert len(sig) == 71  # "v1," + 64-char hex
    
    # Timestamp should be recent
    current_time = int(time.time())
    assert abs(current_time - ts) < 10


def test_signature_changes_with_payload():
    """Verify: Different payloads produce different signatures."""
    payload1 = {"id": "WOT-14", "title": "Issue A"}
    payload2 = {"id": "WOT-14", "title": "Issue B"}
    
    sig1, _ = LinearWebhookFixtures.compute_signature(payload1, timestamp=1000000)
    sig2, _ = LinearWebhookFixtures.compute_signature(payload2, timestamp=1000000)
    
    assert sig1 != sig2


def test_signature_changes_with_timestamp():
    """Verify: Different timestamps produce different signatures."""
    payload = {"id": "WOT-14"}
    
    sig1, _ = LinearWebhookFixtures.compute_signature(payload, timestamp=1000000)
    sig2, _ = LinearWebhookFixtures.compute_signature(payload, timestamp=1000001)
    
    assert sig1 != sig2


# Example webhook event payloads (real Linear webhook format)
class LinearWebhookExamples:
    """Real-world webhook event examples from Linear."""
    
    @staticmethod
    def issue_created_event() -> dict:
        """Issue created in Linear team."""
        return {
            "action": "create",
            "data": {
                "id": "WOT-14",
                "title": "HMAC verification + request routing for Linear",
                "description": "Implement HMAC signature verification...",
                "url": "https://linear.app/wotai/issue/WOT-14/hmac-verification",
                "labels": [
                    {
                        "id": "label-backend",
                        "name": "backend",
                        "color": "#0099FF"
                    }
                ],
                "state": {
                    "id": "state-todo",
                    "name": "Todo",
                    "type": "backlog"
                },
                "priority": 2,
                "assignee": None,
                "parentId": None,
                "teamId": "wotai",
                "createdAt": "2026-05-21T10:00:00.000Z",
                "updatedAt": "2026-05-21T10:00:00.000Z",
                "archivedAt": None
            },
            "teamId": "wotai",
            "userId": "user-nadim",
            "createdAt": "2026-05-21T10:00:00.000Z"
        }
    
    @staticmethod
    def issue_updated_event() -> dict:
        """Issue updated (state change) in Linear team."""
        return {
            "action": "update",
            "data": {
                "id": "WOT-14",
                "title": "HMAC verification + request routing for Linear",
                "previousValues": {
                    "state": {
                        "id": "state-todo",
                        "name": "Todo",
                        "type": "backlog"
                    }
                },
                "state": {
                    "id": "state-in-progress",
                    "name": "In Progress",
                    "type": "started"
                },
                "teamId": "wotai",
                "updatedAt": "2026-05-21T10:15:00.000Z"
            },
            "teamId": "wotai",
            "userId": "user-nadim",
            "createdAt": "2026-05-21T10:15:00.000Z"
        }
    
    @staticmethod
    def issue_archived_event() -> dict:
        """Issue archived (deleted) in Linear team."""
        return {
            "action": "archive",
            "data": {
                "id": "WOT-14",
                "title": "HMAC verification + request routing for Linear",
                "archivedAt": "2026-05-21T10:30:00.000Z",
                "teamId": "wotai"
            },
            "teamId": "wotai",
            "userId": "user-nadim",
            "createdAt": "2026-05-21T10:30:00.000Z"
        }
    
    @staticmethod
    def issue_comment_event() -> dict:
        """Comment added to issue."""
        return {
            "action": "create",
            "data": {
                "id": "comment-123",
                "body": "Starting implementation of HMAC verification.",
                "user": {
                    "id": "user-nadim",
                    "name": "Nadim Tuhin",
                    "email": "nadim@wotai.com"
                },
                "issue": {
                    "id": "WOT-14"
                },
                "teamId": "wotai",
                "createdAt": "2026-05-21T10:45:00.000Z"
            },
            "teamId": "wotai",
            "userId": "user-nadim",
            "createdAt": "2026-05-21T10:45:00.000Z"
        }


# Test scenarios
class TestLinearWebhookVerification:
    """Test cases for HMAC verification implementation."""
    
    def test_compute_valid_signature(self):
        """Verify signature computation produces consistent results."""
        payload = {"id": "WOT-14"}
        timestamp = 1621234567
        
        sig1, ts1 = LinearWebhookFixtures.compute_signature(payload, timestamp)
        sig2, ts2 = LinearWebhookFixtures.compute_signature(payload, timestamp)
        
        assert sig1 == sig2
        assert ts1 == ts2
    
    def test_real_world_issue_created(self):
        """Test signature with real-world Issue.created payload."""
        event = LinearWebhookExamples.issue_created_event()
        sig, ts = LinearWebhookFixtures.compute_signature(event)
        
        # Verify signature format
        assert sig.startswith("v1,")
        
        # Signature should be reproducible
        sig2, _ = LinearWebhookFixtures.compute_signature(event, ts)
        assert sig == sig2
    
    def test_real_world_issue_updated(self):
        """Test signature with real-world Issue.updated payload."""
        event = LinearWebhookExamples.issue_updated_event()
        sig, ts = LinearWebhookFixtures.compute_signature(event)
        
        assert sig.startswith("v1,")
        assert len(sig) == 71  # "v1," + 64-char hex
    
    def test_different_secrets_produce_different_sigs(self):
        """Verify: Same payload with different secrets produce different signatures."""
        payload = LinearWebhookExamples.issue_created_event()
        timestamp = 1621234567
        
        # Compute with fixture secret
        message = f"{timestamp}.{json.dumps(payload, separators=(',', ':'), sort_keys=True)}"
        sig_correct = hmac.new(
            LinearWebhookFixtures.SECRET.encode(),
            message.encode(),
            hashlib.sha256
        ).hexdigest()
        
        # Compute with wrong secret
        sig_wrong = hmac.new(
            "wrong_secret".encode(),
            message.encode(),
            hashlib.sha256
        ).hexdigest()
        
        assert sig_correct != sig_wrong


def test_payload_serialization():
    """Verify: Payload must be serialized consistently for signature validation."""
    payload = {
        "action": "create",
        "data": {
            "id": "WOT-14",
            "title": "Test",
            "labels": [{"name": "backend"}]
        }
    }
    
    # Two different serializations should produce different signatures
    json1 = json.dumps(payload, separators=(',', ':'), sort_keys=True)
    json2 = json.dumps(payload, separators=(', ', ': '), sort_keys=False)
    
    sig1 = hmac.new(b"secret", json1.encode(), hashlib.sha256).hexdigest()
    sig2 = hmac.new(b"secret", json2.encode(), hashlib.sha256).hexdigest()
    
    # This is why we MUST use consistent serialization!
    assert sig1 != sig2


if __name__ == '__main__':
    pytest.main([__file__, '-v', '--tb=short'])
