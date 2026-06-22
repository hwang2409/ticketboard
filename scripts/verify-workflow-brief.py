from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.workflow_brief import brief_parallel_safety_reason


def main() -> None:
    payload = {
        "generatedAt": "2026-06-22T00:00:00Z",
        "lanes": [
            {
                "action": "Finish dependency first.",
                "parallelSafe": True,
                "role": "focus",
                "ticketId": "DEP-1",
                "title": "Build dependency",
                "why": "It unlocks the next lane.",
                "workflowId": "ticket:DEP-1",
            },
            {
                "action": "Start dependent lane.",
                "parallelSafe": True,
                "role": "parallel",
                "ticketId": "DEP-2",
                "title": "Build dependent workflow",
                "why": "The generated brief incorrectly marked this safe.",
                "workflowId": "ticket:DEP-2",
            },
        ],
        "now": {
            "action": "Finish dependency first.",
            "confidence": "high",
            "ticketId": "DEP-1",
            "title": "Build dependency",
            "why": "It unlocks the next lane.",
            "workflowId": "ticket:DEP-1",
        },
        "version": 1,
    }
    readiness = {
        "candidates": [
            {
                "blockedBy": [],
                "status": "ready",
                "workflowId": "ticket:DEP-1",
            },
            {
                "blockedBy": [
                    {
                        "blockedId": "DEP-2",
                        "blockerId": "DEP-1",
                    },
                ],
                "status": "blocked",
                "workflowId": "ticket:DEP-2",
            },
        ],
        "pairwise": [
            {
                "leftWorkflowId": "ticket:DEP-1",
                "reason": "DEP-1 blocks DEP-2.",
                "rightWorkflowId": "ticket:DEP-2",
                "status": "blocked",
                "type": "linear-dependency",
            },
        ],
    }
    reason = brief_parallel_safety_reason(payload, readiness)
    if not reason or "DEP-1 blocks DEP-2" not in reason:
        raise AssertionError(f"Expected dependency safety rejection, got {reason!r}")

    payload["lanes"][1]["parallelSafe"] = False
    reason = brief_parallel_safety_reason(payload, readiness)
    if reason is not None:
        raise AssertionError(f"Expected serialized lane to pass safety validation, got {reason!r}")

    print("verified workflow brief parallel-safety validation")


if __name__ == "__main__":
    main()
