/* global fetch */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

const args = new Set(process.argv.slice(2));
const urlArg = process.argv.find((arg) => arg.startsWith('--url='));
const codexArg = process.argv.find((arg) => arg.startsWith('--codex-bin='));
const codexArgValues = process.argv
  .filter((arg) => arg.startsWith('--codex-arg='))
  .map((arg) => arg.slice('--codex-arg='.length))
  .filter(Boolean);
const PERMISSION_BYPASS_ARGS = [
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-bypass-hook-trust',
];
const PROMPT_ARGUMENT_PLACEHOLDER = '<prompt argument>';
const baseUrl = (urlArg?.slice('--url='.length) ?? process.env.TICKETBOARD_URL ?? 'http://127.0.0.1:4317').replace(/\/$/, '');
const codexBin = codexArg?.slice('--codex-bin='.length) ?? process.env.TICKETBOARD_CODEX_BIN ?? 'codex';
const codexArgs = buildCodexArgs();
const codexCommand = [codexBin, 'exec', ...codexArgs, '--cd', process.cwd(), PROMPT_ARGUMENT_PLACEHOLDER];
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
const evidenceFingerprint = payload.fingerprint ?? stableFingerprint(payload.snapshot ?? {});

if (!snapshotPath || !briefPath) {
  throw new Error('Evidence snapshot response is missing path or briefPath');
}

const promptPath = snapshotPath.replace(/\.json$/, '.prompt.md');
const fingerprintPath = fingerprintPathFor(briefPath);
const prompt = buildPrompt({ briefPath, evidenceFingerprint, snapshotPath });
mkdirSync(dirname(promptPath), { recursive: true });
writeFileSync(promptPath, prompt);

if (dryRun) {
  console.log(JSON.stringify({
    briefPath,
    codexCommand,
    evidenceFingerprint,
    fingerprintPath,
    promptPath,
    promptTransport: 'argv',
    terminalTransport: codexTerminalTransportName(),
    snapshotPath,
  }, null, 2));
  process.exit(0);
}

const result = runCodexCommand(withPrompt(codexCommand, prompt));

if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

writeFingerprintRecord({
  briefPath,
  evidenceFingerprint,
  fingerprintPath,
  snapshotPath,
  status: 'generated',
});
console.log(`Workflow brief written to ${briefPath}`);

function buildCodexArgs() {
  const envArgs = (process.env.TICKETBOARD_CODEX_ARGS ?? '')
    .split(/\s+/)
    .map((arg) => arg.trim())
    .filter(Boolean);
  const explicitArgs = [...envArgs, ...codexArgValues]
    .filter((arg) => arg !== '--yolo');
  const terminalSafeArgs = [];
  if (!hasFlag(explicitArgs, '--json')) {
    terminalSafeArgs.push('--json');
  }
  if (!hasOption(explicitArgs, '--color')) {
    terminalSafeArgs.push('--color', 'never');
  }
  if (args.has('--no-yolo')) {
    return [...terminalSafeArgs, ...explicitArgs.filter((arg) => !PERMISSION_BYPASS_ARGS.includes(arg))];
  }
  if (explicitArgs.includes('--dangerously-bypass-approvals-and-sandbox')) {
    return [...terminalSafeArgs, ...explicitArgs];
  }
  return [...terminalSafeArgs, ...PERMISSION_BYPASS_ARGS, ...explicitArgs];
}

function hasFlag(values, flag) {
  return values.includes(flag);
}

function hasOption(values, option) {
  return values.some((value) => value === option || value.startsWith(`${option}=`));
}

function runCodexCommand(command) {
  if (process.stdin.isTTY) {
    return spawnCommand(command, 'inherit');
  }

  const tty = controllingTty();
  if (tty) {
    try {
      return spawnCommand(command, tty.fd);
    } finally {
      tty.close();
    }
  }

  const pty = ptyCommand(command);
  if (pty) {
    const result = spawnSync(pty.bin, pty.args, {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    if (!result.error || result.error.code !== 'ENOENT') {
      return result;
    }
  }

  return {
    error: new Error(
      'Codex requires terminal stdin, but Ticketboard could not open /dev/tty or create a pseudo-terminal with script(1).',
    ),
    status: 1,
  };
}

function spawnCommand(command, stdin) {
  return spawnSync(command[0], command.slice(1), {
    stdio: [stdin, 'inherit', 'inherit'],
  });
}

function ptyCommand(command) {
  if (process.platform === 'win32') {
    return null;
  }
  if (process.platform === 'darwin' || process.platform.endsWith('bsd')) {
    return {
      args: ['-q', '/dev/null', ...command],
      bin: 'script',
    };
  }
  return {
    args: ['-q', '-e', '-c', shellCommand(command), '/dev/null'],
    bin: 'script',
  };
}

function shellCommand(command) {
  return command.map(shellQuote).join(' ');
}

function shellQuote(value) {
  if (value === '') {
    return "''";
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function controllingTty() {
  try {
    const fd = openSync('/dev/tty', 'r');
    return {
      close() {
        closeSync(fd);
      },
      fd,
    };
  } catch {
    return null;
  }
}

function codexTerminalTransportName() {
  if (process.stdin.isTTY) {
    return 'inherit';
  }
  const tty = controllingTty();
  if (tty) {
    tty.close();
    return '/dev/tty';
  }
  if (process.platform !== 'win32') {
    return process.platform === 'darwin' || process.platform.endsWith('bsd')
      ? 'script-bsd-pty'
      : 'script-linux-pty';
  }
  return 'unavailable';
}

function withPrompt(command, promptValue) {
  return command.map((part) => (part === PROMPT_ARGUMENT_PLACEHOLDER ? promptValue : part));
}

function buildPrompt({ briefPath, evidenceFingerprint, snapshotPath }) {
  return `You are the local Ticketboard workflow brief automation.

Read this evidence snapshot:
${snapshotPath}

Before deciding, verify the live tmux state directly:
- tmux list-windows -t phoebe -F '#{window_index}\\t#{window_name}\\t#{window_active}\\t#{pane_current_path}\\t#{pane_current_command}\\t#{pane_id}'
- tmux capture-pane -p -S -80 -t phoebe:<index> for panes that look relevant

Also inspect snapshot.verification. When PR, Linear, worktree, or planning evidence is missing, stale, contradictory, or about to decide focus/parallel safety/ship readiness:
- Prefer available GitHub and Linear MCP tools for read-only verification of the listed pull requests and tickets.
- Fall back to the read-only git, gh, and tmux commands in snapshot.verification.commands when MCP tools are unavailable.
- Do not require GitHub or Linear API keys inside Ticketboard; use the local Codex environment's MCP/CLI access when it exists.
- Never run mutating source commands, never merge, never update Linear, and never change files except the workflow brief JSON below.

Also inspect snapshot.refreshRequest. If active, source/reason/workflowId/ticketId/prNumber/title describe the explicit event that queued this run. Account for that request in now, lanes, next, staleSignals, or notes; do not blindly obey it when newer live evidence contradicts it. If the request is stale or already satisfied, say why in staleSignals or notes.

Do not edit source files. Only write the workflow brief JSON file below:
${briefPath}

Model this like Henry's daily engineering workflow: several Codex/tmux lanes may be active at once, but only one lane should own focus. Choose exactly one immediate "now" focus move, then build a parallel lane plan for the other work that can proceed, wait, or be cleaned up. Prefer live failing checks, active tmux/worktree lanes, and review state over quiet strategic backlog. Use PR files and worktree status lines to judge file overlap or shared code areas before marking a lane parallel-safe. Use recentHandoffs and each handoff.outcome as orchestration memory: if Ticketboard just launched/resumed/opened a lane and the outcome is live or quiet, do not recommend launching the same lane again unless newer live evidence proves it needs another action. Use planDocs and planningSignals as the orchestrator memory layer: compare their done/current/next/blocked sections with live Linear, PR, tmux, worktree, and Codex evidence. If Linear projects/docs imply one sequence but live PR/tmux/handoff evidence says another, explain the mismatch in staleSignals or notes.

Write JSON matching this schema:
{
  "version": 1,
  "generatedAt": "<ISO timestamp>",
  "source": {
    "evidenceSnapshotPath": "${snapshotPath}",
    "evidenceFingerprint": "${evidenceFingerprint}",
    "dashboardGeneratedAt": "<from snapshot>",
    "planDocPath": "<from snapshot planDoc.path or null>",
    "planDocPaths": ["<from snapshot planDocs[].path>"],
    "refreshRequest": {
      "active": true,
      "source": "<from snapshot.refreshRequest.source>",
      "reason": "<from snapshot.refreshRequest.reason>",
      "workflowId": "<from snapshot.refreshRequest.workflowId>"
    }
  },
  "operatingMode": {
    "summary": "One sentence describing how to run the next hour of work",
    "recommendedActiveLanes": 2,
    "maxActiveLanes": 3,
    "rationale": "Why this much parallelism is safe"
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
  "lanes": [
    {
      "laneId": "focus:PHO-12345",
      "role": "focus|parallel|waiting|cleanup|watch",
      "workflowId": "ticket:PHO-12345",
      "ticketId": "PHO-12345",
      "prNumber": 12345,
      "title": "Short lane title",
      "action": "Specific next action",
      "why": "Why this lane belongs in the operating plan",
      "confidence": "high|medium|low",
      "automation": "Resume Codex|Start Codex lane|Human checkpoint|Watch only|Cleanup lane",
      "parallelSafe": true,
      "status": "Current lane state",
      "handoffWhen": "When to stop or refresh this lane",
      "blockedBy": [],
      "evidence": []
    }
  ],
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
- lanes must include the focus lane and should include useful parallel/waiting/cleanup lanes when live evidence supports them.
- Mark parallelSafe true only when the lane can run without depending on or overwriting the focus lane; cite changed files or explain why file evidence is unavailable.
- Account for recentHandoffs and handoff.outcome in now, lanes, next, and staleSignals so the brief acts like an updated project plan after each handoff.
- If snapshot.refreshRequest.active is true, explicitly account for that queued request; do not drop it silently.
- Keep every title/action/why short enough to scan.
- Evidence must cite actual snapshot or tmux observations.
- Do not invent PR state, check state, tickets, or tmux windows.
`;
}

function fingerprintPathFor(briefPath) {
  const configured = process.env.TICKETBOARD_WORKFLOW_FINGERPRINT_PATH?.trim();
  if (configured) {
    return expandHome(configured);
  }
  return `${briefPath}.fingerprint.json`;
}

function writeFingerprintRecord({
  briefPath,
  evidenceFingerprint,
  fingerprintPath,
  snapshotPath,
  status,
}) {
  mkdirSync(dirname(fingerprintPath), { recursive: true });
  writeFileSync(
    fingerprintPath,
    JSON.stringify(
      {
        version: 1,
        briefPath,
        evidenceFingerprint,
        snapshotPath,
        status,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

function stableFingerprint(value) {
  return createHash('sha256')
    .update(JSON.stringify(sortStable(stripVolatile(value))))
    .digest('hex');
}

function stripVolatile(value) {
  if (Array.isArray(value)) {
    return value.map(stripVolatile);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const next = {};
  for (const [key, child] of Object.entries(value)) {
    if (
      key === 'generatedAt'
      || key === 'dashboardGeneratedAt'
      || key === 'tmuxPanePreviews'
    ) {
      continue;
    }
    next[key] = stripVolatile(child);
  }
  return next;
}

function sortStable(value) {
  if (Array.isArray(value)) {
    return value.map(sortStable);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortStable(child)]),
  );
}

function expandHome(path) {
  if (path === '~') {
    return process.env.HOME ?? path;
  }
  if (path.startsWith('~/')) {
    return `${process.env.HOME ?? '~'}${path.slice(1)}`;
  }
  return path;
}
