from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.workflow_brief import (
    brief_parallel_readiness_drift_reason,
    brief_parallel_safety_reason,
    parallel_readiness_fingerprint,
    summarize_parallel_runs,
)


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
        "source": {
            "parallelReadinessFingerprint": "fingerprint-a",
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

    drift_reason = brief_parallel_readiness_drift_reason(payload, "fingerprint-b")
    if not drift_reason or "Parallel-readiness evidence changed" not in drift_reason:
        raise AssertionError(f"Expected parallel readiness drift rejection, got {drift_reason!r}")

    drift_reason = brief_parallel_readiness_drift_reason(payload, "fingerprint-a")
    if drift_reason is not None:
        raise AssertionError(f"Expected unchanged readiness fingerprint to pass, got {drift_reason!r}")

    readiness_a = {
        "blockerEdges": [
            {"blockedId": "DEP-2", "blockerId": "DEP-1", "relationType": "blocks"},
            {"blockedId": "DEP-4", "blockerId": "DEP-3", "relationType": "blocks"},
        ],
        "candidates": [
            {
                "activeLane": False,
                "activeReasons": [],
                "blockedBy": [],
                "blocks": [],
                "changedPaths": ["b.ts", "a.ts"],
                "changedZones": ["src"],
                "prNumbers": [2, 1],
                "status": "ready",
                "ticketIds": ["DEP-1"],
                "workflowId": "ticket:DEP-1",
            },
            {
                "activeLane": False,
                "activeReasons": [],
                "blockedBy": [],
                "blocks": [],
                "changedPaths": ["c.ts"],
                "changedZones": ["server"],
                "prNumbers": [],
                "status": "ready",
                "ticketIds": ["DEP-3"],
                "workflowId": "ticket:DEP-3",
            },
        ],
        "laneLoad": {"activeCount": 0, "maxActiveLanes": 3, "openSlots": 2, "recommendedActiveLanes": 2},
        "pairwise": [
            {
                "leftWorkflowId": "ticket:DEP-1",
                "reason": "safe",
                "rightWorkflowId": "ticket:DEP-3",
                "status": "safe",
                "type": "independent",
            },
        ],
        "suggestedWaves": [
            {"id": "wave:ready", "workflowIds": ["ticket:DEP-3", "ticket:DEP-1"]},
        ],
    }
    readiness_b = {
        **readiness_a,
        "blockerEdges": list(reversed(readiness_a["blockerEdges"])),
        "candidates": list(reversed(readiness_a["candidates"])),
        "suggestedWaves": [
            {"id": "wave:ready", "workflowIds": ["ticket:DEP-1", "ticket:DEP-3"]},
        ],
    }
    if parallel_readiness_fingerprint(readiness_a) != parallel_readiness_fingerprint(readiness_b):
        raise AssertionError("Expected parallel readiness fingerprint to be order-insensitive")

    dashboard = {
        "codexSessions": [
            {
                "status": "running",
                "threadId": "thread-live",
            },
        ],
        "tickets": [
            {
                "nextAction": "Review the idle lane.",
                "state": "In Progress",
                "ticketId": "DEP-2",
            },
        ],
    }
    parallel_runs = summarize_parallel_runs(
        [
            {
                "batchId": "batch-live",
                "batchTitle": "Live batch",
                "id": "handoff-live",
                "kind": "launch-codex",
                "ranAt": "2026-06-22T00:02:00Z",
                "title": "Live lane",
                "workflowId": "session:thread-live",
            },
            {
                "batchId": "batch-live",
                "batchTitle": "Live batch",
                "id": "handoff-cleared",
                "kind": "open-pr",
                "ranAt": "2026-06-22T00:01:00Z",
                "title": "Cleared lane",
                "workflowId": "pr:123",
            },
            {
                "batchId": "batch-waiting",
                "batchTitle": "Waiting batch",
                "id": "handoff-waiting",
                "kind": "launch-codex",
                "ranAt": "2026-06-22T00:03:00Z",
                "ticketId": "DEP-2",
                "title": "Waiting lane",
                "workflowId": "ticket:DEP-2",
            },
        ],
        dashboard,
    )
    by_batch = {item["batchId"]: item for item in parallel_runs}
    live_batch = by_batch["batch-live"]
    if (
        live_batch["status"] != "live"
        or live_batch["liveCount"] != 1
        or live_batch["clearedCount"] != 1
        or "Wait for live lanes" not in live_batch["nextAction"]
    ):
        raise AssertionError(f"Expected live parallel-run summary, got {live_batch!r}")
    waiting_batch = by_batch["batch-waiting"]
    if (
        waiting_batch["status"] != "waiting"
        or waiting_batch["quietCount"] != 1
        or "Review idle lanes" not in waiting_batch["nextAction"]
    ):
        raise AssertionError(f"Expected waiting parallel-run summary, got {waiting_batch!r}")

    print("verified workflow brief parallel-safety validation")


if __name__ == "__main__":
    main()
