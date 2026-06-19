/* global fetch */

import { spawn } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  openSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath, URL } from 'node:url';

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_RETRY_MS = 60 * 1000;
const DEFAULT_LOCK_TTL_MS = 30 * 60 * 1000;

const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const baseUrl = (
  argValue('--url=') ??
  process.env.TICKETBOARD_URL ??
  'http://127.0.0.1:4317'
).replace(/\/$/, '');
const codexBin = argValue('--codex-bin=') ?? process.env.TICKETBOARD_CODEX_BIN;
const intervalMs = readMs(
  '--interval-ms=',
  'TICKETBOARD_WORKFLOW_AUTOMATION_INTERVAL_MS',
  DEFAULT_INTERVAL_MS,
  60 * 1000,
);
const retryMs = readMs(
  '--retry-ms=',
  'TICKETBOARD_WORKFLOW_AUTOMATION_RETRY_MS',
  DEFAULT_RETRY_MS,
  10 * 1000,
);
const lockTtlMs = readMs(
  '--lock-ttl-ms=',
  'TICKETBOARD_WORKFLOW_LOCK_TTL_MS',
  DEFAULT_LOCK_TTL_MS,
  60 * 1000,
);
const once = args.has('--once');
const force = args.has('--force');
const dryRun = args.has('--dry-run');
const noYolo = args.has('--no-yolo');
const generatorScript = fileURLToPath(
  new URL('./generate-workflow-brief.mjs', import.meta.url),
);

let stopped = false;
let pendingTimer = null;
let wakeSleep = null;

process.on('SIGINT', requestStop);
process.on('SIGTERM', requestStop);

console.log(
  [
    `[brief:watch] watching ${baseUrl}`,
    `interval=${formatDuration(intervalMs)}`,
    `retry=${formatDuration(retryMs)}`,
    noYolo ? 'codex yolo=disabled' : 'codex yolo=enabled',
  ].join(' '),
);

do {
  const waitMs = await checkAndMaybeRun();
  if (once || stopped) {
    break;
  }
  await sleep(waitMs);
} while (!stopped);

async function checkAndMaybeRun() {
  let status;
  try {
    status = await fetchBriefStatus();
  } catch (error) {
    console.error(`[brief:watch] status check failed: ${errorMessage(error)}`);
    return retryMs;
  }

  const reason = runReason(status);
  if (!reason) {
    const ageSeconds = Number(status.ageSeconds ?? 0);
    const waitMs = Math.max(
      retryMs,
      Math.min(intervalMs, intervalMs - ageSeconds * 1000),
    );
    console.log(
      `[brief:watch] brief is fresh (${formatDuration(ageSeconds * 1000)} old); next check in ${formatDuration(waitMs)}`,
    );
    return waitMs;
  }

  const lockPath = lockPathFor(status);
  const lock = acquireLock(lockPath);
  if (!lock.acquired) {
    console.log(`[brief:watch] ${lock.reason}; next check in ${formatDuration(retryMs)}`);
    return retryMs;
  }

  try {
    console.log(`[brief:watch] ${reason}; generating workflow brief`);
    const exitCode = await runGenerator();
    if (exitCode !== 0) {
      console.error(`[brief:watch] generator exited with ${exitCode}`);
      return retryMs;
    }
    return intervalMs;
  } finally {
    releaseLock(lock.path);
  }
}

async function fetchBriefStatus() {
  const response = await fetch(`${baseUrl}/api/workflow-brief`, {
    headers: { 'cache-control': 'no-cache' },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

function runReason(status) {
  if (force) return 'forced run requested';
  if (status.status !== 'ready') {
    return `brief status is ${status.status}`;
  }
  const ageSeconds = Number(status.ageSeconds);
  if (!Number.isFinite(ageSeconds)) {
    return 'brief age is unknown';
  }
  if (ageSeconds * 1000 >= intervalMs) {
    return `brief is ${formatDuration(ageSeconds * 1000)} old`;
  }
  return null;
}

function acquireLock(path) {
  mkdirSync(dirname(path), { recursive: true });
  try {
    const fd = openSync(path, 'wx');
    try {
      writeFileSync(
        fd,
        JSON.stringify(
          {
            createdAt: new Date().toISOString(),
            pid: process.pid,
          },
          null,
          2,
        ),
      );
    } finally {
      closeSync(fd);
    }
    return { acquired: true, path };
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      throw error;
    }
  }

  if (lockIsStale(path)) {
    rmSync(path, { force: true });
    return acquireLock(path);
  }

  return { acquired: false, reason: `lock exists at ${path}` };
}

function lockIsStale(path) {
  try {
    const stats = statSync(path);
    return Date.now() - stats.mtimeMs > lockTtlMs;
  } catch {
    return true;
  }
}

function releaseLock(path) {
  rmSync(path, { force: true });
}

function runGenerator() {
  const generatorArgs = [generatorScript, `--url=${baseUrl}`];
  if (codexBin) {
    generatorArgs.push(`--codex-bin=${codexBin}`);
  }
  if (dryRun) {
    generatorArgs.push('--dry-run');
  }
  if (noYolo) {
    generatorArgs.push('--no-yolo');
  }
  for (const arg of rawArgs) {
    if (arg.startsWith('--codex-arg=')) {
      generatorArgs.push(arg);
    }
  }

  return new Promise((resolve) => {
    const child = spawn(process.execPath, generatorArgs, {
      env: {
        ...process.env,
        TICKETBOARD_URL: baseUrl,
      },
      stdio: 'inherit',
    });
    child.on('error', (error) => {
      console.error(`[brief:watch] failed to start generator: ${error.message}`);
      resolve(1);
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

function lockPathFor(status) {
  const configured = process.env.TICKETBOARD_WORKFLOW_LOCK_PATH?.trim();
  if (configured) {
    return expandHome(configured);
  }
  const briefPath = status.path || process.env.TICKETBOARD_WORKFLOW_BRIEF_PATH;
  if (briefPath) {
    return `${expandHome(briefPath)}.lock`;
  }
  return '/tmp/ticketboard-workflow-brief.lock';
}

function readMs(argPrefix, envName, fallback, minimum) {
  const raw = argValue(argPrefix) ?? process.env[envName];
  const parsed = raw ? Number(raw) : fallback;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(minimum, parsed);
}

function argValue(prefix) {
  return rawArgs.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
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

function sleep(ms) {
  return new Promise((resolve) => {
    wakeSleep = resolve;
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      wakeSleep = null;
      resolve();
    }, ms);
  });
}

function requestStop() {
  stopped = true;
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  if (wakeSleep) {
    wakeSleep();
    wakeSleep = null;
  }
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (!remainingSeconds) return `${minutes}m`;
  return `${minutes}m ${remainingSeconds}s`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
