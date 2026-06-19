from __future__ import annotations

import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import orjson

from .collectors import Settings

WORKFLOW_BRIEF_VERSION = 1
DEFAULT_WORKFLOW_BRIEF_TTL_SECONDS = 10 * 60
MAX_PLAN_DOC_CHARS = 40_000


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


def workflow_brief_status(
    settings: Settings,
    dashboard: dict[str, Any],
) -> dict[str, Any]:
    path = workflow_brief_path(settings)
    payload = read_json(path)
    if payload is None:
        return {
            "status": "missing",
            "brief": None,
            "path": str(path),
            "reason": "No workflow brief has been generated yet.",
        }

    valid, reason = validate_workflow_brief(payload)
    if not valid:
        return {
            "status": "invalid",
            "brief": None,
            "path": str(path),
            "reason": reason,
        }

    age_seconds = brief_age_seconds(payload)
    if age_seconds is not None and age_seconds > workflow_brief_ttl_seconds():
        return {
            "status": "stale",
            "brief": payload,
            "path": str(path),
            "ageSeconds": age_seconds,
            "reason": "The workflow brief is older than the configured TTL.",
        }

    target_id = brief_target_id(payload)
    if target_id and not dashboard_contains_target(dashboard, target_id):
        return {
            "status": "stale",
            "brief": payload,
            "path": str(path),
            "ageSeconds": age_seconds,
            "reason": f"The selected target {target_id} is not visible anymore.",
        }

    return {
        "status": "ready",
        "brief": payload,
        "path": str(path),
        "ageSeconds": age_seconds,
        "reason": None,
    }


def build_workflow_evidence_snapshot(
    settings: Settings,
    dashboard: dict[str, Any],
) -> dict[str, Any]:
    plan_doc = read_configured_plan_doc()
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
        "diagnostics": dashboard.get("diagnostics", []),
        "planDoc": plan_doc,
        "instructions": {
            "purpose": (
                "Use this evidence to choose one immediately actionable workflow. "
                "Prefer live failing checks, active tmux/worktree lanes, and review "
                "state over quiet strategic backlog unless the backlog is the only "
                "unblocked next move."
            ),
            "outputPath": str(workflow_brief_path(settings)),
        },
    }
    return snapshot


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
    for key in ("title", "action", "why", "confidence"):
        if not isinstance(now.get(key), str) or not now[key].strip():
            return False, f"Workflow brief now.{key} must be a non-empty string."
    for key in ("evidence", "commands"):
        if key in now and not isinstance(now[key], list):
            return False, f"Workflow brief now.{key} must be an array."
    for key in ("next", "blocked", "staleSignals"):
        if key in payload and not isinstance(payload[key], list):
            return False, f"Workflow brief {key} must be an array."
    return True, None


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


def read_configured_plan_doc() -> dict[str, Any] | None:
    raw_path = os.environ.get("TICKETBOARD_PLAN_DOC_PATH", "").strip()
    if not raw_path:
        return None
    path = Path(raw_path).expanduser()
    try:
        text = path.read_text(errors="replace")
    except FileNotFoundError:
        return {"path": str(path), "error": "Plan document not found."}
    truncated = len(text) > MAX_PLAN_DOC_CHARS
    return {
        "path": str(path),
        "content": text[:MAX_PLAN_DOC_CHARS],
        "truncated": truncated,
    }


def utc_now_iso() -> str:
    return datetime.now(tz=UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
