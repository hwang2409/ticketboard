/* global fetch */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
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
const DEFAULT_CODEX_TIMEOUT_MS = 8 * 60 * 1000;
const PROMPT_ARGUMENT_PLACEHOLDER = '<prompt argument>';
const baseUrl = (urlArg?.slice('--url='.length) ?? process.env.TICKETBOARD_URL ?? 'http://127.0.0.1:4317').replace(/\/$/, '');
const codexBin = codexArg?.slice('--codex-bin='.length) ?? process.env.TICKETBOARD_CODEX_BIN ?? 'codex';
const codexArgs = buildCodexArgs();
const codexCommand = [codexBin, 'exec', ...codexArgs, '--cd', process.cwd(), PROMPT_ARGUMENT_PLACEHOLDER];
const codexStdinTransport = codexStdinTransportMode();
const codexTimeoutMs = readPositiveMs(process.env.TICKETBOARD_CODEX_TIMEOUT_MS, DEFAULT_CODEX_TIMEOUT_MS);
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
    stdinTransport: codexStdinTransportName(codexStdinTransport),
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
  let triedPty = false;
  if (codexStdinTransport === 'pty') {
    console.error(`[brief:codex] running Codex in a local pseudo-terminal; timeout=${formatDuration(codexTimeoutMs)}`);
    triedPty = true;
    const pty = spawnPtyBuffered(command);
    if (pty) {
      if (pty.status === 0 || !hasTerminalStdinError(pty)) {
        if (pty.status !== 0 || pty.error) {
          replayBuffered(pty);
        }
        return pty;
      }
      console.error('[brief:codex] pseudo-terminal reported non-terminal stdin; retrying direct non-interactive Codex.');
    } else {
      console.error('[brief:codex] pseudo-terminal unavailable; falling back to direct non-interactive Codex.');
    }
  } else {
    console.error(`[brief:codex] running Codex directly; timeout=${formatDuration(codexTimeoutMs)}`);
  }

  const direct = spawnBuffered(command);
  if (direct.status === 0 || !hasTerminalStdinError(direct) || triedPty) {
    if (direct.status !== 0 || direct.error) {
      replayBuffered(direct);
    }
    return direct;
  }

  console.error('[brief:codex] Codex rejected non-terminal stdin; retrying in a local pseudo-terminal.');
  const result = spawnPtyBuffered(command);
  if (result) {
    if (result.status !== 0 || result.error) {
      replayBuffered(result);
    }
    return result;
  }

  return {
    error: new Error(
      'Codex requires terminal stdin, but Ticketboard could not create a pseudo-terminal with script(1).',
    ),
    status: 1,
  };
}

function spawnBuffered(command) {
  return normalizeSpawnResult(spawnSync(command[0], command.slice(1), {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: codexTimeoutMs,
  }));
}

function spawnPtyBuffered(command) {
  const pty = ptyCommand(command);
  if (!pty) {
    return null;
  }
  const result = normalizeSpawnResult(spawnSync(pty.bin, pty.args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: codexTimeoutMs,
  }));
  if (result.error?.code === 'ENOENT') {
    return null;
  }
  return result;
}

function normalizeSpawnResult(result) {
  if (result.error?.code === 'ETIMEDOUT') {
    result.error = new Error(
      `Codex brief generation timed out after ${formatDuration(codexTimeoutMs)}. `
      + 'Set TICKETBOARD_CODEX_TIMEOUT_MS to adjust the limit.',
    );
  }
  return result;
}

function replayBuffered(result) {
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
}

function hasTerminalStdinError(result) {
  if (result.error || result.status === 0) {
    return false;
  }
  const output = [result.stderr, result.stdout].filter(Boolean).join('\n');
  return /stdin is not a terminal|not a terminal/i.test(output);
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

function codexStdinTransportMode() {
  const configured = process.env.TICKETBOARD_CODEX_STDIN_TRANSPORT?.trim().toLowerCase();
  if (configured === 'direct' || configured === 'pty') {
    return configured;
  }
  if (process.platform !== 'win32' && !process.stdin.isTTY) {
    return 'pty';
  }
  return 'direct';
}

function codexStdinTransportName(mode) {
  if (mode === 'pty' && process.platform !== 'win32') {
    return process.platform === 'darwin' || process.platform.endsWith('bsd')
      ? 'script-bsd-pty'
      : 'script-linux-pty';
  }
  if (process.platform !== 'win32') {
    return process.platform === 'darwin' || process.platform.endsWith('bsd')
      ? 'noninteractive-with-script-bsd-pty-fallback'
      : 'noninteractive-with-script-linux-pty-fallback';
  }
  return 'noninteractive';
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

Also inspect snapshot.refreshRequest. If active, source/reason/workflowId/ticketId/prNumber/title/batchId/batchTitle describe the explicit event that queued this run. Account for that request in now, lanes, next, staleSignals, or notes; do not blindly obey it when newer live evidence contradicts it. If the request is stale or already satisfied, say why in staleSignals or notes.

Do not edit source files. Only write the workflow brief JSON file below:
${briefPath}

Model this like Henry's daily engineering workflow: several Codex/tmux lanes may be active at once, but only one lane should own focus. Choose exactly one immediate "now" focus move, then build a parallel lane plan for the other work that can proceed, wait, or be cleaned up. Prefer live failing checks, active tmux/worktree lanes, and review state over quiet strategic backlog. Use projectFocus to preserve the Linear project runway: current, next, blocked, review, completed, and high-priority project pressure should shape lane order. Use completionMemory to avoid redoing recently completed work and to promote follow-up tickets that were just unblocked. Use parallelReadiness for deterministic lane load, candidate, blocker, pairwise conflict, changed-file, and suggested-wave evidence before deciding parallel safety. Use PR files and worktree status lines to judge file overlap or shared code areas before marking a lane parallel-safe. Treat Linear blocker relations as serialization constraints even when file overlap is absent. Use recentHandoffs and each handoff.outcome as orchestration memory: if Ticketboard just launched/resumed/opened a lane and the outcome is live or quiet, do not recommend launching the same lane again unless newer live evidence proves it needs another action. Use parallelRuns as batch memory: lanes in the same batch were intentionally launched together, so account for each batch status, summary, and nextAction before proposing another parallel wave. Use planDocs and planningSignals as the orchestrator memory layer: compare their done/current/next/blocked sections with live Linear, PR, tmux, worktree, Codex, and completion evidence. If Linear projects/docs imply one sequence but live PR/tmux/handoff/completion evidence says another, explain the mismatch in staleSignals or notes.

Write JSON matching this schema:
{
  "version": 1,
  "generatedAt": "<ISO timestamp>",
  "source": {
    "evidenceSnapshotPath": "${snapshotPath}",
    "evidenceFingerprint": "${evidenceFingerprint}",
    "parallelReadinessFingerprint": "<from snapshot.parallelReadinessFingerprint>",
    "dashboardGeneratedAt": "<from snapshot>",
    "planDocPath": "<from snapshot planDoc.path or null>",
    "planDocPaths": ["<from snapshot planDocs[].path>"],
    "refreshRequest": {
      "active": true,
      "batchId": "<from snapshot.refreshRequest.batchId or null>",
      "batchTitle": "<from snapshot.refreshRequest.batchTitle or null>",
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
- Respect snapshot.parallelReadiness.pairwise and blockerEdges: blocked/guarded pairs should not both be marked safe in the same wave unless newer verified evidence proves the snapshot stale.
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

function readPositiveMs(raw, fallback) {
  const value = raw ? Number(raw) : fallback;
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function formatDuration(ms) {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}
