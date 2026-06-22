from __future__ import annotations

import hashlib
import os
import re
import shlex
from collections import defaultdict
from datetime import UTC, datetime
from glob import glob
from pathlib import Path
from typing import Any

import orjson

from .collectors import Settings

WORKFLOW_BRIEF_VERSION = 1
DEFAULT_WORKFLOW_BRIEF_TTL_SECONDS = 10 * 60
DEFAULT_WORKFLOW_AUTOMATION_INTERVAL_MS = 10 * 60 * 1000
DEFAULT_WORKFLOW_LOCK_TTL_MS = 30 * 60 * 1000
MAX_PLAN_DOC_CHARS = 40_000
MAX_PLAN_DOCS = 6
MAX_PLAN_DOC_SIGNAL_LINES = 8
VOLATILE_EVIDENCE_KEYS = {"dashboardGeneratedAt", "generatedAt", "refreshRequest"}
TICKET_ID_PATTERN = re.compile(r"\b[A-Z][A-Z0-9]{1,9}-\d+\b")


def workflow_brief_path(settings: Settings) -> Path:
    configured = os.environ.get("TICKETBOARD_WORKFLOW_BRIEF_PATH", "").strip()
    if configured:
        return Path(configured).expanduser()
    return settings.cache_dir / "workflow-brief.json"


def workflow_evidence_snapshot_path(settings: Settings) -> Path:
    configured = os.environ.get("TICKETBOARD_WORKFLOW_SNAPSHOT_PATH", "").strip()
    if configured:
        return Path(configured).expanduser()
    return settings.cache_dir / "workflow-evidence-snapshot.json"


def workflow_brief_ttl_seconds() -> int:
    return int(
        os.environ.get(
            "TICKETBOARD_WORKFLOW_BRIEF_TTL",
            str(DEFAULT_WORKFLOW_BRIEF_TTL_SECONDS),
        ),
    )


def workflow_automation_interval_seconds() -> int:
    return max(
        60,
        int(
            os.environ.get(
                "TICKETBOARD_WORKFLOW_AUTOMATION_INTERVAL_MS",
                str(DEFAULT_WORKFLOW_AUTOMATION_INTERVAL_MS),
            ),
        )
        // 1000,
    )


def workflow_lock_ttl_seconds() -> int:
    return max(
        60,
        int(
            os.environ.get(
                "TICKETBOARD_WORKFLOW_LOCK_TTL_MS",
                str(DEFAULT_WORKFLOW_LOCK_TTL_MS),
            ),
        )
        // 1000,
    )


def workflow_fingerprint_path(brief_path: Path) -> Path:
    configured = os.environ.get("TICKETBOARD_WORKFLOW_FINGERPRINT_PATH", "").strip()
    if configured:
        return Path(configured).expanduser()
    return Path(f"{brief_path}.fingerprint.json")


def workflow_lock_path(brief_path: Path) -> Path:
    configured = os.environ.get("TICKETBOARD_WORKFLOW_LOCK_PATH", "").strip()
    if configured:
        return Path(configured).expanduser()
    return Path(f"{brief_path}.lock")


def workflow_refresh_request_path(brief_path: Path) -> Path:
    configured = os.environ.get("TICKETBOARD_WORKFLOW_REFRESH_REQUEST_PATH", "").strip()
    if configured:
        return Path(configured).expanduser()
    return Path(f"{brief_path}.refresh-request.json")


def workflow_automation_status(brief_path: Path) -> dict[str, Any]:
    fingerprint_path = workflow_fingerprint_path(brief_path)
    fingerprint = read_json(fingerprint_path)
    if not isinstance(fingerprint, dict):
        fingerprint = {}

    lock_path = workflow_lock_path(brief_path)
    lock_age_seconds: int | None = None
    lock_active = False
    try:
        lock_stat = lock_path.stat()
        lock_age_seconds = max(
            0,
            int(datetime.now(UTC).timestamp() - lock_stat.st_mtime),
        )
        lock_active = lock_age_seconds <= workflow_lock_ttl_seconds()
    except FileNotFoundError:
        pass
    except Exception:
        lock_age_seconds = None

    return {
        "briefTtlSeconds": workflow_brief_ttl_seconds(),
        "intervalSeconds": workflow_automation_interval_seconds(),
        "lockActive": lock_active,
        "lockAgeSeconds": lock_age_seconds,
        "lockPath": str(lock_path),
        "lockStale": lock_age_seconds is not None and not lock_active,
        "lockTtlSeconds": workflow_lock_ttl_seconds(),
        "fingerprintPath": str(fingerprint_path),
        "fingerprintStatus": fingerprint.get("status"),
        "fingerprintUpdatedAt": fingerprint.get("updatedAt"),
        "evidenceFingerprint": fingerprint.get("evidenceFingerprint"),
        "snapshotPath": fingerprint.get("snapshotPath"),
        "refreshRequest": workflow_refresh_request_status(brief_path),
    }


def workflow_refresh_request_status(brief_path: Path) -> dict[str, Any]:
    path = workflow_refresh_request_path(brief_path)
    payload = read_json(path)
    if not isinstance(payload, dict):
        return {
            "active": False,
            "path": str(path),
        }

    requested_at = str(payload.get("requestedAt") or "")
    requested_at_dt = parse_iso_datetime(requested_at)
    age_seconds = (
        max(0, int((datetime.now(UTC) - requested_at_dt).total_seconds()))
        if requested_at_dt
        else None
    )
    return {
        "active": True,
        "ageSeconds": age_seconds,
        "batchId": payload.get("batchId"),
        "batchTitle": payload.get("batchTitle"),
        "handoffId": payload.get("handoffId"),
        "kind": payload.get("kind"),
        "path": str(path),
        "prNumber": payload.get("prNumber"),
        "reason": payload.get("reason"),
        "requestedAt": requested_at or None,
        "source": payload.get("source"),
        "ticketId": payload.get("ticketId"),
        "title": payload.get("title"),
        "workflowId": payload.get("workflowId"),
    }


def workflow_refresh_request_evidence(brief_path: Path) -> dict[str, Any]:
    status = workflow_refresh_request_status(brief_path)
    if not status.get("active"):
        return {
            "active": False,
            "path": status.get("path"),
        }
    return {
        "active": True,
        "batchId": status.get("batchId"),
        "batchTitle": status.get("batchTitle"),
        "handoffId": status.get("handoffId"),
        "kind": status.get("kind"),
        "path": status.get("path"),
        "prNumber": status.get("prNumber"),
        "reason": status.get("reason"),
        "requestedAt": status.get("requestedAt"),
        "source": status.get("source"),
        "ticketId": status.get("ticketId"),
        "title": status.get("title"),
        "workflowId": status.get("workflowId"),
    }


def request_workflow_brief_refresh(
    settings: Settings,
    payload: dict[str, Any],
) -> Path:
    path = workflow_refresh_request_path(workflow_brief_path(settings))
    write_json(
        path,
        {
            "version": WORKFLOW_BRIEF_VERSION,
            "requestedAt": utc_now_iso(),
            **payload,
        },
    )
    return path


def workflow_brief_status(
    settings: Settings,
    dashboard: dict[str, Any],
) -> dict[str, Any]:
    path = workflow_brief_path(settings)
    automation = workflow_automation_status(path)
    parallel_readiness = summarize_parallel_readiness(dashboard)
    readiness_fingerprint = parallel_readiness_fingerprint(parallel_readiness)
    payload = read_json(path)
    if payload is None:
        return {
            "status": "missing",
            "brief": None,
            "path": str(path),
            "ageSeconds": None,
            "automation": automation,
            "parallelReadiness": parallel_readiness,
            "parallelReadinessFingerprint": readiness_fingerprint,
            "ttlSeconds": workflow_brief_ttl_seconds(),
            "reason": "No workflow brief has been generated yet.",
        }

    valid, reason = validate_workflow_brief(payload)
    if not valid:
        return {
            "status": "invalid",
            "brief": None,
            "path": str(path),
            "ageSeconds": None,
            "automation": automation,
            "parallelReadiness": parallel_readiness,
            "parallelReadinessFingerprint": readiness_fingerprint,
            "ttlSeconds": workflow_brief_ttl_seconds(),
            "reason": reason,
        }

    safety_reason = brief_parallel_safety_reason(payload, parallel_readiness)
    if safety_reason:
        return {
            "status": "stale",
            "brief": payload,
            "path": str(path),
            "ageSeconds": brief_age_seconds(payload),
            "automation": automation,
            "parallelReadiness": parallel_readiness,
            "parallelReadinessFingerprint": readiness_fingerprint,
            "ttlSeconds": workflow_brief_ttl_seconds(),
            "reason": safety_reason,
        }

    readiness_drift_reason = brief_parallel_readiness_drift_reason(
        payload,
        readiness_fingerprint,
    )
    if readiness_drift_reason:
        return {
            "status": "stale",
            "brief": payload,
            "path": str(path),
            "ageSeconds": brief_age_seconds(payload),
            "automation": automation,
            "parallelReadiness": parallel_readiness,
            "parallelReadinessFingerprint": readiness_fingerprint,
            "ttlSeconds": workflow_brief_ttl_seconds(),
            "reason": readiness_drift_reason,
        }

    age_seconds = brief_age_seconds(payload)
    if age_seconds is not None and age_seconds > workflow_brief_ttl_seconds():
        return {
            "status": "stale",
            "brief": payload,
            "path": str(path),
            "ageSeconds": age_seconds,
            "automation": automation,
            "parallelReadiness": parallel_readiness,
            "parallelReadinessFingerprint": readiness_fingerprint,
            "ttlSeconds": workflow_brief_ttl_seconds(),
            "reason": "The workflow brief is older than the configured TTL.",
        }

    target_id = brief_target_id(payload)
    if target_id and not dashboard_contains_target(dashboard, target_id):
        return {
            "status": "stale",
            "brief": payload,
            "path": str(path),
            "ageSeconds": age_seconds,
            "automation": automation,
            "parallelReadiness": parallel_readiness,
            "parallelReadinessFingerprint": readiness_fingerprint,
            "ttlSeconds": workflow_brief_ttl_seconds(),
            "reason": f"The selected target {target_id} is not visible anymore.",
        }

    return {
        "status": "ready",
        "brief": payload,
        "path": str(path),
        "ageSeconds": age_seconds,
        "automation": automation,
        "parallelReadiness": parallel_readiness,
        "parallelReadinessFingerprint": readiness_fingerprint,
        "ttlSeconds": workflow_brief_ttl_seconds(),
        "reason": None,
    }


def build_workflow_evidence_snapshot(
    settings: Settings,
    dashboard: dict[str, Any],
    *,
    recent_handoffs: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    plan_docs = read_configured_plan_docs()
    plan_doc = plan_docs[0] if plan_docs else None
    parallel_readiness = summarize_parallel_readiness(dashboard)
    snapshot = {
        "version": WORKFLOW_BRIEF_VERSION,
        "generatedAt": utc_now_iso(),
        "dashboardGeneratedAt": dashboard.get("generatedAt"),
        "repo": dashboard.get("repo"),
        "scope": dashboard.get("scope"),
        "tickets": [
            {
                "ticketId": ticket.get("ticketId"),
                "title": ticket.get("title"),
                "state": ticket.get("state"),
                "nextAction": ticket.get("nextAction"),
                "risk": ticket.get("risk"),
                "prNumbers": ticket.get("prNumbers", []),
                "windows": ticket.get("windows", []),
                "worktrees": ticket.get("worktrees", []),
                "branches": ticket.get("branches", []),
            }
            for ticket in dashboard.get("tickets", [])
        ],
        "linearTickets": [
            {
                "ticketId": ticket.get("ticketId"),
                "title": ticket.get("title"),
                "stateName": ticket.get("stateName"),
                "stateType": ticket.get("stateType"),
                "priority": ticket.get("priority"),
                "projectName": ticket.get("projectName"),
                "cycleName": ticket.get("cycleName"),
                "labels": [
                    label.get("name")
                    for label in ticket.get("labels", [])
                    if isinstance(label, dict) and label.get("name")
                ],
                "attachments": summarize_linear_attachments(
                    ticket.get("attachments", []),
                ),
                "latestComments": summarize_linear_comments(
                    ticket.get("comments", []),
                ),
                "relatedIssues": summarize_linear_relations(
                    ticket.get("relatedIssues", []),
                ),
                "branchName": ticket.get("branchName"),
                "startedAt": ticket.get("startedAt"),
                "completedAt": ticket.get("completedAt"),
                "updatedAt": ticket.get("updatedAt"),
                "url": ticket.get("url"),
            }
            for ticket in dashboard.get("linearTickets", [])
        ],
        "projectFocus": summarize_project_focus(dashboard.get("linearTickets", [])),
        "completionMemory": summarize_completion_memory(
            dashboard.get("linearTickets", []),
        ),
        "parallelReadiness": parallel_readiness,
        "parallelReadinessFingerprint": parallel_readiness_fingerprint(
            parallel_readiness,
        ),
        "sourceDossiers": summarize_source_dossiers(dashboard),
        "prs": [
            {
                "number": pr.get("number"),
                "title": pr.get("title"),
                "url": pr.get("url"),
                "ticketIds": pr.get("ticketIds", []),
                "isDraft": pr.get("isDraft"),
                "reviewDecision": pr.get("reviewDecision"),
                "checkSummary": pr.get("checkSummary"),
                "mergeStateStatus": pr.get("mergeStateStatus"),
                "updatedAt": pr.get("updatedAt"),
                "reviewComments": len(pr.get("reviewComments", [])),
                "latestReviews": pr.get("latestReviews", [])[:3],
                "files": summarize_pr_files(pr.get("files", [])),
            }
            for pr in dashboard.get("prs", [])
        ],
        "tmuxWindows": [
            {
                "session": window.get("session"),
                "index": window.get("index"),
                "name": window.get("name"),
                "paneId": window.get("paneId"),
                "path": window.get("path"),
                "command": window.get("command"),
                "active": window.get("active"),
                "ticketIds": window.get("ticketIds", []),
                "isCodexLike": window.get("isCodexLike"),
            }
            for window in dashboard.get("tmuxWindows", [])
        ],
        "worktrees": [
            {
                "path": worktree.get("path"),
                "branch": worktree.get("branch"),
                "dirtyCount": worktree.get("dirtyCount"),
                "statusLines": worktree.get("statusLines", [])[:20],
                "ticketIds": worktree.get("ticketIds", []),
            }
            for worktree in dashboard.get("worktrees", [])
        ],
        "codexSessions": [
            {
                "threadId": session.get("threadId"),
                "title": session.get("title"),
                "cwd": session.get("cwd"),
                "status": session.get("status"),
                "ticketIds": session.get("ticketIds", []),
                "updatedAt": session.get("updatedAt"),
                "goalObjective": session.get("goalObjective"),
                "goalStatus": session.get("goalStatus"),
                "preview": session.get("preview"),
            }
            for session in dashboard.get("codexSessions", [])
        ],
        "recentHandoffs": summarize_recent_handoffs(
            recent_handoffs or [],
            dashboard,
        ),
        "parallelRuns": summarize_parallel_runs(recent_handoffs or [], dashboard),
        "refreshRequest": workflow_refresh_request_evidence(
            workflow_brief_path(settings),
        ),
        "diagnostics": dashboard.get("diagnostics", []),
        "verification": build_source_verification(dashboard),
        "planDoc": plan_doc,
        "planDocs": plan_docs,
        "planningSignals": summarize_plan_docs(plan_docs),
        "instructions": {
            "purpose": (
                "Use this evidence to choose one immediate focus workflow and a "
                "parallel lane plan. Prefer live failing checks, active "
                "tmux/worktree lanes, and review state over quiet strategic backlog. "
                "Only mark lanes parallel-safe when their work can proceed without "
                "overwriting the focus lane or depending on its result. Use "
                "parallelReadiness for deterministic lane load, dependency, file "
                "overlap, and suggested-wave evidence. Treat "
                "recent handoffs as orchestration memory so launched/resumed lanes "
                "are not immediately recommended again unless live evidence changed. "
                "Use parallelRuns to remember which lanes were intentionally launched "
                "together and whether that batch is live, waiting, or cleared before "
                "starting another wave. Use completionMemory to avoid redoing recently "
                "completed work and to promote follow-ups that just became unblocked."
            ),
            "outputPath": str(workflow_brief_path(settings)),
        },
    }
    return snapshot


def build_source_verification(dashboard: dict[str, Any]) -> dict[str, Any]:
    repo = dashboard.get("repo") if isinstance(dashboard.get("repo"), dict) else {}
    repo_path = str(repo.get("path") or "").strip()
    repo_name = str(repo.get("nameWithOwner") or "").strip()
    pr_numbers = dashboard_pr_numbers(dashboard)[:6]
    ticket_ids = dashboard_ticket_ids(dashboard)[:20]
    tmux_windows = [
        window
        for window in dashboard.get("tmuxWindows", [])
        if isinstance(window, dict)
    ]
    tmux_sessions = sorted(
        {
            str(window.get("session") or "").strip()
            for window in tmux_windows
            if str(window.get("session") or "").strip()
        },
    )[:4]
    tmux_panes = [
        str(window.get("paneId") or "").strip()
        for window in tmux_windows
        if str(window.get("paneId") or "").strip()
    ][:8]

    commands: dict[str, list[str]] = {
        "git": [],
        "github": [],
        "tmux": [],
    }
    if repo_path:
        commands["git"].extend(
            [
                shell_join(["git", "-C", repo_path, "status", "--short", "--branch"]),
                shell_join(["git", "-C", repo_path, "worktree", "list", "--porcelain"]),
            ],
        )
    for pr_number in pr_numbers:
        base = ["gh", "pr", "view", str(pr_number)]
        if repo_name:
            base.extend(["--repo", repo_name])
        commands["github"].append(
            shell_join(
                [
                    *base,
                    "--json",
                    "number,title,state,isDraft,reviewDecision,mergeStateStatus,statusCheckRollup,files,updatedAt",
                ],
            ),
        )
        check_command = ["gh", "pr", "checks", str(pr_number)]
        if repo_name:
            check_command.extend(["--repo", repo_name])
        commands["github"].append(shell_join(check_command))
    for session in tmux_sessions:
        commands["tmux"].append(
            shell_join(
                [
                    "tmux",
                    "list-windows",
                    "-t",
                    session,
                    "-F",
                    "#{window_index}\\t#{window_name}\\t#{window_active}\\t#{pane_current_path}\\t#{pane_current_command}\\t#{pane_id}",
                ],
            ),
        )
    for pane_id in tmux_panes:
        commands["tmux"].append(
            shell_join(["tmux", "capture-pane", "-p", "-S", "-80", "-t", pane_id]),
        )

    return {
        "purpose": (
            "Read-only source checks for Codex when snapshot data is missing, stale, "
            "contradictory, or a lane is about to be marked safe or ship-ready."
        ),
        "mcpHints": [
            (
                "If GitHub MCP tools are available, use them read-only to verify "
                "listed PR checks, review state, files, and merge readiness before "
                "choosing focus or ship lanes."
            ),
            (
                "If Linear MCP tools are available, use them read-only to verify "
                "listed ticket states, project membership, blockers, comments, and "
                "priority before overriding planning docs."
            ),
            "Fallback to the git, gh, and tmux commands below when MCP tools are unavailable.",
        ],
        "targets": {
            "githubRepo": repo_name or None,
            "linearTicketIds": ticket_ids,
            "pullRequests": pr_numbers,
            "repoPath": repo_path or None,
            "tmuxSessions": tmux_sessions,
        },
        "commands": commands,
    }


def dashboard_pr_numbers(dashboard: dict[str, Any]) -> list[int]:
    numbers: list[int] = []
    for pr in dashboard.get("prs", []):
        if isinstance(pr, dict) and isinstance(pr.get("number"), int):
            numbers.append(pr["number"])
    return sorted(set(numbers))


def dashboard_ticket_ids(dashboard: dict[str, Any]) -> list[str]:
    ticket_ids: set[str] = set()
    for collection_name in (
        "tickets",
        "linearTickets",
        "prs",
        "codexSessions",
        "tmuxWindows",
        "worktrees",
    ):
        for item in dashboard.get(collection_name, []):
            if not isinstance(item, dict):
                continue
            ticket_id = str(item.get("ticketId") or "").strip().upper()
            if ticket_id:
                ticket_ids.add(ticket_id)
            nested_ticket_ids = item.get("ticketIds", [])
            if isinstance(nested_ticket_ids, list):
                for nested in nested_ticket_ids:
                    nested_id = str(nested or "").strip().upper()
                    if nested_id:
                        ticket_ids.add(nested_id)
    return sorted(ticket_ids)


def shell_join(parts: list[Any]) -> str:
    return " ".join(shlex.quote(str(part)) for part in parts if str(part))


def summarize_recent_handoffs(
    handoffs: list[dict[str, Any]],
    dashboard: dict[str, Any],
) -> list[dict[str, Any]]:
    summarized = []
    for item in handoffs[:10]:
        if not isinstance(item, dict):
            continue
        summarized.append(
            {
                "id": item.get("id"),
                "batchId": item.get("batchId"),
                "batchTitle": item.get("batchTitle"),
                "kind": item.get("kind"),
                "workflowId": item.get("workflowId"),
                "title": item.get("title"),
                "ticketId": item.get("ticketId"),
                "prNumber": item.get("prNumber"),
                "message": item.get("message"),
                "ranAt": item.get("ranAt"),
                "outcome": handoff_outcome(item, dashboard),
            },
        )
    return summarized


def summarize_parallel_runs(
    handoffs: list[dict[str, Any]],
    dashboard: dict[str, Any],
) -> list[dict[str, Any]]:
    grouped: dict[str, dict[str, Any]] = {}
    for item in handoffs:
        if not isinstance(item, dict):
            continue
        batch_id = str(item.get("batchId") or "").strip()
        if not batch_id:
            continue
        group = grouped.setdefault(
            batch_id,
            {
                "batchId": batch_id,
                "batchTitle": str(item.get("batchTitle") or "").strip() or "Parallel run",
                "handoffs": [],
                "ranAt": item.get("ranAt"),
            },
        )
        ran_at = str(item.get("ranAt") or "")
        if ran_at > str(group.get("ranAt") or ""):
            group["ranAt"] = ran_at
        group["handoffs"].append(
            {
                "id": item.get("id"),
                "kind": item.get("kind"),
                "workflowId": item.get("workflowId"),
                "title": item.get("title"),
                "ticketId": item.get("ticketId"),
                "prNumber": item.get("prNumber"),
                "message": item.get("message"),
                "ranAt": item.get("ranAt"),
                "outcome": handoff_outcome(item, dashboard),
            },
        )

    summarized: list[dict[str, Any]] = []
    for group in grouped.values():
        handoff_items = sorted(
            group["handoffs"],
            key=lambda item: str(item.get("ranAt") or ""),
            reverse=True,
        )
        tones = []
        for handoff in handoff_items:
            outcome = handoff.get("outcome")
            if isinstance(outcome, dict):
                tones.append(str(outcome.get("tone") or ""))
        live_count = tones.count("live")
        quiet_count = tones.count("quiet")
        cleared_count = tones.count("cleared")
        status = parallel_run_status(live_count, quiet_count)
        summarized.append(
            {
                "batchId": group["batchId"],
                "batchTitle": group["batchTitle"],
                "ranAt": group.get("ranAt"),
                "laneCount": len(handoff_items),
                "liveCount": live_count,
                "quietCount": quiet_count,
                "clearedCount": cleared_count,
                "status": status,
                "summary": parallel_run_summary(
                    lane_count=len(handoff_items),
                    live_count=live_count,
                    quiet_count=quiet_count,
                    cleared_count=cleared_count,
                ),
                "nextAction": parallel_run_next_action(status),
                "handoffs": handoff_items[:8],
            },
        )

    return sorted(
        summarized,
        key=lambda item: str(item.get("ranAt") or ""),
        reverse=True,
    )[:8]


def parallel_run_status(live_count: int, quiet_count: int) -> str:
    if live_count:
        return "live"
    if quiet_count:
        return "waiting"
    return "cleared"


def parallel_run_summary(
    *,
    lane_count: int,
    live_count: int,
    quiet_count: int,
    cleared_count: int,
) -> str:
    parts = [
        f"{lane_count} lane(s)",
        f"{live_count} live",
        f"{quiet_count} waiting",
        f"{cleared_count} cleared",
    ]
    return "; ".join(parts)


def parallel_run_next_action(status: str) -> str:
    if status == "live":
        return (
            "Wait for live lanes to finish or hand off before starting another "
            "parallel wave."
        )
    if status == "waiting":
        return (
            "Review idle lanes and refresh evidence before starting another "
            "parallel wave."
        )
    return (
        "Batch is cleared; consider the next wave only if parallel readiness "
        "still allows it."
    )


def summarize_pr_files(files: Any) -> list[dict[str, Any]]:
    if not isinstance(files, list):
        return []
    summarized = []
    for item in files[:40]:
        if not isinstance(item, dict):
            continue
        summarized.append(
            {
                "path": item.get("path"),
                "changeType": item.get("changeType"),
                "additions": item.get("additions"),
                "deletions": item.get("deletions"),
            },
        )
    return summarized


def summarize_linear_attachments(attachments: Any) -> list[dict[str, Any]]:
    if not isinstance(attachments, list):
        return []
    summarized = []
    for item in attachments[:8]:
        if not isinstance(item, dict):
            continue
        summarized.append(
            {
                "title": item.get("title"),
                "subtitle": item.get("subtitle"),
                "url": item.get("url"),
                "createdAt": item.get("createdAt"),
            },
        )
    return summarized


def summarize_linear_comments(comments: Any) -> list[dict[str, Any]]:
    if not isinstance(comments, list):
        return []
    sorted_comments = sorted(
        [item for item in comments if isinstance(item, dict)],
        key=lambda item: str(item.get("createdAt") or ""),
        reverse=True,
    )
    return [
        {
            "author": item.get("author"),
            "body": compact_evidence_text(item.get("body"), 320),
            "createdAt": item.get("createdAt"),
            "url": item.get("url"),
        }
        for item in sorted_comments[:5]
    ]


def summarize_linear_relations(relations: Any) -> list[dict[str, Any]]:
    if not isinstance(relations, list):
        return []
    summarized = []
    for item in relations[:12]:
        if not isinstance(item, dict):
            continue
        issue = item.get("issue")
        if not isinstance(issue, dict):
            continue
        summarized.append(
            {
                "relationType": item.get("relationType"),
                "ticketId": issue.get("ticketId"),
                "title": issue.get("title"),
                "stateName": issue.get("stateName"),
                "stateType": issue.get("stateType"),
                "url": issue.get("url"),
            },
        )
    return summarized


def summarize_source_dossiers(dashboard: dict[str, Any]) -> list[dict[str, Any]]:
    linear_by_id = {
        str(ticket.get("ticketId") or "").upper(): ticket
        for ticket in dashboard.get("linearTickets", [])
        if isinstance(ticket, dict) and ticket.get("ticketId")
    }
    prs_by_ticket: dict[str, list[dict[str, Any]]] = defaultdict(list)
    sessions_by_ticket: dict[str, list[dict[str, Any]]] = defaultdict(list)
    worktrees_by_ticket: dict[str, list[dict[str, Any]]] = defaultdict(list)
    windows_by_ticket: dict[str, list[dict[str, Any]]] = defaultdict(list)

    for pr in dashboard.get("prs", []):
        if not isinstance(pr, dict):
            continue
        for ticket_id in pr.get("ticketIds", []):
            prs_by_ticket[str(ticket_id).upper()].append(pr)

    for session in dashboard.get("codexSessions", []):
        if not isinstance(session, dict):
            continue
        for ticket_id in session.get("ticketIds", []):
            sessions_by_ticket[str(ticket_id).upper()].append(session)

    for worktree in dashboard.get("worktrees", []):
        if not isinstance(worktree, dict):
            continue
        for ticket_id in worktree.get("ticketIds", []):
            worktrees_by_ticket[str(ticket_id).upper()].append(worktree)

    for window in dashboard.get("tmuxWindows", []):
        if not isinstance(window, dict):
            continue
        for ticket_id in window.get("ticketIds", []):
            windows_by_ticket[str(ticket_id).upper()].append(window)

    dossiers = []
    for ticket_id, ticket in sorted(linear_by_id.items()):
        dossiers.append(
            {
                "ticketId": ticket_id,
                "title": ticket.get("title"),
                "projectName": ticket.get("projectName"),
                "cycleName": ticket.get("cycleName"),
                "stateName": ticket.get("stateName"),
                "labels": [
                    label.get("name")
                    for label in ticket.get("labels", [])
                    if isinstance(label, dict) and label.get("name")
                ][:8],
                "attachments": summarize_linear_attachments(
                    ticket.get("attachments", []),
                ),
                "latestComments": summarize_linear_comments(
                    ticket.get("comments", []),
                ),
                "relatedIssues": summarize_linear_relations(
                    ticket.get("relatedIssues", []),
                ),
                "prs": [
                    {
                        "number": pr.get("number"),
                        "title": pr.get("title"),
                        "reviewDecision": pr.get("reviewDecision"),
                        "checkSummary": pr.get("checkSummary"),
                        "files": summarize_pr_files(pr.get("files", []))[:12],
                    }
                    for pr in prs_by_ticket.get(ticket_id, [])[:4]
                ],
                "local": {
                    "codexSessions": [
                        {
                            "threadId": session.get("threadId"),
                            "title": session.get("title"),
                            "cwd": session.get("cwd"),
                            "status": session.get("status"),
                            "updatedAt": session.get("updatedAt"),
                        }
                        for session in sessions_by_ticket.get(ticket_id, [])[:4]
                    ],
                    "worktrees": [
                        {
                            "path": worktree.get("path"),
                            "branch": worktree.get("branch"),
                            "dirtyCount": worktree.get("dirtyCount"),
                            "statusLines": worktree.get("statusLines", [])[:12],
                        }
                        for worktree in worktrees_by_ticket.get(ticket_id, [])[:4]
                    ],
                    "tmuxWindows": [
                        {
                            "session": window.get("session"),
                            "index": window.get("index"),
                            "name": window.get("name"),
                            "path": window.get("path"),
                        }
                        for window in windows_by_ticket.get(ticket_id, [])[:4]
                    ],
                },
            },
        )
    return dossiers[:20]


def summarize_parallel_readiness(dashboard: dict[str, Any]) -> dict[str, Any]:
    edges = linear_dependency_edges(dashboard.get("linearTickets", []))
    candidates = parallel_candidates(dashboard, edges)
    pairwise = pairwise_parallel_conflicts(candidates, edges)
    recommended_active = min(
        2,
        max(
            1,
            len(
                [
                    candidate
                    for candidate in candidates
                    if candidate.get("status") not in {"blocked", "done"}
                ],
            ),
        ),
    )
    max_active = max(3, recommended_active)
    active_count = sum(1 for candidate in candidates if candidate.get("activeLane"))
    open_slots = max(0, recommended_active - active_count)
    suggested_wave = suggested_parallel_wave(candidates, pairwise, open_slots)

    return {
        "candidateCount": len(candidates),
        "laneLoad": {
            "activeCount": active_count,
            "maxActiveLanes": max_active,
            "openSlots": open_slots,
            "recommendedActiveLanes": recommended_active,
        },
        "blockerEdges": edges[:24],
        "candidates": [
            {
                key: value
                for key, value in candidate.items()
                if key not in {"sortKey"}
            }
            for candidate in candidates[:16]
        ],
        "pairwise": pairwise[:32],
        "suggestedWaves": [suggested_wave],
        "summary": parallel_readiness_summary(
            active_count=active_count,
            blocked_count=sum(
                1 for candidate in candidates if candidate.get("status") == "blocked"
            ),
            candidate_count=len(candidates),
            open_slots=open_slots,
            wave_count=len(suggested_wave.get("workflowIds", [])),
        ),
    }


def parallel_candidates(
    dashboard: dict[str, Any],
    edges: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    ticket_rows = {
        str(ticket.get("ticketId") or "").upper(): ticket
        for ticket in dashboard.get("tickets", [])
        if isinstance(ticket, dict) and ticket.get("ticketId")
    }
    linear_rows = {
        str(ticket.get("ticketId") or "").upper(): ticket
        for ticket in dashboard.get("linearTickets", [])
        if isinstance(ticket, dict) and ticket.get("ticketId")
    }
    candidates: list[dict[str, Any]] = []

    for ticket_id, ticket in ticket_rows.items():
        candidates.append(
            parallel_ticket_candidate(
                dashboard=dashboard,
                edges=edges,
                linear=linear_rows.get(ticket_id),
                ticket=ticket,
                ticket_id=ticket_id,
            ),
        )

    for ticket_id, linear in linear_rows.items():
        if ticket_id in ticket_rows or linear_issue_done(linear):
            continue
        candidates.append(
            parallel_ticket_candidate(
                dashboard=dashboard,
                edges=edges,
                linear=linear,
                ticket=None,
                ticket_id=ticket_id,
            ),
        )

    pr_ticket_ids = {
        ticket_id
        for candidate in candidates
        for ticket_id in candidate.get("ticketIds", [])
    }
    for pr in dashboard.get("prs", []):
        if not isinstance(pr, dict) or not isinstance(pr.get("number"), int):
            continue
        ticket_ids = [
            str(ticket_id).upper()
            for ticket_id in pr.get("ticketIds", [])
            if str(ticket_id).strip()
        ]
        if ticket_ids and any(ticket_id in pr_ticket_ids for ticket_id in ticket_ids):
            continue
        candidates.append(parallel_pr_candidate(pr))

    return sorted(candidates, key=lambda candidate: candidate["sortKey"])[:20]


def parallel_ticket_candidate(
    *,
    dashboard: dict[str, Any],
    edges: list[dict[str, Any]],
    linear: dict[str, Any] | None,
    ticket: dict[str, Any] | None,
    ticket_id: str,
) -> dict[str, Any]:
    prs = dashboard_items_for_ticket(dashboard, "prs", ticket_id)
    sessions = dashboard_items_for_ticket(dashboard, "codexSessions", ticket_id)
    windows = dashboard_items_for_ticket(dashboard, "tmuxWindows", ticket_id)
    worktrees = dashboard_items_for_ticket(dashboard, "worktrees", ticket_id)
    paths = changed_paths_from_sources(prs, worktrees)
    blockers = blockers_for_ticket(ticket_id, edges)
    blocks = blocks_for_ticket(ticket_id, edges)
    active_reasons = active_lane_reasons(sessions, windows, worktrees)
    status = parallel_ticket_status(
        active=bool(active_reasons),
        blockers=blockers,
        linear=linear,
        prs=prs,
        ticket=ticket,
    )

    return {
        "activeLane": bool(active_reasons),
        "activeReasons": active_reasons,
        "blockedBy": blockers[:6],
        "blocks": blocks[:6],
        "changedPaths": paths[:16],
        "changedZones": changed_path_zones(paths)[:8],
        "cycleName": linear.get("cycleName") if linear else None,
        "nextAction": ticket.get("nextAction") if ticket else None,
        "priority": linear.get("priority") if linear else None,
        "projectName": linear.get("projectName") if linear else None,
        "prNumbers": [pr.get("number") for pr in prs if isinstance(pr.get("number"), int)],
        "risk": ticket.get("risk") if ticket else None,
        "sortKey": parallel_sort_key(status, bool(active_reasons), linear, ticket),
        "state": ticket.get("state") if ticket else None,
        "stateName": linear.get("stateName") if linear else None,
        "stateType": linear.get("stateType") if linear else None,
        "status": status,
        "ticketIds": [ticket_id],
        "title": (
            ticket.get("title")
            if ticket
            else linear.get("title")
            if linear
            else ticket_id
        ),
        "updatedAt": linear.get("updatedAt") if linear else None,
        "workflowId": f"ticket:{ticket_id}",
    }


def parallel_pr_candidate(pr: dict[str, Any]) -> dict[str, Any]:
    paths = changed_paths_from_sources([pr], [])
    status = parallel_pr_status(pr)
    return {
        "activeLane": False,
        "activeReasons": [],
        "blockedBy": [],
        "blocks": [],
        "changedPaths": paths[:16],
        "changedZones": changed_path_zones(paths)[:8],
        "cycleName": None,
        "nextAction": None,
        "priority": None,
        "projectName": None,
        "prNumbers": [pr.get("number")],
        "risk": "medium",
        "sortKey": (
            status_rank(status),
            99,
            newest_first_timestamp(pr.get("updatedAt")),
        ),
        "state": None,
        "stateName": None,
        "stateType": None,
        "status": status,
        "ticketIds": [
            str(ticket_id).upper()
            for ticket_id in pr.get("ticketIds", [])
            if str(ticket_id).strip()
        ],
        "title": pr.get("title"),
        "updatedAt": pr.get("updatedAt"),
        "workflowId": f"pr:{pr.get('number')}",
    }


def parallel_ticket_status(
    *,
    active: bool,
    blockers: list[dict[str, Any]],
    linear: dict[str, Any] | None,
    prs: list[dict[str, Any]],
    ticket: dict[str, Any] | None,
) -> str:
    if linear and linear_issue_done(linear):
        return "done"
    if blockers or ticket and ticket.get("state") == "blocked":
        return "blocked"
    if active:
        return "active"
    if any(pr_check_state(pr) == "red" for pr in prs):
        return "fix-ci"
    if (
        any(pr_needs_review_response(pr) for pr in prs)
        or ticket
        and ticket.get("state") == "review"
    ):
        return "review"
    if any(pr_ready_to_ship(pr) for pr in prs) or ticket and ticket.get("state") == "green":
        return "ship"
    if linear and linear.get("stateType") in {"backlog", "unstarted"}:
        return "queued"
    return "ready"


def parallel_pr_status(pr: dict[str, Any]) -> str:
    if pr_check_state(pr) == "red":
        return "fix-ci"
    if pr_needs_review_response(pr):
        return "review"
    if pr_ready_to_ship(pr):
        return "ship"
    return "review"


def pr_needs_review_response(pr: dict[str, Any]) -> bool:
    if pr.get("reviewDecision") == "CHANGES_REQUESTED":
        return True
    review_comments = pr.get("reviewComments")
    return isinstance(review_comments, list) and len(review_comments) > 0


def pr_ready_to_ship(pr: dict[str, Any]) -> bool:
    return (
        pr_check_state(pr) == "green"
        and not pr.get("isDraft")
        and pr.get("reviewDecision") in {"APPROVED", None}
    )


def active_lane_reasons(
    sessions: list[dict[str, Any]],
    windows: list[dict[str, Any]],
    worktrees: list[dict[str, Any]],
) -> list[str]:
    reasons: list[str] = []
    active_sessions = [session for session in sessions if is_active_codex_session(session)]
    dirty_files = sum(int(worktree.get("dirtyCount") or 0) for worktree in worktrees)
    prunable_count = sum(1 for worktree in worktrees if worktree.get("prunable"))
    if active_sessions:
        reasons.append(f"{len(active_sessions)} active Codex session(s)")
    if windows:
        reasons.append(f"{len(windows)} tmux window(s)")
    if dirty_files:
        reasons.append(f"{dirty_files} dirty file(s)")
    if prunable_count:
        reasons.append(f"{prunable_count} prunable worktree(s)")
    return reasons


def parallel_sort_key(
    status: str,
    active: bool,
    linear: dict[str, Any] | None,
    ticket: dict[str, Any] | None,
) -> tuple[Any, ...]:
    priority = linear.get("priority") if linear else None
    updated_at = linear.get("updatedAt") if linear else ""
    risk = ticket.get("risk") if ticket else None
    return (
        status_rank("active" if active else status),
        int(priority) if isinstance(priority, int) and priority > 0 else 99,
        risk_rank(str(risk or "")),
        newest_first_timestamp(updated_at),
    )


def newest_first_timestamp(value: Any) -> float:
    if not isinstance(value, str):
        return 0
    parsed = parse_iso_datetime(value)
    if not parsed:
        return 0
    return -parsed.timestamp()


def status_rank(status: str) -> int:
    return {
        "fix-ci": 0,
        "review": 1,
        "ship": 2,
        "active": 3,
        "ready": 4,
        "queued": 5,
        "blocked": 6,
        "done": 7,
    }.get(status, 8)


def risk_rank(risk: str) -> int:
    return {"high": 0, "medium": 1, "low": 2}.get(risk, 3)


def linear_dependency_edges(tickets: Any) -> list[dict[str, Any]]:
    if not isinstance(tickets, list):
        return []
    edges: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    for ticket in tickets:
        if not isinstance(ticket, dict):
            continue
        source = linear_issue_link(ticket)
        if not source:
            continue
        for relation in ticket.get("relatedIssues", []):
            if not isinstance(relation, dict):
                continue
            edge = dependency_edge_from_relation(source, relation)
            if not edge:
                continue
            key = (
                str(edge.get("blockerId") or ""),
                str(edge.get("blockedId") or ""),
                str(edge.get("relationType") or ""),
            )
            if key in seen:
                continue
            seen.add(key)
            edges.append(edge)
    return edges


def dependency_edge_from_relation(
    source: dict[str, Any],
    relation: dict[str, Any],
) -> dict[str, Any] | None:
    relation_type = normalize_relation_type(relation.get("relationType"))
    related = relation.get("issue")
    if not isinstance(related, dict) or not related.get("ticketId"):
        return None
    related_link = linear_issue_link(related)
    if not related_link:
        return None
    if relation_type in {"blocked_by", "blocks_this"}:
        return dependency_edge(
            blocked=source,
            blocker=related_link,
            relation_type=relation_type,
            source_ticket_id=source["ticketId"],
        )
    if relation_type in {"blocks", "this_blocks"}:
        return dependency_edge(
            blocked=related_link,
            blocker=source,
            relation_type=relation_type,
            source_ticket_id=source["ticketId"],
        )
    return None


def dependency_edge(
    *,
    blocked: dict[str, Any],
    blocker: dict[str, Any],
    relation_type: str,
    source_ticket_id: str,
) -> dict[str, Any]:
    return {
        "blockedId": blocked["ticketId"],
        "blockedStateName": blocked.get("stateName"),
        "blockedStateType": blocked.get("stateType"),
        "blockedTitle": blocked.get("title"),
        "blockerId": blocker["ticketId"],
        "blockerStateName": blocker.get("stateName"),
        "blockerStateType": blocker.get("stateType"),
        "blockerTitle": blocker.get("title"),
        "relationType": relation_type,
        "sourceTicketId": source_ticket_id,
    }


def linear_issue_link(issue: dict[str, Any]) -> dict[str, Any] | None:
    ticket_id = str(issue.get("ticketId") or "").strip().upper()
    if not ticket_id:
        return None
    return {
        "stateName": issue.get("stateName"),
        "stateType": issue.get("stateType"),
        "ticketId": ticket_id,
        "title": issue.get("title"),
        "url": issue.get("url"),
    }


def normalize_relation_type(value: Any) -> str:
    normalized = re.sub(r"[\s-]+", "_", str(value or "").strip().lower())
    if normalized in {"blocked", "blocked_by"}:
        return "blocked_by"
    if normalized == "blocks":
        return "blocks"
    return normalized


def blockers_for_ticket(ticket_id: str, edges: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        edge
        for edge in edges
        if edge.get("blockedId") == ticket_id
        and edge.get("blockerId") != ticket_id
        and not linear_issue_state_done(edge.get("blockerStateType"))
    ]


def blocks_for_ticket(ticket_id: str, edges: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        edge
        for edge in edges
        if edge.get("blockerId") == ticket_id
        and edge.get("blockedId") != ticket_id
        and not linear_issue_state_done(edge.get("blockedStateType"))
    ]


def linear_issue_done(issue: dict[str, Any]) -> bool:
    return linear_issue_state_done(issue.get("stateType")) or bool(issue.get("completedAt"))


def linear_issue_state_done(state_type: Any) -> bool:
    return state_type in {"completed", "canceled"}


def changed_paths_from_sources(
    prs: list[dict[str, Any]],
    worktrees: list[dict[str, Any]],
) -> list[str]:
    paths: set[str] = set()
    for pr in prs:
        for file in pr.get("files", []):
            if isinstance(file, dict):
                add_changed_path(paths, file.get("path"))
    for worktree in worktrees:
        for line in worktree.get("statusLines", []):
            for path in paths_from_status_line(str(line or "")):
                add_changed_path(paths, path)
    return sorted(paths)


def add_changed_path(paths: set[str], value: Any) -> None:
    normalized = normalize_changed_path(value)
    if normalized:
        paths.add(normalized)


def paths_from_status_line(line: str) -> list[str]:
    stripped = re.sub(r"^[ MADRCU?!]{1,2}\s+", "", line.strip())
    if not stripped:
        return []
    if " -> " in stripped:
        return [unquote_status_path(part) for part in stripped.split(" -> ")]
    return [unquote_status_path(stripped)]


def unquote_status_path(value: str) -> str:
    return value.strip().strip('"')


def normalize_changed_path(value: Any) -> str | None:
    trimmed = str(value or "").strip()
    if not trimmed:
        return None
    return re.sub(r"^\./+", "", trimmed)


def changed_path_zones(paths: list[str]) -> list[str]:
    zones = {
        zone
        for path in paths
        if (zone := changed_path_zone(path))
    }
    return sorted(zones)


def changed_path_zone(path: str) -> str | None:
    normalized = normalize_changed_path(path)
    if not normalized:
        return None
    parts = [part for part in normalized.split("/") if part]
    if not parts:
        return None
    if len(parts) == 1:
        return parts[0]
    return "/".join(parts[:-1])


def pairwise_parallel_conflicts(
    candidates: list[dict[str, Any]],
    edges: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    pairwise: list[dict[str, Any]] = []
    limited = candidates[:10]
    for left_index, left in enumerate(limited):
        for right in limited[left_index + 1 :]:
            item = pairwise_parallel_item(left, right, edges)
            if item:
                pairwise.append(item)
    return pairwise


def pairwise_parallel_item(
    left: dict[str, Any],
    right: dict[str, Any],
    edges: list[dict[str, Any]],
) -> dict[str, Any] | None:
    dependency = dependency_between_candidates(left, right, edges)
    left_paths = list(left.get("changedPaths", []))
    right_paths = list(right.get("changedPaths", []))
    overlap = intersect_values(left_paths, right_paths)
    shared_zones = intersect_values(
        list(left.get("changedZones", [])),
        list(right.get("changedZones", [])),
    )
    base = {
        "leftWorkflowId": left.get("workflowId"),
        "rightWorkflowId": right.get("workflowId"),
    }
    if dependency:
        return {
            **base,
            "reason": f"{dependency['blockerId']} blocks {dependency['blockedId']}.",
            "status": "blocked",
            "type": "linear-dependency",
        }
    if overlap:
        return {
            **base,
            "overlapPaths": overlap[:8],
            "reason": f"Both lanes touch {', '.join(overlap[:3])}.",
            "status": "blocked",
            "type": "file-overlap",
        }
    if shared_zones:
        return {
            **base,
            "reason": f"Both lanes touch {', '.join(shared_zones[:3])}.",
            "sharedZones": shared_zones[:8],
            "status": "guarded",
            "type": "same-area",
        }
    if left_paths and right_paths:
        return {
            **base,
            "reason": "No file or Linear dependency conflict is visible.",
            "status": "safe",
            "type": "independent",
        }
    return {
        **base,
        "reason": "Changed-file evidence is incomplete; verify before running together.",
        "status": "guarded",
        "type": "missing-file-evidence",
    }


def dependency_between_candidates(
    left: dict[str, Any],
    right: dict[str, Any],
    edges: list[dict[str, Any]],
) -> dict[str, Any] | None:
    left_ids = set(left.get("ticketIds", []))
    right_ids = set(right.get("ticketIds", []))
    for edge in edges:
        if linear_issue_state_done(edge.get("blockerStateType")):
            continue
        blocked_id = str(edge.get("blockedId") or "")
        blocker_id = str(edge.get("blockerId") or "")
        if (
            blocked_id in left_ids
            and blocker_id in right_ids
            or blocked_id in right_ids
            and blocker_id in left_ids
        ):
            return edge
    return None


def intersect_values(left: list[Any], right: list[Any]) -> list[str]:
    right_set = {str(value) for value in right}
    return [str(value) for value in left if str(value) in right_set]


def suggested_parallel_wave(
    candidates: list[dict[str, Any]],
    pairwise: list[dict[str, Any]],
    open_slots: int,
) -> dict[str, Any]:
    if open_slots <= 0:
        return {
            "id": "wave:capacity",
            "reason": "No open Codex lane capacity is available.",
            "title": "At capacity",
            "workflowIds": [],
        }
    pair_status = {
        frozenset([str(item.get("leftWorkflowId")), str(item.get("rightWorkflowId"))]): item
        for item in pairwise
    }
    selected: list[str] = []
    for candidate in candidates:
        workflow_id = str(candidate.get("workflowId") or "")
        if not workflow_id or candidate.get("activeLane"):
            continue
        if candidate.get("status") in {"blocked", "done"}:
            continue
        if candidate.get("blockedBy"):
            continue
        if not candidate.get("changedPaths"):
            continue
        if any(
            pair_status.get(frozenset([workflow_id, existing]), {}).get("status")
            != "safe"
            for existing in selected
        ):
            continue
        selected.append(workflow_id)
        if len(selected) >= open_slots:
            break
    return {
        "id": "wave:ready",
        "reason": (
            "Candidates have open capacity, changed-file evidence, and no visible "
            "pairwise file or Linear dependency conflict."
            if selected
            else "No candidate has enough evidence to auto-start in parallel right now."
        ),
        "title": "Ready parallel wave" if selected else "No safe auto-start wave",
        "workflowIds": selected,
    }


def parallel_readiness_summary(
    *,
    active_count: int,
    blocked_count: int,
    candidate_count: int,
    open_slots: int,
    wave_count: int,
) -> str:
    return (
        f"{candidate_count} candidate lane(s); {active_count} active; "
        f"{open_slots} open slot(s); {blocked_count} blocked; "
        f"{wave_count} suggested for the next wave."
    )


def compact_evidence_text(value: Any, limit: int) -> str:
    cleaned = re.sub(r"\s+", " ", str(value or "")).strip()
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[: max(0, limit - 3)].rstrip() + "..."


def handoff_outcome(item: dict[str, Any], dashboard: dict[str, Any]) -> dict[str, Any]:
    workflow_id = str(item.get("workflowId") or "")
    if workflow_id.startswith("ticket:"):
        ticket_id = workflow_id.removeprefix("ticket:")
        return ticket_handoff_outcome(ticket_id, dashboard)
    if workflow_id.startswith("pr:"):
        return pr_handoff_outcome(workflow_id.removeprefix("pr:"), dashboard)
    if workflow_id.startswith("session:"):
        return session_handoff_outcome(workflow_id.removeprefix("session:"), dashboard)
    if workflow_id.startswith("worktree:"):
        return worktree_handoff_outcome(workflow_id.removeprefix("worktree:"), dashboard)

    ticket_id = str(item.get("ticketId") or "")
    if ticket_id:
        return ticket_handoff_outcome(ticket_id, dashboard)
    pr_number = item.get("prNumber")
    if isinstance(pr_number, int):
        return pr_handoff_outcome(str(pr_number), dashboard)
    return cleared_handoff_outcome()


def ticket_handoff_outcome(ticket_id: str, dashboard: dict[str, Any]) -> dict[str, Any]:
    ticket = next(
        (
            row
            for row in dashboard.get("tickets", [])
            if isinstance(row, dict) and row.get("ticketId") == ticket_id
        ),
        None,
    )
    sessions = dashboard_items_for_ticket(dashboard, "codexSessions", ticket_id)
    windows = dashboard_items_for_ticket(dashboard, "tmuxWindows", ticket_id)
    worktrees = dashboard_items_for_ticket(dashboard, "worktrees", ticket_id)
    prs = dashboard_items_for_ticket(dashboard, "prs", ticket_id)
    return target_handoff_outcome(
        target_name=ticket_id,
        ticket=ticket,
        prs=prs,
        sessions=sessions,
        windows=windows,
        worktrees=worktrees,
    )


def pr_handoff_outcome(pr_number: str, dashboard: dict[str, Any]) -> dict[str, Any]:
    pr = next(
        (
            item
            for item in dashboard.get("prs", [])
            if isinstance(item, dict) and str(item.get("number")) == pr_number
        ),
        None,
    )
    if not pr:
        return cleared_handoff_outcome()

    ticket_ids = [
        ticket_id
        for ticket_id in pr.get("ticketIds", [])
        if isinstance(ticket_id, str) and ticket_id
    ]
    sessions = dashboard_items_for_any_ticket(dashboard, "codexSessions", ticket_ids)
    windows = dashboard_items_for_any_ticket(dashboard, "tmuxWindows", ticket_ids)
    worktrees = dashboard_items_for_any_ticket(dashboard, "worktrees", ticket_ids)
    return target_handoff_outcome(
        target_name=f"PR #{pr_number}",
        ticket=None,
        prs=[pr],
        sessions=sessions,
        windows=windows,
        worktrees=worktrees,
    )


def session_handoff_outcome(thread_id: str, dashboard: dict[str, Any]) -> dict[str, Any]:
    session = next(
        (
            item
            for item in dashboard.get("codexSessions", [])
            if isinstance(item, dict) and item.get("threadId") == thread_id
        ),
        None,
    )
    if not session:
        return cleared_handoff_outcome()
    if is_active_codex_session(session):
        return {
            "detail": "The Codex session is still active.",
            "label": "Live",
            "tone": "live",
        }
    return {
        "detail": "The Codex session is visible but idle.",
        "label": "Idle",
        "tone": "quiet",
    }


def worktree_handoff_outcome(path: str, dashboard: dict[str, Any]) -> dict[str, Any]:
    worktree = next(
        (
            item
            for item in dashboard.get("worktrees", [])
            if isinstance(item, dict) and item.get("path") == path
        ),
        None,
    )
    if not worktree:
        return cleared_handoff_outcome()
    if (worktree.get("dirtyCount") or 0) > 0:
        return {
            "detail": "The worktree still has local changes.",
            "label": "Still dirty",
            "tone": "live",
        }
    return {
        "detail": "The worktree is visible and clean.",
        "label": "Clean",
        "tone": "quiet",
    }


def target_handoff_outcome(
    *,
    target_name: str,
    ticket: dict[str, Any] | None,
    prs: list[dict[str, Any]],
    sessions: list[dict[str, Any]],
    windows: list[dict[str, Any]],
    worktrees: list[dict[str, Any]],
) -> dict[str, Any]:
    if any(is_active_codex_session(session) for session in sessions):
        return {
            "detail": f"Codex is still active for {target_name}.",
            "label": "Live",
            "tone": "live",
        }
    if windows:
        return {
            "detail": f"A tmux lane is still open for {target_name}.",
            "label": "Live",
            "tone": "live",
        }
    if any((worktree.get("dirtyCount") or 0) > 0 for worktree in worktrees):
        return {
            "detail": f"Local changes still exist for {target_name}.",
            "label": "Still dirty",
            "tone": "live",
        }
    if any(pr_check_state(pr) == "red" for pr in prs):
        return {
            "detail": f"{target_name} still has failing PR checks.",
            "label": "Checks failing",
            "tone": "live",
        }
    if any(pr_check_state(pr) == "pending" for pr in prs):
        return {
            "detail": f"{target_name} still has pending PR checks.",
            "label": "Checks pending",
            "tone": "quiet",
        }
    if ticket:
        next_action = ticket.get("nextAction") or "No immediate action."
        return {
            "detail": f"{target_name} is still visible: {next_action}",
            "label": str(ticket.get("state") or "Visible").title(),
            "tone": "quiet",
        }
    if prs:
        return {
            "detail": f"{target_name} is still visible.",
            "label": "Visible",
            "tone": "quiet",
        }
    return cleared_handoff_outcome()


def cleared_handoff_outcome() -> dict[str, Any]:
    return {
        "detail": "The handed-off workflow no longer appears in the active board.",
        "label": "Cleared",
        "tone": "cleared",
    }


def dashboard_items_for_ticket(
    dashboard: dict[str, Any],
    key: str,
    ticket_id: str,
) -> list[dict[str, Any]]:
    return dashboard_items_for_any_ticket(dashboard, key, [ticket_id])


def dashboard_items_for_any_ticket(
    dashboard: dict[str, Any],
    key: str,
    ticket_ids: list[str],
) -> list[dict[str, Any]]:
    wanted = set(ticket_ids)
    if not wanted:
        return []
    return [
        item
        for item in dashboard.get(key, [])
        if isinstance(item, dict)
        and any(ticket_id in wanted for ticket_id in item.get("ticketIds", []))
    ]


def is_active_codex_session(session: dict[str, Any]) -> bool:
    return session.get("status") in {"goal-active", "running"}


def pr_check_state(pr: dict[str, Any]) -> str:
    check_summary = pr.get("checkSummary")
    if not isinstance(check_summary, dict):
        return "unknown"
    return str(check_summary.get("state") or "unknown")


def workflow_evidence_fingerprint(
    snapshot: dict[str, Any],
    *,
    include_previews: bool = False,
) -> str:
    normalized = normalize_evidence_for_fingerprint(
        snapshot,
        include_previews=include_previews,
    )
    encoded = orjson.dumps(normalized, option=orjson.OPT_SORT_KEYS)
    return hashlib.sha256(encoded).hexdigest()


def parallel_readiness_fingerprint(parallel_readiness: dict[str, Any]) -> str:
    encoded = orjson.dumps(
        normalize_parallel_readiness_for_fingerprint(parallel_readiness),
        option=orjson.OPT_SORT_KEYS,
    )
    return hashlib.sha256(encoded).hexdigest()


def normalize_parallel_readiness_for_fingerprint(
    parallel_readiness: dict[str, Any],
) -> dict[str, Any]:
    return {
        "blockerEdges": normalized_blocker_edges(
            parallel_readiness.get("blockerEdges", []),
        ),
        "candidates": normalized_readiness_candidates(
            parallel_readiness.get("candidates", []),
        ),
        "laneLoad": parallel_readiness.get("laneLoad", {}),
        "pairwise": normalized_readiness_pairs(parallel_readiness.get("pairwise", [])),
        "suggestedWaves": normalized_readiness_waves(
            parallel_readiness.get("suggestedWaves", []),
        ),
    }


def normalized_blocker_edges(value: Any) -> list[dict[str, Any]]:
    edges = [
        {
            "blockedId": edge.get("blockedId"),
            "blockedStateType": edge.get("blockedStateType"),
            "blockerId": edge.get("blockerId"),
            "blockerStateType": edge.get("blockerStateType"),
            "relationType": edge.get("relationType"),
        }
        for edge in value
        if isinstance(edge, dict)
    ]
    return sorted(
        edges,
        key=lambda edge: (
            str(edge.get("blockerId") or ""),
            str(edge.get("blockedId") or ""),
            str(edge.get("relationType") or ""),
        ),
    )


def normalized_readiness_candidates(value: Any) -> list[dict[str, Any]]:
    candidates = [
        {
            "activeLane": candidate.get("activeLane"),
            "activeReasons": sorted(str(item) for item in candidate.get("activeReasons", [])),
            "blockedBy": normalized_brief_edges(candidate.get("blockedBy", [])),
            "blocks": normalized_brief_edges(candidate.get("blocks", [])),
            "changedPaths": sorted(str(path) for path in candidate.get("changedPaths", [])),
            "changedZones": sorted(str(zone) for zone in candidate.get("changedZones", [])),
            "prNumbers": sorted(candidate.get("prNumbers", [])),
            "status": candidate.get("status"),
            "ticketIds": sorted(str(ticket_id) for ticket_id in candidate.get("ticketIds", [])),
            "workflowId": candidate.get("workflowId"),
        }
        for candidate in value
        if isinstance(candidate, dict)
    ]
    return sorted(candidates, key=lambda candidate: str(candidate.get("workflowId") or ""))


def normalized_brief_edges(value: Any) -> list[dict[str, Any]]:
    edges = [
        {
            "blockedId": edge.get("blockedId"),
            "blockerId": edge.get("blockerId"),
        }
        for edge in value
        if isinstance(edge, dict)
    ]
    return sorted(
        edges,
        key=lambda edge: (
            str(edge.get("blockerId") or ""),
            str(edge.get("blockedId") or ""),
        ),
    )


def normalized_readiness_pairs(value: Any) -> list[dict[str, Any]]:
    pairs = [
        {
            "leftWorkflowId": pair.get("leftWorkflowId"),
            "overlapPaths": sorted(str(path) for path in pair.get("overlapPaths", [])),
            "reason": pair.get("reason"),
            "rightWorkflowId": pair.get("rightWorkflowId"),
            "sharedZones": sorted(str(zone) for zone in pair.get("sharedZones", [])),
            "status": pair.get("status"),
            "type": pair.get("type"),
        }
        for pair in value
        if isinstance(pair, dict)
    ]
    return sorted(
        pairs,
        key=lambda pair: (
            str(pair.get("leftWorkflowId") or ""),
            str(pair.get("rightWorkflowId") or ""),
            str(pair.get("type") or ""),
        ),
    )


def normalized_readiness_waves(value: Any) -> list[dict[str, Any]]:
    waves = [
        {
            "id": wave.get("id"),
            "workflowIds": sorted(
                str(workflow_id)
                for workflow_id in wave.get("workflowIds", [])
            ),
        }
        for wave in value
        if isinstance(wave, dict)
    ]
    return sorted(waves, key=lambda wave: str(wave.get("id") or ""))


def normalize_evidence_for_fingerprint(
    value: Any,
    *,
    include_previews: bool,
) -> Any:
    if isinstance(value, dict):
        normalized = {}
        for key, child in value.items():
            if key in VOLATILE_EVIDENCE_KEYS:
                continue
            if key == "tmuxPanePreviews" and not include_previews:
                continue
            normalized[key] = normalize_evidence_for_fingerprint(
                child,
                include_previews=include_previews,
            )
        return normalized
    if isinstance(value, list):
        return [
            normalize_evidence_for_fingerprint(child, include_previews=include_previews)
            for child in value
        ]
    return value


def save_workflow_evidence_snapshot(settings: Settings, snapshot: dict[str, Any]) -> Path:
    path = workflow_evidence_snapshot_path(settings)
    write_json(path, snapshot)
    return path


def write_workflow_brief(settings: Settings, brief: dict[str, Any]) -> Path:
    path = workflow_brief_path(settings)
    write_json(path, brief)
    return path


def read_json(path: Path) -> Any:
    try:
        return orjson.loads(path.read_bytes())
    except FileNotFoundError:
        return None
    except Exception:
        return None


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(
        orjson.dumps(
            payload,
            option=orjson.OPT_INDENT_2 | orjson.OPT_APPEND_NEWLINE,
        ),
    )


def validate_workflow_brief(payload: Any) -> tuple[bool, str | None]:
    if not isinstance(payload, dict):
        return False, "Workflow brief must be a JSON object."
    if payload.get("version") != WORKFLOW_BRIEF_VERSION:
        return False, f"Workflow brief version must be {WORKFLOW_BRIEF_VERSION}."
    if not isinstance(payload.get("generatedAt"), str):
        return False, "Workflow brief is missing generatedAt."
    now = payload.get("now")
    if not isinstance(now, dict):
        return False, "Workflow brief is missing now."
    valid, reason = validate_brief_item(now, "now")
    if not valid:
        return False, reason
    for key in ("next", "blocked", "staleSignals", "lanes"):
        if key in payload and not isinstance(payload[key], list):
            return False, f"Workflow brief {key} must be an array."
    for key in ("next", "blocked", "staleSignals", "lanes"):
        for index, item in enumerate(payload.get(key, [])):
            if not isinstance(item, dict):
                return False, f"Workflow brief {key}[{index}] must be an object."
            valid, reason = validate_brief_item(item, f"{key}[{index}]")
            if not valid:
                return False, reason
    operating_mode = payload.get("operatingMode")
    if operating_mode is not None and not isinstance(operating_mode, dict):
        return False, "Workflow brief operatingMode must be an object."
    return True, None


def validate_brief_item(item: dict[str, Any], path: str) -> tuple[bool, str | None]:
    for key in ("title", "action", "why"):
        if not isinstance(item.get(key), str) or not item[key].strip():
            return False, f"Workflow brief {path}.{key} must be a non-empty string."
    if path == "now" and (
        not isinstance(item.get("confidence"), str) or not item["confidence"].strip()
    ):
        return False, "Workflow brief now.confidence must be a non-empty string."
    if "confidence" in item and not isinstance(item["confidence"], str):
        return False, f"Workflow brief {path}.confidence must be a string."
    for key in ("evidence", "commands", "blockedBy"):
        if key in item and not isinstance(item[key], list):
            return False, f"Workflow brief {path}.{key} must be an array."
    return True, None


def brief_parallel_safety_reason(
    payload: dict[str, Any],
    parallel_readiness: dict[str, Any],
) -> str | None:
    lanes = [lane for lane in payload.get("lanes", []) if isinstance(lane, dict)]
    if not lanes:
        return None

    readiness_by_workflow = {
        str(candidate.get("workflowId") or ""): candidate
        for candidate in parallel_readiness.get("candidates", [])
        if isinstance(candidate, dict) and candidate.get("workflowId")
    }
    safe_workflow_ids: set[str] = set()
    now_id = workflow_id_from_brief_item(payload.get("now"))
    if now_id:
        safe_workflow_ids.add(now_id)

    for lane in lanes:
        workflow_id = workflow_id_from_brief_item(lane)
        if not workflow_id:
            continue
        role = str(lane.get("role") or "").strip().lower()
        if role == "focus" or (
            lane.get("parallelSafe") is True
            and role not in {"watch", "waiting"}
        ):
            safe_workflow_ids.add(workflow_id)
        if lane.get("parallelSafe") is not True or role in {"focus", "watch", "waiting"}:
            continue
        candidate = readiness_by_workflow.get(workflow_id)
        if not candidate:
            continue
        blocker_reason = candidate_blocker_reason(workflow_id, candidate)
        if blocker_reason:
            return blocker_reason

    if len(safe_workflow_ids) < 2:
        return None

    for pair in parallel_readiness.get("pairwise", []):
        if not isinstance(pair, dict):
            continue
        left = str(pair.get("leftWorkflowId") or "")
        right = str(pair.get("rightWorkflowId") or "")
        if left not in safe_workflow_ids or right not in safe_workflow_ids:
            continue
        status = str(pair.get("status") or "")
        if status not in {"blocked", "guarded"}:
            continue
        reason = str(pair.get("reason") or "current readiness requires serialization")
        pair_type = str(pair.get("type") or "pairwise conflict")
        return (
            "Workflow brief marks "
            f"{left} and {right} parallel-safe, but current readiness says "
            f"{pair_type}: {reason}"
        )

    return None


def brief_parallel_readiness_drift_reason(
    payload: dict[str, Any],
    current_fingerprint: str,
) -> str | None:
    source = payload.get("source")
    if not isinstance(source, dict):
        return None
    brief_fingerprint = str(source.get("parallelReadinessFingerprint") or "").strip()
    if not brief_fingerprint or brief_fingerprint == current_fingerprint:
        return None
    return (
        "Parallel-readiness evidence changed since this workflow brief was "
        "generated."
    )


def workflow_id_from_brief_item(item: Any) -> str | None:
    if not isinstance(item, dict):
        return None
    workflow_id = str(item.get("workflowId") or "").strip()
    if workflow_id:
        return workflow_id
    ticket_id = str(item.get("ticketId") or "").strip().upper()
    if ticket_id:
        return f"ticket:{ticket_id}"
    pr_number = item.get("prNumber")
    if isinstance(pr_number, int):
        return f"pr:{pr_number}"
    return None


def candidate_blocker_reason(
    workflow_id: str,
    candidate: dict[str, Any],
) -> str | None:
    blockers = [
        blocker
        for blocker in candidate.get("blockedBy", [])
        if isinstance(blocker, dict)
    ]
    if blockers:
        blocker = blockers[0]
        blocker_id = str(blocker.get("blockerId") or "another workflow")
        blocked_id = str(blocker.get("blockedId") or workflow_id)
        return (
            f"Workflow brief marks {workflow_id} parallel-safe, but "
            f"{blocker_id} blocks {blocked_id}."
        )
    if candidate.get("status") == "blocked":
        return (
            f"Workflow brief marks {workflow_id} parallel-safe, but current "
            "readiness marks it blocked."
        )
    return None


def summarize_project_focus(tickets: list[Any]) -> list[dict[str, Any]]:
    summaries: dict[str, dict[str, Any]] = {}
    for ticket in tickets:
        if not isinstance(ticket, dict):
            continue
        project_name = str(ticket.get("projectName") or "No project")
        summary = summaries.setdefault(
            project_name,
            {
                "active": 0,
                "backlog": 0,
                "completed": 0,
                "highPriority": 0,
                "latestUpdatedAt": None,
                "name": project_name,
                "review": 0,
            },
        )
        state_type = ticket.get("stateType")
        state_name = str(ticket.get("stateName") or "").lower()
        if state_type == "completed":
            summary["completed"] += 1
        elif state_type == "backlog" or state_type == "unstarted":
            summary["backlog"] += 1
        elif "review" in state_name:
            summary["review"] += 1
        else:
            summary["active"] += 1
        if ticket.get("priority") in (1, 2):
            summary["highPriority"] += 1
        updated_at = ticket.get("updatedAt")
        if isinstance(updated_at, str) and (
            not summary["latestUpdatedAt"] or updated_at > summary["latestUpdatedAt"]
        ):
            summary["latestUpdatedAt"] = updated_at
    return sorted(
        summaries.values(),
        key=lambda item: str(item.get("latestUpdatedAt") or ""),
        reverse=True,
    )


def summarize_completion_memory(tickets: list[Any]) -> dict[str, Any]:
    if not isinstance(tickets, list):
        return {"recent": [], "summary": "No completed Linear work is visible.", "unlocked": []}

    completed = [
        ticket
        for ticket in tickets
        if isinstance(ticket, dict) and linear_ticket_completed(ticket)
    ]
    completed_by_id = {
        str(ticket.get("ticketId") or "").upper(): ticket
        for ticket in completed
        if str(ticket.get("ticketId") or "").strip()
    }
    recent = [
        summarize_completed_ticket(ticket)
        for ticket in sorted(completed, key=completion_sort_key, reverse=True)[:8]
    ]
    unlocked = summarize_completion_unlocks(
        completed_by_id,
        linear_dependency_edges(tickets),
    )
    return {
        "recent": recent,
        "summary": (
            f"{len(recent)} recent completed item(s); "
            f"{len(unlocked)} unblocked follow-up(s)."
        ),
        "unlocked": unlocked,
    }


def linear_ticket_completed(ticket: dict[str, Any]) -> bool:
    return ticket.get("stateType") == "completed" or bool(ticket.get("completedAt"))


def summarize_completed_ticket(ticket: dict[str, Any]) -> dict[str, Any]:
    return {
        "completedAt": ticket.get("completedAt"),
        "priority": ticket.get("priority"),
        "projectName": ticket.get("projectName"),
        "stateName": ticket.get("stateName"),
        "ticketId": ticket.get("ticketId"),
        "title": ticket.get("title"),
        "updatedAt": ticket.get("updatedAt"),
        "url": ticket.get("url"),
    }


def completion_sort_key(ticket: dict[str, Any]) -> str:
    return str(ticket.get("completedAt") or ticket.get("updatedAt") or "")


def summarize_completion_unlocks(
    completed_by_id: dict[str, dict[str, Any]],
    edges: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    unlocked = []
    seen: set[tuple[str, str]] = set()
    for edge in edges:
        blocker_id = str(edge.get("blockerId") or "").upper()
        blocked_id = str(edge.get("blockedId") or "").upper()
        if (
            not blocker_id
            or not blocked_id
            or blocker_id not in completed_by_id
            or linear_issue_state_done(edge.get("blockedStateType"))
        ):
            continue
        key = (blocker_id, blocked_id)
        if key in seen:
            continue
        seen.add(key)
        completed = completed_by_id[blocker_id]
        unlocked.append(
            {
                "blockedId": blocked_id,
                "blockedStateName": edge.get("blockedStateName"),
                "blockedTitle": edge.get("blockedTitle"),
                "blockerCompletedAt": completed.get("completedAt"),
                "blockerId": blocker_id,
                "blockerTitle": completed.get("title") or edge.get("blockerTitle"),
                "reason": (
                    f"{blocker_id} is complete; {blocked_id} can move next."
                ),
            },
        )
    return sorted(
        unlocked,
        key=lambda item: str(item.get("blockerCompletedAt") or ""),
        reverse=True,
    )[:8]


def brief_age_seconds(payload: dict[str, Any]) -> int | None:
    generated_at = payload.get("generatedAt")
    if not isinstance(generated_at, str):
        return None
    parsed = parse_iso_datetime(generated_at)
    if not parsed:
        return None
    return max(0, int(datetime.now(tz=UTC).timestamp() - parsed.timestamp()))


def parse_iso_datetime(value: str) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed


def brief_target_id(payload: dict[str, Any]) -> str | None:
    now = payload.get("now")
    if not isinstance(now, dict):
        return None
    for key in ("workflowId", "ticketId"):
        value = str(now.get(key) or "").strip()
        if value:
            return value
    pr_number = now.get("prNumber")
    if isinstance(pr_number, int):
        return f"pr:{pr_number}"
    return None


def dashboard_contains_target(dashboard: dict[str, Any], target_id: str) -> bool:
    if target_id.startswith("ticket:"):
        target_id = target_id.removeprefix("ticket:")
    if target_id.startswith("pr:"):
        number = int(target_id.removeprefix("pr:"))
        return any(pr.get("number") == number for pr in dashboard.get("prs", []))
    if target_id.upper().startswith("PHO-"):
        return any(
            ticket.get("ticketId") == target_id.upper()
            for ticket in dashboard.get("tickets", [])
        )
    return True


def read_configured_plan_docs() -> list[dict[str, Any]]:
    paths = configured_plan_doc_paths()
    docs: list[dict[str, Any]] = []
    seen: set[str] = set()
    for path in paths:
        key = str(path.expanduser())
        if key in seen:
            continue
        seen.add(key)
        docs.append(read_plan_doc(path))
        if len(docs) >= MAX_PLAN_DOCS:
            break
    return docs


def configured_plan_doc_paths() -> list[Path]:
    configured: list[Path] = []
    for raw_value in (
        os.environ.get("TICKETBOARD_PLAN_DOC_PATH", ""),
        os.environ.get("TICKETBOARD_PLAN_DOC_PATHS", ""),
    ):
        configured.extend(Path(part).expanduser() for part in split_doc_config(raw_value))

    for pattern in split_doc_config(os.environ.get("TICKETBOARD_PLAN_DOC_GLOBS", "")):
        configured.extend(
            Path(match).expanduser() for match in glob(os.path.expanduser(pattern))
        )

    return configured


def split_doc_config(raw_value: str) -> list[str]:
    normalized = raw_value.replace("\n", ",")
    parts: list[str] = []
    for chunk in normalized.split(","):
        if os.pathsep in chunk:
            parts.extend(piece.strip() for piece in chunk.split(os.pathsep))
        else:
            parts.append(chunk.strip())
    return [part for part in parts if part]


def read_plan_doc(path: Path) -> dict[str, Any]:
    expanded = path.expanduser()
    try:
        text = expanded.read_text(errors="replace")
    except FileNotFoundError:
        return {"path": str(expanded), "error": "Plan document not found."}
    truncated = len(text) > MAX_PLAN_DOC_CHARS
    return {
        "path": str(expanded),
        "content": text[:MAX_PLAN_DOC_CHARS],
        "signals": plan_doc_signals(text),
        "truncated": truncated,
    }


def summarize_plan_docs(plan_docs: list[dict[str, Any]]) -> dict[str, Any]:
    ticket_ids: set[str] = set()
    sections: list[dict[str, Any]] = []
    docs: list[dict[str, Any]] = []
    for doc in plan_docs:
        signals = doc.get("signals") if isinstance(doc.get("signals"), dict) else {}
        doc_ticket_ids = [
            ticket_id
            for ticket_id in signals.get("ticketIds", [])
            if isinstance(ticket_id, str)
        ]
        ticket_ids.update(doc_ticket_ids)
        doc_sections = [
            section
            for section in signals.get("sections", [])
            if isinstance(section, dict)
        ]
        sections.extend(
            {
                "docPath": doc.get("path"),
                "heading": section.get("heading"),
                "items": section.get("items", []),
                "kind": section.get("kind"),
            }
            for section in doc_sections[:3]
        )
        docs.append(
            {
                "error": doc.get("error"),
                "path": doc.get("path"),
                "sectionCount": len(doc_sections),
                "ticketIds": doc_ticket_ids[:12],
                "title": signals.get("title"),
                "truncated": doc.get("truncated"),
            },
        )

    return {
        "docCount": len(plan_docs),
        "docs": docs,
        "sections": sections[:12],
        "ticketIds": sorted(ticket_ids),
    }


def plan_doc_signals(text: str) -> dict[str, Any]:
    ticket_ids = sorted(set(TICKET_ID_PATTERN.findall(text)))
    headings: list[str] = []
    sections: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        heading_match = re.match(r"^(#{1,4})\s+(.+)$", line)
        if heading_match:
            heading = heading_match.group(2).strip()
            headings.append(heading)
            kind = plan_section_kind(heading)
            current = (
                {
                    "heading": heading,
                    "items": [],
                    "kind": kind,
                }
                if kind
                else None
            )
            if current:
                sections.append(current)
            continue
        if current and len(current["items"]) < MAX_PLAN_DOC_SIGNAL_LINES:
            item = normalize_plan_doc_line(line)
            if item:
                current["items"].append(item)

    return {
        "headings": headings[:20],
        "sections": [section for section in sections if section["items"]][:12],
        "ticketIds": ticket_ids[:40],
        "title": headings[0] if headings else None,
    }


def plan_section_kind(heading: str) -> str | None:
    normalized = heading.lower()
    if any(word in normalized for word in ("done", "completed", "shipped", "merged")):
        return "done"
    if any(word in normalized for word in ("now", "current", "focus", "doing")):
        return "now"
    if any(word in normalized for word in ("next", "todo", "upcoming", "queued")):
        return "next"
    if any(word in normalized for word in ("block", "risk", "stale", "question")):
        return "blocked"
    if "clean" in normalized or "follow" in normalized:
        return "cleanup"
    return None


def normalize_plan_doc_line(line: str) -> str | None:
    cleaned = re.sub(r"^[-*+]\s+", "", line)
    cleaned = re.sub(r"^\d+[.)]\s+", "", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if not cleaned:
        return None
    return cleaned[:240]


def utc_now_iso() -> str:
    return datetime.now(tz=UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
