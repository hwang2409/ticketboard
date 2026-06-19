# Ticketboard

Local workflow launcher for the Phoebe repo. It turns live Linear, GitHub, Codex, tmux, and worktree signals into one selected next move, a generated handoff, and a validated local action instead of making you inspect every source separately.

## Run

```bash
pnpm install
pnpm dev
```

Open `http://localhost:4317`.

Optional environment overrides:

```bash
LINEAR_API_KEY=lin_api_...
TICKETBOARD_GITHUB_LOGIN=hwang2409
TICKETBOARD_LINEAR_ASSIGNEE=henry@phoebe.work
TICKETBOARD_TICKET_PREFIXES=PHO
TICKETBOARD_LINEAR_TTL=300
TICKETBOARD_LINEAR_FULL_REFRESH_TTL=900
TICKETBOARD_GITHUB_TTL=60
TICKETBOARD_GITHUB_FULL_REFRESH_TTL=300
TICKETBOARD_PR_DETAIL_TTL=60
TICKETBOARD_CHECK_LOG_TTL=300
TICKETBOARD_REVIEW_COMMENT_PRS=0
TICKETBOARD_DASHBOARD_TTL=20
TICKETBOARD_TMUX_TTL=5
TICKETBOARD_CODEX_PATH_TTL=5
TICKETBOARD_WORKTREE_WORKERS=64
TICKETBOARD_WORKTREE_LIST_TTL=5
TICKETBOARD_WORKTREE_TTL=300
TICKETBOARD_WORKTREE_DETAIL_TTL=2
TICKETBOARD_ACTION_SESSION=ticketboard
TICKETBOARD_WORKTREE_ROOT=/Users/henry/me/fun/phoebe/.codex/worktrees
TICKETBOARD_DB_PATH=~/.codex/ticketboard/ticketboard.db
TICKETBOARD_PLAN_DOC_PATH=
TICKETBOARD_WORKFLOW_BRIEF_PATH=~/.codex/ticketboard/workflow-brief.json
TICKETBOARD_WORKFLOW_SNAPSHOT_PATH=~/.codex/ticketboard/workflow-evidence-snapshot.json
TICKETBOARD_WORKFLOW_BRIEF_TTL=1200
PHOEBE_REPO_PATH=/Users/henry/me/fun/phoebe
TICKETBOARD_REPO=phoebe-health/phoebe
PORT=4317
```

You can put these in `.env`; it is loaded automatically by the Python backend and is ignored by git. Use `.env.example` as the template. `TICKETBOARD_GITHUB_LOGIN` and `TICKETBOARD_LINEAR_ASSIGNEE` are optional overrides; by default the backend uses `gh api user` and the Linear API viewer. Prefer a Linear email address or user ID for `TICKETBOARD_LINEAR_ASSIGNEE`; display names are accepted but less precise. `TICKETBOARD_TICKET_PREFIXES` controls which ticket IDs are recognized from free text.
`TICKETBOARD_LINEAR_TTL` controls how long the backend reuses Linear issue detail before revalidating it, which keeps refreshes fast and avoids wasting Linear API quota.
`TICKETBOARD_LINEAR_FULL_REFRESH_TTL` controls how often stale Linear cache revalidation must fetch full issue summaries; within that window the backend first uses a lightweight Linear version probe and reuses cached summaries when issue assignees and `updatedAt` values have not changed.
`TICKETBOARD_GITHUB_TTL` controls how long the backend reuses the open PR list before calling `gh` again.
`TICKETBOARD_GITHUB_FULL_REFRESH_TTL` controls how often stale PR cache revalidation must fetch full PR summaries; within that window the backend first uses a lightweight GitHub version probe and reuses cached summaries when PR numbers and `updatedAt` values have not changed.
`TICKETBOARD_PR_DETAIL_TTL` controls how long the backend reuses PR detail and parsed PR diffs across memory and disk caches.
`TICKETBOARD_CHECK_LOG_TTL` controls how long fetched GitHub Actions check logs are reused in memory after owner validation.
`TICKETBOARD_REVIEW_COMMENT_PRS` controls how many PRs fetch inline review comments during dashboard refresh; the default `0` keeps dashboard refreshes lightweight because full review threads load from the PR detail endpoint.
`TICKETBOARD_DASHBOARD_TTL` controls how long an in-memory dashboard response is considered fresh; stale responses are served while a background refresh runs.
`TICKETBOARD_TMUX_TTL` controls how long the backend reuses tmux pane summaries during dashboard refresh. Pane preview detail still refreshes live when opened.
`TICKETBOARD_CODEX_PATH_TTL` controls the short in-memory reuse window for the sorted Codex session path scan.
`TICKETBOARD_DB_PATH` controls where the local SQLite cache database is stored. By default it lives at `~/.codex/ticketboard/ticketboard.db`; existing JSON caches in that directory are imported on first startup when the database is empty.
The persisted dashboard startup snapshot is only reused when the repo path, repo name, and configured GitHub/Linear owners match the current `.env`.
`TICKETBOARD_WORKTREE_WORKERS` controls the git status fanout used for local worktree summaries.
`TICKETBOARD_WORKTREE_LIST_TTL` controls how long the backend reuses in-memory worktree summaries before running `git worktree list` again.
`TICKETBOARD_WORKTREE_TTL` controls how long the backend reuses local worktree status summaries before running `git status` across worktrees again.
`TICKETBOARD_WORKTREE_DETAIL_TTL` controls the short in-memory reuse window for full worktree detail responses. Set it to `0` to force live Git reads for every detail request.
`TICKETBOARD_ACTION_SESSION` controls which tmux session receives new Codex workflow lanes. If omitted, Ticketboard reuses the first discovered tmux session or creates `ticketboard`.
`TICKETBOARD_WORKTREE_ROOT` controls where fresh ticket lanes are created. If omitted, Ticketboard uses `.codex/worktrees` inside `PHOEBE_REPO_PATH`.
`TICKETBOARD_PLAN_DOC_PATH` optionally points at a local planning document to include in the Codex evidence snapshot. It is not required and is never hardcoded by the app.
`TICKETBOARD_WORKFLOW_BRIEF_PATH` controls where the local Codex automation writes the structured workflow brief that the app reads.
`TICKETBOARD_WORKFLOW_SNAPSHOT_PATH` controls where Ticketboard writes the compact evidence snapshot consumed by the local Codex automation.
`TICKETBOARD_WORKFLOW_BRIEF_TTL` controls how long the app treats a generated workflow brief as fresh.

## Workflow actions

The selected workflow's primary action runs one validated local action: focus an existing tmux lane, create a ticket worktree and launch Codex, resume a known Codex session, launch a new Codex lane with the generated workflow prompt, open a PR, or open a worktree/source link. Codex-starting actions move the workflow out of the way after a successful handoff so the board advances to the next move. Skipped and handed-off moves are persisted by the backend for the day, with local browser storage only used as a fallback. The backend validates every action against the current dashboard snapshot before running it, so the browser cannot submit arbitrary shell commands.

The selected card shows a generated handoff with what is done, what to run now, what follows, and how to know the move is finished. When a local Codex workflow brief exists, it drives the default selected move and adds a compact "Codex brief" panel with the current action, reasoning, evidence, follow-up order, and stale-signal warnings. If the brief is missing, invalid, or stale, Ticketboard falls back to deterministic live ranking.

## Local Codex brief automation

Ticketboard does not call LLM APIs from the web app. Instead, it exposes a compact evidence snapshot and reads a local JSON artifact written by Codex.

With `pnpm dev` running, inspect the snapshot/prompt paths:

```bash
pnpm brief:snapshot
```

Generate a fresh brief with local Codex:

```bash
pnpm brief:codex
```

The script fetches `/api/workflow-brief/evidence-snapshot?refresh=1&includePreviews=1`, writes a prompt beside the snapshot, asks local `codex` to verify the live `phoebe` tmux session, and writes the JSON brief to `TICKETBOARD_WORKFLOW_BRIEF_PATH`. The next dashboard refresh reads that brief from disk. The app never stores a model key and never blocks rendering on generation.

The right side of the workflow screen is a generated live plan, not an external planning document. By default it shows a compact digest of what follows the selected move and any cleanup that should happen later. The full done/current/next/cleanup order is available behind **Open full live plan**, and the larger queue remains behind **Explore other moves** when deeper inspection is needed.

`/tokens` is retained as a separate Codex usage page. It summarizes total token spend, recent ranges, trend bars, and the heaviest sessions using `/api/tokens`.
