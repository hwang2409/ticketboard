from __future__ import annotations

import hashlib
import os
import sqlite3
import threading
from pathlib import Path
from typing import Any

import orjson

SCHEMA_VERSION = 1
KNOWN_CACHE_FILES = (
    "dashboard-cache.json",
    "pr-list-cache.json",
    "pr-detail-cache.json",
    "pr-diff-cache.json",
    "linear-cache.json",
    "worktree-cache.json",
    "codex-summary-cache.json",
)

_INIT_LOCK = threading.Lock()
_INITIALIZED: set[Path] = set()
_PAYLOAD_CACHE: dict[tuple[Path, str], Any] = {}
MAX_PAYLOAD_CACHE = 32


def default_cache_dir() -> Path:
    return Path(os.environ.get("CODEX_HOME", "~/.codex")).expanduser() / "ticketboard"


def database_path(cache_dir: Path | None = None) -> Path:
    configured = os.environ.get("TICKETBOARD_DB_PATH", "").strip()
    if configured:
        return Path(configured).expanduser()
    return (cache_dir or default_cache_dir()) / "ticketboard.db"


def initialize_cache_database(db_path: Path, cache_dir: Path) -> None:
    ensure_database(db_path)
    if cache_payload_count(db_path) > 0:
        return
    for cache_name in KNOWN_CACHE_FILES:
        path = cache_dir / cache_name
        payload = load_legacy_json(path)
        if payload is not None:
            save_cache_payload(path, payload, db_path=db_path)


def load_cache_payload(path: Path) -> Any | None:
    cache_name = path.name
    db_path = database_path(path.parent)
    memory_key = (db_path, cache_name)
    if memory_key in _PAYLOAD_CACHE:
        return _PAYLOAD_CACHE[memory_key]
    try:
        ensure_database(db_path)
        with connect(db_path) as connection:
            row = connection.execute(
                "SELECT data FROM cache_payloads WHERE cache_name = ?",
                (cache_name,),
            ).fetchone()
        if row:
            payload = orjson.loads(row["data"])
            remember_payload(memory_key, payload)
            return payload
    except Exception:
        return load_legacy_json(path)

    payload = load_legacy_json(path)
    if payload is not None:
        save_cache_payload(path, payload, db_path=db_path)
    return payload


def save_cache_payload(path: Path, payload: Any, *, db_path: Path | None = None) -> None:
    db_path = db_path or database_path(path.parent)
    cache_name = path.name
    saved_at = payload_saved_at(payload)
    try:
        ensure_database(db_path)
        encoded = orjson.dumps(payload)
        with connect(db_path) as connection:
            connection.execute("BEGIN")
            connection.execute(
                """
                INSERT INTO cache_payloads (cache_name, data, saved_at)
                VALUES (?, ?, ?)
                ON CONFLICT(cache_name) DO UPDATE SET
                    data = excluded.data,
                    saved_at = excluded.saved_at
                """,
                (cache_name, encoded, saved_at),
            )
            normalize_cache_payload(connection, cache_name, payload, saved_at)
            connection.commit()
        remember_payload((db_path, cache_name), payload)
    except Exception:
        return


def cache_payload_count(db_path: Path) -> int:
    try:
        with connect(db_path) as connection:
            row = connection.execute("SELECT COUNT(*) AS count FROM cache_payloads").fetchone()
        return int(row["count"]) if row else 0
    except Exception:
        return 0


def ensure_database(db_path: Path) -> None:
    resolved = db_path.expanduser()
    if resolved in _INITIALIZED:
        return
    with _INIT_LOCK:
        if resolved in _INITIALIZED:
            return
        resolved.parent.mkdir(parents=True, exist_ok=True)
        with connect(resolved) as connection:
            connection.executescript(SCHEMA)
            connection.execute(
                """
                INSERT INTO schema_migrations (version, applied_at)
                VALUES (?, datetime('now'))
                ON CONFLICT(version) DO NOTHING
                """,
                (SCHEMA_VERSION,),
            )
        _INITIALIZED.add(resolved)


def connect(db_path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(db_path, timeout=5)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode = WAL")
    connection.execute("PRAGMA synchronous = NORMAL")
    connection.execute("PRAGMA busy_timeout = 5000")
    return connection


def load_legacy_json(path: Path) -> Any | None:
    try:
        return orjson.loads(path.read_bytes())
    except Exception:
        return None


def remember_payload(memory_key: tuple[Path, str], payload: Any) -> None:
    _PAYLOAD_CACHE[memory_key] = payload
    while len(_PAYLOAD_CACHE) > MAX_PAYLOAD_CACHE:
        _PAYLOAD_CACHE.pop(next(iter(_PAYLOAD_CACHE)))


def payload_saved_at(payload: Any) -> str:
    if isinstance(payload, dict):
        saved_at = payload.get("savedAt")
        if isinstance(saved_at, str):
            return saved_at
    return ""


def normalize_cache_payload(
    connection: sqlite3.Connection,
    cache_name: str,
    payload: Any,
    saved_at: str,
) -> None:
    if not isinstance(payload, dict):
        return
    if cache_name == "dashboard-cache.json":
        save_dashboard_snapshot(connection, cache_name, payload, saved_at)
    elif cache_name == "pr-list-cache.json":
        save_pr_list(connection, cache_name, payload, saved_at)
    elif cache_name == "pr-detail-cache.json":
        save_pr_details(connection, cache_name, payload)
    elif cache_name == "pr-diff-cache.json":
        save_pr_diffs(connection, cache_name, payload)
    elif cache_name == "linear-cache.json":
        save_linear_cache(connection, cache_name, payload, saved_at)
    elif cache_name == "worktree-cache.json":
        save_worktree_cache(connection, cache_name, payload, saved_at)
    elif cache_name == "codex-summary-cache.json":
        save_codex_summary_cache(connection, cache_name, payload)


def save_dashboard_snapshot(
    connection: sqlite3.Connection,
    cache_name: str,
    payload: dict[str, Any],
    saved_at: str,
) -> None:
    data = payload.get("data")
    if not isinstance(data, dict):
        return
    repo = data.get("repo") if isinstance(data.get("repo"), dict) else {}
    scope = data.get("scope") if isinstance(data.get("scope"), dict) else {}
    scope_key = stable_key({"repo": repo, "scope": scope})
    connection.execute("DELETE FROM dashboard_snapshots WHERE cache_name = ?", (cache_name,))
    connection.execute(
        """
        INSERT INTO dashboard_snapshots (
            cache_name, scope_key, repo_name, repo_path, etag, data, saved_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            cache_name,
            scope_key,
            str(repo.get("nameWithOwner") or ""),
            str(repo.get("path") or ""),
            str(payload.get("etag") or ""),
            orjson.dumps(data),
            saved_at,
        ),
    )


def save_pr_list(
    connection: sqlite3.Connection,
    cache_name: str,
    payload: dict[str, Any],
    saved_at: str,
) -> None:
    cache_key = str(payload.get("cacheKey") or "")
    repo, owner_login = parse_pr_list_cache_key(cache_key)
    prs = payload.get("prs")
    if not isinstance(prs, list):
        return
    connection.execute("DELETE FROM github_prs WHERE cache_name = ?", (cache_name,))
    for pr in prs:
        if isinstance(pr, dict):
            upsert_github_pr(connection, cache_name, repo, owner_login, pr, saved_at)


def save_pr_details(
    connection: sqlite3.Connection,
    cache_name: str,
    payload: dict[str, Any],
) -> None:
    entries = payload.get("entries")
    if not isinstance(entries, dict):
        return
    connection.execute("DELETE FROM pr_details WHERE cache_name = ?", (cache_name,))
    for cache_key, entry in entries.items():
        if not isinstance(entry, dict):
            continue
        pr = entry.get("pr")
        if not isinstance(pr, dict):
            continue
        repo, number = parse_pr_cache_key(str(cache_key))
        saved_at = str(entry.get("savedAt") or "")
        connection.execute(
            """
            INSERT INTO pr_details (
                cache_name, cache_key, repo, number, updated_at, data, saved_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                cache_name,
                str(cache_key),
                repo,
                number,
                str(entry.get("updatedAt") or pr.get("updatedAt") or ""),
                orjson.dumps(pr),
                saved_at,
            ),
        )
        upsert_github_pr(
            connection,
            cache_name,
            repo,
            normalize_owner_name(pr.get("author")),
            pr,
            saved_at,
        )


def save_pr_diffs(
    connection: sqlite3.Connection,
    cache_name: str,
    payload: dict[str, Any],
) -> None:
    entries = payload.get("entries")
    if not isinstance(entries, dict):
        return
    connection.execute("DELETE FROM pr_diffs WHERE cache_name = ?", (cache_name,))
    for cache_key, entry in entries.items():
        if not isinstance(entry, dict):
            continue
        diff = entry.get("diff")
        if not isinstance(diff, dict):
            continue
        repo, number = parse_pr_cache_key(str(cache_key))
        connection.execute(
            """
            INSERT INTO pr_diffs (
                cache_name, cache_key, repo, number, updated_at, data, saved_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                cache_name,
                str(cache_key),
                repo,
                number,
                str(entry.get("updatedAt") or ""),
                orjson.dumps(diff),
                str(entry.get("savedAt") or ""),
            ),
        )


def upsert_github_pr(
    connection: sqlite3.Connection,
    cache_name: str,
    repo: str,
    owner_login: str,
    pr: dict[str, Any],
    saved_at: str,
) -> None:
    number = pr.get("number")
    if not isinstance(number, int):
        return
    connection.execute(
        """
        INSERT INTO github_prs (
            cache_name, repo, number, owner_login, updated_at, detail_level, data, saved_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cache_name, repo, number) DO UPDATE SET
            owner_login = excluded.owner_login,
            updated_at = excluded.updated_at,
            detail_level = excluded.detail_level,
            data = excluded.data,
            saved_at = excluded.saved_at
        """,
        (
            cache_name,
            repo,
            number,
            owner_login,
            str(pr.get("updatedAt") or ""),
            str(pr.get("detailLevel") or "summary"),
            orjson.dumps(pr),
            saved_at,
        ),
    )


def save_linear_cache(
    connection: sqlite3.Connection,
    cache_name: str,
    payload: dict[str, Any],
    saved_at: str,
) -> None:
    owner_names = sorted(
        normalize_owner_name(value)
        for value in payload.get("ownerNames", [])
        if normalize_owner_name(value)
    )
    scope_key = ",".join(owner_names)
    tickets = payload.get("tickets")
    ignored = payload.get("ignoredTicketIds")
    connection.execute("DELETE FROM linear_tickets WHERE cache_name = ?", (cache_name,))
    connection.execute(
        "DELETE FROM linear_ignored_tickets WHERE cache_name = ?",
        (cache_name,),
    )
    if isinstance(tickets, list):
        for ticket in tickets:
            if isinstance(ticket, dict) and ticket.get("ticketId"):
                connection.execute(
                    """
                    INSERT INTO linear_tickets (
                        cache_name, scope_key, ticket_id, updated_at, state_type,
                        assignee_id, assignee_email, assignee_name, detail_level,
                        data, saved_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        cache_name,
                        scope_key,
                        normalize_ticket_id(ticket["ticketId"]),
                        str(ticket.get("updatedAt") or ""),
                        str(ticket.get("stateType") or ""),
                        str(ticket.get("assigneeId") or ""),
                        str(ticket.get("assigneeEmail") or ""),
                        str(ticket.get("assigneeName") or ticket.get("assignee") or ""),
                        str(ticket.get("detailLevel") or "summary"),
                        orjson.dumps(ticket),
                        saved_at,
                    ),
                )
    if isinstance(ignored, list):
        for ticket_id in ignored:
            if ticket_id:
                connection.execute(
                    """
                    INSERT INTO linear_ignored_tickets (
                        cache_name, scope_key, ticket_id, saved_at
                    )
                    VALUES (?, ?, ?, ?)
                    """,
                    (cache_name, scope_key, normalize_ticket_id(ticket_id), saved_at),
                )


def save_worktree_cache(
    connection: sqlite3.Connection,
    cache_name: str,
    payload: dict[str, Any],
    saved_at: str,
) -> None:
    cache_key = str(payload.get("cacheKey") or "")
    worktrees = payload.get("worktrees")
    if not isinstance(worktrees, list):
        return
    connection.execute("DELETE FROM worktrees WHERE cache_name = ?", (cache_name,))
    for worktree in worktrees:
        if not isinstance(worktree, dict) or not worktree.get("path"):
            continue
        connection.execute(
            """
            INSERT INTO worktrees (
                cache_name, cache_key, path, branch, head, dirty_count, data, saved_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                cache_name,
                cache_key,
                str(worktree.get("path") or ""),
                str(worktree.get("branch") or ""),
                str(worktree.get("head") or ""),
                (
                    int(worktree["dirtyCount"])
                    if isinstance(worktree.get("dirtyCount"), int)
                    else None
                ),
                orjson.dumps(worktree),
                saved_at,
            ),
        )


def save_codex_summary_cache(
    connection: sqlite3.Connection,
    cache_name: str,
    payload: dict[str, Any],
) -> None:
    entries = payload.get("entries")
    if not isinstance(entries, dict):
        return
    connection.execute("DELETE FROM codex_sessions WHERE cache_name = ?", (cache_name,))
    for path, entry in entries.items():
        if not isinstance(entry, dict):
            continue
        summary = entry.get("summary")
        if not isinstance(summary, dict) or not summary.get("threadId"):
            continue
        connection.execute(
            """
            INSERT INTO codex_sessions (
                cache_name, path, thread_id, cache_key, cwd, git_branch, status,
                updated_at, data, saved_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                cache_name,
                str(path),
                str(summary.get("threadId") or ""),
                orjson.dumps(entry.get("cacheKey")),
                str(summary.get("cwd") or ""),
                str(summary.get("gitBranch") or ""),
                str(summary.get("status") or ""),
                str(summary.get("updatedAt") or ""),
                orjson.dumps(summary),
                str(entry.get("savedAt") or ""),
            ),
        )


def parse_pr_list_cache_key(cache_key: str) -> tuple[str, str]:
    parts = cache_key.rsplit(":", 2)
    if len(parts) == 3:
        return parts[0], normalize_owner_name(parts[2])
    return "", ""


def parse_pr_cache_key(cache_key: str) -> tuple[str, int | None]:
    repo, separator, number = cache_key.rpartition(":")
    if not separator:
        return "", None
    try:
        return repo, int(number)
    except ValueError:
        return repo, None


def normalize_owner_name(value: Any) -> str:
    return str(value or "").strip().lower()


def normalize_ticket_id(value: Any) -> str:
    return str(value or "").strip().upper()


def stable_key(value: Any) -> str:
    return hashlib.sha256(orjson.dumps(value, option=orjson.OPT_SORT_KEYS)).hexdigest()


SCHEMA = """
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cache_payloads (
    cache_name TEXT PRIMARY KEY,
    data BLOB NOT NULL,
    saved_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dashboard_snapshots (
    cache_name TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    repo_name TEXT NOT NULL,
    repo_path TEXT NOT NULL,
    etag TEXT NOT NULL,
    data BLOB NOT NULL,
    saved_at TEXT NOT NULL,
    PRIMARY KEY (cache_name, scope_key)
);

CREATE TABLE IF NOT EXISTS github_prs (
    cache_name TEXT NOT NULL,
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    owner_login TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    detail_level TEXT NOT NULL,
    data BLOB NOT NULL,
    saved_at TEXT NOT NULL,
    PRIMARY KEY (cache_name, repo, number)
);
CREATE INDEX IF NOT EXISTS idx_github_prs_owner_updated
    ON github_prs (repo, owner_login, updated_at);

CREATE TABLE IF NOT EXISTS pr_details (
    cache_name TEXT NOT NULL,
    cache_key TEXT NOT NULL,
    repo TEXT NOT NULL,
    number INTEGER,
    updated_at TEXT NOT NULL,
    data BLOB NOT NULL,
    saved_at TEXT NOT NULL,
    PRIMARY KEY (cache_name, cache_key)
);

CREATE TABLE IF NOT EXISTS pr_diffs (
    cache_name TEXT NOT NULL,
    cache_key TEXT NOT NULL,
    repo TEXT NOT NULL,
    number INTEGER,
    updated_at TEXT NOT NULL,
    data BLOB NOT NULL,
    saved_at TEXT NOT NULL,
    PRIMARY KEY (cache_name, cache_key)
);

CREATE TABLE IF NOT EXISTS linear_tickets (
    cache_name TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    ticket_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    state_type TEXT NOT NULL,
    assignee_id TEXT NOT NULL,
    assignee_email TEXT NOT NULL,
    assignee_name TEXT NOT NULL,
    detail_level TEXT NOT NULL,
    data BLOB NOT NULL,
    saved_at TEXT NOT NULL,
    PRIMARY KEY (cache_name, scope_key, ticket_id)
);
CREATE INDEX IF NOT EXISTS idx_linear_tickets_scope_updated
    ON linear_tickets (scope_key, updated_at);

CREATE TABLE IF NOT EXISTS linear_ignored_tickets (
    cache_name TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    ticket_id TEXT NOT NULL,
    saved_at TEXT NOT NULL,
    PRIMARY KEY (cache_name, scope_key, ticket_id)
);

CREATE TABLE IF NOT EXISTS worktrees (
    cache_name TEXT NOT NULL,
    cache_key TEXT NOT NULL,
    path TEXT NOT NULL,
    branch TEXT NOT NULL,
    head TEXT NOT NULL,
    dirty_count INTEGER,
    data BLOB NOT NULL,
    saved_at TEXT NOT NULL,
    PRIMARY KEY (cache_name, cache_key, path)
);

CREATE TABLE IF NOT EXISTS codex_sessions (
    cache_name TEXT NOT NULL,
    path TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    cache_key BLOB NOT NULL,
    cwd TEXT NOT NULL,
    git_branch TEXT NOT NULL,
    status TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    data BLOB NOT NULL,
    saved_at TEXT NOT NULL,
    PRIMARY KEY (cache_name, path)
);
CREATE INDEX IF NOT EXISTS idx_codex_sessions_thread_id
    ON codex_sessions (thread_id);
"""
