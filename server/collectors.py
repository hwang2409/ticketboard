from __future__ import annotations

import hashlib
import os
import re
import subprocess
import time
from collections import defaultdict
from collections.abc import Iterable
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, cast
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
import orjson

from .store import database_path, load_cache_payload, save_cache_payload
from .types import (
    CodexSessionDetail,
    CodexSessionSummary,
    DashboardData,
    LinearTicketSummary,
    PrCheckLogSummary,
    PrDiffSummary,
    PullRequestSummary,
    TicketRow,
    TmuxWindowSummary,
    WorktreeDetailSummary,
    WorktreeSummary,
)

TICKET_RE = re.compile(r"\b([A-Z]{2,10}-\d+)\b", re.IGNORECASE)
PR_NUMBER_RE = re.compile(r"(?<!\d)#?(\d{3,7})(?!\d)")
MAX_PREVIEW = 1_200
MAX_DIFF_LINES = 4_000
MAX_LOG_CHARS = 60_000
MAX_PANE_CHARS = 16_000
MAX_ROLLOUT_CHARS = 60_000
CODEX_PARSER_VERSION = 7
CODEX_SUMMARY_MESSAGE_LIMIT = 3
CODEX_SUMMARY_MESSAGE_CHARS = 320
CODEX_SUMMARY_TOOL_CALL_LIMIT = 4
CODEX_SUMMARY_TOOL_PREVIEW_CHARS = 140
CODEX_SUMMARY_PREVIEW_CHARS = 280
CODEX_DETAIL_EVENT_LIMIT = 120
CODEX_DETAIL_MESSAGE_LIMIT = 120
CODEX_DETAIL_TOOL_CALL_LIMIT = 120
MAX_CODEX_DETAIL_CACHE = 128
MAX_PR_DETAIL_CACHE = 64
MAX_PR_DIFF_CACHE = 64
MAX_CHECK_LOG_CACHE = 32
MAX_CODEX_SUMMARY_CACHE = 256
MAX_WORKTREE_DETAIL_CACHE = 32
LINEAR_ISSUE_BATCH_SIZE = 10
LINEAR_ISSUE_BATCH_WORKERS = 5
LINEAR_VERSION_BATCH_SIZE = 50
LINEAR_VERSION_BATCH_WORKERS = 3
LINEAR_FILTER_BATCH_SIZE = 100
LINEAR_CACHE_VERSION = 2
LINEAR_RETRY_STATUS_CODES = {400, 429, 500, 502, 503, 504}
LINEAR_RETRY_DELAY_SECONDS = 0.15

_CODEX_DETAIL_CACHE: dict[
    str,
    tuple[tuple[Any, ...], CodexSessionDetail, dict[str, Any]],
] = {}
_CODEX_SESSION_PATH_CACHE: dict[str, Path] = {}
_CODEX_SESSION_INDEX_CACHE: tuple[Path, tuple[int, int], dict[str, dict[str, Any]]] | None = (
    None
)
_PR_DETAIL_CACHE: dict[str, tuple[float, str | None, PullRequestSummary]] = {}
_PR_DIFF_CACHE: dict[str, tuple[float, str | None, PrDiffSummary]] = {}
_CHECK_LOG_CACHE: dict[str, tuple[float, PrCheckLogSummary]] = {}
_GITHUB_AUTH_TOKEN_CACHE: str | None = None
_GITHUB_LOGIN_CACHE: tuple[tuple[str, str], str | None] | None = None
_GITHUB_GRAPHQL_CLIENT: httpx.Client | None = None
_LINEAR_GRAPHQL_CLIENT: httpx.Client | None = None
_LINEAR_OWNER_CACHE: tuple[str, set[str], set[str]] | None = None
_CODEX_GIT_BRANCH_CACHE: dict[str, tuple[int, str | None]] = {}
_TMUX_WINDOWS_CACHE: tuple[float, list[TmuxWindowSummary]] | None = None
_WORKTREE_SUMMARY_CACHE: tuple[float, str, list[WorktreeSummary]] | None = None
_WORKTREE_DETAIL_CACHE: dict[str, tuple[float, WorktreeDetailSummary]] = {}
_CODEX_SESSION_PATHS_CACHE: tuple[float, Path, list[Path]] | None = None
_CODEX_TOKEN_USAGE_CACHE: dict[str, tuple[tuple[int, int], dict[str, Any] | None]] = {}
_ALLOWED_TICKET_PREFIXES_CACHE: tuple[str, set[str]] | None = None


@dataclass(frozen=True)
class Settings:
    root: Path
    repo_path: Path
    repo_name: str
    codex_home: Path
    cache_dir: Path
    db_path: Path
    github_pr_limit: int
    codex_session_limit: int


def make_settings() -> Settings:
    root = Path(__file__).resolve().parents[1]
    codex_home = Path(os.environ.get("CODEX_HOME", "~/.codex")).expanduser()
    cache_dir = codex_home / "ticketboard"
    return Settings(
        root=root,
        repo_path=Path(
            os.environ.get("PHOEBE_REPO_PATH", "/Users/henry/me/fun/phoebe")
        ).expanduser(),
        repo_name=os.environ.get("TICKETBOARD_REPO", "phoebe-health/phoebe"),
        codex_home=codex_home,
        cache_dir=cache_dir,
        db_path=database_path(cache_dir),
        github_pr_limit=int(os.environ.get("TICKETBOARD_PR_LIMIT", "40")),
        codex_session_limit=int(os.environ.get("TICKETBOARD_CODEX_LIMIT", "24")),
    )


def utc_now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def stable_etag(data: Any) -> str:
    encoded = orjson.dumps(data, option=orjson.OPT_SORT_KEYS)
    return hashlib.sha256(encoded).hexdigest()


def run_command(
    args: list[str],
    *,
    cwd: Path | None = None,
    timeout: int = 20,
) -> str:
    result = subprocess.run(
        args,
        cwd=str(cwd) if cwd else None,
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )
    if result.returncode != 0:
        message = (result.stderr or result.stdout or "command failed").strip()
        raise RuntimeError(f"{' '.join(args[:4])}: {message}")
    return result.stdout


def load_json(path: Path) -> Any | None:
    return load_cache_payload(path)


def save_json(path: Path, data: Any) -> None:
    save_cache_payload(path, data)


def truncate(text: Any, limit: int = MAX_PREVIEW) -> str:
    value = "" if text is None else str(text)
    if len(value) <= limit:
        return value
    return value[: max(0, limit - 1)] + "..."


def normalize_ticket_id(value: str) -> str:
    return value.upper()


def allowed_ticket_prefixes() -> set[str]:
    global _ALLOWED_TICKET_PREFIXES_CACHE
    raw = os.environ.get("TICKETBOARD_TICKET_PREFIXES", "PHO")
    if _ALLOWED_TICKET_PREFIXES_CACHE and _ALLOWED_TICKET_PREFIXES_CACHE[0] == raw:
        return _ALLOWED_TICKET_PREFIXES_CACHE[1]
    prefixes = {
        value.strip().upper()
        for value in raw.split(",")
        if value.strip()
    }
    _ALLOWED_TICKET_PREFIXES_CACHE = (raw, prefixes)
    return prefixes


def extract_ticket_ids(*values: Any) -> list[str]:
    found: set[str] = set()
    allowed_prefixes = allowed_ticket_prefixes()
    for value in values:
        if value is None:
            continue
        if isinstance(value, (list, tuple, set)):
            found.update(extract_ticket_ids(*value))
            continue
        for match in TICKET_RE.finditer(str(value).replace("_", "-")):
            ticket_id = normalize_ticket_id(match.group(1))
            prefix = ticket_id.split("-", 1)[0]
            if not allowed_prefixes or prefix in allowed_prefixes:
                found.add(ticket_id)
    return sorted(found)


def extract_pr_numbers(*values: Any) -> list[int]:
    found: set[int] = set()
    for value in values:
        if value is None:
            continue
        if isinstance(value, (list, tuple, set)):
            found.update(extract_pr_numbers(*value))
            continue
        for match in PR_NUMBER_RE.finditer(str(value)):
            found.add(int(match.group(1)))
    return sorted(found)


def collect_dashboard(settings: Settings | None = None) -> DashboardData:
    settings = settings or make_settings()
    diagnostics: list[str] = []
    current_github_login = github_login(diagnostics)
    linear_token = os.environ.get("LINEAR_API_KEY")
    linear_owners = linear_owner_names(linear_token, diagnostics)
    linear_cache_payload = cached_linear_payload(settings)
    cached_linear_ids = (
        set(cached_linear_tickets(settings, linear_cache_payload))
        | cached_linear_ignored_ticket_ids(settings, linear_cache_payload)
        if linear_token
        else set()
    )
    linear_cache_fresh = linear_cache_is_fresh(
        settings,
        linear_owners,
        linear_cache_payload,
    )
    linear_prefetch_ids = (
        cached_linear_ids
        if cached_linear_ids and linear_owners and not linear_cache_fresh
        else set()
    )
    cached_owner_ticket_ids = cached_owner_backed_ticket_ids(
        settings,
        current_github_login,
        linear_owners,
        linear_cache_payload,
    )
    linear_prefetch_future = None

    with ThreadPoolExecutor(max_workers=6) as executor:
        pr_future = executor.submit(
            collect_github_prs,
            settings,
            diagnostics,
            current_github_login,
        )
        worktree_future = executor.submit(
            collect_worktrees,
            settings,
            diagnostics,
            status_ticket_ids=cached_owner_ticket_ids or None,
        )
        tmux_future = executor.submit(collect_tmux_windows, diagnostics)
        codex_future = executor.submit(collect_codex_sessions, settings, diagnostics)
        if linear_prefetch_ids:
            linear_prefetch_future = executor.submit(
                collect_linear_tickets,
                settings,
                linear_prefetch_ids,
                diagnostics,
                owner_names=linear_owners,
                cache_payload=linear_cache_payload,
            )

        prs = pr_future.result()
        worktrees = worktree_future.result()
        tmux_windows = tmux_future.result()
        codex_sessions = codex_future.result()
        repo = repo_summary(settings, diagnostics)

    tmux_windows = attach_pr_ticket_ids_to_tmux_windows(tmux_windows, prs)
    ticket_ids = collect_dashboard_ticket_ids(prs, worktrees, tmux_windows, codex_sessions)
    if linear_prefetch_future:
        prefetched = {
            ticket["ticketId"]: ticket
            for ticket in linear_prefetch_future.result()
            if ticket.get("ticketId")
        }
        if ticket_ids:
            missing_ticket_ids = ticket_ids.difference(linear_prefetch_ids)
            if missing_ticket_ids:
                for ticket in collect_linear_tickets(
                    settings,
                    missing_ticket_ids,
                    diagnostics,
                    owner_names=linear_owners,
                ):
                    prefetched[ticket["ticketId"]] = ticket
                save_linear_ticket_cache(
                    settings,
                    (
                        ticket
                        for ticket_id, ticket in prefetched.items()
                        if ticket_id in ticket_ids
                    ),
                    owner_names=linear_owners,
                )
            linear_tickets = sort_linear_tickets(
                ticket
                for ticket_id, ticket in prefetched.items()
                if ticket_id in ticket_ids
            )
        else:
            linear_tickets = sort_linear_tickets(prefetched.values())
    else:
        linear_tickets = collect_linear_tickets(
            settings,
            ticket_ids,
            diagnostics,
            owner_names=linear_owners,
            cache_payload=linear_cache_payload,
        )

    tickets = build_ticket_rows(
        prs=prs,
        linear_tickets=linear_tickets,
        codex_sessions=codex_sessions,
        tmux_windows=tmux_windows,
        worktrees=worktrees,
    )
    dashboard_prs = [dashboard_pr_summary(pr) for pr in prs]
    dashboard_linear_tickets = [
        dashboard_linear_ticket_summary(ticket) for ticket in linear_tickets
    ]

    return {
        "generatedAt": utc_now_iso(),
        "scope": {
            "githubLogin": current_github_login,
            "linearOwners": sorted(linear_owners),
        },
        "repo": repo,
        "prs": dashboard_prs,
        "linearTickets": dashboard_linear_tickets,
        "codexSessions": codex_sessions,
        "tmuxWindows": tmux_windows,
        "worktrees": worktrees,
        "tickets": tickets,
        "diagnostics": diagnostics,
    }


def attach_pr_ticket_ids_to_tmux_windows(
    tmux_windows: list[TmuxWindowSummary],
    prs: list[PullRequestSummary],
) -> list[TmuxWindowSummary]:
    ticket_ids_by_pr_number = {
        pr["number"]: set(pr.get("ticketIds", []))
        for pr in prs
        if pr.get("ticketIds")
    }
    if not ticket_ids_by_pr_number:
        return tmux_windows

    enriched: list[TmuxWindowSummary] = []
    for window in tmux_windows:
        ticket_ids = set(window.get("ticketIds", []))
        for number in extract_pr_numbers(window.get("name")):
            ticket_ids.update(ticket_ids_by_pr_number.get(number, set()))
        if ticket_ids == set(window.get("ticketIds", [])):
            enriched.append(window)
        else:
            enriched.append(
                cast(TmuxWindowSummary, {**window, "ticketIds": sorted(ticket_ids)}),
            )
    return enriched


def cached_owner_backed_ticket_ids(
    settings: Settings,
    github_owner: str | None,
    linear_owners: set[str],
    linear_cache_payload: dict[str, Any],
) -> set[str]:
    ticket_ids = {
        ticket["ticketId"]
        for ticket in cached_linear_tickets(settings, linear_cache_payload).values()
        if ticket.get("ticketId")
        and linear_ticket_matches_owner(ticket, linear_owners)
        and linear_ticket_needs_worktree_status(ticket)
    }
    for pr in cached_prs_list(settings, github_owner):
        ticket_ids.update(pr.get("ticketIds", []))
    return ticket_ids


def linear_ticket_needs_worktree_status(ticket: LinearTicketSummary) -> bool:
    state_type = str(ticket.get("stateType") or "").strip().lower()
    if state_type in {"completed", "canceled"}:
        return False
    return True


def dashboard_pr_summary(pr: PullRequestSummary) -> PullRequestSummary:
    return {
        **pr,
        "detailLevel": "summary",
        "bodyPreview": truncate(pr.get("bodyPreview"), 600),
        "latestComments": [],
        "reviewComments": [],
        "latestReviews": [],
        "commits": [],
        "files": [],
        "checks": [],
    }


def dashboard_linear_ticket_summary(
    ticket: LinearTicketSummary,
) -> LinearTicketSummary:
    return {
        **ticket,
        "detailLevel": "summary",
        "description": "",
        "url": "",
        "startedAt": None,
        "completedAt": None,
        "creator": None,
        "projectUrl": None,
        "parent": summary_linear_link(ticket.get("parent")),
        "children": [
            link
            for link in (summary_linear_link(child) for child in ticket.get("children", []))
            if link
        ],
        "relatedIssues": [
            {"relationType": relation.get("relationType") or "related", "issue": link}
            for relation in ticket.get("relatedIssues", [])
            if (link := summary_linear_link(relation.get("issue")))
        ],
        "comments": [],
        "attachments": [],
        "activity": [],
    }


def summary_linear_link(value: Any) -> dict[str, str] | None:
    if not isinstance(value, dict) or not value.get("ticketId"):
        return None
    return {
        "ticketId": str(value.get("ticketId") or "").upper(),
        "title": "",
        "url": "",
        "stateName": "",
        "stateType": "",
    }


def repo_summary(settings: Settings, diagnostics: list[str]) -> dict[str, str]:
    return {
        "path": str(settings.repo_path),
        "nameWithOwner": settings.repo_name,
        "url": f"https://github.com/{settings.repo_name}",
    }


def github_login(diagnostics: list[str]) -> str | None:
    global _GITHUB_LOGIN_CACHE
    override = os.environ.get("TICKETBOARD_GITHUB_LOGIN")
    if override:
        return override.strip() or None
    cache_key = (
        os.environ.get("GH_TOKEN") or "",
        os.environ.get("GITHUB_TOKEN") or "",
    )
    if _GITHUB_LOGIN_CACHE and _GITHUB_LOGIN_CACHE[0] == cache_key:
        return _GITHUB_LOGIN_CACHE[1]
    try:
        output = run_command(["gh", "api", "user", "--jq", ".login"], timeout=8).strip()
        login = output or None
        _GITHUB_LOGIN_CACHE = (cache_key, login)
        return login
    except Exception as exc:
        diagnostics.append(f"GitHub login unavailable: {exc}")
        return None


GH_PR_SUMMARY_FIELDS = [
    "number",
    "title",
    "url",
    "body",
    "headRefName",
    "baseRefName",
    "author",
    "isDraft",
    "mergeStateStatus",
    "reviewDecision",
    "updatedAt",
    "additions",
    "deletions",
    "labels",
    "assignees",
    "reviewRequests",
    "milestone",
    "statusCheckRollup",
]

GH_PR_DETAIL_FIELDS = [
    *GH_PR_SUMMARY_FIELDS,
    "comments",
    "reviews",
    "latestReviews",
    "commits",
    "files",
]

GH_PR_SUMMARY_QUERY = """
query TicketboardPrs($query: String!, $limit: Int!) {
  search(query: $query, type: ISSUE, first: $limit) {
    nodes {
      ... on PullRequest {
        number
        title
        url
        body
        headRefName
        baseRefName
        author { login }
        isDraft
        mergeStateStatus
        reviewDecision
        updatedAt
        additions
        deletions
        labels(first: 20) { nodes { name color description } }
        assignees(first: 10) { nodes { login name } }
        reviewRequests(first: 10) {
          nodes {
            requestedReviewer {
              __typename
              ... on User { login name }
              ... on Team { slug name }
            }
          }
        }
        milestone { title dueOn state url }
        statusCheckRollup {
          state
          contexts(first: 1) {
            totalCount
          }
        }
      }
    }
  }
}
"""


GH_PR_VERSION_QUERY = """
query TicketboardPrVersions($query: String!, $limit: Int!) {
  search(query: $query, type: ISSUE, first: $limit) {
    nodes {
      ... on PullRequest {
        number
        updatedAt
      }
    }
  }
}
"""


GH_PR_SINGLE_VERSION_QUERY = """
query TicketboardPrVersion($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number
      updatedAt
      author { login }
    }
  }
}
"""


GH_PR_DETAIL_QUERY = """
query TicketboardPrDetail($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number
      title
      url
      body
      headRefName
      baseRefName
      author { login }
      isDraft
      mergeStateStatus
      reviewDecision
      updatedAt
      additions
      deletions
      labels(first: 20) { nodes { name color description } }
      assignees(first: 10) { nodes { login name } }
      reviewRequests(first: 10) {
        nodes {
          requestedReviewer {
            __typename
            ... on User { login name }
            ... on Team { slug name }
          }
        }
      }
      milestone { title dueOn state url }
      statusCheckRollup {
        contexts(first: 50) {
          nodes {
            __typename
            ... on CheckRun {
              name
              status
              conclusion
              detailsUrl
              startedAt
              completedAt
            }
            ... on StatusContext {
              context
              state
              targetUrl
              createdAt
            }
          }
        }
      }
      comments(last: 50) {
        totalCount
        nodes { author { login } authorAssociation body createdAt url }
      }
      reviews(last: 50) {
        totalCount
        nodes { author { login } state submittedAt body }
      }
      reviewThreads(last: 50) {
        nodes {
          comments(last: 50) {
            nodes {
              databaseId
              author { login }
              body
              path
              line
              originalLine
              createdAt
              updatedAt
              url
            }
          }
        }
      }
      commits(last: 12) {
        nodes {
          commit {
            oid
            messageHeadline
            messageBody
            authoredDate
            committedDate
            url
            authors(first: 1) {
              nodes { name user { login } }
            }
          }
        }
      }
      files(first: 100) {
        nodes { path additions deletions changeType }
      }
    }
  }
}
"""


def collect_github_prs(
    settings: Settings,
    diagnostics: list[str],
    owner_login: str | None,
) -> list[PullRequestSummary]:
    if not owner_login:
        diagnostics.append(
            "GitHub owner unavailable; set TICKETBOARD_GITHUB_LOGIN to show PRs"
        )
        return []
    cache_payload = cached_prs_payload(settings)
    if github_pr_cache_is_fresh(settings, owner_login, cache_payload):
        return cached_prs_list(settings, owner_login, cache_payload)
    cached_by_number = filter_prs_by_github_owner(
        cached_prs_by_number(settings, cache_payload),
        owner_login,
    )
    cached_prs = cached_prs_list(settings, owner_login, cache_payload)
    if cached_prs and not github_pr_full_refresh_due(settings, owner_login, cache_payload):
        try:
            versions = fetch_github_pr_version_items_graphql(settings, owner_login)
            if github_pr_versions_match_cache(versions, cached_by_number):
                save_github_pr_cache(
                    settings,
                    owner_login,
                    cached_prs,
                    full_refresh=False,
                    existing_payload=cache_payload,
                )
                return cached_prs
        except Exception as exc:
            diagnostics.append(
                "GitHub PR version probe unavailable; refreshing full PR summary: "
                f"{exc}"
            )
    try:
        raw_prs = fetch_github_pr_summary_items(settings, owner_login, diagnostics)
        prs: list[PullRequestSummary] = []
        review_comment_budget = int(os.environ.get("TICKETBOARD_REVIEW_COMMENT_PRS", "0"))
        numbers_with_review_comments = [
            int(item["number"])
            for item in raw_prs[:review_comment_budget]
            if should_refresh_pr_review_comments(item, cached_by_number)
        ]
        review_comments_by_number: dict[int, list[dict[str, Any]]] = {}
        if numbers_with_review_comments:
            with ThreadPoolExecutor(
                max_workers=min(6, len(numbers_with_review_comments))
            ) as executor:
                futures = {
                    executor.submit(fetch_pr_review_comments, settings, number): number
                    for number in numbers_with_review_comments
                }
                for future in as_completed(futures):
                    number = futures[future]
                    try:
                        review_comments_by_number[number] = future.result()
                    except Exception as exc:
                        diagnostics.append(
                            f"GitHub review comments unavailable for PR #{number}: {exc}"
                        )
        for item in raw_prs:
            number = int(item["number"])
            pr = normalize_pr(
                item,
                fallback=cached_by_number.get(number),
                review_comments=review_comments_by_number.get(number),
                detail_level="summary",
            )
            if github_pr_matches_owner(pr, owner_login):
                prs.append(pr)
        save_github_pr_cache(settings, owner_login, prs, full_refresh=True)
        return prs
    except Exception as exc:
        diagnostics.append(f"GitHub PR collection unavailable, using cache if present: {exc}")
        return cached_prs_list(settings, owner_login, cache_payload)


def fetch_github_pr_summary_items(
    settings: Settings,
    owner_login: str,
    diagnostics: list[str],
) -> list[dict[str, Any]]:
    try:
        return fetch_github_pr_summary_items_graphql(settings, owner_login)
    except Exception as exc:
        diagnostics.append(
            "GitHub GraphQL PR summary unavailable, falling back to gh pr list: "
            f"{exc}"
        )
        return fetch_github_pr_summary_items_gh(settings, owner_login)


def fetch_github_pr_summary_items_graphql(
    settings: Settings,
    owner_login: str,
) -> list[dict[str, Any]]:
    token = github_auth_token()
    limit = min(max(settings.github_pr_limit, 1), 100)
    response = github_graphql_client().post(
        "https://api.github.com/graphql",
        headers={
            "Authorization": f"bearer {token}",
            "Accept": "application/vnd.github+json",
        },
        json={
            "query": GH_PR_SUMMARY_QUERY,
            "variables": {
                "query": github_pr_search_query(settings, owner_login),
                "limit": limit,
            },
        },
    )
    response.raise_for_status()
    payload = response.json()
    errors = payload.get("errors")
    if errors:
        message = errors[0].get("message") if isinstance(errors[0], dict) else errors[0]
        raise RuntimeError(str(message))
    nodes = (((payload.get("data") or {}).get("search") or {}).get("nodes") or [])
    return [
        github_graphql_pr_to_gh_item(node)
        for node in nodes
        if isinstance(node, dict) and node.get("number") is not None
    ]


def fetch_github_pr_version_items_graphql(
    settings: Settings,
    owner_login: str,
) -> list[dict[str, Any]]:
    token = github_auth_token()
    limit = min(max(settings.github_pr_limit, 1), 100)
    response = github_graphql_client().post(
        "https://api.github.com/graphql",
        headers={
            "Authorization": f"bearer {token}",
            "Accept": "application/vnd.github+json",
        },
        json={
            "query": GH_PR_VERSION_QUERY,
            "variables": {
                "query": github_pr_search_query(settings, owner_login),
                "limit": limit,
            },
        },
    )
    response.raise_for_status()
    payload = response.json()
    errors = payload.get("errors")
    if errors:
        message = errors[0].get("message") if isinstance(errors[0], dict) else errors[0]
        raise RuntimeError(str(message))
    nodes = (((payload.get("data") or {}).get("search") or {}).get("nodes") or [])
    return [
        node
        for node in nodes
        if isinstance(node, dict) and node.get("number") is not None
    ]


def github_pr_search_query(settings: Settings, owner_login: str) -> str:
    return (
        f"repo:{settings.repo_name} is:pr is:open "
        f"author:{owner_login} sort:updated-desc"
    )


def fetch_github_pr_summary_items_gh(
    settings: Settings,
    owner_login: str,
) -> list[dict[str, Any]]:
    args = [
        "gh",
        "pr",
        "list",
        "--repo",
        settings.repo_name,
        "--state",
        "open",
        "--limit",
        str(settings.github_pr_limit),
        "--json",
        ",".join(GH_PR_SUMMARY_FIELDS),
        "--author",
        owner_login,
    ]
    output = run_command(
        args,
        timeout=45,
    )
    raw_prs = orjson.loads(output)
    return raw_prs if isinstance(raw_prs, list) else []


def github_auth_token() -> str:
    global _GITHUB_AUTH_TOKEN_CACHE
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if token:
        return token
    if _GITHUB_AUTH_TOKEN_CACHE:
        return _GITHUB_AUTH_TOKEN_CACHE
    _GITHUB_AUTH_TOKEN_CACHE = run_command(["gh", "auth", "token"], timeout=8).strip()
    if not _GITHUB_AUTH_TOKEN_CACHE:
        raise RuntimeError("gh auth token returned an empty token")
    return _GITHUB_AUTH_TOKEN_CACHE


def github_graphql_client() -> httpx.Client:
    global _GITHUB_GRAPHQL_CLIENT
    if _GITHUB_GRAPHQL_CLIENT is None:
        _GITHUB_GRAPHQL_CLIENT = httpx.Client(timeout=20)
    return _GITHUB_GRAPHQL_CLIENT


def linear_graphql_client() -> httpx.Client:
    global _LINEAR_GRAPHQL_CLIENT
    if _LINEAR_GRAPHQL_CLIENT is None:
        _LINEAR_GRAPHQL_CLIENT = httpx.Client(timeout=30)
    return _LINEAR_GRAPHQL_CLIENT


def close_persistent_clients() -> None:
    global _GITHUB_GRAPHQL_CLIENT, _LINEAR_GRAPHQL_CLIENT
    for client in (_GITHUB_GRAPHQL_CLIENT, _LINEAR_GRAPHQL_CLIENT):
        if client is not None:
            client.close()
    _GITHUB_GRAPHQL_CLIENT = None
    _LINEAR_GRAPHQL_CLIENT = None


def invalidate_local_action_caches() -> None:
    global _CODEX_SESSION_PATHS_CACHE, _TMUX_WINDOWS_CACHE, _WORKTREE_SUMMARY_CACHE
    _TMUX_WINDOWS_CACHE = None
    _WORKTREE_SUMMARY_CACHE = None
    _WORKTREE_DETAIL_CACHE.clear()
    _CODEX_SESSION_PATHS_CACHE = None


def github_graphql_pr_to_gh_item(node: dict[str, Any]) -> dict[str, Any]:
    item = dict(node)
    item["labels"] = connection_nodes(node.get("labels"))
    item["assignees"] = connection_nodes(node.get("assignees"))
    item["reviewRequests"] = [
        reviewer
        for reviewer in (
            request.get("requestedReviewer")
            for request in connection_nodes(node.get("reviewRequests"))
            if isinstance(request, dict)
        )
        if isinstance(reviewer, dict)
    ]
    rollup = node.get("statusCheckRollup")
    contexts = rollup.get("contexts") if isinstance(rollup, dict) else None
    context_nodes = connection_nodes(contexts)
    item["statusCheckRollup"] = (
        context_nodes
        if context_nodes
        else rollup if isinstance(rollup, dict) else {}
    )
    return item


def connection_nodes(value: Any) -> list[dict[str, Any]]:
    nodes = value.get("nodes") if isinstance(value, dict) else value
    if not isinstance(nodes, list):
        return []
    return [node for node in nodes if isinstance(node, dict)]


def github_pr_cache_key(settings: Settings, owner_login: str | None) -> str:
    return f"{settings.repo_name}:{settings.github_pr_limit}:{owner_login}"


def github_pr_cache_is_fresh(
    settings: Settings,
    owner_login: str | None,
    payload: dict[str, Any] | None = None,
) -> bool:
    ttl_seconds = int(os.environ.get("TICKETBOARD_GITHUB_TTL", "60"))
    if ttl_seconds <= 0:
        return False
    payload = payload if payload is not None else cached_prs_payload(settings)
    if payload.get("cacheKey") != github_pr_cache_key(settings, owner_login):
        return False
    saved_at = payload.get("savedAt")
    if not isinstance(saved_at, str):
        return False
    try:
        saved = datetime.fromisoformat(saved_at.replace("Z", "+00:00"))
    except ValueError:
        return False
    return (datetime.now(UTC) - saved).total_seconds() < ttl_seconds


def github_pr_full_refresh_due(
    settings: Settings,
    owner_login: str | None,
    payload: dict[str, Any],
) -> bool:
    ttl_seconds = int(os.environ.get("TICKETBOARD_GITHUB_FULL_REFRESH_TTL", "300"))
    if ttl_seconds <= 0:
        return True
    if payload.get("cacheKey") != github_pr_cache_key(settings, owner_login):
        return True
    age_seconds = cache_age_seconds(payload, "fullSavedAt")
    if age_seconds is None:
        age_seconds = cache_age_seconds(payload, "savedAt")
    return age_seconds is None or age_seconds >= ttl_seconds


def cache_age_seconds(payload: dict[str, Any], field: str) -> float | None:
    saved_at = payload.get(field)
    if not isinstance(saved_at, str):
        return None
    try:
        saved = datetime.fromisoformat(saved_at.replace("Z", "+00:00"))
    except ValueError:
        return None
    return (datetime.now(UTC) - saved).total_seconds()


def github_pr_versions_match_cache(
    versions: list[dict[str, Any]],
    cached_by_number: dict[int, PullRequestSummary],
) -> bool:
    version_by_number: dict[int, str] = {}
    for item in versions:
        number = item.get("number")
        updated_at = item.get("updatedAt")
        if number is None or not isinstance(updated_at, str):
            return False
        version_by_number[int(number)] = updated_at
    if set(version_by_number) != set(cached_by_number):
        return False
    return all(
        str(cached_by_number[number].get("updatedAt") or "") == updated_at
        for number, updated_at in version_by_number.items()
    )


def save_github_pr_cache(
    settings: Settings,
    owner_login: str | None,
    prs: list[PullRequestSummary],
    *,
    full_refresh: bool,
    existing_payload: dict[str, Any] | None = None,
) -> None:
    saved_at = utc_now_iso()
    existing_payload = existing_payload or {}
    full_saved_at = (
        saved_at
        if full_refresh
        else (
            existing_payload.get("fullSavedAt")
            or existing_payload.get("savedAt")
            or saved_at
        )
    )
    save_json(
        settings.cache_dir / "pr-list-cache.json",
        {
            "version": 1,
            "cacheKey": github_pr_cache_key(settings, owner_login),
            "savedAt": saved_at,
            "fullSavedAt": full_saved_at,
            "prs": prs,
        },
    )


def should_refresh_pr_review_comments(
    item: dict[str, Any],
    cached_by_number: dict[int, PullRequestSummary],
) -> bool:
    number = item.get("number")
    if number is None:
        return False
    fallback = cached_by_number.get(int(number))
    if not fallback:
        return True
    return fallback.get("updatedAt") != item.get("updatedAt")


def filter_prs_by_github_owner(
    prs: dict[int, PullRequestSummary],
    owner_login: str | None,
) -> dict[int, PullRequestSummary]:
    return {
        number: pr
        for number, pr in prs.items()
        if github_pr_matches_owner(pr, owner_login)
    }


def github_pr_matches_owner(
    pr: PullRequestSummary,
    owner_login: str | None,
) -> bool:
    if not owner_login:
        return False
    return normalize_owner_name(pr.get("author")) == normalize_owner_name(owner_login)


def cached_prs_payload(settings: Settings) -> dict[str, Any]:
    payload = load_json(settings.cache_dir / "pr-list-cache.json")
    return payload if isinstance(payload, dict) else {}


def cached_prs_list(
    settings: Settings,
    owner_login: str | None,
    payload: dict[str, Any] | None = None,
) -> list[PullRequestSummary]:
    payload = payload if payload is not None else cached_prs_payload(settings)
    prs = payload.get("prs")
    if not isinstance(prs, list):
        return []
    return [
        pr
        for pr in prs
        if isinstance(pr, dict)
        and isinstance(pr.get("number"), int)
        and github_pr_matches_owner(pr, owner_login)
    ]


def cached_prs_by_number(
    settings: Settings,
    payload: dict[str, Any] | None = None,
) -> dict[int, PullRequestSummary]:
    by_number: dict[int, PullRequestSummary] = {}
    payload = payload if payload is not None else cached_prs_payload(settings)
    prs = payload.get("prs")
    if not isinstance(prs, list):
        return by_number
    for pr in prs:
        if isinstance(pr, dict) and isinstance(pr.get("number"), int):
            by_number[pr["number"]] = pr
    return by_number


def fetch_pull_request_detail(settings: Settings, number: int) -> PullRequestSummary:
    owner_login = github_login([])
    if not owner_login:
        raise FileNotFoundError(f"PR #{number} owner is unavailable")
    cached = cached_prs_by_number(settings).get(number)
    if cached and not github_pr_matches_owner(cached, owner_login):
        raise FileNotFoundError(f"PR #{number} is not owned by {owner_login}")
    if (
        cached
        and cached.get("detailLevel") == "full"
        and github_pr_cache_is_fresh(settings, owner_login)
    ):
        return cached

    version = cached.get("updatedAt") if cached else None
    cache_key = pr_detail_cache_key(settings, number)
    cached_detail = _PR_DETAIL_CACHE.get(cache_key)
    if cached_detail and pr_detail_cache_is_fresh(cached_detail[0]):
        if not cached or cached_detail[1] == version:
            return cached_detail[2]
        if github_pr_matches_owner(cached_detail[2], owner_login):
            return cached_detail[2]
    persisted_detail = cached_pr_detail(settings, cache_key, version, owner_login)
    if persisted_detail:
        _PR_DETAIL_CACHE[cache_key] = (
            time.monotonic(),
            persisted_detail.get("updatedAt"),
            persisted_detail,
        )
        trim_cache(_PR_DETAIL_CACHE, MAX_PR_DETAIL_CACHE)
        return persisted_detail

    try:
        version = cached_owned_pr_version(settings, number)
    except FileNotFoundError:
        raise
    except Exception:
        version = cached.get("updatedAt") if cached else None
    if version:
        persisted_detail = cached_pr_detail(
            settings,
            cache_key,
            version,
            owner_login,
            allow_revalidated=True,
        )
        if persisted_detail:
            _PR_DETAIL_CACHE[cache_key] = (
                time.monotonic(),
                persisted_detail.get("updatedAt"),
                persisted_detail,
            )
            trim_cache(_PR_DETAIL_CACHE, MAX_PR_DETAIL_CACHE)
            save_pr_detail_cache(settings, cache_key, persisted_detail)
            return persisted_detail

    raw, review_comments = fetch_pr_view_with_review_comments(settings, number)
    pr = normalize_pr(
        raw,
        fallback=cached,
        review_comments=review_comments,
        detail_level="full",
    )
    if not github_pr_matches_owner(pr, owner_login):
        raise FileNotFoundError(f"PR #{number} is not owned by {owner_login}")
    _PR_DETAIL_CACHE[cache_key] = (time.monotonic(), pr.get("updatedAt"), pr)
    trim_cache(_PR_DETAIL_CACHE, MAX_PR_DETAIL_CACHE)
    save_pr_detail_cache(settings, cache_key, pr)
    return pr


def cached_pr_detail(
    settings: Settings,
    cache_key: str,
    updated_at: str | None,
    owner_login: str,
    *,
    allow_revalidated: bool = False,
) -> PullRequestSummary | None:
    payload = load_json(pr_detail_cache_path(settings))
    if not isinstance(payload, dict) or payload.get("version") != 1:
        return None
    entries = payload.get("entries")
    if not isinstance(entries, dict):
        return None
    entry = entries.get(cache_key)
    if not isinstance(entry, dict):
        return None
    is_fresh = pr_detail_disk_entry_is_fresh(entry)
    if (
        not is_fresh
        and (
            not allow_revalidated
            or not updated_at
            or not pr_detail_disk_entry_is_revalidatable(entry)
        )
    ):
        return None
    pr = entry.get("pr")
    if not isinstance(pr, dict) or not github_pr_matches_owner(pr, owner_login):
        return None
    if updated_at and pr.get("updatedAt") != updated_at:
        return None
    return pr


def save_pr_detail_cache(
    settings: Settings,
    cache_key: str,
    pr: PullRequestSummary,
) -> None:
    payload = load_json(pr_detail_cache_path(settings))
    entries = payload.get("entries") if isinstance(payload, dict) else None
    if not isinstance(entries, dict):
        entries = {}
    entries[cache_key] = {
        "savedAt": utc_now_iso(),
        "updatedAt": pr.get("updatedAt"),
        "pr": pr,
    }
    trimmed_entries = dict(
        sorted(
            entries.items(),
            key=lambda item: str(item[1].get("savedAt") if isinstance(item[1], dict) else ""),
            reverse=True,
        )[:MAX_PR_DETAIL_CACHE]
    )
    save_json(
        pr_detail_cache_path(settings),
        {"version": 1, "entries": trimmed_entries},
    )


def pr_detail_cache_path(settings: Settings) -> Path:
    return settings.cache_dir / "pr-detail-cache.json"


def pr_detail_disk_entry_is_fresh(entry: dict[str, Any]) -> bool:
    ttl_seconds = int(os.environ.get("TICKETBOARD_PR_DETAIL_TTL", "60"))
    if ttl_seconds <= 0:
        return False
    age_seconds = pr_detail_disk_entry_age_seconds(entry)
    return age_seconds is not None and age_seconds < ttl_seconds


def pr_detail_disk_entry_is_revalidatable(entry: dict[str, Any]) -> bool:
    if int(os.environ.get("TICKETBOARD_PR_DETAIL_TTL", "60")) <= 0:
        return False
    ttl_seconds = int(os.environ.get("TICKETBOARD_GITHUB_FULL_REFRESH_TTL", "300"))
    if ttl_seconds <= 0:
        return False
    age_seconds = pr_detail_disk_entry_age_seconds(entry)
    return age_seconds is not None and age_seconds < ttl_seconds


def pr_detail_disk_entry_age_seconds(entry: dict[str, Any]) -> float | None:
    saved_at = entry.get("savedAt")
    if not isinstance(saved_at, str):
        return None
    try:
        saved = datetime.fromisoformat(saved_at.replace("Z", "+00:00"))
    except ValueError:
        return None
    return (datetime.now(UTC) - saved).total_seconds()


def fetch_pr_view_with_review_comments(
    settings: Settings,
    number: int,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    try:
        raw = fetch_pr_view_graphql(settings, number)
        review_comments = raw.get("reviewComments")
        return raw, review_comments if isinstance(review_comments, list) else []
    except Exception:
        with ThreadPoolExecutor(max_workers=2) as executor:
            pr_future = executor.submit(fetch_pr_view_gh, settings, number)
            comments_future = executor.submit(fetch_pr_review_comments, settings, number)
            return pr_future.result(), comments_future.result()


def fetch_pr_view(settings: Settings, number: int) -> dict[str, Any]:
    try:
        return fetch_pr_view_graphql(settings, number)
    except Exception:
        return fetch_pr_view_gh(settings, number)


def fetch_pr_view_graphql(settings: Settings, number: int) -> dict[str, Any]:
    owner, repo = settings.repo_name.split("/", 1)
    token = github_auth_token()
    response = github_graphql_client().post(
        "https://api.github.com/graphql",
        headers={
            "Authorization": f"bearer {token}",
            "Accept": "application/vnd.github+json",
        },
        json={
            "query": GH_PR_DETAIL_QUERY,
            "variables": {"owner": owner, "repo": repo, "number": number},
        },
    )
    response.raise_for_status()
    payload = response.json()
    errors = payload.get("errors")
    if errors:
        message = errors[0].get("message") if isinstance(errors[0], dict) else errors[0]
        raise RuntimeError(str(message))
    pr = (((payload.get("data") or {}).get("repository") or {}).get("pullRequest"))
    if not isinstance(pr, dict):
        raise RuntimeError(f"PR #{number} detail response was empty")
    return github_graphql_pr_detail_to_gh_item(pr)


def github_graphql_pr_detail_to_gh_item(pr: dict[str, Any]) -> dict[str, Any]:
    item = github_graphql_pr_to_gh_item(pr)
    comments = pr.get("comments")
    reviews = pr.get("reviews")
    item["comments"] = connection_nodes(comments)
    item["reviews"] = connection_nodes(reviews)
    item["commentCount"] = connection_total_count(comments)
    item["reviewCount"] = connection_total_count(reviews)
    item["latestReviews"] = item["reviews"]
    item["reviewComments"] = github_graphql_review_comments(pr.get("reviewThreads"))
    item["files"] = connection_nodes(pr.get("files"))
    item["commits"] = [
        github_graphql_commit_to_gh_item(node)
        for node in connection_nodes(pr.get("commits"))
        if isinstance(node.get("commit"), dict)
    ]
    return item


def github_graphql_review_comments(value: Any) -> list[dict[str, Any]]:
    comments = []
    for thread in connection_nodes(value):
        thread_comments = thread.get("comments")
        for comment in connection_nodes(thread_comments):
            comments.append(
                {
                    "id": comment.get("databaseId"),
                    "author": comment.get("author"),
                    "body": comment.get("body"),
                    "path": comment.get("path"),
                    "line": comment.get("line"),
                    "originalLine": comment.get("originalLine"),
                    "createdAt": comment.get("createdAt"),
                    "updatedAt": comment.get("updatedAt"),
                    "url": comment.get("url"),
                }
            )
    return comments


def connection_total_count(value: Any) -> int:
    if not isinstance(value, dict):
        return 0
    total = value.get("totalCount")
    return int(total) if isinstance(total, int) else 0


def github_graphql_commit_to_gh_item(node: dict[str, Any]) -> dict[str, Any]:
    commit = node["commit"]
    authors = [
        {
            "login": ((author.get("user") or {}).get("login") or author.get("name") or ""),
            "name": author.get("name"),
        }
        for author in connection_nodes(commit.get("authors"))
    ]
    return {
        "oid": commit.get("oid"),
        "messageHeadline": commit.get("messageHeadline"),
        "messageBody": commit.get("messageBody"),
        "authors": authors,
        "authoredDate": commit.get("authoredDate"),
        "committedDate": commit.get("committedDate"),
        "url": commit.get("url"),
    }


def fetch_pr_view_gh(settings: Settings, number: int) -> dict[str, Any]:
    output = run_command(
        [
            "gh",
            "pr",
            "view",
            str(number),
            "--repo",
            settings.repo_name,
            "--json",
            ",".join(GH_PR_DETAIL_FIELDS),
        ],
        timeout=30,
    )
    payload = orjson.loads(output)
    if not isinstance(payload, dict):
        raise RuntimeError(f"PR #{number} detail response was not an object")
    return payload


def pr_detail_cache_key(settings: Settings, number: int) -> str:
    return f"{settings.repo_name}:{number}"


def pr_detail_cache_is_fresh(saved_at: float) -> bool:
    ttl_seconds = int(os.environ.get("TICKETBOARD_PR_DETAIL_TTL", "60"))
    return ttl_seconds > 0 and time.monotonic() - saved_at < ttl_seconds


def trim_cache(cache: dict[Any, Any], limit: int) -> None:
    while len(cache) > limit:
        cache.pop(next(iter(cache)))


def fetch_pr_review_comments(settings: Settings, number: int) -> list[dict[str, Any]]:
    try:
        return fetch_pr_review_comments_rest(settings, number)
    except Exception:
        return fetch_pr_review_comments_gh(settings, number)


def fetch_pr_review_comments_rest(settings: Settings, number: int) -> list[dict[str, Any]]:
    token = github_auth_token()
    owner, repo = settings.repo_name.split("/", 1)
    url = f"https://api.github.com/repos/{owner}/{repo}/pulls/{number}/comments"
    comments: list[dict[str, Any]] = []
    params: dict[str, str] | None = {"per_page": "100"}
    while url:
        response = github_graphql_client().get(
            url,
            headers={
                "Authorization": f"bearer {token}",
                "Accept": "application/vnd.github+json",
            },
            params=params,
        )
        response.raise_for_status()
        payload = response.json()
        if isinstance(payload, list):
            comments.extend(item for item in payload if isinstance(item, dict))
        next_url = response.links.get("next", {}).get("url")
        url = next_url or ""
        params = None
    return comments


def fetch_pr_review_comments_gh(settings: Settings, number: int) -> list[dict[str, Any]]:
    owner, repo = settings.repo_name.split("/", 1)
    output = run_command(
        [
            "gh",
            "api",
            "--paginate",
            f"repos/{owner}/{repo}/pulls/{number}/comments",
        ],
        timeout=20,
    )
    return orjson.loads(output or "[]")


def normalize_pr(
    item: dict[str, Any],
    *,
    fallback: PullRequestSummary | None,
    review_comments: list[dict[str, Any]] | None,
    detail_level: str,
) -> PullRequestSummary:
    comments = item.get("comments") if isinstance(item.get("comments"), list) else []
    reviews = item.get("latestReviews") or item.get("reviews") or []
    files = normalize_pr_files(item.get("files"))
    status_rollup = item.get("statusCheckRollup")
    checks = normalize_checks(status_rollup)
    ticket_ids = extract_ticket_ids(
        item.get("title"),
        item.get("body"),
        item.get("headRefName"),
        *(comment.get("body") for comment in comments if isinstance(comment, dict)),
    )
    normalized_review_comments = (
        normalize_review_comments(review_comments)
        if review_comments is not None
        else []
    )
    number = item.get("number")
    if number is None and fallback:
        number = fallback.get("number")
    return {
        "detailLevel": detail_level,
        "number": int(number or 0),
        "title": str(item.get("title") or ""),
        "url": str(item.get("url") or ""),
        "bodyPreview": truncate(item.get("body"), 2_000),
        "headRefName": str(item.get("headRefName") or ""),
        "baseRefName": str(item.get("baseRefName") or ""),
        "author": actor_name(item.get("author")),
        "isDraft": bool(item.get("isDraft")),
        "mergeStateStatus": str(item.get("mergeStateStatus") or "UNKNOWN"),
        "reviewDecision": item.get("reviewDecision"),
        "updatedAt": str(item.get("updatedAt") or ""),
        "additions": int(item.get("additions") or 0),
        "deletions": int(item.get("deletions") or 0),
        "ticketIds": ticket_ids,
        "checkSummary": check_summary_from_rollup(status_rollup, checks),
        "commentCount": int(item.get("commentCount") or len(comments)),
        "reviewCount": int(
            item.get("reviewCount") or len(item.get("reviews") or reviews or [])
        ),
        "latestComments": normalize_issue_comments(comments),
        "reviewComments": normalized_review_comments,
        "labels": normalize_labels(item.get("labels")),
        "assignees": normalize_actors(item.get("assignees")),
        "reviewRequests": normalize_review_requests(item.get("reviewRequests")),
        "milestone": normalize_milestone(item.get("milestone")),
        "latestReviews": normalize_latest_reviews(reviews),
        "commits": normalize_commits(item.get("commits")),
        "files": files,
        "checks": checks,
    }


def actor_name(value: Any) -> str:
    if isinstance(value, dict):
        return str(value.get("login") or value.get("name") or "")
    return str(value or "")


def actor_url(login: str) -> str | None:
    return f"https://github.com/{login}" if login else None


def normalize_actors(values: Any) -> list[dict[str, str | None]]:
    if not isinstance(values, list):
        return []
    actors = []
    for item in values:
        if not isinstance(item, dict):
            continue
        login = str(item.get("login") or item.get("name") or "")
        actors.append(
            {"login": login, "name": item.get("name") or None, "url": actor_url(login)}
        )
    return actors


def normalize_labels(values: Any) -> list[dict[str, str | None]]:
    if not isinstance(values, list):
        return []
    return [
        {
            "name": str(item.get("name") or ""),
            "color": item.get("color"),
            "description": item.get("description"),
        }
        for item in values
        if isinstance(item, dict)
    ]


def normalize_review_requests(values: Any) -> list[dict[str, str | None]]:
    if not isinstance(values, list):
        return []
    requests = []
    for item in values:
        if not isinstance(item, dict):
            continue
        kind = str(item.get("__typename") or item.get("kind") or "User")
        name = str(item.get("login") or item.get("name") or item.get("slug") or "")
        url = actor_url(name) if kind.lower() == "user" else None
        requests.append({"name": name, "kind": kind, "url": url})
    return requests


def normalize_milestone(value: Any) -> dict[str, str | None] | None:
    if not isinstance(value, dict):
        return None
    title = value.get("title")
    if not title:
        return None
    return {
        "title": str(title),
        "dueOn": value.get("dueOn") or value.get("dueDate"),
        "state": value.get("state"),
        "url": value.get("url"),
    }


def normalize_issue_comments(values: Any) -> list[dict[str, Any]]:
    if not isinstance(values, list):
        return []
    comments = []
    for item in values[-8:]:
        if not isinstance(item, dict):
            continue
        comments.append(
            {
                "author": actor_name(item.get("author")),
                "authorAssociation": item.get("authorAssociation"),
                "body": truncate(item.get("body"), 2_000),
                "createdAt": item.get("createdAt"),
                "url": item.get("url"),
                "kind": "comment",
            }
        )
    return comments


def normalize_review_comments(values: Any) -> list[dict[str, Any]]:
    if not isinstance(values, list):
        return []
    comments = []
    for item in values[-30:]:
        if not isinstance(item, dict):
            continue
        comments.append(
            {
                "id": int(item.get("id") or 0),
                "author": actor_name(item.get("user") or item.get("author")),
                "body": truncate(item.get("body"), 2_000),
                "path": str(item.get("path") or ""),
                "line": item.get("line"),
                "originalLine": item.get("original_line") or item.get("originalLine"),
                "side": item.get("side"),
                "createdAt": str(item.get("created_at") or item.get("createdAt") or ""),
                "updatedAt": str(item.get("updated_at") or item.get("updatedAt") or ""),
                "url": str(item.get("html_url") or item.get("url") or ""),
            }
        )
    return comments


def normalize_latest_reviews(values: Any) -> list[dict[str, str]]:
    if not isinstance(values, list):
        return []
    reviews = []
    for item in values[-8:]:
        if not isinstance(item, dict):
            continue
        reviews.append(
            {
                "author": actor_name(item.get("author")),
                "state": str(item.get("state") or ""),
                "submittedAt": str(item.get("submittedAt") or ""),
                "body": truncate(item.get("body"), 2_000),
            }
        )
    return reviews


def normalize_commits(values: Any) -> list[dict[str, str]]:
    if not isinstance(values, list):
        return []
    commits = []
    for item in values[-12:]:
        if not isinstance(item, dict):
            continue
        oid = str(item.get("oid") or "")
        authors = item.get("authors") if isinstance(item.get("authors"), list) else []
        author = actor_name(authors[0]) if authors else ""
        commits.append(
            {
                "oid": oid,
                "shortOid": oid[:7],
                "headline": str(item.get("messageHeadline") or ""),
                "bodyPreview": truncate(item.get("messageBody"), 500),
                "author": author,
                "authoredAt": str(item.get("authoredDate") or ""),
                "committedAt": str(item.get("committedDate") or ""),
                "url": str(item.get("url") or ""),
            }
        )
    return commits


def normalize_pr_files(values: Any) -> list[dict[str, Any]]:
    if not isinstance(values, list):
        return []
    files = []
    for item in values:
        if not isinstance(item, dict):
            continue
        files.append(
            {
                "path": str(item.get("path") or ""),
                "additions": int(item.get("additions") or 0),
                "deletions": int(item.get("deletions") or 0),
                "changeType": str(item.get("changeType") or "MODIFIED"),
            }
        )
    return files


def normalize_checks(values: Any) -> list[dict[str, Any]]:
    if not isinstance(values, list):
        return []
    checks = []
    for item in values:
        if not isinstance(item, dict):
            continue
        if item.get("__typename") == "StatusContext":
            checks.append(
                {
                    "name": str(item.get("context") or ""),
                    "workflowName": None,
                    "status": "COMPLETED",
                    "conclusion": normalize_status_conclusion(item.get("state")),
                    "startedAt": item.get("startedAt"),
                    "completedAt": item.get("completedAt"),
                    "url": item.get("targetUrl"),
                }
            )
        else:
            checks.append(
                {
                    "name": str(item.get("name") or ""),
                    "workflowName": item.get("workflowName"),
                    "status": str(item.get("status") or "UNKNOWN"),
                    "conclusion": item.get("conclusion"),
                    "startedAt": item.get("startedAt"),
                    "completedAt": item.get("completedAt"),
                    "url": item.get("detailsUrl") or item.get("url"),
                }
            )
    return checks


def normalize_status_conclusion(value: Any) -> str | None:
    state = str(value or "").upper()
    if state in {"SUCCESS", "PASSING"}:
        return "SUCCESS"
    if state in {"FAILURE", "ERROR", "FAILING"}:
        return "FAILURE"
    if state in {"PENDING", "EXPECTED"}:
        return None
    return state or None


def check_summary(checks: list[dict[str, Any]]) -> dict[str, Any]:
    passed = failed = pending = 0
    for check in checks:
        status = str(check.get("status") or "").upper()
        conclusion = str(check.get("conclusion") or "").upper()
        if status and status not in {"COMPLETED", "SUCCESS"}:
            pending += 1
        elif conclusion in {"FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"}:
            failed += 1
        elif conclusion in {"SUCCESS", "NEUTRAL", "SKIPPED"}:
            passed += 1
        else:
            pending += 1
    total = len(checks)
    state = "unknown"
    if failed:
        state = "red"
    elif pending:
        state = "pending"
    elif total:
        state = "green"
    return {
        "total": total,
        "passed": passed,
        "failed": failed,
        "pending": pending,
        "state": state,
    }


def check_summary_from_rollup(
    rollup: Any,
    checks: list[dict[str, Any]],
) -> dict[str, Any]:
    if checks:
        return check_summary(checks)
    state = "unknown"
    total = 0
    if isinstance(rollup, dict):
        state = normalize_rollup_state(rollup.get("state"))
        total = rollup_context_total(rollup)
    passed = total if state == "green" else 0
    failed = total if state == "red" else 0
    pending = total if state == "pending" else 0
    return {
        "total": total,
        "passed": passed,
        "failed": failed,
        "pending": pending,
        "state": state,
    }


def rollup_context_total(rollup: dict[str, Any]) -> int:
    contexts = rollup.get("contexts")
    if not isinstance(contexts, dict):
        return 0
    total = contexts.get("totalCount")
    return int(total) if isinstance(total, int) else 0


def normalize_rollup_state(value: Any) -> str:
    state = str(value or "").upper()
    if state == "SUCCESS":
        return "green"
    if state in {"FAILURE", "ERROR", "ACTION_REQUIRED"}:
        return "red"
    if state in {"PENDING", "EXPECTED"}:
        return "pending"
    return "unknown"


def fetch_pr_diff(settings: Settings, number: int) -> PrDiffSummary:
    version = cached_owned_pr_version(settings, number)
    cache_key = pr_detail_cache_key(settings, number)
    cached_diff = _PR_DIFF_CACHE.get(cache_key)
    if cached_diff and cached_diff[1] == version and pr_detail_cache_is_fresh(
        cached_diff[0]
    ):
        return cached_diff[2]
    persisted_diff = cached_pr_diff(
        settings,
        cache_key,
        version,
        allow_revalidated=True,
    )
    if persisted_diff:
        _PR_DIFF_CACHE[cache_key] = (time.monotonic(), version, persisted_diff)
        trim_cache(_PR_DIFF_CACHE, MAX_PR_DIFF_CACHE)
        save_pr_diff_cache(settings, cache_key, version, persisted_diff)
        return persisted_diff

    output = fetch_pr_patch(settings, number)
    diff = parse_unified_diff(number, output)
    _PR_DIFF_CACHE[cache_key] = (time.monotonic(), version, diff)
    trim_cache(_PR_DIFF_CACHE, MAX_PR_DIFF_CACHE)
    save_pr_diff_cache(settings, cache_key, version, diff)
    return diff


def fetch_pr_patch(settings: Settings, number: int) -> str:
    try:
        return fetch_pr_patch_rest(settings, number)
    except Exception:
        return fetch_pr_patch_gh(settings, number)


def fetch_pr_patch_rest(settings: Settings, number: int) -> str:
    token = github_auth_token()
    owner, repo = settings.repo_name.split("/", 1)
    response = github_graphql_client().get(
        f"https://api.github.com/repos/{owner}/{repo}/pulls/{number}",
        headers={
            "Authorization": f"bearer {token}",
            "Accept": "application/vnd.github.patch",
        },
    )
    response.raise_for_status()
    return response.text


def fetch_pr_patch_gh(settings: Settings, number: int) -> str:
    return run_command(
        ["gh", "pr", "diff", str(number), "--repo", settings.repo_name, "--patch"],
        timeout=40,
    )


def cached_owned_pr_version(settings: Settings, number: int) -> str | None:
    owner_login = github_login([])
    if not owner_login:
        raise FileNotFoundError(f"PR #{number} owner is unavailable")
    cache_key = pr_detail_cache_key(settings, number)
    cache_payload = cached_prs_payload(settings)
    cached_by_number = cached_prs_by_number(settings, cache_payload)
    cached = cached_by_number.get(number)
    if cached:
        if not github_pr_matches_owner(cached, owner_login):
            raise FileNotFoundError(f"PR #{number} is not owned by {owner_login}")
        if github_pr_cache_is_fresh(settings, owner_login, cache_payload):
            return cached.get("updatedAt") or None
    detail_version = cached_pr_detail_version(settings, cache_key, owner_login)
    if detail_version:
        return detail_version
    try:
        return fetch_owned_pr_version_graphql(settings, number, owner_login)
    except Exception:
        return fetch_owned_pr_version_from_view(settings, number, owner_login, cached)


def cached_pr_detail_version(
    settings: Settings,
    cache_key: str,
    owner_login: str,
) -> str | None:
    cached_detail = _PR_DETAIL_CACHE.get(cache_key)
    if cached_detail and pr_detail_cache_is_fresh(cached_detail[0]):
        pr = cached_detail[2]
        if github_pr_matches_owner(pr, owner_login):
            return pr.get("updatedAt") or None

    persisted_detail = cached_pr_detail(settings, cache_key, None, owner_login)
    if not persisted_detail:
        return None
    _PR_DETAIL_CACHE[cache_key] = (
        time.monotonic(),
        persisted_detail.get("updatedAt"),
        persisted_detail,
    )
    trim_cache(_PR_DETAIL_CACHE, MAX_PR_DETAIL_CACHE)
    return persisted_detail.get("updatedAt") or None


def fetch_owned_pr_version_graphql(
    settings: Settings,
    number: int,
    owner_login: str,
) -> str | None:
    owner, repo = settings.repo_name.split("/", 1)
    token = github_auth_token()
    response = github_graphql_client().post(
        "https://api.github.com/graphql",
        headers={
            "Authorization": f"bearer {token}",
            "Accept": "application/vnd.github+json",
        },
        json={
            "query": GH_PR_SINGLE_VERSION_QUERY,
            "variables": {"owner": owner, "repo": repo, "number": number},
        },
    )
    response.raise_for_status()
    payload = response.json()
    errors = payload.get("errors")
    if errors:
        message = errors[0].get("message") if isinstance(errors[0], dict) else errors[0]
        raise RuntimeError(str(message))
    pr = (((payload.get("data") or {}).get("repository") or {}).get("pullRequest"))
    if not isinstance(pr, dict):
        raise FileNotFoundError(f"PR #{number} not found")
    if normalize_owner_name(actor_name(pr.get("author"))) != normalize_owner_name(
        owner_login
    ):
        raise FileNotFoundError(f"PR #{number} is not owned by {owner_login}")
    updated_at = pr.get("updatedAt")
    return str(updated_at) if updated_at else None


def fetch_owned_pr_version_from_view(
    settings: Settings,
    number: int,
    owner_login: str,
    fallback: PullRequestSummary | None,
) -> str | None:
    pr = normalize_pr(
        fetch_pr_view(settings, number),
        fallback=fallback,
        review_comments=[],
        detail_level="summary",
    )
    if not github_pr_matches_owner(pr, owner_login):
        raise FileNotFoundError(f"PR #{number} is not owned by {owner_login}")
    return pr.get("updatedAt") or None


def cached_pr_diff(
    settings: Settings,
    cache_key: str,
    updated_at: str | None,
    *,
    allow_revalidated: bool = False,
) -> PrDiffSummary | None:
    payload = load_json(pr_diff_cache_path(settings))
    if not isinstance(payload, dict) or payload.get("version") != 1:
        return None
    entries = payload.get("entries")
    if not isinstance(entries, dict):
        return None
    entry = entries.get(cache_key)
    if not isinstance(entry, dict):
        return None
    if (
        not pr_detail_disk_entry_is_fresh(entry)
        and (
            not allow_revalidated
            or not updated_at
            or not pr_detail_disk_entry_is_revalidatable(entry)
        )
    ):
        return None
    if entry.get("updatedAt") != updated_at:
        return None
    diff = entry.get("diff")
    return diff if isinstance(diff, dict) else None


def save_pr_diff_cache(
    settings: Settings,
    cache_key: str,
    updated_at: str | None,
    diff: PrDiffSummary,
) -> None:
    payload = load_json(pr_diff_cache_path(settings))
    entries = payload.get("entries") if isinstance(payload, dict) else None
    if not isinstance(entries, dict):
        entries = {}
    entries[cache_key] = {
        "savedAt": utc_now_iso(),
        "updatedAt": updated_at,
        "diff": diff,
    }
    trimmed_entries = dict(
        sorted(
            entries.items(),
            key=lambda item: str(item[1].get("savedAt") if isinstance(item[1], dict) else ""),
            reverse=True,
        )[:MAX_PR_DIFF_CACHE]
    )
    save_json(pr_diff_cache_path(settings), {"version": 1, "entries": trimmed_entries})


def pr_diff_cache_path(settings: Settings) -> Path:
    return settings.cache_dir / "pr-diff-cache.json"


def parse_unified_diff(number: int, diff: str) -> PrDiffSummary:
    files: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    current_hunk: dict[str, Any] | None = None
    old_line = 0
    new_line = 0
    loaded_lines = 0
    truncated_diff = False

    def ensure_file() -> dict[str, Any]:
        nonlocal current
        if current is None:
            current = {
                "path": "diff",
                "oldPath": None,
                "additions": 0,
                "deletions": 0,
                "changeType": "MODIFIED",
                "hunks": [],
            }
            files.append(current)
        return current

    for raw_line in diff.splitlines():
        if loaded_lines >= MAX_DIFF_LINES:
            truncated_diff = True
            break
        if raw_line.startswith("diff --git "):
            parts = raw_line.split()
            old_path = strip_git_path(parts[2]) if len(parts) > 2 else None
            new_path = strip_git_path(parts[3]) if len(parts) > 3 else old_path
            current = {
                "path": new_path or old_path or "unknown",
                "oldPath": old_path if old_path != new_path else None,
                "additions": 0,
                "deletions": 0,
                "changeType": "MODIFIED",
                "hunks": [],
            }
            files.append(current)
            current_hunk = None
            continue
        if current is None:
            continue
        if raw_line.startswith("new file"):
            current["changeType"] = "ADDED"
            continue
        if raw_line.startswith("deleted file"):
            current["changeType"] = "DELETED"
            continue
        if raw_line.startswith("rename from "):
            current["oldPath"] = raw_line.removeprefix("rename from ").strip()
            current["changeType"] = "RENAMED"
            continue
        if raw_line.startswith("rename to "):
            current["path"] = raw_line.removeprefix("rename to ").strip()
            current["changeType"] = "RENAMED"
            continue
        if raw_line.startswith("@@"):
            current_hunk = {"header": raw_line, "lines": []}
            current["hunks"].append(current_hunk)
            old_line, new_line = parse_hunk_start(raw_line)
            continue
        if current_hunk is None:
            continue
        loaded_lines += 1
        if raw_line.startswith("+") and not raw_line.startswith("+++"):
            current_hunk["lines"].append(
                {"kind": "add", "content": raw_line[1:], "oldLine": None, "newLine": new_line}
            )
            current["additions"] += 1
            new_line += 1
        elif raw_line.startswith("-") and not raw_line.startswith("---"):
            current_hunk["lines"].append(
                {
                    "kind": "remove",
                    "content": raw_line[1:],
                    "oldLine": old_line,
                    "newLine": None,
                }
            )
            current["deletions"] += 1
            old_line += 1
        elif raw_line.startswith("\\"):
            current_hunk["lines"].append(
                {"kind": "meta", "content": raw_line, "oldLine": None, "newLine": None}
            )
        else:
            content = raw_line[1:] if raw_line.startswith(" ") else raw_line
            current_hunk["lines"].append(
                {
                    "kind": "context",
                    "content": content,
                    "oldLine": old_line,
                    "newLine": new_line,
                }
            )
            old_line += 1
            new_line += 1

    return {
        "number": number,
        "files": files,
        "totalLines": loaded_lines,
        "truncated": truncated_diff,
    }


def strip_git_path(value: str) -> str | None:
    if value == "/dev/null":
        return None
    return re.sub(r"^[ab]/", "", value)


def parse_hunk_start(header: str) -> tuple[int, int]:
    match = re.search(r"@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@", header)
    if not match:
        return 0, 0
    return int(match.group(1)), int(match.group(2))


def fetch_check_log(settings: Settings, number: int, check_key: str) -> PrCheckLogSummary:
    try:
        check = check_from_key(check_key)
        if check.get("url"):
            cached_owned_pr_version(settings, number)
        else:
            raise KeyError("check not found")
    except KeyError:
        pr = fetch_pull_request_detail(settings, number)
        check = next((item for item in pr["checks"] if check_run_key(item) == check_key), None)
        if not check:
            check = check_from_key(check_key)
    url = check.get("url") or ""
    cache_key = check_log_cache_key(settings, number, check_key)
    cached_log = cached_check_log(cache_key)
    if cached_log:
        return cached_log
    command = ""
    log = ""
    run_match = re.search(r"/actions/runs/(\d+)(?:/job/(\d+))?", url)
    if run_match:
        run_id, job_id = run_match.groups()
        command_args = [
            "gh",
            "run",
            "view",
            run_id,
            "--repo",
            settings.repo_name,
            "--log-failed",
        ]
        if job_id:
            command_args.extend(["--job", job_id])
        command = " ".join(command_args)
        log = run_command(command_args, timeout=45)
    if not log:
        raise RuntimeError("no GitHub Actions log available for this check")
    truncated = len(log) > MAX_LOG_CHARS
    result: PrCheckLogSummary = {
        "prNumber": number,
        "checkKey": check_key,
        "checkName": str(check.get("name") or ""),
        "workflowName": check.get("workflowName"),
        "url": url,
        "command": command,
        "log": log[:MAX_LOG_CHARS],
        "truncated": truncated,
    }
    _CHECK_LOG_CACHE[cache_key] = (time.monotonic(), result)
    trim_cache(_CHECK_LOG_CACHE, MAX_CHECK_LOG_CACHE)
    return result


def check_log_cache_key(settings: Settings, number: int, check_key: str) -> str:
    return f"{settings.repo_name}:{number}:{check_key}"


def cached_check_log(cache_key: str) -> PrCheckLogSummary | None:
    cached = _CHECK_LOG_CACHE.get(cache_key)
    if not cached:
        return None
    ttl_seconds = int(os.environ.get("TICKETBOARD_CHECK_LOG_TTL", "300"))
    if ttl_seconds <= 0 or time.monotonic() - cached[0] >= ttl_seconds:
        _CHECK_LOG_CACHE.pop(cache_key, None)
        return None
    return cached[1]


def check_from_key(check_key: str) -> dict[str, Any]:
    workflow_name, separator, rest = check_key.partition(":")
    if not separator:
        raise KeyError("check not found")
    name, separator, url = rest.partition(":")
    if not separator:
        raise KeyError("check not found")
    return {
        "name": name,
        "workflowName": workflow_name or None,
        "url": url,
    }


def check_run_key(check: dict[str, Any]) -> str:
    return (
        f"{check.get('workflowName') or ''}:{check.get('name') or ''}:{check.get('url') or ''}"
    )


def collect_linear_tickets(
    settings: Settings,
    ticket_ids: set[str],
    diagnostics: list[str],
    *,
    write_cache: bool = True,
    owner_names: set[str] | None = None,
    cache_payload: dict[str, Any] | None = None,
) -> list[LinearTicketSummary]:
    cached = cached_linear_tickets(settings, cache_payload)
    token = os.environ.get("LINEAR_API_KEY")
    owner_names = owner_names if owner_names is not None else linear_owner_names(
        token,
        diagnostics,
    )
    filtered_count = 0
    filtered_ticket_ids: set[str] = set()
    tickets: dict[str, LinearTicketSummary] = {}
    cached_known_ticket_ids = set(cached) | cached_linear_ignored_ticket_ids(
        settings,
        cache_payload,
    )

    if not owner_names:
        diagnostics.append(
            "Linear owner unavailable; set TICKETBOARD_LINEAR_ASSIGNEE to show Linear tickets"
        )
        return []

    if linear_cache_is_fresh(settings, owner_names, cache_payload):
        if ticket_ids and ticket_ids.issubset(cached_known_ticket_ids):
            return sort_linear_tickets(
                ticket for ticket_id, ticket in cached.items() if ticket_id in ticket_ids
            )
        if not ticket_ids and cached:
            return sort_linear_tickets(list(cached.values())[:50])

    if (
        token
        and ticket_ids
        and ticket_ids.issubset(cached_known_ticket_ids)
        and not linear_full_refresh_due(settings, owner_names, cache_payload)
    ):
        try:
            versions, version_errors = fetch_linear_issue_versions(
                token,
                sorted(ticket_ids),
                owner_names=owner_names,
            )
            append_linear_error_diagnostics(version_errors, diagnostics)
            if linear_versions_match_cache(
                versions,
                cached,
                cached_linear_ignored_ticket_ids(settings, cache_payload),
                ticket_ids,
                owner_names,
            ):
                save_linear_ticket_cache(
                    settings,
                    cached.values(),
                    owner_names=owner_names,
                    full_refresh=False,
                )
                return sort_linear_tickets(
                    ticket
                    for ticket_id, ticket in cached.items()
                    if ticket_id in ticket_ids
                )
        except Exception as exc:
            diagnostics.append(
                "Linear issue version probe unavailable; refreshing full issue summaries: "
                f"{exc}"
            )

    if token and ticket_ids:
        fetched, errors = fetch_linear_issues(
            token,
            sorted(ticket_ids),
            owner_names=owner_names,
        )
        append_linear_error_diagnostics(errors, diagnostics)
        for ticket_id in sorted(ticket_ids):
            ticket = fetched.get(ticket_id)
            if ticket and linear_ticket_matches_owner(ticket, owner_names):
                tickets[ticket["ticketId"]] = ticket
            elif ticket:
                filtered_count += 1
                filtered_ticket_ids.add(ticket_id)
            elif ticket_id not in errors:
                filtered_count += 1
                filtered_ticket_ids.add(ticket_id)
            elif ticket_id in cached and linear_ticket_matches_owner(
                cached[ticket_id],
                owner_names,
            ):
                tickets[ticket_id] = cached[ticket_id]
    elif ticket_ids:
        diagnostics.append("LINEAR_API_KEY is not set; using cached Linear tickets if present")

    for ticket_id in ticket_ids:
        if (
            ticket_id in cached
            and ticket_id not in tickets
            and linear_ticket_matches_owner(cached[ticket_id], owner_names)
        ):
            tickets[ticket_id] = cached[ticket_id]

    if not ticket_ids and cached:
        tickets.update(
            {
                ticket_id: ticket
                for ticket_id, ticket in list(cached.items())[:50]
                if linear_ticket_matches_owner(ticket, owner_names)
            }
        )

    if filtered_count and owner_names:
        diagnostics.append(
            f"Filtered {filtered_count} Linear tickets not assigned to "
            f"{format_owner_names(owner_names)}"
        )
    if token and ticket_ids and write_cache:
        save_linear_ticket_cache(
            settings,
            tickets.values(),
            ignored_ticket_ids=filtered_ticket_ids,
            owner_names=owner_names,
        )
    return sort_linear_tickets(tickets.values())


def fetch_linear_ticket_detail(
    settings: Settings,
    ticket_id: str,
) -> LinearTicketSummary:
    normalized = normalize_ticket_id(ticket_id)
    diagnostics: list[str] = []
    token = os.environ.get("LINEAR_API_KEY")
    owner_names = linear_owner_names(token, diagnostics)
    if not owner_names:
        raise FileNotFoundError(f"Linear issue {normalized} owner is unavailable")

    cached = cached_linear_tickets(settings)
    ticket = cached.get(normalized)
    if (
        ticket
        and ticket.get("detailLevel") == "full"
        and linear_ticket_matches_owner(ticket, owner_names)
    ):
        return ticket
    if not token:
        if ticket and linear_ticket_matches_owner(ticket, owner_names):
            return ticket
        raise FileNotFoundError(f"Linear issue {normalized} is not cached")

    fetched = fetch_linear_issue(token, normalized)
    if fetched and linear_ticket_matches_owner(fetched, owner_names):
        cached[normalized] = fetched
        save_linear_ticket_cache(settings, cached.values(), owner_names=owner_names)
        return fetched

    save_linear_ticket_cache(
        settings,
        cached.values(),
        ignored_ticket_ids=[normalized],
        owner_names=owner_names,
    )
    raise FileNotFoundError(f"Linear issue {normalized} is not assigned to this owner")


def append_linear_error_diagnostics(
    errors: dict[str, str],
    diagnostics: list[str],
) -> None:
    by_message: dict[str, list[str]] = defaultdict(list)
    for ticket_id, message in errors.items():
        by_message[truncate(message, 220)].append(ticket_id)
    for message, ticket_ids in by_message.items():
        preview_ids = ", ".join(sorted(ticket_ids)[:5])
        remaining = len(ticket_ids) - 5
        suffix = f" and {remaining} more" if remaining > 0 else ""
        diagnostics.append(
            f"Linear issues {preview_ids}{suffix} unavailable from API: {message}"
        )


def save_linear_ticket_cache(
    settings: Settings,
    tickets: Iterable[LinearTicketSummary],
    *,
    ignored_ticket_ids: Iterable[str] = (),
    owner_names: Iterable[str] = (),
    full_refresh: bool = True,
) -> None:
    existing_payload = cached_linear_payload(settings)
    existing_tickets = cached_linear_tickets(settings, existing_payload)
    ticket_list = [
        merge_linear_ticket_for_cache(ticket, existing_tickets.get(ticket["ticketId"]))
        for ticket in tickets
        if ticket.get("ticketId")
    ]
    visible_ticket_ids = {
        normalize_ticket_id(str(ticket["ticketId"]))
        for ticket in ticket_list
        if ticket.get("ticketId")
    }
    ignored = {
        normalize_ticket_id(ticket_id)
        for ticket_id in (
            set(cached_linear_ignored_ticket_ids(settings, existing_payload))
            | set(ignored_ticket_ids)
        )
    }.difference(visible_ticket_ids)
    saved_at = utc_now_iso()
    full_saved_at = (
        saved_at
        if full_refresh
        else (
            existing_payload.get("fullSavedAt")
            or existing_payload.get("savedAt")
            or saved_at
        )
    )
    save_json(
        settings.cache_dir / "linear-cache.json",
        {
            "version": LINEAR_CACHE_VERSION,
            "savedAt": saved_at,
            "fullSavedAt": full_saved_at,
            "ownerNames": sorted(owner_names),
            "tickets": sort_linear_tickets(ticket_list),
            "ignoredTicketIds": sorted(ignored),
        },
    )


def merge_linear_ticket_for_cache(
    ticket: LinearTicketSummary,
    existing: LinearTicketSummary | None,
) -> LinearTicketSummary:
    if (
        existing
        and existing.get("detailLevel") == "full"
        and ticket.get("detailLevel") != "full"
        and existing.get("ticketId") == ticket.get("ticketId")
        and existing.get("updatedAt") == ticket.get("updatedAt")
    ):
        return {
            **existing,
            "assignee": ticket.get("assignee") or existing.get("assignee"),
            "assigneeId": ticket.get("assigneeId") or existing.get("assigneeId"),
            "assigneeEmail": ticket.get("assigneeEmail")
            or existing.get("assigneeEmail"),
            "assigneeName": ticket.get("assigneeName") or existing.get("assigneeName"),
        }
    return ticket


def sort_linear_tickets(
    tickets: Iterable[LinearTicketSummary],
) -> list[LinearTicketSummary]:
    return sorted(tickets, key=lambda item: item.get("updatedAt") or "", reverse=True)


def cached_linear_payload(settings: Settings) -> dict[str, Any]:
    payload = load_json(settings.cache_dir / "linear-cache.json")
    return payload if isinstance(payload, dict) else {}


def cached_linear_tickets(
    settings: Settings,
    payload: dict[str, Any] | None = None,
) -> dict[str, LinearTicketSummary]:
    payload = payload if payload is not None else cached_linear_payload(settings)
    values = payload.get("tickets") if isinstance(payload, dict) else None
    if not isinstance(values, list):
        return {}
    tickets = {}
    for item in values:
        if isinstance(item, dict) and item.get("ticketId"):
            tickets[str(item["ticketId"]).upper()] = item
    return tickets


def cached_linear_ignored_ticket_ids(
    settings: Settings,
    payload: dict[str, Any] | None = None,
) -> set[str]:
    payload = payload if payload is not None else cached_linear_payload(settings)
    values = payload.get("ignoredTicketIds") if isinstance(payload, dict) else None
    if not isinstance(values, list):
        return set()
    return {normalize_ticket_id(str(value)) for value in values if value}


def linear_cache_is_fresh(
    settings: Settings,
    owner_names: set[str],
    payload: dict[str, Any] | None = None,
) -> bool:
    ttl_seconds = int(os.environ.get("TICKETBOARD_LINEAR_TTL", "300"))
    if ttl_seconds <= 0:
        return False
    payload = payload if payload is not None else cached_linear_payload(settings)
    if not payload:
        return False
    if payload.get("version") != LINEAR_CACHE_VERSION:
        return False
    cached_owner_names = {
        normalize_owner_name(value)
        for value in payload.get("ownerNames", [])
        if normalize_owner_name(value)
    }
    if cached_owner_names != owner_names:
        return False
    saved_at = payload.get("savedAt")
    if not isinstance(saved_at, str):
        return False
    try:
        saved = datetime.fromisoformat(saved_at.replace("Z", "+00:00"))
    except ValueError:
        return False
    age_seconds = (datetime.now(UTC) - saved).total_seconds()
    return age_seconds < ttl_seconds


def linear_full_refresh_due(
    settings: Settings,
    owner_names: set[str],
    payload: dict[str, Any] | None = None,
) -> bool:
    ttl_seconds = int(os.environ.get("TICKETBOARD_LINEAR_FULL_REFRESH_TTL", "900"))
    if ttl_seconds <= 0:
        return True
    payload = payload if payload is not None else cached_linear_payload(settings)
    if not payload:
        return True
    if payload.get("version") != LINEAR_CACHE_VERSION:
        return True
    cached_owner_names = {
        normalize_owner_name(value)
        for value in payload.get("ownerNames", [])
        if normalize_owner_name(value)
    }
    if cached_owner_names != owner_names:
        return True
    age_seconds = cache_age_seconds(payload, "fullSavedAt")
    if age_seconds is None:
        age_seconds = cache_age_seconds(payload, "savedAt")
    return age_seconds is None or age_seconds >= ttl_seconds


def normalize_owner_name(value: Any) -> str:
    return str(value or "").strip().lower()


def format_owner_names(owner_names: set[str]) -> str:
    return ", ".join(sorted(owner_names)) or "configured owner"


def linear_owner_names(token: str | None, diagnostics: list[str]) -> set[str]:
    global _LINEAR_OWNER_CACHE
    configured = {
        normalize_owner_name(value)
        for value in os.environ.get("TICKETBOARD_LINEAR_ASSIGNEE", "").split(",")
        if normalize_owner_name(value)
    }
    if configured and all(linear_owner_value_is_stable(value) for value in configured):
        return configured
    if not token:
        return configured
    if _LINEAR_OWNER_CACHE and _LINEAR_OWNER_CACHE[0] == token:
        viewer_owners = set(_LINEAR_OWNER_CACHE[1])
        viewer_aliases = set(_LINEAR_OWNER_CACHE[2])
    else:
        try:
            viewer = fetch_linear_viewer(token)
        except Exception as exc:
            diagnostics.append(
                "Linear viewer unavailable; Linear tickets are not owner-filtered: "
                f"{exc}"
            )
            return configured
        viewer_owners = linear_actor_stable_identities(viewer)
        viewer_aliases = linear_actor_identity_tokens(viewer)
        _LINEAR_OWNER_CACHE = (token, viewer_owners, viewer_aliases)
    if configured:
        if configured.intersection(viewer_aliases):
            return viewer_owners
        return configured
    return viewer_owners


def linear_actor_stable_identities(value: Any) -> set[str]:
    if not isinstance(value, dict):
        return set()
    return {
        normalized
        for key in ("id", "email", "name")
        if (normalized := normalize_owner_name(value.get(key)))
        and (key != "name" or "@" in normalized)
    }


def linear_owner_value_is_stable(value: str) -> bool:
    return "@" in value or looks_like_uuid(value)


def linear_actor_identity_tokens(value: Any) -> set[str]:
    if not isinstance(value, dict):
        return set()
    try:
        return {
            normalized
            for key in ("id", "email", "name", "displayName")
            if (normalized := normalize_owner_name(value.get(key)))
        }
    except Exception:
        return set()


def linear_ticket_matches_owner(
    ticket: LinearTicketSummary,
    owner_names: set[str],
) -> bool:
    if not owner_names:
        return False
    return not owner_names.isdisjoint(linear_ticket_owner_tokens(ticket))


def linear_ticket_owner_tokens(ticket: dict[str, Any]) -> set[str]:
    return {
        normalized
        for key in ("assigneeId", "assigneeEmail", "assigneeName", "assignee")
        if (normalized := normalize_owner_name(ticket.get(key)))
    }


LINEAR_VIEWER_QUERY = """
query TicketboardViewer {
  viewer {
    id
    name
    displayName
    email
  }
}
"""


def fetch_linear_viewer(token: str) -> dict[str, Any]:
    response = linear_graphql_client().post(
        "https://api.linear.app/graphql",
        headers={"Authorization": token, "Content-Type": "application/json"},
        json={"query": LINEAR_VIEWER_QUERY},
    )
    response.raise_for_status()
    payload = response.json()
    if payload.get("errors"):
        raise RuntimeError(payload["errors"][0].get("message", "Linear GraphQL error"))
    viewer = (payload.get("data") or {}).get("viewer")
    return viewer if isinstance(viewer, dict) else {}


LINEAR_ISSUE_SUMMARY_FIELDS = """
    identifier
    title
    createdAt
    updatedAt
    completedAt
    dueDate
    branchName
    priority
    state { name type }
    assignee { id name displayName email }
    team { name }
    project { name }
    cycle { name }
    labels(first: 50) { nodes { name } }
    parent { identifier title url state { name type } }
    children(first: 50) { nodes { identifier title url state { name type } } }
    relations(first: 50) {
      nodes {
        type
        relatedIssue { identifier title url state { name type } }
      }
    }
"""


LINEAR_ISSUE_VERSION_FIELDS = """
    identifier
    updatedAt
    assignee { id name displayName email }
"""


LINEAR_ISSUE_DETAIL_FIELDS = """
    identifier
    title
    description
    url
    createdAt
    updatedAt
    startedAt
    completedAt
    dueDate
    branchName
    priority
    state { name type }
    creator { id name displayName email }
    assignee { id name displayName email }
    team { name }
    project { name url }
    cycle { name }
    labels(first: 50) { nodes { name color } }
    parent { identifier title url state { name type } }
    children(first: 50) { nodes { identifier title url state { name type } } }
    relations(first: 50) {
      nodes {
        type
        relatedIssue { identifier title url state { name type } }
      }
    }
    comments(first: 50) { nodes { id body createdAt url user { id name displayName email } } }
    attachments(first: 50) { nodes { id title subtitle url createdAt } }
"""


LINEAR_ISSUE_QUERY = (
    "query TicketboardIssue($id: String!) {\n"
    "  issue(id: $id) {\n"
    f"{LINEAR_ISSUE_DETAIL_FIELDS}\n"
    "  }\n"
    "}\n"
)


def fetch_linear_issue(token: str, ticket_id: str) -> LinearTicketSummary | None:
    response = linear_graphql_client().post(
        "https://api.linear.app/graphql",
        headers={"Authorization": token, "Content-Type": "application/json"},
        json={"query": LINEAR_ISSUE_QUERY, "variables": {"id": ticket_id}},
    )
    response.raise_for_status()
    payload = response.json()
    if payload.get("errors"):
        raise RuntimeError(payload["errors"][0].get("message", "Linear GraphQL error"))
    issue = (payload.get("data") or {}).get("issue")
    if not issue:
        return None
    return normalize_linear_issue(issue, detail_level="full")


def fetch_linear_issues(
    token: str,
    ticket_ids: list[str],
    *,
    owner_names: set[str] | None = None,
) -> tuple[dict[str, LinearTicketSummary], dict[str, str]]:
    tickets: dict[str, LinearTicketSummary] = {}
    errors: dict[str, str] = {}
    if not ticket_ids:
        return tickets, errors
    if owner_names:
        return fetch_linear_issues_by_filter(
            token,
            ticket_ids,
            owner_names,
            LINEAR_ISSUE_SUMMARY_FIELDS,
            "TicketboardIssuesByFilter",
            detail_level="summary",
        )
    chunks = [
        ticket_ids[chunk_start : chunk_start + LINEAR_ISSUE_BATCH_SIZE]
        for chunk_start in range(0, len(ticket_ids), LINEAR_ISSUE_BATCH_SIZE)
    ]
    client = linear_graphql_client()
    with ThreadPoolExecutor(
        max_workers=min(LINEAR_ISSUE_BATCH_WORKERS, len(chunks))
    ) as executor:
        futures = {
            executor.submit(fetch_linear_issue_chunk, token, chunk, client): chunk
            for chunk in chunks
        }
        for future in as_completed(futures):
            chunk = futures[future]
            try:
                chunk_tickets, chunk_errors = future.result()
            except Exception as exc:
                chunk_tickets = {}
                chunk_errors = {ticket_id: str(exc) for ticket_id in chunk}
            tickets.update(chunk_tickets)
            errors.update(chunk_errors)
    return tickets, errors


def fetch_linear_issue_versions(
    token: str,
    ticket_ids: list[str],
    *,
    owner_names: set[str] | None = None,
) -> tuple[dict[str, dict[str, str | None]], dict[str, str]]:
    versions: dict[str, dict[str, str | None]] = {}
    errors: dict[str, str] = {}
    if not ticket_ids:
        return versions, errors
    if owner_names:
        return fetch_linear_issue_versions_by_filter(token, ticket_ids, owner_names)
    chunks = [
        ticket_ids[chunk_start : chunk_start + LINEAR_VERSION_BATCH_SIZE]
        for chunk_start in range(0, len(ticket_ids), LINEAR_VERSION_BATCH_SIZE)
    ]
    client = linear_graphql_client()
    with ThreadPoolExecutor(
        max_workers=min(LINEAR_VERSION_BATCH_WORKERS, len(chunks))
    ) as executor:
        futures = {
            executor.submit(fetch_linear_issue_version_chunk, token, chunk, client): chunk
            for chunk in chunks
        }
        for future in as_completed(futures):
            chunk = futures[future]
            try:
                chunk_versions, chunk_errors = future.result()
            except Exception as exc:
                chunk_versions = {}
                chunk_errors = {ticket_id: str(exc) for ticket_id in chunk}
            versions.update(chunk_versions)
            errors.update(chunk_errors)
    return versions, errors


def fetch_linear_issue_versions_by_filter(
    token: str,
    ticket_ids: list[str],
    owner_names: set[str],
) -> tuple[dict[str, dict[str, str | None]], dict[str, str]]:
    issues, errors = fetch_linear_issues_by_filter(
        token,
        ticket_ids,
        owner_names,
        LINEAR_ISSUE_VERSION_FIELDS,
        "TicketboardIssueVersionsByFilter",
        detail_level="summary",
    )
    versions = {
        ticket_id: {
            "ticketId": ticket.get("ticketId"),
            "updatedAt": ticket.get("updatedAt"),
            "assignee": ticket.get("assignee"),
            "assigneeId": ticket.get("assigneeId"),
            "assigneeEmail": ticket.get("assigneeEmail"),
            "assigneeName": ticket.get("assigneeName"),
        }
        for ticket_id, ticket in issues.items()
    }
    return versions, errors


def fetch_linear_issues_by_filter(
    token: str,
    ticket_ids: list[str],
    owner_names: set[str],
    fields: str,
    operation_name: str,
    *,
    detail_level: str,
) -> tuple[dict[str, LinearTicketSummary], dict[str, str]]:
    tickets: dict[str, LinearTicketSummary] = {}
    errors: dict[str, str] = {}
    chunks = list(linear_ticket_filter_chunks(ticket_ids))
    if not chunks:
        return tickets, errors
    query = linear_issues_filter_query(fields, operation_name)
    client = linear_graphql_client()
    max_workers = min(LINEAR_VERSION_BATCH_WORKERS, len(chunks))
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {
            executor.submit(
                fetch_linear_issue_filter_chunk,
                client,
                token,
                query,
                prefix,
                numbers,
                owner_names,
                detail_level,
            ): target_ids
            for prefix, numbers, target_ids in chunks
        }
        for future in as_completed(futures):
            target_ids = futures[future]
            try:
                chunk_tickets, chunk_errors = future.result()
            except Exception as exc:
                chunk_tickets = {}
                chunk_errors = {ticket_id: str(exc) for ticket_id in target_ids}
            tickets.update(chunk_tickets)
            errors.update(chunk_errors)
    return tickets, errors


def fetch_linear_issue_filter_chunk(
    client: httpx.Client,
    token: str,
    query: str,
    prefix: str,
    numbers: list[int],
    owner_names: set[str],
    detail_level: str,
) -> tuple[dict[str, LinearTicketSummary], dict[str, str]]:
    target_ids = {f"{prefix}-{number}" for number in numbers}
    response = post_linear_graphql(
        client,
        token,
        query,
        {
            "filter": linear_issue_filter(prefix, numbers, owner_names),
            "first": len(numbers),
        },
    )
    if response.status_code >= 400:
        message = truncate(response.text, 500) or response.reason_phrase
        return {}, {ticket_id: message for ticket_id in target_ids}
    payload = response.json()
    errors = linear_filter_errors(payload, target_ids)
    data = payload.get("data") if isinstance(payload, dict) else None
    connection = data.get("issues") if isinstance(data, dict) else None
    nodes = connection.get("nodes") if isinstance(connection, dict) else None
    tickets: dict[str, LinearTicketSummary] = {}
    if isinstance(nodes, list):
        for issue in nodes:
            if not isinstance(issue, dict):
                continue
            ticket_id = normalize_ticket_id(str(issue.get("identifier") or ""))
            if ticket_id in target_ids:
                tickets[ticket_id] = normalize_linear_issue(
                    issue,
                    detail_level=detail_level,
                )
    return tickets, errors


def linear_filter_errors(
    payload: Any,
    ticket_ids: set[str],
) -> dict[str, str]:
    errors: dict[str, str] = {}
    if not isinstance(payload, dict):
        return errors
    for error in payload.get("errors") or []:
        if isinstance(error, dict):
            message = str(error.get("message") or "Linear GraphQL error")
            for ticket_id in ticket_ids:
                errors[ticket_id] = message
    return errors


def linear_ticket_filter_chunks(
    ticket_ids: Iterable[str],
) -> Iterable[tuple[str, list[int], set[str]]]:
    numbers_by_prefix: dict[str, set[int]] = defaultdict(set)
    for ticket_id in ticket_ids:
        normalized = normalize_ticket_id(ticket_id)
        prefix, separator, raw_number = normalized.partition("-")
        if not separator or not raw_number.isdigit():
            continue
        numbers_by_prefix[prefix].add(int(raw_number))
    for prefix in sorted(numbers_by_prefix):
        numbers = sorted(numbers_by_prefix[prefix])
        for index in range(0, len(numbers), LINEAR_FILTER_BATCH_SIZE):
            chunk = numbers[index : index + LINEAR_FILTER_BATCH_SIZE]
            yield prefix, chunk, {f"{prefix}-{number}" for number in chunk}


def linear_issue_filter(
    prefix: str,
    numbers: list[int],
    owner_names: set[str],
) -> dict[str, Any]:
    return {
        "and": [
            {"number": {"in": numbers}},
            {"team": {"key": {"eq": prefix}}},
            {"assignee": linear_assignee_filter(owner_names)},
        ]
    }


def linear_assignee_filter(owner_names: set[str]) -> dict[str, Any]:
    filters = []
    for owner_name in sorted(owner_names):
        if looks_like_uuid(owner_name):
            filters.append({"id": {"eq": owner_name}})
        elif "@" in owner_name:
            filters.extend(
                {field: {"eqIgnoreCase": owner_name}} for field in ("email", "name")
            )
        else:
            filters.extend(
                {field: {"eqIgnoreCase": owner_name}}
                for field in ("name", "displayName", "email")
            )
    if len(filters) == 1:
        return filters[0]
    return {"or": filters}


def looks_like_uuid(value: str) -> bool:
    return bool(
        re.fullmatch(
            r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
            value,
        )
    )


def linear_issues_filter_query(fields: str, operation_name: str) -> str:
    return (
        f"query {operation_name}($filter: IssueFilter!, $first: Int!) {{\n"
        "  issues(filter: $filter, first: $first, includeArchived: true) {\n"
        "    nodes {\n"
        f"{fields}\n"
        "    }\n"
        "  }\n"
        "}\n"
    )


def fetch_linear_issue_version_chunk(
    token: str,
    ticket_ids: list[str],
    client: httpx.Client | None = None,
) -> tuple[dict[str, dict[str, str | None]], dict[str, str]]:
    versions: dict[str, dict[str, str | None]] = {}
    errors: dict[str, str] = {}
    query, variables, aliases = linear_issues_batch_query(
        ticket_ids,
        LINEAR_ISSUE_VERSION_FIELDS,
        "TicketboardIssueVersions",
    )
    if client is None:
        with httpx.Client(timeout=30) as chunk_client:
            response = post_linear_graphql(chunk_client, token, query, variables)
    else:
        response = post_linear_graphql(client, token, query, variables)
    if response.status_code >= 400:
        message = truncate(response.text, 500) or response.reason_phrase
        for ticket_id in ticket_ids:
            errors[ticket_id] = message
        return versions, errors
    payload = response.json()
    data = payload.get("data") if isinstance(payload, dict) else None
    if isinstance(data, dict):
        for alias, ticket_id in aliases.items():
            issue = data.get(alias)
            if isinstance(issue, dict):
                versions[ticket_id] = {
                    "ticketId": str(issue.get("identifier") or "").upper(),
                    "updatedAt": issue.get("updatedAt"),
                    "assignee": linear_actor_display(issue.get("assignee")),
                    "assigneeId": linear_actor_id(issue.get("assignee")),
                    "assigneeEmail": linear_actor_email(issue.get("assignee")),
                    "assigneeName": linear_actor_name(issue.get("assignee")),
                }
    for error in payload.get("errors") or []:
        if not isinstance(error, dict):
            continue
        path = error.get("path") or []
        alias = str(path[0]) if path else ""
        ticket_id = aliases.get(alias)
        if ticket_id:
            errors[ticket_id] = str(error.get("message") or "Linear GraphQL error")
    return versions, errors


def linear_versions_match_cache(
    versions: dict[str, dict[str, str | None]],
    cached: dict[str, LinearTicketSummary],
    ignored_ticket_ids: set[str],
    ticket_ids: set[str],
    owner_names: set[str],
) -> bool:
    if set(versions).difference(ticket_ids):
        return False
    missing_ticket_ids = ticket_ids.difference(versions)
    if missing_ticket_ids.difference(ignored_ticket_ids):
        return False
    for ticket_id, version in versions.items():
        version_matches_owner = not owner_names.isdisjoint(
            linear_ticket_owner_tokens(version)
        )
        if ticket_id in ignored_ticket_ids:
            if version_matches_owner:
                return False
            continue
        cached_ticket = cached.get(ticket_id)
        if not cached_ticket or not version_matches_owner:
            return False
        if cached_ticket.get("updatedAt") != version.get("updatedAt"):
            return False
        if not linear_ticket_matches_owner(cached_ticket, owner_names):
            return False
    return True


def fetch_linear_issue_chunk(
    token: str,
    ticket_ids: list[str],
    client: httpx.Client | None = None,
) -> tuple[dict[str, LinearTicketSummary], dict[str, str]]:
    tickets: dict[str, LinearTicketSummary] = {}
    errors: dict[str, str] = {}
    query, variables, aliases = linear_issues_batch_query(ticket_ids)
    if client is None:
        with httpx.Client(timeout=30) as chunk_client:
            response = post_linear_graphql(chunk_client, token, query, variables)
    else:
        response = post_linear_graphql(client, token, query, variables)
    if response.status_code >= 400:
        message = truncate(response.text, 500) or response.reason_phrase
        for ticket_id in ticket_ids:
            errors[ticket_id] = message
        return tickets, errors
    payload = response.json()
    data = payload.get("data") if isinstance(payload, dict) else None
    if isinstance(data, dict):
        for alias, ticket_id in aliases.items():
            issue = data.get(alias)
            if isinstance(issue, dict):
                tickets[ticket_id] = normalize_linear_issue(issue, detail_level="summary")
    for error in payload.get("errors") or []:
        if not isinstance(error, dict):
            continue
        path = error.get("path") or []
        alias = str(path[0]) if path else ""
        ticket_id = aliases.get(alias)
        if ticket_id:
            errors[ticket_id] = str(error.get("message") or "Linear GraphQL error")
    return tickets, errors


def post_linear_graphql(
    client: httpx.Client,
    token: str,
    query: str,
    variables: dict[str, Any],
) -> httpx.Response:
    for attempt in range(2):
        response = client.post(
            "https://api.linear.app/graphql",
            headers={"Authorization": token, "Content-Type": "application/json"},
            json={"query": query, "variables": variables},
        )
        if (
            attempt == 0
            and response.status_code in LINEAR_RETRY_STATUS_CODES
        ):
            time.sleep(LINEAR_RETRY_DELAY_SECONDS)
            continue
        return response
    return response


def linear_issues_batch_query(
    ticket_ids: list[str],
    fields: str = LINEAR_ISSUE_SUMMARY_FIELDS,
    operation_name: str = "TicketboardIssues",
) -> tuple[str, dict[str, str], dict[str, str]]:
    variables = {f"id{index}": ticket_id for index, ticket_id in enumerate(ticket_ids)}
    aliases = {
        f"issue{index}": ticket_id
        for index, ticket_id in enumerate(ticket_ids)
    }
    variable_defs = ", ".join(f"$id{index}: String!" for index in range(len(ticket_ids)))
    selections = "\n".join(
        f"  issue{index}: issue(id: $id{index}) {{\n{fields}\n  }}"
        for index in range(len(ticket_ids))
    )
    return (
        f"query {operation_name}({variable_defs}) {{\n{selections}\n}}",
        variables,
        aliases,
    )


def normalize_linear_issue(
    issue: dict[str, Any],
    *,
    detail_level: str,
) -> LinearTicketSummary:
    state = issue.get("state") or {}
    project = issue.get("project") or {}
    creator = issue.get("creator")
    assignee = issue.get("assignee")
    return {
        "detailLevel": detail_level,
        "ticketId": str(issue.get("identifier") or "").upper(),
        "title": str(issue.get("title") or ""),
        "description": issue.get("description") or "",
        "url": issue.get("url") or "",
        "stateName": state.get("name") or "",
        "stateType": state.get("type") or "",
        "createdAt": issue.get("createdAt") or "",
        "startedAt": issue.get("startedAt"),
        "completedAt": issue.get("completedAt"),
        "dueDate": issue.get("dueDate"),
        "branchName": issue.get("branchName"),
        "creator": normalize_linear_actor(creator) if creator else None,
        "priority": issue.get("priority"),
        "assignee": linear_actor_display(assignee),
        "assigneeId": linear_actor_id(assignee),
        "assigneeEmail": linear_actor_email(assignee),
        "assigneeName": linear_actor_name(assignee),
        "teamName": (issue.get("team") or {}).get("name"),
        "projectName": project.get("name"),
        "projectUrl": project.get("url"),
        "cycleName": (issue.get("cycle") or {}).get("name"),
        "labels": [
            {"name": node.get("name") or "", "color": node.get("color")}
            for node in nodes(issue, "labels")
        ],
        "parent": normalize_linear_link(issue.get("parent")),
        "children": [normalize_linear_link(node) for node in nodes(issue, "children")],
        "relatedIssues": [
            {
                "relationType": node.get("type") or "related",
                "issue": normalize_linear_link(node.get("relatedIssue")),
            }
            for node in nodes(issue, "relations")
            if node.get("relatedIssue")
        ],
        "updatedAt": issue.get("updatedAt") or "",
        "comments": [
            {
                "id": node.get("id") or "",
                "author": linear_actor_display(node.get("user")) or "unknown",
                "body": node.get("body") or "",
                "createdAt": node.get("createdAt") or "",
                "url": node.get("url"),
            }
            for node in nodes(issue, "comments")
        ],
        "attachments": [
            {
                "id": node.get("id") or "",
                "title": node.get("title") or "",
                "subtitle": node.get("subtitle"),
                "url": node.get("url") or "",
                "createdAt": node.get("createdAt") or "",
            }
            for node in nodes(issue, "attachments")
        ],
        "activity": [],
    }


def nodes(parent: dict[str, Any], key: str) -> list[dict[str, Any]]:
    value = parent.get(key)
    if isinstance(value, dict) and isinstance(value.get("nodes"), list):
        return [item for item in value["nodes"] if isinstance(item, dict)]
    return []


def normalize_linear_actor(value: Any) -> dict[str, str | None]:
    if not isinstance(value, dict):
        return {"id": None, "name": "", "displayName": None, "email": None}
    return {
        "id": value.get("id"),
        "name": value.get("name") or "",
        "displayName": value.get("displayName"),
        "email": value.get("email"),
    }


def linear_actor_display(value: Any) -> str | None:
    if not isinstance(value, dict):
        return None
    return value.get("displayName") or value.get("name")


def linear_actor_id(value: Any) -> str | None:
    if not isinstance(value, dict):
        return None
    return value.get("id")


def linear_actor_email(value: Any) -> str | None:
    if not isinstance(value, dict):
        return None
    return value.get("email")


def linear_actor_name(value: Any) -> str | None:
    if not isinstance(value, dict):
        return None
    return value.get("name")


def normalize_linear_link(value: Any) -> dict[str, str] | None:
    if not isinstance(value, dict):
        return None
    state = value.get("state") or {}
    return {
        "ticketId": str(value.get("identifier") or "").upper(),
        "title": value.get("title") or "",
        "url": value.get("url") or "",
        "stateName": state.get("name") or "",
        "stateType": state.get("type") or "",
    }


def collect_worktrees(
    settings: Settings,
    diagnostics: list[str],
    *,
    status_ticket_ids: set[str] | None = None,
) -> list[WorktreeSummary]:
    cached_memory = cached_worktree_memory_summaries(settings, status_ticket_ids)
    if cached_memory is not None:
        return cached_memory
    try:
        output = run_command(
            ["git", "-C", str(settings.repo_path), "worktree", "list", "--porcelain"],
            timeout=15,
        )
    except Exception as exc:
        diagnostics.append(f"Git worktree collection unavailable: {exc}")
        return []
    entries = parse_worktree_porcelain(output)
    cached = cached_worktree_summaries(settings, entries, status_ticket_ids)
    if cached is not None:
        save_worktree_memory_cache(settings, status_ticket_ids, cached)
        return cached
    summaries: list[WorktreeSummary | None] = [None] * len(entries)
    status_entries: list[tuple[int, dict[str, str]]] = []
    for index, entry in enumerate(entries):
        if should_scan_worktree_status(entry, status_ticket_ids):
            status_entries.append((index, entry))
        else:
            summaries[index] = worktree_summary_from_entry(
                entry,
                diagnostics,
                scan_status=False,
            )
    if status_entries:
        max_workers = min(
            int(os.environ.get("TICKETBOARD_WORKTREE_WORKERS", "64")),
            len(status_entries),
        )
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {
                executor.submit(
                    worktree_summary_from_entry,
                    entry,
                    diagnostics,
                    True,
                ): index
                for index, entry in status_entries
            }
            for future in as_completed(futures):
                summaries[futures[future]] = future.result()
    collected = [summary for summary in summaries if summary is not None]
    save_worktree_cache(settings, entries, collected, status_ticket_ids)
    save_worktree_memory_cache(settings, status_ticket_ids, collected)
    return collected


def cached_worktree_memory_summaries(
    settings: Settings,
    status_ticket_ids: set[str] | None = None,
) -> list[WorktreeSummary] | None:
    cached = _WORKTREE_SUMMARY_CACHE
    if not cached:
        return None
    ttl_seconds = int(os.environ.get("TICKETBOARD_WORKTREE_LIST_TTL", "5"))
    if ttl_seconds <= 0 or time.monotonic() - cached[0] >= ttl_seconds:
        return None
    if cached[1] != worktree_memory_cache_key(settings, status_ticket_ids):
        return None
    return [dict(item) for item in cached[2]]


def save_worktree_memory_cache(
    settings: Settings,
    status_ticket_ids: set[str] | None,
    worktrees: list[WorktreeSummary],
) -> None:
    global _WORKTREE_SUMMARY_CACHE
    if int(os.environ.get("TICKETBOARD_WORKTREE_LIST_TTL", "5")) <= 0:
        _WORKTREE_SUMMARY_CACHE = None
        return
    _WORKTREE_SUMMARY_CACHE = (
        time.monotonic(),
        worktree_memory_cache_key(settings, status_ticket_ids),
        [dict(item) for item in worktrees],
    )


def worktree_memory_cache_key(
    settings: Settings,
    status_ticket_ids: set[str] | None = None,
) -> str:
    return stable_etag(
        {
            "repoPath": str(settings.repo_path),
            "ticketPrefixes": sorted(allowed_ticket_prefixes()),
            "statusTicketIds": sorted(status_ticket_ids or []),
        }
    )


def cached_worktree_summaries(
    settings: Settings,
    entries: list[dict[str, str]],
    status_ticket_ids: set[str] | None = None,
) -> list[WorktreeSummary] | None:
    ttl_seconds = int(os.environ.get("TICKETBOARD_WORKTREE_TTL", "300"))
    if ttl_seconds <= 0:
        return None
    payload = load_json(settings.cache_dir / "worktree-cache.json")
    if not isinstance(payload, dict):
        return None
    if payload.get("cacheKey") != worktree_cache_key(entries, status_ticket_ids):
        return None
    saved_at = payload.get("savedAt")
    if not isinstance(saved_at, str):
        return None
    try:
        saved = datetime.fromisoformat(saved_at.replace("Z", "+00:00"))
    except ValueError:
        return None
    if (datetime.now(UTC) - saved).total_seconds() >= ttl_seconds:
        return None
    worktrees = payload.get("worktrees")
    if not isinstance(worktrees, list):
        return None
    return [item for item in worktrees if isinstance(item, dict)]


def save_worktree_cache(
    settings: Settings,
    entries: list[dict[str, str]],
    worktrees: list[WorktreeSummary],
    status_ticket_ids: set[str] | None = None,
) -> None:
    save_json(
        settings.cache_dir / "worktree-cache.json",
        {
            "version": 1,
            "savedAt": utc_now_iso(),
            "cacheKey": worktree_cache_key(entries, status_ticket_ids),
            "worktrees": worktrees,
        },
    )


def worktree_cache_key(
    entries: list[dict[str, str]],
    status_ticket_ids: set[str] | None = None,
) -> str:
    return stable_etag(
        {
            "ticketPrefixes": sorted(allowed_ticket_prefixes()),
            "statusTicketIds": sorted(status_ticket_ids or []),
            "entries": [
                {
                    "worktree": entry.get("worktree"),
                    "branch": entry.get("branch"),
                    "HEAD": entry.get("HEAD"),
                    "prunable": "prunable" in entry,
                }
                for entry in entries
            ],
        }
    )


def should_scan_worktree_status(
    entry: dict[str, str],
    status_ticket_ids: set[str] | None,
) -> bool:
    if status_ticket_ids is None:
        return True
    return bool(worktree_entry_ticket_ids(entry).intersection(status_ticket_ids))


def worktree_entry_ticket_ids(entry: dict[str, str]) -> set[str]:
    return set(extract_ticket_ids(entry.get("worktree"), entry.get("branch")))


def worktree_summary_from_entry(
    entry: dict[str, str],
    diagnostics: list[str],
    scan_status: bool = True,
) -> WorktreeSummary:
    path = Path(entry["worktree"])
    prunable = "prunable" in entry
    exists = path.exists() and not prunable
    branch = entry.get("branch")
    status_lines: list[str] = []
    dirty_count: int | None = None
    if exists and scan_status:
        try:
            status_lines = run_command(
                ["git", "-C", str(path), "status", "--short"],
                timeout=8,
            ).splitlines()
            dirty_count = len(status_lines)
        except Exception as exc:
            diagnostics.append(f"Git status unavailable for {path}: {exc}")
    return {
        "path": str(path),
        "branch": branch,
        "head": entry.get("HEAD"),
        "prunable": prunable,
        "exists": exists,
        "dirtyCount": dirty_count,
        "statusLines": status_lines[:20],
        "ticketIds": extract_ticket_ids(str(path), branch, *status_lines),
    }


def parse_worktree_porcelain(output: str) -> list[dict[str, str]]:
    entries: list[dict[str, str]] = []
    current: dict[str, str] = {}
    for line in output.splitlines():
        if not line:
            if current:
                entries.append(current)
                current = {}
            continue
        key, _, value = line.partition(" ")
        if key == "worktree" and current:
            entries.append(current)
            current = {}
        current[key] = value
    if current:
        entries.append(current)
    for entry in entries:
        if entry.get("branch", "").startswith("refs/heads/"):
            entry["branch"] = entry["branch"].removeprefix("refs/heads/")
    return entries


def fetch_worktree_detail(path: str) -> WorktreeDetailSummary:
    worktree = Path(path).expanduser()
    if not worktree.exists():
        raise FileNotFoundError(path)
    cache_key = str(worktree)
    cached = cached_worktree_detail(cache_key)
    if cached:
        return cached
    git_results = {
        "status": try_git(worktree, ["status", "--porcelain=v2", "--branch"])
    }
    branch, head, status_lines = parse_worktree_status_v2(git_results["status"])
    has_staged, has_unstaged = worktree_change_kinds(status_lines)

    diff_commands = {}
    if has_staged:
        diff_commands["staged"] = ["diff", "--cached", "--stat", "--patch", "--", "."]
    if has_unstaged:
        diff_commands["unstaged"] = ["diff", "--stat", "--patch", "--", "."]
    if diff_commands:
        with ThreadPoolExecutor(max_workers=len(diff_commands)) as executor:
            futures = {
                name: executor.submit(try_git, worktree, args)
                for name, args in diff_commands.items()
            }
            for name, future in futures.items():
                stat, patch = split_git_stat_patch(future.result())
                git_results[f"{name}_stat"] = stat
                git_results[f"{name}_diff"] = patch
    summary: WorktreeSummary = {
        "path": str(worktree),
        "branch": branch,
        "head": head,
        "prunable": False,
        "exists": True,
        "dirtyCount": None,
        "statusLines": [],
        "ticketIds": [],
    }
    staged_diff = git_results.get("staged_diff", "")
    unstaged_diff = git_results.get("unstaged_diff", "")
    untracked_files = untracked_files_from_status(status_lines)
    summary.update(
        {
            "dirtyCount": len(status_lines),
            "statusLines": status_lines[:100],
            "ticketIds": extract_ticket_ids(str(worktree), summary["branch"], *status_lines),
        }
    )
    staged_diff, staged_truncated = truncate_with_flag(staged_diff, MAX_LOG_CHARS)
    unstaged_diff, unstaged_truncated = truncate_with_flag(unstaged_diff, MAX_LOG_CHARS)
    detail: WorktreeDetailSummary = {
        **summary,
        "stagedStat": git_results.get("staged_stat", ""),
        "unstagedStat": git_results.get("unstaged_stat", ""),
        "stagedDiff": staged_diff,
        "unstagedDiff": unstaged_diff,
        "untrackedFiles": untracked_files[:200],
        "truncated": staged_truncated or unstaged_truncated,
    }
    save_worktree_detail_cache(cache_key, detail)
    return copy_worktree_detail(detail)


def cached_worktree_detail(cache_key: str) -> WorktreeDetailSummary | None:
    cached = _WORKTREE_DETAIL_CACHE.get(cache_key)
    if not cached:
        return None
    ttl_seconds = float(os.environ.get("TICKETBOARD_WORKTREE_DETAIL_TTL", "2"))
    if ttl_seconds <= 0 or time.monotonic() - cached[0] >= ttl_seconds:
        _WORKTREE_DETAIL_CACHE.pop(cache_key, None)
        return None
    return copy_worktree_detail(cached[1])


def save_worktree_detail_cache(
    cache_key: str,
    detail: WorktreeDetailSummary,
) -> None:
    if float(os.environ.get("TICKETBOARD_WORKTREE_DETAIL_TTL", "2")) <= 0:
        _WORKTREE_DETAIL_CACHE.pop(cache_key, None)
        return
    _WORKTREE_DETAIL_CACHE[cache_key] = (time.monotonic(), copy_worktree_detail(detail))
    trim_cache(_WORKTREE_DETAIL_CACHE, MAX_WORKTREE_DETAIL_CACHE)


def copy_worktree_detail(detail: WorktreeDetailSummary) -> WorktreeDetailSummary:
    return {
        **detail,
        "statusLines": list(detail.get("statusLines", [])),
        "ticketIds": list(detail.get("ticketIds", [])),
        "untrackedFiles": list(detail.get("untrackedFiles", [])),
    }


def worktree_change_kinds(status_lines: list[str]) -> tuple[bool, bool]:
    has_staged = False
    has_unstaged = False
    for line in status_lines:
        if not line.startswith("??"):
            has_staged = has_staged or (len(line) > 0 and line[0] != " ")
            has_unstaged = has_unstaged or (len(line) > 1 and line[1] != " ")
    return has_staged, has_unstaged


def parse_worktree_status_v2(status: str) -> tuple[str | None, str | None, list[str]]:
    branch = None
    head = None
    status_lines: list[str] = []
    for line in status.splitlines():
        if line.startswith("# branch.oid "):
            value = line.removeprefix("# branch.oid ").strip()
            head = None if value == "(initial)" else value
        elif line.startswith("# branch.head "):
            value = line.removeprefix("# branch.head ").strip()
            branch = None if value == "(detached)" else value
        elif line.startswith("? "):
            status_lines.append(f"?? {line[2:]}")
        elif line[:1] in {"1", "2", "u"}:
            parts = line.split(" ")
            if len(parts) >= 2:
                path = worktree_status_v2_path(line)
                if path:
                    status_lines.append(f"{worktree_status_v2_xy(parts[1])} {path}")
    return branch, head, status_lines


def split_git_stat_patch(output: str) -> tuple[str, str]:
    marker = "diff --git "
    if output.startswith(marker):
        return "", output
    index = output.find(f"\n{marker}")
    if index < 0:
        return output, ""
    return output[:index].rstrip(), output[index + 1 :]


def worktree_status_v2_path(line: str) -> str:
    if line.startswith("1 "):
        parts = line.split(" ", 8)
        return parts[8] if len(parts) > 8 else ""
    if line.startswith("2 "):
        parts = line.split(" ", 9)
        return parts[9].split("\t", 1)[0] if len(parts) > 9 else ""
    if line.startswith("u "):
        parts = line.split(" ", 10)
        return parts[10] if len(parts) > 10 else ""
    return ""


def worktree_status_v2_xy(value: str) -> str:
    xy = (value + "..")[:2].replace(".", " ")
    return xy


def untracked_files_from_status(status_lines: list[str]) -> list[str]:
    return [line[3:] for line in status_lines if line.startswith("?? ")]


def try_git(cwd: Path, args: list[str]) -> str:
    try:
        return run_command(["git", "-C", str(cwd), *args], timeout=12)
    except Exception:
        return ""


def truncate_with_flag(text: str, limit: int) -> tuple[str, bool]:
    if len(text) <= limit:
        return text, False
    return text[:limit], True


def collect_tmux_windows(diagnostics: list[str]) -> list[TmuxWindowSummary]:
    global _TMUX_WINDOWS_CACHE
    cached = cached_tmux_windows()
    if cached is not None:
        return cached
    try:
        output = run_command(
            [
                "tmux",
                "list-panes",
                "-a",
                "-F",
                "#{session_name}\t#{window_index}\t#{window_name}\t#{pane_id}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_active}\t#{pane_pid}",
            ],
            timeout=8,
        )
    except Exception as exc:
        diagnostics.append(f"tmux panes unavailable: {exc}")
        return []
    panes: list[tuple[str, str, str, str, str, str, str, str, bool, bool]] = []
    for line in output.splitlines():
        parts = line.split("\t")
        if len(parts) != 8:
            continue
        session, index, name, pane_id, path, command, active, pane_pid = parts
        is_codex = is_codex_like(name, command, path)
        should_capture = is_codex or command == "node"
        panes.append(
            (
                session,
                index,
                name,
                pane_id,
                path,
                command,
                active,
                pane_pid,
                is_codex,
                should_capture,
            )
        )
    previews = capture_tmux_panes(
        [pane[3] for pane in panes if pane[9]],
        diagnostics,
    )
    windows = []
    for (
        session,
        index,
        name,
        pane_id,
        path,
        command,
        active,
        pane_pid,
        is_codex,
        _should_capture,
    ) in panes:
        preview = previews.get(pane_id, "")
        ticket_ids = tmux_window_ticket_ids(name, path, preview)
        windows.append(
            {
                "session": session,
                "index": int(index),
                "name": name,
                "paneId": pane_id,
                "path": path,
                "command": command,
                "active": active == "1",
                "panePid": int(pane_pid) if pane_pid.isdigit() else None,
                "ticketIds": ticket_ids,
                "isCodexLike": is_codex,
                "panePreview": "",
                "panePreviewTruncated": False,
            }
        )
    _TMUX_WINDOWS_CACHE = (time.monotonic(), windows)
    return windows


def tmux_window_ticket_ids(name: str, path: str, preview: str) -> list[str]:
    direct_ticket_ids = extract_ticket_ids(name, path)
    if direct_ticket_ids:
        return direct_ticket_ids

    preview_ticket_ids = extract_ticket_ids(preview)
    if len(preview_ticket_ids) == 1:
        return preview_ticket_ids
    return []


def cached_tmux_windows() -> list[TmuxWindowSummary] | None:
    cached = _TMUX_WINDOWS_CACHE
    if not cached:
        return None
    ttl_seconds = int(os.environ.get("TICKETBOARD_TMUX_TTL", "5"))
    if ttl_seconds <= 0 or time.monotonic() - cached[0] >= ttl_seconds:
        return None
    return list(cached[1])


def capture_tmux_panes(pane_ids: list[str], diagnostics: list[str]) -> dict[str, str]:
    if not pane_ids:
        return {}
    try:
        return capture_tmux_panes_batch(pane_ids)
    except Exception as exc:
        diagnostics.append(f"tmux batch pane capture unavailable: {exc}")
        return capture_tmux_panes_individual(pane_ids, diagnostics)


def capture_tmux_panes_batch(pane_ids: list[str]) -> dict[str, str]:
    args = ["tmux"]
    marker = "__TICKETBOARD_CAPTURE_PANE__"
    marker_ids: dict[str, str] = {}
    for pane_id in pane_ids:
        marker_id = pane_id.removeprefix("%")
        marker_ids[marker_id] = pane_id
        if len(args) > 1:
            args.append(";")
        args.extend(["display-message", "-p", "-t", pane_id, f"{marker}\t{marker_id}"])
        args.append(";")
        args.extend(["capture-pane", "-p", "-S", "-160", "-t", pane_id])
    output = run_command(args, timeout=min(max(8, len(pane_ids) * 2), 30))
    previews: dict[str, list[str]] = {}
    current_pane_id: str | None = None
    for line in output.splitlines():
        if line.startswith(f"{marker}\t"):
            marker_id = line.split("\t", 1)[1]
            current_pane_id = marker_ids.get(marker_id)
            if current_pane_id:
                previews.setdefault(current_pane_id, [])
            continue
        if current_pane_id:
            previews[current_pane_id].append(line)
    return {pane_id: "\n".join(lines) for pane_id, lines in previews.items()}


def capture_tmux_panes_individual(
    pane_ids: list[str],
    diagnostics: list[str],
) -> dict[str, str]:
    previews: dict[str, str] = {}
    with ThreadPoolExecutor(max_workers=min(8, len(pane_ids))) as executor:
        futures = {
            executor.submit(capture_tmux_pane, pane_id): pane_id for pane_id in pane_ids
        }
        for future in as_completed(futures):
            pane_id = futures[future]
            try:
                previews[pane_id] = future.result()
            except Exception as exc:
                diagnostics.append(f"tmux pane {pane_id} preview unavailable: {exc}")
    return previews


def is_codex_like(*values: str) -> bool:
    joined = " ".join(values).lower()
    return "codex" in joined or "claude" in joined or "$linear-ticket-to-pr" in joined


def capture_tmux_pane(pane_id: str) -> str:
    return run_command(["tmux", "capture-pane", "-p", "-S", "-160", "-t", pane_id], timeout=8)


def fetch_tmux_preview(pane_id: str) -> dict[str, Any]:
    preview = capture_tmux_pane(pane_id)
    preview, truncated = truncate_with_flag(preview, MAX_PANE_CHARS)
    return {"panePreview": preview, "panePreviewTruncated": truncated}


def collect_codex_sessions(
    settings: Settings, diagnostics: list[str]
) -> list[CodexSessionSummary]:
    index = load_codex_session_index(settings.codex_home)
    session_root = settings.codex_home / "sessions"
    if not session_root.exists():
        diagnostics.append(f"Codex session directory not found: {session_root}")
        return []
    paths = cached_codex_session_paths(session_root)
    sessions = []
    git_branch_cache: dict[str, str | None] = {}
    summary_cache = cached_codex_summary_entries(settings)
    summary_cache_changed = False
    for path in paths[: settings.codex_session_limit]:
        try:
            thread_id = rollout_id_from_path(path)
            _CODEX_SESSION_PATH_CACHE[thread_id] = path
            indexed = index.get(thread_id)
            cached = cached_codex_summary(summary_cache, path, indexed)
            if cached:
                sessions.append(cached)
                continue
            parsed = parse_codex_rollout(
                path,
                indexed,
                git_branch_cache,
            )
            if parsed:
                sessions.append(parsed)
                summary_cache[str(path)] = {
                    "cacheKey": codex_summary_cache_key(path, indexed),
                    "summary": parsed,
                    "savedAt": utc_now_iso(),
                }
                summary_cache_changed = True
        except Exception as exc:
            diagnostics.append(f"Codex rollout parse failed for {path.name}: {exc}")
    if summary_cache_changed:
        save_codex_summary_cache(settings, summary_cache)
    return sessions


def cached_codex_session_paths(session_root: Path) -> list[Path]:
    global _CODEX_SESSION_PATHS_CACHE
    cached = _CODEX_SESSION_PATHS_CACHE
    ttl_seconds = float(os.environ.get("TICKETBOARD_CODEX_PATH_TTL", "5"))
    if (
        cached
        and ttl_seconds > 0
        and time.monotonic() - cached[0] < ttl_seconds
        and cached[1] == session_root
    ):
        return list(cached[2])
    paths = sorted(
        session_root.glob("**/*.jsonl"), key=lambda item: item.stat().st_mtime, reverse=True
    )
    if ttl_seconds > 0:
        _CODEX_SESSION_PATHS_CACHE = (time.monotonic(), session_root, paths)
    else:
        _CODEX_SESSION_PATHS_CACHE = None
    return paths


def collect_codex_token_usage(settings: Settings) -> dict[str, Any]:
    session_root = settings.codex_home / "sessions"
    now = datetime.now(tz=UTC)
    ranges = codex_token_ranges(now)
    if not session_root.exists():
        return {
            "totalTokens": 0,
            "sessionCount": 0,
            "sessionsWithUsage": 0,
            "range": "all",
            "ranges": empty_codex_token_ranges(ranges),
            "updatedAt": utc_now_iso(),
        }

    paths = cached_codex_session_paths(session_root)
    index = load_codex_session_index(settings.codex_home)
    prune_codex_token_usage_cache(paths)
    totals = {key: 0 for key in ranges}
    trend_buckets = {key: initial_codex_trend_buckets(ranges[key], now) for key in ranges}
    top_sessions: dict[str, list[dict[str, Any]]] = {key: [] for key in ranges}
    sessions_with_usage = 0
    for path in paths:
        stats = codex_session_token_stats(path)
        if not stats:
            continue
        latest_total = stats.get("totalTokens")
        if isinstance(latest_total, int):
            totals["all"] += latest_total
            append_top_codex_token_session(
                top_sessions["all"],
                path,
                stats,
                latest_total,
                index,
            )
        range_session_totals = {key: 0 for key in ranges if key != "all"}
        for occurred_at, delta in stats.get("deltas", []):
            all_bucket_key = codex_trend_bucket_key(occurred_at, ranges["all"])
            if all_bucket_key in trend_buckets["all"]:
                trend_buckets["all"][all_bucket_key] += delta
            for key, window in ranges.items():
                if key == "all":
                    continue
                start = window["start"]
                if start and occurred_at >= start:
                    totals[key] += delta
                    range_session_totals[key] += delta
                    bucket_key = codex_trend_bucket_key(occurred_at, window)
                    trend_buckets[key][bucket_key] = (
                        trend_buckets[key].get(bucket_key, 0) + delta
                    )
        for key, total in range_session_totals.items():
            if total > 0:
                append_top_codex_token_session(
                    top_sessions[key],
                    path,
                    stats,
                    total,
                    index,
                )
        sessions_with_usage += 1
    return {
        "totalTokens": totals["all"],
        "sessionCount": len(paths),
        "sessionsWithUsage": sessions_with_usage,
        "range": "all",
        "ranges": {
            key: {
                "totalTokens": totals[key],
                "label": window["label"],
                "periodStart": iso_from_datetime(window["start"]) if window["start"] else None,
                "trend": codex_trend_points(trend_buckets[key], window),
                "topSessions": sorted(
                    top_sessions[key],
                    key=lambda session: session["tokens"],
                    reverse=True,
                )[:5],
            }
            for key, window in ranges.items()
        },
        "updatedAt": utc_now_iso(),
    }


def codex_token_ranges(now: datetime) -> dict[str, dict[str, Any]]:
    local_now = now.astimezone(ticketboard_timezone())
    today_start = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = today_start - timedelta(days=today_start.weekday())
    return {
        "all": {"label": "all time", "start": None},
        "week": {"label": "this week", "start": week_start.astimezone(UTC)},
        "today": {"label": "today", "start": today_start.astimezone(UTC)},
    }


def empty_codex_token_ranges(ranges: dict[str, dict[str, Any]]) -> dict[str, Any]:
    now = datetime.now(tz=UTC)
    return {
        key: {
            "totalTokens": 0,
            "label": window["label"],
            "periodStart": iso_from_datetime(window["start"]) if window["start"] else None,
            "topSessions": [],
            "trend": codex_trend_points(
                initial_codex_trend_buckets(window, now),
                window,
            ),
        }
        for key, window in ranges.items()
    }


def initial_codex_trend_buckets(
    window: dict[str, Any],
    now: datetime,
) -> dict[str, int]:
    local_now = now.astimezone(ticketboard_timezone())
    if window["label"] == "today":
        start = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
        return {
            (start + timedelta(hours=hour)).strftime("%Y-%m-%dT%H:00:00")
            : 0
            for hour in range(local_now.hour + 1)
        }
    if window["label"] == "this week":
        start = window["start"].astimezone(ticketboard_timezone())
        end = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
        days = max((end.date() - start.date()).days, 0)
        return {
            (start + timedelta(days=day)).strftime("%Y-%m-%d")
            : 0
            for day in range(days + 1)
        }

    start = (local_now - timedelta(days=29)).replace(
        hour=0,
        minute=0,
        second=0,
        microsecond=0,
    )
    return {
        (start + timedelta(days=day)).strftime("%Y-%m-%d"): 0
        for day in range(30)
    }


def codex_trend_bucket_key(occurred_at: datetime, window: dict[str, Any]) -> str:
    local_time = occurred_at.astimezone(ticketboard_timezone())
    if window["label"] == "today":
        return local_time.replace(minute=0, second=0, microsecond=0).strftime(
            "%Y-%m-%dT%H:00:00"
        )
    return local_time.strftime("%Y-%m-%d")


def codex_trend_points(
    buckets: dict[str, int],
    window: dict[str, Any],
) -> list[dict[str, Any]]:
    return [
        {
            "timestamp": bucket,
            "label": codex_trend_label(bucket, window),
            "totalTokens": tokens,
        }
        for bucket, tokens in sorted(buckets.items())
    ]


def codex_trend_label(bucket: str, window: dict[str, Any]) -> str:
    if window["label"] == "today":
        try:
            parsed = datetime.strptime(bucket, "%Y-%m-%dT%H:00:00")
        except ValueError:
            return bucket
        hour = parsed.strftime("%I %p").lstrip("0")
        return hour
    try:
        parsed = datetime.strptime(bucket, "%Y-%m-%d")
    except ValueError:
        return bucket
    return parsed.strftime("%b %-d")


def append_top_codex_token_session(
    sessions: list[dict[str, Any]],
    path: Path,
    stats: dict[str, Any],
    tokens: int,
    index: dict[str, dict[str, Any]],
) -> None:
    thread_id = str(stats.get("threadId") or rollout_id_from_path(path))
    indexed = index.get(thread_id) or {}
    raw_title = str(
        indexed.get("thread_name")
        or stats.get("title")
        or stats.get("firstUserMessage")
        or path.stem
    ).strip()
    sessions.append(
        {
            "threadId": thread_id,
            "title": readable_top_codex_session_title(raw_title, thread_id),
            "cwd": stats.get("cwd") or "",
            "model": stats.get("model"),
            "tokens": tokens,
            "updatedAt": stats.get("updatedAt") or iso_from_mtime(path),
        }
    )


def readable_top_codex_session_title(value: str, thread_id: str) -> str:
    cleaned = clean_codex_message_text(value).strip()
    if not cleaned or re.match(r"^<[^>]+>", cleaned):
        return f"Codex session {thread_id[:8]}"
    return truncate(cleaned, 120)


def ticketboard_timezone() -> ZoneInfo:
    name = os.environ.get("TICKETBOARD_TIMEZONE") or os.environ.get("TZ") or "America/New_York"
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError:
        return ZoneInfo("UTC")


def prune_codex_token_usage_cache(paths: list[Path]) -> None:
    if len(_CODEX_TOKEN_USAGE_CACHE) <= len(paths) + 128:
        return
    live_paths = {str(path) for path in paths}
    for key in list(_CODEX_TOKEN_USAGE_CACHE):
        if key not in live_paths:
            _CODEX_TOKEN_USAGE_CACHE.pop(key, None)


def codex_session_total_tokens(path: Path) -> int | None:
    stats = codex_session_token_stats(path)
    if not stats:
        return None
    total = stats.get("totalTokens")
    return total if isinstance(total, int) else None


def codex_session_token_stats(path: Path) -> dict[str, Any] | None:
    try:
        stat_result = path.stat()
    except Exception:
        return None
    cache_key = (stat_result.st_mtime_ns, stat_result.st_size)
    cached = _CODEX_TOKEN_USAGE_CACHE.get(str(path))
    if cached and cached[0] == cache_key:
        return cached[1]

    latest_total: int | None = None
    previous_total = 0
    deltas: list[tuple[datetime, int]] = []
    fallback_timestamp = iso_from_stat(stat_result)
    meta: dict[str, Any] = {
        "threadId": rollout_id_from_path(path),
        "updatedAt": fallback_timestamp,
        "cwd": "",
        "model": None,
        "title": "",
        "firstUserMessage": "",
    }
    try:
        with path.open("rb") as handle:
            for line in handle:
                try:
                    item = orjson.loads(line)
                except Exception:
                    continue
                if not isinstance(item, dict):
                    continue
                payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
                timestamp_text = codex_item_timestamp(item, payload, meta["updatedAt"])
                meta["updatedAt"] = timestamp_text or meta["updatedAt"]
                item_type = item.get("type")

                if item_type == "session_meta":
                    meta["threadId"] = payload.get("id") or meta["threadId"]
                    meta["cwd"] = payload.get("cwd") or meta["cwd"]
                    continue

                if item_type == "turn_context":
                    meta["cwd"] = payload.get("cwd") or meta["cwd"]
                    meta["model"] = payload.get("model") or meta["model"]
                    continue

                if item_type == "event_msg" and payload.get("type") == "user_message":
                    text = clean_codex_message_text(payload.get("message") or "")
                    if text and not meta["firstUserMessage"]:
                        meta["firstUserMessage"] = truncate(text, 120)
                    if text and not meta["title"]:
                        meta["title"] = truncate(text.strip().splitlines()[0], 120)

                if item_type == "response_item" and payload.get("type") == "message":
                    role = normalize_codex_role(payload.get("role"))
                    text = clean_codex_message_text(content_text(payload.get("content")))
                    if role == "user" and text and not meta["firstUserMessage"]:
                        meta["firstUserMessage"] = truncate(text, 120)
                    if role == "user" and text and not meta["title"]:
                        meta["title"] = truncate(text.strip().splitlines()[0], 120)

                if item_type != "event_msg":
                    continue
                if payload.get("type") != "token_count":
                    continue
                usage = (payload.get("info") or {}).get("total_token_usage") or {}
                parsed_total = parse_nonnegative_int(usage.get("total_tokens"))
                if parsed_total is not None:
                    occurred_at = parse_iso_datetime(timestamp_text)
                    delta = max(parsed_total - previous_total, 0)
                    if occurred_at and delta > 0:
                        deltas.append((occurred_at, delta))
                    previous_total = parsed_total
                    latest_total = parsed_total
    except Exception:
        return None

    stats = (
        {**meta, "totalTokens": latest_total, "deltas": deltas}
        if latest_total is not None
        else None
    )
    _CODEX_TOKEN_USAGE_CACHE[str(path)] = (cache_key, stats)
    return stats


def parse_iso_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def iso_from_datetime(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_nonnegative_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value >= 0 else None
    if isinstance(value, float):
        return int(value) if value >= 0 and value.is_integer() else None
    if isinstance(value, str) and value.isdecimal():
        return int(value)
    return None


def load_codex_session_index(codex_home: Path) -> dict[str, dict[str, Any]]:
    global _CODEX_SESSION_INDEX_CACHE
    path = codex_home / "session_index.jsonl"
    if not path.exists():
        _CODEX_SESSION_INDEX_CACHE = None
        return {}
    stat_result = path.stat()
    cache_key = (stat_result.st_mtime_ns, stat_result.st_size)
    if (
        _CODEX_SESSION_INDEX_CACHE
        and _CODEX_SESSION_INDEX_CACHE[0] == path
        and _CODEX_SESSION_INDEX_CACHE[1] == cache_key
    ):
        return _CODEX_SESSION_INDEX_CACHE[2]
    index: dict[str, dict[str, Any]] = {}
    try:
        content = path.read_bytes()
    except Exception:
        return index
    try:
        for line in content.splitlines():
            item = orjson.loads(line)
            if item.get("id"):
                index[item["id"]] = item
    except Exception:
        return index
    _CODEX_SESSION_INDEX_CACHE = (path, cache_key, index)
    return index


def cached_codex_summary_entries(settings: Settings) -> dict[str, dict[str, Any]]:
    payload = load_json(codex_summary_cache_path(settings))
    if not isinstance(payload, dict) or payload.get("version") != 1:
        return {}
    entries = payload.get("entries")
    if not isinstance(entries, dict):
        return {}
    return {key: value for key, value in entries.items() if isinstance(value, dict)}


def cached_codex_summary(
    entries: dict[str, dict[str, Any]],
    path: Path,
    indexed: dict[str, Any] | None,
) -> CodexSessionSummary | None:
    entry = entries.get(str(path))
    if not isinstance(entry, dict):
        return None
    if entry.get("cacheKey") != codex_summary_cache_key(path, indexed):
        return None
    summary = entry.get("summary")
    if not isinstance(summary, dict) or not summary.get("threadId"):
        return None
    cached = dict(summary)
    if cached.get("status") not in {"goal-active", "idle", "running", "unknown"}:
        cached["status"] = codex_status(path, {"goalStatus": cached.get("goalStatus")})
    return cached


def save_codex_summary_cache(
    settings: Settings,
    entries: dict[str, dict[str, Any]],
) -> None:
    trimmed_entries = dict(
        sorted(
            entries.items(),
            key=lambda item: str(
                item[1].get("savedAt") if isinstance(item[1], dict) else ""
            ),
            reverse=True,
        )[:MAX_CODEX_SUMMARY_CACHE]
    )
    save_json(
        codex_summary_cache_path(settings),
        {"version": 1, "entries": trimmed_entries},
    )


def codex_summary_cache_path(settings: Settings) -> Path:
    return settings.cache_dir / "codex-summary-cache.json"


def codex_summary_cache_key(
    path: Path,
    indexed: dict[str, Any] | None,
) -> list[Any]:
    stat_result = path.stat()
    indexed_title = indexed.get("thread_name") if indexed else None
    return [CODEX_PARSER_VERSION, stat_result.st_mtime_ns, stat_result.st_size, indexed_title]


def rollout_id_from_path(path: Path) -> str:
    match = re.search(r"([0-9a-f]{8}-[0-9a-f-]{27,})", path.name)
    return match.group(1) if match else path.stem


def parse_codex_rollout(
    path: Path,
    indexed: dict[str, Any] | None,
    git_branch_cache: dict[str, str | None] | None = None,
) -> CodexSessionSummary | None:
    detail = parse_codex_detail(path, indexed)
    if not detail["threadId"]:
        return None
    meta = getattr(parse_codex_detail, "_last_meta", {})
    messages = detail["messages"]
    first_user = next((item["text"] for item in messages if item["role"] == "user"), "")
    display_messages = [
        item for item in messages if item["role"] in {"user", "assistant"}
    ]
    latest_messages = [
        summarize_codex_message(item)
        for item in display_messages[-CODEX_SUMMARY_MESSAGE_LIMIT:]
    ]
    tool_calls = [
        summarize_codex_tool_call(call)
        for call in detail["toolCalls"][-CODEX_SUMMARY_TOOL_CALL_LIMIT:]
    ]
    updated_at = meta.get("updatedAt") or iso_from_mtime(path)
    cwd = meta.get("cwd") or ""
    git_branch = meta.get("gitBranch") or cached_codex_git_branch(cwd, git_branch_cache)
    text_for_tickets = [detail["title"], first_user, cwd, git_branch]
    text_for_tickets.extend(item["text"] for item in display_messages[-12:])
    for call in detail["toolCalls"][-12:]:
        text_for_tickets.extend(
            [
                call.get("name"),
                call.get("argumentsPreview"),
                call.get("outputPreview"),
            ]
        )
    summary: CodexSessionSummary = {
        "threadId": detail["threadId"],
        "title": detail["title"],
        "preview": truncate(
            first_user or (latest_messages[-1]["text"] if latest_messages else ""),
            CODEX_SUMMARY_PREVIEW_CHARS,
        ),
        "cwd": cwd,
        "gitBranch": git_branch,
        "model": meta.get("model"),
        "modelProvider": meta.get("modelProvider") or "openai",
        "reasoningEffort": meta.get("reasoningEffort"),
        "tokensUsed": int(meta.get("tokensUsed") or 0),
        "updatedAt": updated_at,
        "goalObjective": meta.get("goalObjective"),
        "goalStatus": meta.get("goalStatus"),
        "goalTokensUsed": meta.get("goalTokensUsed"),
        "goalTokenBudget": meta.get("goalTokenBudget"),
        "ticketIds": extract_ticket_ids(*text_for_tickets),
        "status": codex_status(path, meta),
        "recentToolCalls": tool_calls,
        "latestMessages": latest_messages,
    }
    if first_user:
        summary["firstUserMessage"] = truncate(first_user, CODEX_SUMMARY_PREVIEW_CHARS)
    if meta.get("createdAt"):
        summary["createdAt"] = meta["createdAt"]
    if meta.get("gitSha"):
        summary["gitSha"] = meta["gitSha"]
    summary["rolloutPath"] = str(path)
    return summary


def summarize_codex_message(message: dict[str, str]) -> dict[str, str]:
    return {
        "role": message["role"],
        "text": truncate(message["text"], CODEX_SUMMARY_MESSAGE_CHARS),
        "timestamp": message["timestamp"],
    }


def summarize_codex_tool_call(call: dict[str, Any]) -> dict[str, Any]:
    return {
        "callId": call.get("callId") or "",
        "name": call.get("name") or "tool",
        "status": call.get("status") or "completed",
        "argumentsPreview": truncate(
            call.get("argumentsPreview") or "",
            CODEX_SUMMARY_TOOL_PREVIEW_CHARS,
        ),
        "outputPreview": truncate(
            call.get("outputPreview") or "",
            CODEX_SUMMARY_TOOL_PREVIEW_CHARS,
        ),
        "timestamp": call.get("timestamp") or "",
    }


def parse_codex_detail(path: Path, indexed: dict[str, Any] | None = None) -> CodexSessionDetail:
    stat_result = path.stat()
    indexed_title = indexed.get("thread_name") if indexed else None
    cache_key = (
        CODEX_PARSER_VERSION,
        stat_result.st_mtime_ns,
        stat_result.st_size,
        indexed_title,
    )
    cached = _CODEX_DETAIL_CACHE.get(str(path))
    if cached and cached[0] == cache_key:
        detail, meta = cached[1], cached[2]
        parse_codex_detail._last_meta = dict(meta)  # type: ignore[attr-defined]
        return detail

    thread_id = rollout_id_from_path(path)
    title = indexed_title
    messages: list[dict[str, str]] = []
    events: list[dict[str, Any]] = []
    event_ids: set[str] = set()
    calls_by_id: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    open_turns: set[str] = set()
    meta: dict[str, Any] = {
        "createdAt": None,
        "updatedAt": iso_from_stat(stat_result),
        "cwd": "",
        "modelProvider": "openai",
    }
    parsed = 0
    truncated = False
    total_chars = 0

    for line in path.read_bytes().splitlines():
        if total_chars > MAX_ROLLOUT_CHARS * 4:
            truncated = True
            break
        total_chars += len(line)
        try:
            item = orjson.loads(line)
        except Exception:
            continue
        parsed += 1
        payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
        timestamp = codex_item_timestamp(item, payload, meta["updatedAt"])
        item_type = item.get("type")
        payload_type = payload.get("type")
        meta["updatedAt"] = timestamp or meta["updatedAt"]

        if item_type == "session_meta":
            thread_id = payload.get("id") or thread_id
            meta["createdAt"] = payload.get("timestamp") or timestamp
            meta["cwd"] = payload.get("cwd") or meta["cwd"]
            meta["modelProvider"] = payload.get("model_provider") or meta["modelProvider"]
            git = payload.get("git") if isinstance(payload.get("git"), dict) else {}
            meta["gitBranch"] = git.get("branch") or meta.get("gitBranch")
            meta["gitSha"] = git.get("commit_hash") or meta.get("gitSha")
            continue

        if item_type == "turn_context":
            meta["cwd"] = payload.get("cwd") or meta["cwd"]
            meta["model"] = payload.get("model") or meta.get("model")
            mode = (payload.get("collaboration_mode") or {}).get("settings") or {}
            meta["reasoningEffort"] = mode.get("reasoning_effort") or meta.get(
                "reasoningEffort"
            )
            continue

        if item_type == "event_msg" and payload_type == "token_count":
            usage = (payload.get("info") or {}).get("total_token_usage") or {}
            meta["tokensUsed"] = usage.get("total_tokens") or meta.get("tokensUsed")
            continue

        if item_type == "event_msg" and payload_type == "task_started":
            turn_id = str(payload.get("turn_id") or "")
            if turn_id:
                open_turns.add(turn_id)
            meta["latestTaskState"] = "running"
            append_event(
                events,
                event_ids,
                {
                    "id": f"task:{turn_id or parsed}:start",
                    "kind": "system",
                    "timestamp": timestamp,
                    "title": "Task started",
                    "detail": readable_task_detail(payload),
                    "status": "started",
                },
            )
            continue

        if item_type == "event_msg" and payload_type in {"task_complete", "turn_aborted"}:
            turn_id = str(payload.get("turn_id") or "")
            if turn_id:
                open_turns.discard(turn_id)
            meta["latestTaskState"] = "idle"
            completed = payload_type == "task_complete"
            title_text = "Task completed" if completed else "Turn aborted"
            detail_text = payload.get("last_agent_message") or payload.get("reason") or ""
            append_event(
                events,
                event_ids,
                {
                    "id": f"task:{turn_id or parsed}:end",
                    "kind": "system",
                    "timestamp": timestamp,
                    "title": title_text,
                    "detail": truncate(str(detail_text), 500),
                    "status": "completed",
                },
            )
            continue

        if item_type == "event_msg" and payload_type in {"user_message", "agent_message"}:
            role = "user" if payload_type == "user_message" else "assistant"
            text = payload.get("message") or ""
            display_text = add_message(messages, role, text, timestamp)
            if display_text:
                append_event(
                    events,
                    event_ids,
                    event_from_message(len(events), role, display_text, timestamp),
                )
                if role == "user" and not title:
                    title = truncate(
                        display_text.strip().splitlines()[0]
                        if display_text.strip()
                        else "",
                        80,
                    )
            continue

        if item_type == "response_item" and payload_type == "message":
            role = normalize_codex_role(payload.get("role"))
            if role not in {"assistant", "user"}:
                continue
            text = content_text(payload.get("content"))
            display_text = add_message(messages, role, text, timestamp)
            if role == "user" and display_text and not title:
                title = truncate(
                    display_text.strip().splitlines()[0]
                    if display_text.strip()
                    else "",
                    80,
                )
            continue

        if item_type == "response_item" and payload_type in {
            "function_call",
            "custom_tool_call",
        }:
            call_id = payload.get("call_id") or f"call-{len(calls_by_id)}"
            if call_id not in calls_by_id:
                order.append(call_id)
            raw_name = payload.get("name") or "tool"
            args = payload.get("arguments") if payload_type == "function_call" else None
            if args is None:
                args = payload.get("input") or ""
            arguments_preview = readable_tool_arguments(raw_name, args)
            readable_name = readable_tool_name(raw_name, args)
            calls_by_id[call_id] = {
                "callId": call_id,
                "name": readable_name,
                "status": "started",
                "argumentsPreview": truncate(arguments_preview, 220),
                "outputPreview": "",
                "timestamp": timestamp,
                "arguments": truncate(args, MAX_LOG_CHARS),
                "argumentsTruncated": len(args) > MAX_LOG_CHARS,
            }
            append_event(
                events,
                event_ids,
                {
                    "id": f"tool:{call_id}:start",
                    "kind": "tool_call",
                    "timestamp": timestamp,
                    "title": readable_name,
                    "detail": truncate(arguments_preview, 500),
                    "status": "started",
                },
            )
            continue

        if item_type == "event_msg" and payload_type == "patch_apply_end":
            call_id = payload.get("call_id") or f"patch-{parsed}"
            call = calls_by_id.setdefault(
                call_id,
                {
                    "callId": call_id,
                    "name": "Patch",
                    "argumentsPreview": "",
                    "timestamp": timestamp,
                },
            )
            if call_id not in order:
                order.append(call_id)
            summary = readable_patch_result(payload)
            call.update(
                {
                    "status": "completed",
                    "outputPreview": truncate(summary, 300),
                    "output": summary,
                    "outputTruncated": False,
                }
            )
            append_tool_output_event(events, event_ids, call_id, call, summary, timestamp)
            continue

        if item_type == "response_item" and payload_type in {
            "function_call_output",
            "custom_tool_call_output",
        }:
            call_id = payload.get("call_id") or f"call-{len(calls_by_id)}"
            output = clean_tool_output(payload.get("output") or "")
            call = calls_by_id.setdefault(
                call_id,
                {
                    "callId": call_id,
                    "name": "tool",
                    "argumentsPreview": "",
                    "timestamp": timestamp,
                },
            )
            if call_id not in order:
                order.append(call_id)
            call.update(
                {
                    "status": "completed",
                    "outputPreview": truncate(output, 300),
                    "output": truncate(output, MAX_LOG_CHARS),
                    "outputTruncated": len(output) > MAX_LOG_CHARS,
                }
            )
            append_tool_output_event(events, event_ids, call_id, call, output, timestamp)

    if open_turns:
        meta["latestTaskState"] = "running"
    tool_calls = [calls_by_id[call_id] for call_id in order]
    detail: CodexSessionDetail = {
        "threadId": thread_id,
        "title": title or thread_id,
        "rolloutPath": str(path),
        "events": events[-CODEX_DETAIL_EVENT_LIMIT:],
        "toolCalls": tool_calls[-CODEX_DETAIL_TOOL_CALL_LIMIT:],
        "messages": messages[-CODEX_DETAIL_MESSAGE_LIMIT:],
        "totalParsedEvents": parsed,
        "truncated": truncated,
    }
    _CODEX_DETAIL_CACHE[str(path)] = (cache_key, detail, dict(meta))
    if len(_CODEX_DETAIL_CACHE) > MAX_CODEX_DETAIL_CACHE:
        _CODEX_DETAIL_CACHE.pop(next(iter(_CODEX_DETAIL_CACHE)))
    parse_codex_detail._last_meta = meta  # type: ignore[attr-defined]
    return detail


def add_message(
    messages: list[dict[str, str]],
    role: str,
    text: str,
    timestamp: str,
) -> str | None:
    clean_text = clean_codex_message_text(text)
    if not clean_text:
        return None
    clean_text = truncate(clean_text, 4_000)
    if any(
        message["role"] == role and message["text"] == clean_text
        for message in messages[-12:]
    ):
        return None
    messages.append({"role": role, "text": clean_text, "timestamp": timestamp or ""})
    return clean_text


def event_from_message(index: int, role: str, text: str, timestamp: str) -> dict[str, str]:
    return {
        "id": f"message:{index}",
        "kind": "message",
        "timestamp": timestamp or "",
        "title": role,
        "detail": truncate(text, 500),
    }


def clean_codex_message_text(text: Any) -> str:
    value = str(text or "").strip()
    if not value:
        return ""
    cleaned = strip_codex_injected_context(value)
    if cleaned:
        return strip_codex_task_prelude(cleaned)
    return "" if is_codex_injected_context(value) else strip_codex_task_prelude(value)


def strip_codex_injected_context(text: str) -> str:
    cleaned = text
    cleaned = re.sub(
        r"(?is)(?:^|\n)# AGENTS\.md instructions[^\n]*\n\s*<INSTRUCTIONS>.*?</INSTRUCTIONS>",
        "\n",
        cleaned,
    )
    for tag in (
        "INSTRUCTIONS",
        "environment_context",
        "permissions instructions",
        "collaboration_mode",
        "skills_instructions",
        "plugins_instructions",
    ):
        escaped = re.escape(tag)
        cleaned = re.sub(
            rf"(?is)\s*<{escaped}>.*?</{escaped}>\s*",
            "\n",
            cleaned,
        )
    cleaned = re.sub(r"(?im)^\s*# AGENTS\.md instructions[^\n]*\n?", "\n", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def strip_codex_task_prelude(text: str) -> str:
    cleaned = re.sub(
        r"(?is)^essentially,\s*the task for this session is:\s*",
        "",
        text,
    )
    cleaned = re.sub(
        r"(?is)<image\s+name=\[([^\]]+)\]>\s*</image>",
        r"\1",
        cleaned,
    )
    return re.sub(r"^\s*[-*]\s+", "", cleaned).strip()


def is_codex_injected_context(text: str) -> bool:
    lower = text.lower()
    if "# agents.md instructions" in lower and "<instructions>" in lower:
        return True
    marker_hits = sum(
        marker in lower
        for marker in (
            "<environment_context>",
            "<permissions instructions>",
            "<collaboration_mode>",
            "<skills_instructions>",
            "<plugins_instructions>",
        )
    )
    return marker_hits >= 2


def append_event(
    events: list[dict[str, Any]],
    event_ids: set[str],
    event: dict[str, Any],
) -> None:
    event_id = str(event.get("id") or "")
    if event_id and event_id in event_ids:
        return
    if event_id:
        event_ids.add(event_id)
    events.append(event)


def append_tool_output_event(
    events: list[dict[str, Any]],
    event_ids: set[str],
    call_id: str,
    call: dict[str, Any],
    output: str,
    timestamp: str,
) -> None:
    append_event(
        events,
        event_ids,
        {
            "id": f"tool:{call_id}:output",
            "kind": "tool_output",
            "timestamp": timestamp,
            "title": call.get("name") or "tool output",
            "detail": truncate(output, 500),
            "status": "completed",
        },
    )


def codex_item_timestamp(
    item: dict[str, Any],
    payload: dict[str, Any],
    fallback: str,
) -> str:
    for value in (
        item.get("timestamp"),
        payload.get("completed_at"),
        payload.get("started_at"),
        payload.get("timestamp"),
        fallback,
    ):
        timestamp = iso_from_timestamp_value(value)
        if timestamp:
            return timestamp
    return fallback


def iso_from_timestamp_value(value: Any) -> str | None:
    if isinstance(value, str) and value:
        return value
    if isinstance(value, int | float):
        return (
            datetime.fromtimestamp(value, tz=UTC)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z")
        )
    return None


def readable_task_detail(payload: dict[str, Any]) -> str:
    details = []
    if payload.get("collaboration_mode_kind"):
        details.append(f"mode: {payload['collaboration_mode_kind']}")
    if payload.get("model_context_window"):
        details.append(f"context: {payload['model_context_window']}")
    return ", ".join(details)


def readable_tool_name(raw_name: Any, raw_arguments: Any) -> str:
    name = str(raw_name or "tool")
    args = parse_json_object(raw_arguments)
    if name == "exec_command" and args:
        command = first_line(args.get("cmd"))
        return f"Shell: {truncate(command, 90)}" if command else "Shell command"
    if name == "write_stdin":
        return "Shell input"
    if name == "apply_patch":
        return patch_title(str(raw_arguments or ""))
    if name == "update_plan":
        return "Update plan"
    if name == "request_user_input":
        return "Ask user"
    if name == "view_image":
        return "View image"
    if name.startswith("mcp__linear"):
        return f"Linear: {humanize_tool_name(name.removeprefix('mcp__linear__'))}"
    if name.startswith("mcp__datadog"):
        return f"Datadog: {humanize_tool_name(name.removeprefix('mcp__datadog_mcp__'))}"
    if "search" in name and "web" in name:
        return "Web search"
    return humanize_tool_name(name)


def readable_tool_arguments(raw_name: Any, raw_arguments: Any) -> str:
    name = str(raw_name or "tool")
    if name == "apply_patch":
        return summarize_patch_input(str(raw_arguments or ""))
    args = parse_json_object(raw_arguments)
    if name == "exec_command" and args:
        parts = [str(args.get("cmd") or "").strip()]
        if args.get("workdir"):
            parts.append(f"cwd: {args['workdir']}")
        return "\n".join(part for part in parts if part)
    if args:
        return truncate(orjson.dumps(args, option=orjson.OPT_INDENT_2).decode(), 1_000)
    return str(raw_arguments or "")


def parse_json_object(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = orjson.loads(value)
    except Exception:
        return None
    return parsed if isinstance(parsed, dict) else None


def clean_tool_output(output: str) -> str:
    lines = output.splitlines()
    output_marker = next(
        (index for index, line in enumerate(lines[:8]) if line.strip() == "Output:"),
        None,
    )
    if output_marker is not None:
        lines = lines[output_marker + 1 :]
    cleaned = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith(("Chunk ID:", "Wall time:", "Original token count:")):
            continue
        if stripped.startswith(("Process exited with code", "Exit code:")):
            continue
        if stripped.startswith("Total output lines:"):
            continue
        cleaned.append(line)
    return "\n".join(cleaned).strip()


def humanize_tool_name(name: str) -> str:
    cleaned = name.replace("functions.", "").replace("_", " ").strip()
    return cleaned[:1].upper() + cleaned[1:] if cleaned else "Tool"


def first_line(value: Any) -> str:
    return str(value or "").strip().splitlines()[0] if str(value or "").strip() else ""


def patch_title(patch_text: str) -> str:
    paths = extract_patch_paths(patch_text)
    if not paths:
        return "Patch"
    return f"Patch: {len(paths)} file{'s' if len(paths) != 1 else ''}"


def summarize_patch_input(patch_text: str) -> str:
    paths = extract_patch_paths(patch_text)
    if not paths:
        return truncate(patch_text, 500)
    visible = ", ".join(short_display_path(path) for path in paths[:4])
    if len(paths) > 4:
        visible = f"{visible}, +{len(paths) - 4} more"
    return f"Changes: {visible}"


def extract_patch_paths(patch_text: str) -> list[str]:
    paths: list[str] = []
    for line in patch_text.splitlines():
        match = re.match(r"\*\*\* (?:Update|Add|Delete) File: (.+)", line)
        if match:
            paths.append(match.group(1).strip())
    return paths


def readable_patch_result(payload: dict[str, Any]) -> str:
    changes = payload.get("changes")
    if not isinstance(changes, dict) or not changes:
        if payload.get("success") is False:
            return truncate(payload.get("stderr") or "Patch failed", 500)
        return "Patch applied"
    paths = [short_display_path(path) for path in changes]
    visible = ", ".join(paths[:5])
    if len(paths) > 5:
        visible = f"{visible}, +{len(paths) - 5} more"
    status = "applied" if payload.get("success", True) else "failed"
    return f"Patch {status}: {visible}"


def short_display_path(path: str) -> str:
    value = str(path)
    home = str(Path.home())
    if value.startswith(home):
        value = "~" + value[len(home) :]
    parts = value.split("/")
    if len(parts) > 4:
        value = "/".join([parts[0], "...", *parts[-3:]])
    return value


def normalize_codex_role(role: Any) -> str:
    value = str(role or "unknown")
    return value if value in {"assistant", "developer", "system", "user"} else "unknown"


def content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict):
                parts.append(str(item.get("text") or item.get("content") or ""))
            else:
                parts.append(str(item))
        return "\n".join(part for part in parts if part)
    return ""


def iso_from_mtime(path: Path) -> str:
    return iso_from_stat(path.stat())


def iso_from_stat(stat_result: os.stat_result) -> str:
    return (
        datetime.fromtimestamp(stat_result.st_mtime, tz=UTC)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def codex_git_branch(cwd: str) -> str | None:
    if not cwd:
        return None
    path = Path(cwd)
    if not path.exists():
        return None
    head_path = git_head_path(path)
    head_mtime = git_head_mtime(head_path)
    cache_key = str(path)
    cached = _CODEX_GIT_BRANCH_CACHE.get(cache_key)
    if head_mtime is not None and cached and cached[0] == head_mtime:
        return cached[1]
    branch = git_head_branch(head_path)
    if branch is None:
        branch = try_git(path, ["rev-parse", "--abbrev-ref", "HEAD"]).strip() or None
    if head_mtime is not None:
        _CODEX_GIT_BRANCH_CACHE[cache_key] = (head_mtime, branch)
    return branch


def git_head_path(path: Path) -> Path | None:
    git_path = path / ".git"
    try:
        if git_path.is_dir():
            return git_path / "HEAD"
        elif git_path.is_file():
            content = git_path.read_text(errors="ignore").strip()
            if not content.startswith("gitdir:"):
                return None
            raw_git_dir = Path(content.partition(":")[2].strip())
            git_dir = (
                raw_git_dir
                if raw_git_dir.is_absolute()
                else git_path.parent / raw_git_dir
            )
            return git_dir / "HEAD"
    except Exception:
        return None
    return None


def git_head_mtime(head_path: Path | None) -> int | None:
    try:
        return head_path.stat().st_mtime_ns if head_path else None
    except Exception:
        return None


def git_head_branch(head_path: Path | None) -> str | None:
    try:
        content = head_path.read_text(errors="ignore").strip() if head_path else ""
    except Exception:
        return None
    ref_prefix = "ref: refs/heads/"
    if content.startswith(ref_prefix):
        return content.removeprefix(ref_prefix) or None
    return None


def cached_codex_git_branch(
    cwd: str,
    cache: dict[str, str | None] | None,
) -> str | None:
    if cache is None:
        return codex_git_branch(cwd)
    if cwd not in cache:
        cache[cwd] = codex_git_branch(cwd)
    return cache[cwd]


def codex_status(path: Path, meta: dict[str, Any]) -> str:
    goal_status = str(meta.get("goalStatus") or "").lower()
    if goal_status in {"active", "running"}:
        return "goal-active"
    latest_task_state = str(meta.get("latestTaskState") or "").lower()
    if latest_task_state == "running":
        return "running"
    if latest_task_state in {"idle", "completed", "aborted"}:
        return "idle"
    age_seconds = datetime.now(UTC).timestamp() - path.stat().st_mtime
    if age_seconds < 5 * 60:
        return "running"
    return "idle"


def fetch_codex_detail(settings: Settings, thread_id: str) -> CodexSessionDetail:
    def detail_with_summary(path: Path, indexed: dict[str, Any] | None) -> CodexSessionDetail:
        detail = parse_codex_detail(path, indexed)
        summary = parse_codex_rollout(path, indexed)
        return {**detail, "summary": summary} if summary else detail

    cached_path = _CODEX_SESSION_PATH_CACHE.get(thread_id)
    if cached_path and cached_path.exists() and thread_id in cached_path.name:
        index = load_codex_session_index(settings.codex_home)
        return detail_with_summary(cached_path, index.get(thread_id))

    for path in cached_codex_session_paths(settings.codex_home / "sessions"):
        if thread_id in path.name:
            _CODEX_SESSION_PATH_CACHE[thread_id] = path
            index = load_codex_session_index(settings.codex_home)
            return detail_with_summary(path, index.get(thread_id))
    raise FileNotFoundError(thread_id)


def collect_dashboard_ticket_ids(
    prs: list[PullRequestSummary],
    worktrees: list[WorktreeSummary],
    tmux_windows: list[TmuxWindowSummary],
    codex_sessions: list[CodexSessionSummary],
) -> set[str]:
    ticket_ids: set[str] = set()
    for collection in (prs, worktrees, tmux_windows, codex_sessions):
        for item in collection:
            ticket_ids.update(item.get("ticketIds", []))
    return ticket_ids


def build_ticket_rows(
    *,
    prs: list[PullRequestSummary],
    linear_tickets: list[LinearTicketSummary],
    codex_sessions: list[CodexSessionSummary],
    tmux_windows: list[TmuxWindowSummary],
    worktrees: list[WorktreeSummary],
) -> list[TicketRow]:
    ticket_ids = set()
    for collection in (prs, linear_tickets, codex_sessions, tmux_windows, worktrees):
        for item in collection:
            if item.get("ticketId"):
                ticket_ids.add(item["ticketId"])
            ticket_ids.update(item.get("ticketIds", []))

    owner_backed_ticket_ids = {
        ticket["ticketId"]
        for ticket in linear_tickets
        if ticket.get("ticketId")
    }
    for pr in prs:
        owner_backed_ticket_ids.update(pr["ticketIds"])
    if owner_backed_ticket_ids:
        ticket_ids.intersection_update(owner_backed_ticket_ids)

    linear_by_id = {item["ticketId"]: item for item in linear_tickets}
    prs_by_id: dict[str, list[PullRequestSummary]] = defaultdict(list)
    sessions_by_id: dict[str, list[CodexSessionSummary]] = defaultdict(list)
    windows_by_id: dict[str, list[TmuxWindowSummary]] = defaultdict(list)
    worktrees_by_id: dict[str, list[WorktreeSummary]] = defaultdict(list)

    for pr in prs:
        for ticket_id in pr["ticketIds"]:
            prs_by_id[ticket_id].append(pr)
    for session in codex_sessions:
        for ticket_id in session["ticketIds"]:
            sessions_by_id[ticket_id].append(session)
    for window in tmux_windows:
        for ticket_id in window["ticketIds"]:
            windows_by_id[ticket_id].append(window)
    for worktree in worktrees:
        for ticket_id in worktree["ticketIds"]:
            worktrees_by_id[ticket_id].append(worktree)

    rows = [
        build_ticket_row(
            ticket_id,
            linear_by_id.get(ticket_id),
            prs_by_id[ticket_id],
            sessions_by_id[ticket_id],
            windows_by_id[ticket_id],
            worktrees_by_id[ticket_id],
        )
        for ticket_id in ticket_ids
    ]
    return sorted(rows, key=ticket_sort_key)


def build_ticket_row(
    ticket_id: str,
    linear: LinearTicketSummary | None,
    prs: list[PullRequestSummary],
    sessions: list[CodexSessionSummary],
    windows: list[TmuxWindowSummary],
    worktrees: list[WorktreeSummary],
) -> TicketRow:
    branches = sorted(
        {
            value
            for value in [
                *(pr["headRefName"] for pr in prs),
                *(session.get("gitBranch") for session in sessions),
                *(worktree.get("branch") for worktree in worktrees),
                linear.get("branchName") if linear else None,
            ]
            if value
        }
    )
    state, next_action, risk = classify_ticket(linear, prs, sessions, worktrees)
    return {
        "ticketId": ticket_id,
        "title": linear.get("title") if linear else (prs[0]["title"] if prs else None),
        "prNumbers": [pr["number"] for pr in prs],
        "windows": [f"{window['session']}:{window['index']}" for window in windows],
        "worktrees": [worktree["path"] for worktree in worktrees],
        "branches": branches,
        "state": state,
        "nextAction": next_action,
        "risk": risk,
    }


def classify_ticket(
    linear: LinearTicketSummary | None,
    prs: list[PullRequestSummary],
    sessions: list[CodexSessionSummary],
    worktrees: list[WorktreeSummary],
) -> tuple[str, str, str]:
    if any(pr["checkSummary"]["state"] == "red" for pr in prs):
        return "blocked", "Fix failing PR checks", "high"
    if any(str(session.get("goalStatus") or "").lower() == "blocked" for session in sessions):
        return "blocked", "Unblock Codex session", "high"
    if any(
        pr["reviewComments"]
        or pr["reviewRequests"]
        or pr.get("reviewDecision") == "REVIEW_REQUIRED"
        for pr in prs
    ):
        return "review", "Address review activity", "medium"
    if any(
        pr["checkSummary"]["state"] == "green"
        and pr.get("reviewDecision") == "APPROVED"
        and not pr["isDraft"]
        for pr in prs
    ):
        return "green", "Ready to merge", "low"
    if any(session["status"] in {"running", "goal-active"} for session in sessions):
        return "active", "Codex work is running", "medium"
    if any((worktree.get("dirtyCount") or 0) > 0 for worktree in worktrees):
        return "active", "Review local worktree changes", "medium"
    if any(pr["checkSummary"]["state"] == "pending" for pr in prs):
        return "active", "Wait for checks", "medium"
    if linear and str(linear.get("stateType") or "").lower() in {"started", "unstarted"}:
        return "active", f"Linear state: {linear.get('stateName')}", "low"
    return "quiet", "No immediate action", "low"


def ticket_sort_key(ticket: TicketRow) -> tuple[int, str]:
    rank = {"blocked": 0, "review": 1, "active": 2, "green": 3, "quiet": 4}
    return rank.get(ticket["state"], 9), ticket["ticketId"]
