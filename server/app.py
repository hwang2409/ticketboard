from __future__ import annotations

import asyncio
import gzip
import hashlib
import os
import platform
import re
import shlex
import signal
import subprocess
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import orjson
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse

from .collectors import (
    Settings,
    close_persistent_clients,
    collect_codex_token_usage,
    collect_dashboard,
    fetch_check_log,
    fetch_codex_detail,
    fetch_linear_ticket_detail,
    fetch_pr_diff,
    fetch_pull_request_detail,
    fetch_tmux_preview,
    fetch_worktree_detail,
    invalidate_local_action_caches,
    load_json,
    make_settings,
    save_json,
    utc_now_iso,
)
from .store import initialize_cache_database
from .workflow_brief import (
    build_workflow_evidence_snapshot,
    save_workflow_evidence_snapshot,
    workflow_brief_path,
    workflow_brief_status,
)

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")


def app_port() -> int:
    return int(os.environ.get("PORT", "4317"))


class DashboardCache:
    def __init__(self) -> None:
        self.data: dict[str, Any] | None = None
        self.etag: str | None = None
        self.body: bytes | None = None
        self.gzip_body: bytes | None = None
        self.loaded_at = 0.0
        self.refresh_task: asyncio.Task[None] | None = None
        self.lock = asyncio.Lock()

    async def snapshot(
        self,
    ) -> tuple[dict[str, Any] | None, str | None, bytes | None, bytes | None, float, bool]:
        async with self.lock:
            refreshing = self.refresh_task is not None and not self.refresh_task.done()
            return (
                self.data,
                self.etag,
                self.body,
                self.gzip_body,
                self.loaded_at,
                refreshing,
            )

    async def start_refresh(self) -> asyncio.Task[None]:
        async with self.lock:
            if self.refresh_task and not self.refresh_task.done():
                return self.refresh_task
            self.refresh_task = asyncio.create_task(refresh_dashboard_cache())
            self.refresh_task.add_done_callback(consume_background_exception)
            return self.refresh_task

    async def restore(
        self,
        data: dict[str, Any],
        etag: str,
        body: bytes,
        gzip_body: bytes,
    ) -> None:
        async with self.lock:
            if self.data is None:
                self.data = data
                self.etag = etag
                self.body = body
                self.gzip_body = gzip_body
                self.loaded_at = 0.0


class ViteProxy:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.port = int(os.environ.get("TICKETBOARD_VITE_PORT", str(app_port() + 1)))
        self.process: subprocess.Popen[str] | None = None
        self.client = httpx.AsyncClient(timeout=30, follow_redirects=False)

    @property
    def origin(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    async def start(self) -> None:
        if frontend_mode(self.settings) != "vite":
            return
        if self.process and self.process.poll() is None:
            return
        env = {
            **os.environ,
            "VITE_PORT": str(self.port),
            "TICKETBOARD_VITE_HMR_PORT": str(self.port),
        }
        self.process = subprocess.Popen(
            [
                "pnpm",
                "exec",
                "vite",
                "--host",
                "127.0.0.1",
                "--port",
                str(self.port),
                "--strictPort",
            ],
            cwd=self.settings.root,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        await self.wait_until_ready()

    async def wait_until_ready(self) -> None:
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if self.process and self.process.poll() is not None:
                raise RuntimeError("Vite dev server exited")
            try:
                response = await self.client.get(self.origin)
                if response.status_code < 500:
                    return
            except httpx.HTTPError:
                await asyncio.sleep(0.2)
        raise RuntimeError("Vite dev server did not become ready")

    async def stop(self) -> None:
        await self.client.aclose()
        if not self.process or self.process.poll() is not None:
            return
        self.process.send_signal(signal.SIGTERM)
        try:
            await asyncio.to_thread(self.process.wait, 5)
        except subprocess.TimeoutExpired:
            self.process.kill()

    async def proxy(self, request: Request, path: str) -> Response:
        await self.start()
        query = request.url.query
        url = f"{self.origin}/{path}"
        if query:
            url = f"{url}?{query}"
        headers = {
            key: value
            for key, value in request.headers.items()
            if key.lower() not in {"host", "content-length", "accept-encoding"}
        }
        body = await request.body()
        upstream = await self.client.request(
            request.method,
            url,
            content=body,
            headers=headers,
        )
        response_headers = {
            key: value
            for key, value in upstream.headers.items()
            if key.lower()
            not in {
                "content-encoding",
                "content-length",
                "transfer-encoding",
                "connection",
            }
        }
        return Response(
            content=upstream.content,
            status_code=upstream.status_code,
            headers=response_headers,
            media_type=upstream.headers.get("content-type"),
        )


settings = make_settings()
dashboard_cache = DashboardCache()
vite_proxy = ViteProxy(settings)
JSON_GZIP_MIN_BYTES = 4_096
JSON_GZIP_COMPRESSLEVEL = 1
DASHBOARD_SNAPSHOT_VERSION = 7
WORKFLOW_ACTION_KINDS = {
    "focus-tmux",
    "launch-codex",
    "open-pr",
    "open-url",
    "open-worktree",
    "resume-codex",
    "start-lane",
}
MAX_ACTION_PROMPT_CHARS = 16_000


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    await asyncio.to_thread(
        initialize_cache_database,
        settings.db_path,
        settings.cache_dir,
    )
    if frontend_mode(settings) == "vite":
        await vite_proxy.start()
    try:
        yield
    finally:
        await vite_proxy.stop()
        await asyncio.to_thread(close_persistent_clients)


app = FastAPI(title="Ticketboard", lifespan=lifespan)


def json_response(
    data: Any,
    *,
    request: Request | None = None,
    headers: dict[str, str] | None = None,
    status_code: int = 200,
) -> Response:
    body = orjson.dumps(data)
    response_headers = dict(headers or {})
    if request and len(body) >= JSON_GZIP_MIN_BYTES and request_accepts_gzip(request):
        response_headers["Content-Encoding"] = "gzip"
        response_headers["Vary"] = "Accept-Encoding"
        body = gzip.compress(body, compresslevel=JSON_GZIP_COMPRESSLEVEL)
    return Response(
        content=body,
        headers=response_headers,
        media_type="application/json",
        status_code=status_code,
    )


def request_accepts_gzip(request: Request) -> bool:
    return "gzip" in request.headers.get("accept-encoding", "").lower()


def dashboard_response(
    request: Request,
    body: bytes,
    gzip_body: bytes,
    *,
    headers: dict[str, str] | None = None,
) -> Response:
    response_headers = dict(headers or {})
    if request_accepts_gzip(request):
        response_headers["Content-Encoding"] = "gzip"
        response_headers["Vary"] = "Accept-Encoding"
        return Response(
            content=gzip_body,
            headers=response_headers,
            media_type="application/json",
        )
    return Response(
        content=body,
        headers=response_headers,
        media_type="application/json",
    )


def dashboard_bodies(data: Any) -> tuple[bytes, bytes]:
    body = orjson.dumps(data)
    return body, gzip.compress(body, compresslevel=JSON_GZIP_COMPRESSLEVEL)


def dashboard_etag(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


async def refresh_dashboard_cache() -> None:
    try:
        data = await asyncio.to_thread(collect_dashboard, settings)
        body, gzip_body = dashboard_bodies(data)
        etag = dashboard_etag(body)
        await asyncio.to_thread(save_dashboard_snapshot, data, etag)
        loaded_at = time.monotonic()
        async with dashboard_cache.lock:
            dashboard_cache.data = data
            dashboard_cache.etag = etag
            dashboard_cache.body = body
            dashboard_cache.gzip_body = gzip_body
            dashboard_cache.loaded_at = loaded_at
    finally:
        current_task = asyncio.current_task()
        async with dashboard_cache.lock:
            if dashboard_cache.refresh_task is current_task:
                dashboard_cache.refresh_task = None


def consume_background_exception(task: asyncio.Task[None]) -> None:
    if not task.cancelled():
        task.exception()


@app.exception_handler(HTTPException)
async def http_exception_handler(_: Request, exc: HTTPException) -> JSONResponse:
    if isinstance(exc.detail, dict) and "error" in exc.detail:
        return JSONResponse(exc.detail, status_code=exc.status_code)
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)


@app.get("/api/dashboard")
async def api_dashboard(request: Request, refresh: str | None = None) -> Response:
    force = refresh == "1"
    ttl_seconds = int(os.environ.get("TICKETBOARD_DASHBOARD_TTL", "20"))
    data, etag, body, gzip_body, loaded_at, refreshing = await dashboard_cache.snapshot()

    if not force and data is None:
        snapshot = await asyncio.to_thread(load_dashboard_snapshot)
        if snapshot:
            data, etag = snapshot
            body, gzip_body = dashboard_bodies(data)
            etag = dashboard_etag(body)
            await dashboard_cache.restore(data, etag, body, gzip_body)
            await dashboard_cache.start_refresh()
            headers = {"ETag": etag, "X-Ticketboard-Refreshing": "1"}
            if request.headers.get("if-none-match") == etag:
                return Response(status_code=304, headers=headers)
            return dashboard_response(request, body, gzip_body, headers=headers)

    is_fresh = data is not None and time.monotonic() - loaded_at < ttl_seconds

    if force or data is None:
        refresh_task = await dashboard_cache.start_refresh()
        await refresh_task
        data, etag, body, gzip_body, loaded_at, refreshing = await dashboard_cache.snapshot()
        is_fresh = data is not None and time.monotonic() - loaded_at < ttl_seconds
    elif not is_fresh and not refreshing:
        await dashboard_cache.start_refresh()
        refreshing = True

    headers = {"ETag": etag or ""}
    if refreshing and not is_fresh:
        headers["X-Ticketboard-Refreshing"] = "1"
    if etag and request.headers.get("if-none-match") == etag and not force:
        return Response(status_code=304, headers=headers)
    if body is None or gzip_body is None:
        body, gzip_body = dashboard_bodies(data)
    return dashboard_response(request, body, gzip_body, headers=headers)


@app.get("/api/workflow-brief")
async def api_workflow_brief(request: Request, refresh: str | None = None) -> Response:
    dashboard = await dashboard_for_brief(refresh == "1")
    return json_response(
        workflow_brief_status(settings, dashboard),
        request=request,
    )


@app.get("/api/workflow-brief/evidence-snapshot")
async def api_workflow_evidence_snapshot(
    request: Request,
    refresh: str | None = None,
    includePreviews: str | None = None,
) -> Response:
    dashboard = await dashboard_for_brief(refresh == "1")
    snapshot = build_workflow_evidence_snapshot(settings, dashboard)
    if includePreviews == "1":
        snapshot["tmuxPanePreviews"] = await tmux_pane_previews_for_brief(dashboard)
    path = await asyncio.to_thread(save_workflow_evidence_snapshot, settings, snapshot)
    return json_response(
        {
            "briefPath": str(workflow_brief_path(settings)),
            "path": str(path),
            "snapshot": snapshot,
        },
        request=request,
    )


async def dashboard_for_brief(force: bool) -> dict[str, Any]:
    if force:
        await refresh_dashboard_cache()
        data, *_ = await dashboard_cache.snapshot()
        if isinstance(data, dict):
            return data
    return await dashboard_for_action()


async def tmux_pane_previews_for_brief(dashboard: dict[str, Any]) -> list[dict[str, Any]]:
    windows = [
        window
        for window in dashboard.get("tmuxWindows", [])
        if isinstance(window, dict)
        and window.get("paneId")
        and (
            window.get("active")
            or window.get("ticketIds")
            or window.get("session") == "phoebe"
        )
    ][:12]
    previews = []
    for window in windows:
        pane_id = str(window.get("paneId"))
        try:
            preview = await asyncio.to_thread(fetch_tmux_preview, pane_id)
        except Exception as exc:
            previews.append(
                {
                    "error": str(exc),
                    "index": window.get("index"),
                    "name": window.get("name"),
                    "paneId": pane_id,
                    "session": window.get("session"),
                    "ticketIds": window.get("ticketIds", []),
                },
            )
            continue
        previews.append(
            {
                "index": window.get("index"),
                "name": window.get("name"),
                "paneId": pane_id,
                "preview": str(preview.get("panePreview") or "")[:8_000],
                "previewTruncated": bool(preview.get("panePreviewTruncated")),
                "session": window.get("session"),
                "ticketIds": window.get("ticketIds", []),
            },
        )
    return previews


def dashboard_snapshot_path() -> Path:
    return settings.cache_dir / "dashboard-cache.json"


def load_dashboard_snapshot() -> tuple[dict[str, Any], str] | None:
    payload = load_json(dashboard_snapshot_path())
    if not isinstance(payload, dict) or payload.get("version") != DASHBOARD_SNAPSHOT_VERSION:
        return None
    data = payload.get("data")
    etag = payload.get("etag")
    if not isinstance(data, dict) or not isinstance(etag, str) or not etag:
        return None
    if not dashboard_snapshot_matches_settings(data):
        return None
    return data, etag


def dashboard_snapshot_matches_settings(data: dict[str, Any]) -> bool:
    repo = data.get("repo")
    if not isinstance(repo, dict):
        return False
    if repo.get("nameWithOwner") != settings.repo_name:
        return False
    if repo.get("path") != str(settings.repo_path):
        return False

    scope = data.get("scope")
    if not isinstance(scope, dict):
        return False

    github_login = os.environ.get("TICKETBOARD_GITHUB_LOGIN", "").strip().lower()
    if github_login and str(scope.get("githubLogin") or "").strip().lower() != github_login:
        return False
    scoped_github_login = str(scope.get("githubLogin") or "").strip().lower()
    prs = data.get("prs")
    if isinstance(prs, list):
        for pr in prs:
            if not isinstance(pr, dict):
                return False
            author = str(pr.get("author") or "").strip().lower()
            if author and scoped_github_login and author != scoped_github_login:
                return False
            if author and not scoped_github_login:
                return False

    linear_owners = env_owner_set("TICKETBOARD_LINEAR_ASSIGNEE")
    scoped_linear_owners: set[str] = set()
    cached = scope.get("linearOwners")
    if isinstance(cached, list):
        scoped_linear_owners = {
            str(value).strip().lower()
            for value in cached
            if str(value).strip()
        }
    if linear_owners:
        if not isinstance(cached, list):
            return False
        if not linear_owners.issubset(scoped_linear_owners):
            return False
    linear_tickets = data.get("linearTickets")
    if isinstance(linear_tickets, list):
        for ticket in linear_tickets:
            if not isinstance(ticket, dict):
                return False
            if scoped_linear_owners and not snapshot_linear_ticket_matches_owner(
                ticket,
                scoped_linear_owners,
            ):
                return False
            if not scoped_linear_owners and ticket.get("ticketId"):
                return False

    return True


def env_owner_set(name: str) -> set[str]:
    return {
        value.strip().lower()
        for value in os.environ.get(name, "").split(",")
        if value.strip()
    }


def snapshot_linear_ticket_matches_owner(
    ticket: dict[str, Any],
    owner_names: set[str],
) -> bool:
    ticket_owner_tokens = {
        normalized
        for key in ("assigneeId", "assigneeEmail", "assigneeName", "assignee")
        if (normalized := str(ticket.get(key) or "").strip().lower())
    }
    return not owner_names.isdisjoint(ticket_owner_tokens)


def save_dashboard_snapshot(data: dict[str, Any], etag: str) -> None:
    save_json(
        dashboard_snapshot_path(),
        {
            "version": DASHBOARD_SNAPSHOT_VERSION,
            "etag": etag,
            "savedAt": time.time(),
            "data": data,
        },
    )


@app.get("/api/pr/{number}/detail")
async def api_pr_detail(request: Request, number: int) -> Response:
    try:
        return json_response(
            await asyncio.to_thread(fetch_pull_request_detail, settings, number),
            request=request,
        )
    except Exception as exc:
        raise api_error(exc, f"Unable to load PR #{number}") from exc


@app.get("/api/pr/{number}/diff")
async def api_pr_diff(request: Request, number: int) -> Response:
    try:
        return json_response(
            await asyncio.to_thread(fetch_pr_diff, settings, number),
            request=request,
        )
    except Exception as exc:
        raise api_error(exc, f"Unable to load diff for PR #{number}") from exc


@app.get("/api/pr/{number}/check-log")
async def api_check_log(request: Request, number: int, checkKey: str) -> Response:
    try:
        return json_response(
            await asyncio.to_thread(fetch_check_log, settings, number, checkKey),
            request=request,
        )
    except Exception as exc:
        raise api_error(exc, f"Unable to load check log for PR #{number}") from exc


@app.get("/api/linear/{ticket_id}/detail")
async def api_linear_detail(request: Request, ticket_id: str) -> Response:
    data = dashboard_cache.data
    normalized = ticket_id.upper()
    if data:
        for ticket in data.get("linearTickets", []):
            if (
                ticket.get("ticketId") == normalized
                and ticket.get("detailLevel") == "full"
            ):
                return json_response(ticket, request=request)

    try:
        return json_response(
            await asyncio.to_thread(fetch_linear_ticket_detail, settings, normalized),
            request=request,
        )
    except Exception as exc:
        raise api_error(exc, f"Unable to load Linear issue {normalized}") from exc


@app.get("/api/worktree/detail")
async def api_worktree_detail(request: Request, path: str) -> Response:
    try:
        return json_response(
            await asyncio.to_thread(fetch_worktree_detail, path),
            request=request,
        )
    except Exception as exc:
        raise api_error(exc, "Unable to load worktree detail") from exc


@app.get("/api/codex-session/{thread_id}/detail")
async def api_codex_detail(request: Request, thread_id: str) -> Response:
    try:
        return json_response(
            await asyncio.to_thread(fetch_codex_detail, settings, thread_id),
            request=request,
        )
    except Exception as exc:
        raise api_error(exc, "Unable to load Codex session detail") from exc


@app.get("/api/tokens")
async def api_tokens(request: Request) -> Response:
    try:
        return json_response(
            await asyncio.to_thread(collect_codex_token_usage, settings),
            request=request,
        )
    except Exception as exc:
        raise api_error(exc, "Unable to load token usage") from exc


@app.get("/api/tmux-pane/{pane_id}/preview")
async def api_tmux_preview(request: Request, pane_id: str) -> Response:
    try:
        return json_response(
            await asyncio.to_thread(fetch_tmux_preview, pane_id),
            request=request,
        )
    except Exception as exc:
        raise api_error(exc, "Unable to load tmux pane preview") from exc


def user_state_path() -> Path:
    return settings.cache_dir / "user-state.json"


def load_user_state() -> dict[str, Any]:
    data = load_json(user_state_path())
    if isinstance(data, dict):
        dismissed = data.get("dismissed")
        if isinstance(dismissed, dict):
            return {"dismissed": dismissed}
    return {"dismissed": {}}


@app.get("/api/user-state")
async def api_user_state_get(request: Request) -> Response:
    return json_response(load_user_state(), request=request)


@app.post("/api/user-state/dismiss")
async def api_user_state_dismiss(payload: dict[str, Any]) -> Response:
    action_id = str(payload.get("id") or "").strip()
    kind = str(payload.get("kind") or "").strip()
    if not action_id:
        raise HTTPException(status_code=400, detail={"error": "Missing id"})
    if kind not in ("snooze", "dismiss"):
        raise HTTPException(status_code=400, detail={"error": "Invalid kind"})
    state = load_user_state()
    now = datetime.now(tz=UTC)
    until = (now + timedelta(hours=24)).isoformat() if kind == "snooze" else None
    created = now.isoformat()
    state["dismissed"][action_id] = {
        "kind": kind,
        "until": until,
        "createdAt": created,
    }
    save_json(user_state_path(), state)
    return JSONResponse(state)


@app.delete("/api/user-state/dismiss/{action_id:path}")
async def api_user_state_undismiss(action_id: str) -> Response:
    state = load_user_state()
    if action_id in state["dismissed"]:
        del state["dismissed"][action_id]
        save_json(user_state_path(), state)
    return JSONResponse(state)


@app.post("/api/workflow-action")
async def api_workflow_action(payload: dict[str, Any], request: Request) -> Response:
    try:
        dashboard = await dashboard_for_action()
        result = await asyncio.to_thread(run_workflow_action, dashboard, payload)
        return json_response(result, request=request)
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
    except Exception as exc:
        raise api_error(exc, "Unable to run workflow action") from exc


async def dashboard_for_action() -> dict[str, Any]:
    data, *_ = await dashboard_cache.snapshot()
    if isinstance(data, dict):
        return data
    snapshot = await asyncio.to_thread(load_dashboard_snapshot)
    if snapshot:
        return snapshot[0]
    return await asyncio.to_thread(collect_dashboard, settings)


def run_workflow_action(
    dashboard: dict[str, Any],
    payload: dict[str, Any],
) -> dict[str, Any]:
    kind = str(payload.get("kind") or "").strip()
    if kind not in WORKFLOW_ACTION_KINDS:
        raise ValueError("Invalid workflow action")
    dry_run = bool(payload.get("dryRun"))

    if kind == "focus-tmux":
        session = str(payload.get("session") or "").strip()
        index = int(payload.get("index"))
        require_known_tmux_window(dashboard, session, index)
        command = ["tmux", "select-window", "-t", f"{session}:{index}"]
        output = "" if dry_run else run_action_command(command)
        return action_result(
            command,
            dry_run=dry_run,
            message=f"Focused tmux window {session}:{index}.",
            output=output,
        )

    if kind == "open-pr":
        number = int(payload.get("prNumber"))
        require_known_pr(dashboard, number)
        command = ["gh", "pr", "view", str(number), "--web"]
        output = "" if dry_run else run_action_command(command, cwd=settings.repo_path)
        return action_result(
            command,
            dry_run=dry_run,
            message=f"Opened PR #{number}.",
            output=output,
        )

    if kind == "open-url":
        url = str(payload.get("url") or "").strip()
        require_known_url(dashboard, url)
        command = opener_command(url)
        output = "" if dry_run else run_action_command(command)
        return action_result(
            command,
            dry_run=dry_run,
            message="Opened the linked source.",
            output=output,
        )

    if kind == "open-worktree":
        path = require_known_path(dashboard, payload.get("path"))
        command = opener_command(str(path))
        output = "" if dry_run else run_action_command(command)
        return action_result(
            command,
            dry_run=dry_run,
            message=f"Opened {short_action_path(path)}.",
            output=output,
        )

    if kind == "resume-codex":
        thread_id = str(payload.get("threadId") or "").strip()
        require_known_session(dashboard, thread_id)
        cwd = require_known_path(dashboard, payload.get("cwd"))
        prompt = action_prompt(payload)
        title = action_title(payload, fallback=thread_id[:8] or "codex")
        session_name = workflow_tmux_session(dashboard)
        command = codex_tmux_command(
            session_name=session_name,
            window_name=title,
            cwd=cwd,
            codex_command=codex_resume_command(thread_id, cwd, prompt),
        )
        output = "" if dry_run else launch_tmux_codex(command, session_name, cwd)
        if not dry_run:
            invalidate_local_action_caches()
        return action_result(
            command,
            dry_run=dry_run,
            message=f"Resumed Codex in tmux session {session_name}.",
            output=output,
        )

    if kind == "start-lane":
        ticket_id = optional_ticket_id(payload)
        if not ticket_id:
            raise ValueError("Missing Linear ticket")
        ticket = require_known_ticket(dashboard, ticket_id)
        prompt = action_prompt(payload)
        branch = start_lane_branch(payload, ticket)
        worktree_path = start_lane_path(payload, ticket_id)
        title = action_title(payload, fallback=ticket_id)
        session_name = workflow_tmux_session(dashboard)
        worktree_command = worktree_add_command(settings.repo_path, worktree_path, branch)
        codex_command = codex_tmux_command(
            session_name=session_name,
            window_name=title,
            cwd=worktree_path,
            codex_command=codex_launch_command(worktree_path, prompt),
        )
        commands = [worktree_command, codex_command]
        output = ""
        if not dry_run:
            ensure_worktree_lane(settings.repo_path, worktree_path, branch)
            output = launch_tmux_codex(codex_command, session_name, worktree_path)
            invalidate_local_action_caches()
        return action_plan_result(
            commands,
            dry_run=dry_run,
            message=(
                f"Started {ticket_id} in {short_action_path(worktree_path)} "
                f"and launched Codex in {session_name}."
            ),
            output=output,
        )

    ticket_id = optional_ticket_id(payload)
    if ticket_id:
        require_known_ticket(dashboard, ticket_id)
    pr_number = optional_pr_number(payload)
    if pr_number is not None:
        require_known_pr(dashboard, pr_number)
    cwd = require_known_path(dashboard, payload.get("cwd"))
    prompt = action_prompt(payload)
    fallback_title = ticket_id or (f"pr-{pr_number}" if pr_number else "codex")
    title = action_title(payload, fallback=fallback_title)
    session_name = workflow_tmux_session(dashboard)
    command = codex_tmux_command(
        session_name=session_name,
        window_name=title,
        cwd=cwd,
        codex_command=codex_launch_command(cwd, prompt),
    )
    output = "" if dry_run else launch_tmux_codex(command, session_name, cwd)
    if not dry_run:
        invalidate_local_action_caches()
    return action_result(
        command,
        dry_run=dry_run,
        message=f"Started Codex in tmux session {session_name}.",
        output=output,
    )


def optional_ticket_id(payload: dict[str, Any]) -> str | None:
    value = str(payload.get("ticketId") or "").strip().upper()
    return value or None


def start_lane_branch(payload: dict[str, Any], ticket: dict[str, Any]) -> str:
    branch = str(payload.get("branchName") or ticket.get("branchName") or "").strip()
    if not branch:
        title = str(payload.get("ticketTitle") or ticket.get("title") or "").strip()
        branch = ticket_branch_slug(str(ticket["ticketId"]), title)
    validate_git_branch(branch)
    return branch


def ticket_branch_slug(ticket_id: str, title: str) -> str:
    title_slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    suffix = f"-{title_slug[:48].strip('-')}" if title_slug else ""
    return f"{ticket_id.lower()}{suffix}"


def start_lane_path(payload: dict[str, Any], ticket_id: str) -> Path:
    raw_path = payload.get("path")
    if raw_path:
        path = Path(str(raw_path)).expanduser().resolve(strict=False)
        root = worktree_root().resolve(strict=False)
        if path != root and root not in path.parents:
            raise ValueError("Start lane path must be inside the configured worktree root")
        return path
    return worktree_root() / ticket_id.lower()


def worktree_root() -> Path:
    configured = os.environ.get("TICKETBOARD_WORKTREE_ROOT", "").strip()
    if configured:
        return Path(configured).expanduser().resolve(strict=False)
    return settings.repo_path.expanduser().resolve(strict=False) / ".codex" / "worktrees"


def validate_git_branch(branch: str) -> None:
    if not branch or branch.startswith("-"):
        raise ValueError("Invalid branch name")
    run_action_command(
        ["git", "-C", str(settings.repo_path), "check-ref-format", "--branch", branch],
        timeout=8,
    )


def worktree_add_command(repo_path: Path, worktree_path: Path, branch: str) -> list[str]:
    return [
        "git",
        "-C",
        str(repo_path),
        "worktree",
        "add",
        "-b",
        branch,
        str(worktree_path),
        "HEAD",
    ]


def ensure_worktree_lane(repo_path: Path, worktree_path: Path, branch: str) -> None:
    worktree_path.parent.mkdir(parents=True, exist_ok=True)
    if worktree_path.exists():
        if not worktree_path.is_dir():
            raise ValueError(f"Worktree path is not a directory: {worktree_path}")
        try:
            current_root = run_action_command(
                ["git", "-C", str(worktree_path), "rev-parse", "--show-toplevel"],
                timeout=8,
            )
        except Exception as exc:
            raise ValueError(
                f"Worktree path exists but is not a git worktree: {worktree_path}"
            ) from exc
        if Path(current_root).resolve(strict=False) != worktree_path.resolve(strict=False):
            raise ValueError(f"Unexpected git root for worktree path: {current_root}")
        return

    if local_branch_exists(repo_path, branch):
        run_action_command(
            ["git", "-C", str(repo_path), "worktree", "add", str(worktree_path), branch],
            timeout=45,
        )
        return

    remote = remote_branch_ref(repo_path, branch)
    if remote:
        run_action_command(
            [
                "git",
                "-C",
                str(repo_path),
                "worktree",
                "add",
                "-b",
                branch,
                str(worktree_path),
                remote,
            ],
            timeout=45,
        )
        return

    run_action_command(worktree_add_command(repo_path, worktree_path, branch), timeout=45)


def local_branch_exists(repo_path: Path, branch: str) -> bool:
    result = subprocess.run(
        [
            "git",
            "-C",
            str(repo_path),
            "show-ref",
            "--verify",
            "--quiet",
            f"refs/heads/{branch}",
        ],
        text=True,
        capture_output=True,
        timeout=8,
        check=False,
    )
    return result.returncode == 0


def remote_branch_ref(repo_path: Path, branch: str) -> str | None:
    for remote in ("origin",):
        ref = f"refs/remotes/{remote}/{branch}"
        result = subprocess.run(
            ["git", "-C", str(repo_path), "show-ref", "--verify", "--quiet", ref],
            text=True,
            capture_output=True,
            timeout=8,
            check=False,
        )
        if result.returncode == 0:
            return f"{remote}/{branch}"
    return None


def optional_pr_number(payload: dict[str, Any]) -> int | None:
    value = payload.get("prNumber")
    if value is None or value == "":
        return None
    return int(value)


def action_prompt(payload: dict[str, Any]) -> str:
    prompt = str(payload.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("Missing Codex prompt")
    if len(prompt) > MAX_ACTION_PROMPT_CHARS:
        raise ValueError("Codex prompt is too large")
    return prompt


def action_title(payload: dict[str, Any], *, fallback: str) -> str:
    raw = str(payload.get("title") or fallback).strip()
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "-", raw).strip("-")
    return (cleaned or "ticketboard")[:42]


def workflow_tmux_session(dashboard: dict[str, Any]) -> str:
    configured = os.environ.get("TICKETBOARD_ACTION_SESSION", "").strip()
    if configured:
        return configured
    windows = dashboard.get("tmuxWindows")
    if isinstance(windows, list):
        for window in windows:
            if isinstance(window, dict) and window.get("session"):
                return str(window["session"])
    return "ticketboard"


def codex_launch_command(cwd: Path, prompt: str) -> str:
    return " ".join(
        [
            "codex",
            "--cd",
            shlex.quote(str(cwd)),
            shlex.quote(prompt),
        ],
    )


def codex_resume_command(thread_id: str, cwd: Path, prompt: str) -> str:
    return " ".join(
        [
            "codex",
            "resume",
            "--cd",
            shlex.quote(str(cwd)),
            shlex.quote(thread_id),
            shlex.quote(prompt),
        ],
    )


def codex_tmux_command(
    *,
    session_name: str,
    window_name: str,
    cwd: Path,
    codex_command: str,
) -> list[str]:
    return [
        "tmux",
        "new-window",
        "-d",
        "-P",
        "-F",
        "#{session_name}:#{window_index}",
        "-t",
        session_name,
        "-n",
        window_name,
        "-c",
        str(cwd),
        codex_command,
    ]


def launch_tmux_codex(command: list[str], session_name: str, cwd: Path) -> str:
    ensure_tmux_session(session_name, cwd)
    return run_action_command(command, timeout=10)


def ensure_tmux_session(session_name: str, cwd: Path) -> None:
    result = subprocess.run(
        ["tmux", "has-session", "-t", session_name],
        text=True,
        capture_output=True,
        timeout=5,
        check=False,
    )
    if result.returncode == 0:
        return
    run_action_command(
        ["tmux", "new-session", "-d", "-s", session_name, "-c", str(cwd), "-n", "home"],
        timeout=10,
    )


def run_action_command(
    args: list[str],
    *,
    cwd: Path | None = None,
    timeout: int = 12,
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
        raise RuntimeError(f"{format_action_command(args)}: {message}")
    return result.stdout.strip()


def action_result(
    command: list[str],
    *,
    dry_run: bool,
    message: str,
    output: str,
) -> dict[str, Any]:
    return {
        "ok": True,
        "dryRun": dry_run,
        "message": message,
        "command": format_action_command(command),
        "output": output,
        "ranAt": utc_now_iso(),
    }


def action_plan_result(
    commands: list[list[str]],
    *,
    dry_run: bool,
    message: str,
    output: str,
) -> dict[str, Any]:
    return {
        "ok": True,
        "dryRun": dry_run,
        "message": message,
        "command": format_action_plan(commands),
        "output": output,
        "ranAt": utc_now_iso(),
    }


def format_action_command(args: list[str]) -> str:
    value = " ".join(shlex.quote(part) for part in args)
    return value if len(value) <= 1_200 else value[:1_197] + "..."


def format_action_plan(commands: list[list[str]]) -> str:
    value = "\n".join(format_action_command(command) for command in commands)
    return value if len(value) <= 1_800 else value[:1_797] + "..."


def opener_command(target: str) -> list[str]:
    if platform.system() == "Darwin":
        return ["open", target]
    return ["xdg-open", target]


def require_known_pr(dashboard: dict[str, Any], number: int) -> None:
    if number not in {
        int(pr.get("number"))
        for pr in dashboard.get("prs", [])
        if isinstance(pr, dict) and isinstance(pr.get("number"), int)
    }:
        raise ValueError("Unknown PR")


def require_known_session(dashboard: dict[str, Any], thread_id: str) -> None:
    if thread_id not in {
        str(session.get("threadId"))
        for session in dashboard.get("codexSessions", [])
        if isinstance(session, dict) and session.get("threadId")
    }:
        raise ValueError("Unknown Codex session")


def require_known_ticket(dashboard: dict[str, Any], ticket_id: str) -> dict[str, Any]:
    normalized = ticket_id.upper()
    for collection_name in ("linearTickets", "tickets"):
        for ticket in dashboard.get(collection_name, []):
            if not isinstance(ticket, dict) or not ticket.get("ticketId"):
                continue
            if str(ticket["ticketId"]).upper() == normalized:
                return ticket

    for collection_name in ("prs", "codexSessions", "worktrees", "tmuxWindows"):
        for item in dashboard.get(collection_name, []):
            if isinstance(item, dict):
                ticket_ids = {str(value).upper() for value in item.get("ticketIds", [])}
                if normalized in ticket_ids:
                    return {"ticketId": normalized, "title": ""}
    raise ValueError("Unknown Linear ticket")


def require_known_tmux_window(dashboard: dict[str, Any], session: str, index: int) -> None:
    for window in dashboard.get("tmuxWindows", []):
        if not isinstance(window, dict):
            continue
        if window.get("session") == session and window.get("index") == index:
            return
    raise ValueError("Unknown tmux window")


def require_known_url(dashboard: dict[str, Any], url: str) -> None:
    if url not in known_urls(dashboard):
        raise ValueError("Unknown URL")


def known_urls(dashboard: dict[str, Any]) -> set[str]:
    urls: set[str] = set()
    repo = dashboard.get("repo")
    if isinstance(repo, dict) and repo.get("url"):
        urls.add(str(repo["url"]))
    for pr in dashboard.get("prs", []):
        if isinstance(pr, dict) and pr.get("url"):
            urls.add(str(pr["url"]))
    for ticket in dashboard.get("linearTickets", []):
        if not isinstance(ticket, dict):
            continue
        for key in ("url", "projectUrl"):
            if ticket.get(key):
                urls.add(str(ticket[key]))
    return urls


def require_known_path(dashboard: dict[str, Any], value: Any) -> Path:
    if not value:
        raise ValueError("Missing path")
    path = Path(str(value)).expanduser().resolve(strict=False)
    if path not in known_paths(dashboard):
        raise ValueError("Unknown local path")
    if not path.exists():
        raise ValueError(f"Path does not exist: {path}")
    return path


def known_paths(dashboard: dict[str, Any]) -> set[Path]:
    paths = {settings.repo_path.expanduser().resolve(strict=False)}
    repo = dashboard.get("repo")
    if isinstance(repo, dict) and repo.get("path"):
        paths.add(Path(str(repo["path"])).expanduser().resolve(strict=False))
    for worktree in dashboard.get("worktrees", []):
        if isinstance(worktree, dict) and worktree.get("path"):
            paths.add(Path(str(worktree["path"])).expanduser().resolve(strict=False))
    for session in dashboard.get("codexSessions", []):
        if isinstance(session, dict) and session.get("cwd"):
            paths.add(Path(str(session["cwd"])).expanduser().resolve(strict=False))
    return paths


def short_action_path(path: Path) -> str:
    parts = path.parts
    return "/".join(parts[-2:]) if len(parts) >= 2 else str(path)


@app.api_route(
    "/{path:path}", methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
)
async def frontend(request: Request, path: str = "") -> Response:
    if frontend_mode(settings) == "vite":
        return await vite_proxy.proxy(request, path)
    return static_frontend_response(settings.root / "dist", path)


def static_frontend_response(dist: Path, path: str) -> Response:
    target = (dist / path).resolve()
    if path and target.is_file() and dist.resolve() in target.parents:
        return FileResponse(target)
    index = dist / "index.html"
    if not index.exists():
        raise HTTPException(status_code=404, detail={"error": "Frontend build not found"})
    return FileResponse(index)


def api_error(exc: Exception, fallback: str) -> HTTPException:
    status = 404 if isinstance(exc, (FileNotFoundError, KeyError)) else 502
    return HTTPException(status_code=status, detail={"error": f"{fallback}: {exc}"})


def frontend_mode(current_settings: Settings) -> str:
    configured = os.environ.get("TICKETBOARD_FRONTEND")
    if configured:
        return configured
    if (current_settings.root / "node_modules").exists():
        return "vite"
    return "static"


if __name__ == "__main__":
    uvicorn.run("server.app:app", host="127.0.0.1", port=app_port(), log_level="info")
