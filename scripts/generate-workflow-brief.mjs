/* global fetch */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const args = new Set(process.argv.slice(2));
const urlArg = process.argv.find((arg) => arg.startsWith('--url='));
const codexArg = process.argv.find((arg) => arg.startsWith('--codex-bin='));
const baseUrl = (urlArg?.slice('--url='.length) ?? process.env.TICKETBOARD_URL ?? 'http://127.0.0.1:4317').replace(/\/$/, '');
const codexBin = codexArg?.slice('--codex-bin='.length) ?? process.env.TICKETBOARD_CODEX_BIN ?? 'codex';
const dryRun = args.has('--dry-run');

const response = await fetch(
  `${baseUrl}/api/workflow-brief/evidence-snapshot?refresh=1&includePreviews=1`,
  { headers: { 'cache-control': 'no-cache' } },
);

if (!response.ok) {
  throw new Error(`Evidence snapshot request failed with ${response.status}: ${await response.text()}`);
}

const payload = await response.json();
const snapshotPath = payload.path;
const briefPath = payload.briefPath;

if (!snapshotPath || !briefPath) {
  throw new Error('Evidence snapshot response is missing path or briefPath');
}

const promptPath = snapshotPath.replace(/\.json$/, '.prompt.md');
const prompt = buildPrompt({ briefPath, snapshotPath });
mkdirSync(dirname(promptPath), { recursive: true });
writeFileSync(promptPath, prompt);

if (dryRun) {
  console.log(JSON.stringify({ briefPath, promptPath, snapshotPath }, null, 2));
  process.exit(0);
}

const result = spawnSync(codexBin, ['--cd', process.cwd(), prompt], {
  stdio: 'inherit',
});

if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(`Workflow brief written to ${briefPath}`);

function buildPrompt({ briefPath, snapshotPath }) {
  return `You are the local Ticketboard workflow brief automation.

Read this evidence snapshot:
${snapshotPath}

Before deciding, verify the live tmux state directly:
- tmux list-windows -t phoebe -F '#{window_index}\\t#{window_name}\\t#{window_active}\\t#{pane_current_path}\\t#{pane_current_command}\\t#{pane_id}'
- tmux capture-pane -p -S -80 -t phoebe:<index> for panes that look relevant

Do not edit source files. Only write the workflow brief JSON file below:
${briefPath}

Choose exactly one immediate "now" move. Prefer live failing checks, active tmux/worktree lanes, and review state over quiet strategic backlog. If the plan doc says one thing but live evidence says another, explain the mismatch in staleSignals or notes.

Write JSON matching this schema:
{
  "version": 1,
  "generatedAt": "<ISO timestamp>",
  "source": {
    "evidenceSnapshotPath": "${snapshotPath}",
    "dashboardGeneratedAt": "<from snapshot>",
    "planDocPath": "<from snapshot planDoc.path or null>"
  },
  "now": {
    "workflowId": "ticket:PHO-12345",
    "ticketId": "PHO-12345",
    "prNumber": 12345,
    "title": "Short work title",
    "action": "Specific next action in plain English",
    "why": "One sentence tying the choice to live evidence",
    "confidence": "high|medium|low",
    "evidence": [
      "Concrete evidence line with source, e.g. tmux phoebe:5 shows PHO-11463 PR work",
      "Concrete PR/check/worktree evidence"
    ],
    "commands": [
      "tmux select-window -t phoebe:5"
    ],
    "finishedWhen": "Concrete finish condition"
  },
  "next": [
    {
      "workflowId": "ticket:PHO-12346",
      "ticketId": "PHO-12346",
      "title": "Short follow-up title",
      "action": "What should happen after now",
      "why": "Why it follows",
      "confidence": "high|medium|low",
      "evidence": []
    }
  ],
  "blocked": [],
  "staleSignals": [],
  "notes": []
}

Rules:
- Output valid JSON only in ${briefPath}; no markdown wrapper.
- workflowId should match Ticketboard when possible: ticket:<ticketId>, pr:<number>, session:<threadId>, or worktree:<path>.
- Keep every title/action/why short enough to scan.
- Evidence must cite actual snapshot or tmux observations.
- Do not invent PR state, check state, tickets, or tmux windows.
`;
}
