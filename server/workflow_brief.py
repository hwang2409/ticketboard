from __future__ import annotations

import hashlib
import os
import re
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
VOLATILE_EVIDENCE_KEYS = {"dashboardGeneratedAt", "generatedAt"}
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
    }


def workflow_brief_status(
    settings: Settings,
    dashboard: dict[str, Any],
) -> dict[str, Any]:
    path = workflow_brief_path(settings)
    automation = workflow_automation_status(path)
    payload = read_json(path)
    if payload is None:
        return {
            "status": "missing",
            "brief": None,
            "path": str(path),
            "ageSeconds": None,
            "automation": automation,
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
            "ttlSeconds": workflow_brief_ttl_seconds(),
            "reason": reason,
        }

    age_seconds = brief_age_seconds(payload)
    if age_seconds is not None and age_seconds > workflow_brief_ttl_seconds():
        return {
            "status": "stale",
            "brief": payload,
            "path": str(path),
            "ageSeconds": age_seconds,
            "automation": automation,
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
            "ttlSeconds": workflow_brief_ttl_seconds(),
            "reason": f"The selected target {target_id} is not visible anymore.",
        }

    return {
        "status": "ready",
        "brief": payload,
        "path": str(path),
        "ageSeconds": age_seconds,
        "automation": automation,
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
                "branchName": ticket.get("branchName"),
                "startedAt": ticket.get("startedAt"),
                "completedAt": ticket.get("completedAt"),
                "updatedAt": ticket.get("updatedAt"),
                "url": ticket.get("url"),
            }
            for ticket in dashboard.get("linearTickets", [])
        ],
        "projectFocus": summarize_project_focus(dashboard.get("linearTickets", [])),
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
        "diagnostics": dashboard.get("diagnostics", []),
        "planDoc": plan_doc,
        "planDocs": plan_docs,
        "planningSignals": summarize_plan_docs(plan_docs),
        "instructions": {
            "purpose": (
                "Use this evidence to choose one immediate focus workflow and a "
                "parallel lane plan. Prefer live failing checks, active "
                "tmux/worktree lanes, and review state over quiet strategic backlog. "
                "Only mark lanes parallel-safe when their work can proceed without "
                "overwriting the focus lane or depending on its result. Treat "
                "recent handoffs as orchestration memory so launched/resumed lanes "
                "are not immediately recommended again unless live evidence changed."
            ),
            "outputPath": str(workflow_brief_path(settings)),
        },
    }
    return snapshot


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


def brief_age_seconds(payload: dict[str, Any]) -> int | None:
    generated_at = payload.get("generatedAt")
    if not isinstance(generated_at, str):
        return None
    try:
        parsed = datetime.fromisoformat(generated_at.replace("Z", "+00:00"))
    except ValueError:
        return None
    return max(0, int(datetime.now(tz=UTC).timestamp() - parsed.timestamp()))


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
