CLAUDE OPUS 4.8
================
What Ticketboard is (purpose + moat)

A personal, local workflow dashboard for your own work on phoebe-health/phoebe. It joins four signals nobody else stitches together for you:

1. Linear tickets assigned to you (PHO-*)
2. Open GitHub PRs authored by you (with check status, review state)
3. tmux Codex sessions running locally (which ticket each pane is working on)
4. Local git worktrees (which are dirty, which match a ticket branch)

The data is collected by a Python Express-replacement backend (server/) that polls gh, the Linear GraphQL API, tmux, and git, then caches into SQLite at
~/.codex/ticketboard/ticketboard.db with finely-tuned per-source TTLs (so refreshes stay cheap and don't burn API quota).

The moat is the join. Each row is "one ticket" with all four signals reconciled: this PHO has a running Codex pane in window 3, an open PR with green checks, no dirty worktree →
"green." That PHO has a dirty worktree but no PR → "drift." That Codex pane is running but not mapped to any active ticket → "mismatch." None of those signals on their own give that
picture, and there's no off-the-shelf tool that joins them — they live in four totally different surfaces.

So the product is essentially: "one row per ticket, with everything I touched today reconciled across Linear / tmux / git / GitHub." Everything else (the queue, the audit, the
canvas) is presentation on top of that join.

---
What I tried, and what I saw

I ran it at http://localhost:4317 (it was already up). Note: your in-progress edit at src/App.tsx:242 has a raw > in JSX text (Linear -> Codex -> PR) which trips Vite's HMR — it
throws an error overlay on every reload. Use → or {'>'}. I dismissed the overlay to inspect the prior-good render.

At default desktop width, the page is:

- Header row — brand, meta strip ("hwang2409 · phoebe-health/phoebe · 48 tickets · 20 sessions · 4 PRs · 2 dirty"), updated timestamp, "Missions" pill, search box, 4 icon-only
toolbar buttons, dark-mode toggle.
- Tab row — All 48 / Needs Review 4 / Blocked 0 / Green 4 / Running Codex 25 / Dirty Trees 2.
- Inspector aside (full-width overlay) with three columns:
- Control desk — a giant serif H2 of your most-recent Codex session ("running · Is 30mg of concerta a normal dose"), four counters labeled now 22 / drift 5 / latest 8 / hidden 0,
and two CTAs ("Open first item", "Copy plan").
- Queue · "Do next" — a vertical list of cards, each with badge / status / ticket ID / description / metadata footer / three buttons (Copy, Snooze, Hide).
- Audit · "Mismatches" — same card pattern; five of the top six items have the same title "Codex session is not mapped to work."
- A react-flow canvas underneath (@xyflow/react) that peeks out behind/around the inspector — barely visible, with "In progress 15 clusters" and ticket cards.

---
UI/UX issues — why you feel overloaded

The biggest single problem: there's no clear primary surface. Two complete content systems compete on screen — a paginated card list (the inspector overlay) and a free-form canvas
(react-flow) underneath. Neither is fully readable. The "map note" in the lower-left even explains that the canvas is "for relationship tracing," but the canvas is hidden behind the
thing explaining it.

Other concrete things that make it hard to land:

1. The H2 hero is a non-sequitur. "running · Is 30mg of concerta a normal dose" is a personal Codex prompt being elevated to the page's biggest type, above the dashboard. It reads
like the headline of the page, but it's just the most-recently-active session. The first thing your eye lands on is a confusing private query, not a workflow state.
2. The four counters use private jargon. now / drift / latest / hidden — only you know what those mean. The user-facing version probably needs to be "Ready / Needs sync / New today
/ Hidden" or similar.
3. CTAs aren't grounded. "Open first item" of which list? "Copy plan" of what? They sit visually inside the brief column but act on the queue.
4. Tab labels don't add up and overlap. All 48 ≠ Needs Review 4 + Blocked 0 + Green 4 + Running Codex 25 + Dirty Trees 2 (= 35). Some categories are status, some are signal-type.
Whether they're mutually exclusive is unclear — Green can also be Running Codex, presumably. Either pick a single faceting axis or use chips/filters instead of tab-style "one of."
5. The Audit column is showing the same finding five times. Five rows all titled "Codex session is not mapped to work" should collapse into one group: "5 unmapped Codex sessions ·
expand." Right now they look like five separate redundant alerts and add ~70% of the visual weight of the right column.
6. Three actions per card × ~10 visible cards = ~30 buttons on screen. Copy / Snooze / Hide are secondary and could live in a hover state or a kebab menu. They're currently the same
visual weight as the card title.
7. Header is 10+ distinct controls in one row, mostly unlabeled icons. Missions pill, search, "mission control", "copy data health report", refresh, "command palette", dark mode —
and the toolbar icons have no text. You have to hover each to discover what it does. Combined with the tab row, that's two full rows of chrome before any content.
8. The search input appears twice — once in the header, once in the bottom "Browse" panel. Same control, two surfaces.
9. Per-card metadata footers are dense. "Codex · openai · gpt-5.5 · xhigh · 12:01:10 PM" — five facets per card, all small caps, no hierarchy among them. Token counts ("381,659
tokens") on Mismatches read like a sortable value but probably aren't load-bearing for the decision the row is asking you to make.
10. No clear "what should I do right now" affordance. The whole point of the join you've built is to tell you "ship PHO-12071 first" — the surfacing of that single decision is
buried inside three columns, four counters, and a giant serif headline that isn't a recommendation.

---
What I'd recommend, in order

1. Fix the JSX error at src/App.tsx:242 first — your dev loop is silently broken on save.
2. Pick one primary surface — either the queue OR the canvas, not both simultaneously. The canvas can be a secondary view behind a tab/toggle.
3. Replace the H2 hero with the top-of-queue ticket recommendation (not the most-recently-active Codex session). The page should answer "what do I work on next?" in one sentence at
the top.
4. Rename the four counters in plain English, or drop them — they're internal terminology.
5. Collapse identical Mismatches into grouped findings.
6. Demote per-card actions (Copy / Snooze / Hide) to hover or a ⋯ menu.
7. Add labels (or aria-only icons + tooltips you actually see) to the header toolbar; remove the duplicated search.
8. Reconcile the tab counts (either make them faceted filters that can stack, or make them mutually-exclusive statuses that sum to the total).


OPENAI GPT 5.5
==============

