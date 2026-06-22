import { chromium } from 'playwright';

const url = process.env.TICKETBOARD_URL ?? 'http://localhost:4317';
const baseUrl = url.replace(/\/$/, '');
const API_TIMEOUT_MS = 60_000;
const SCREENSHOT_TIMEOUT_MS = 60_000;
const browser = await launchBrowser();
const errors = [];

try {
  await verifyViewport({
    height: 960,
    screenshot: '/tmp/ticketboard-simple-desktop.png',
    width: 1440,
  });
  await verifyViewport({
    height: 844,
    screenshot: '/tmp/ticketboard-simple-mobile.png',
    width: 390,
  });
  await verifyDependencyGuardedBatch();
  await verifyTokensPage({
    height: 900,
    screenshot: '/tmp/ticketboard-tokens.png',
    width: 1280,
  });
  await verifyTokensPage({
    height: 844,
    screenshot: '/tmp/ticketboard-tokens-mobile.png',
    width: 390,
  });
} finally {
  await closeBrowser(browser);
}

if (errors.length) {
  throw new Error(`Browser errors:\n${errors.join('\n')}`);
}

console.log('verified simplified ticketboard workflow UI');
process.exit(0);

async function launchBrowser() {
  try {
    return await chromium.launch({ channel: 'chrome', headless: true });
  } catch {
    return chromium.launch({ headless: true });
  }
}

async function closeBrowser(instance) {
  await instance.close();
}

async function verifyViewport({ width, height, screenshot }) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page
    .context()
    .grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseUrl })
    .catch(() => undefined);
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });
  page.on('pageerror', (error) => errors.push(error.message));

  const dashboardResponse = await page.request.get(
    `${baseUrl}/api/dashboard?refresh=1&verify=${width}x${height}-${Date.now()}`,
    { headers: { 'cache-control': 'no-cache' }, timeout: API_TIMEOUT_MS },
  );
  if (!dashboardResponse.ok()) {
    throw new Error(`Expected dashboard API to load, got ${dashboardResponse.status()}`);
  }
  const dashboard = await dashboardResponse.json();
  validateDashboardShape(dashboard);
  const briefResponse = await page.request.get(
    `${baseUrl}/api/workflow-brief?verify=${width}x${height}-${Date.now()}`,
    { headers: { 'cache-control': 'no-cache' }, timeout: API_TIMEOUT_MS },
  );
  if (!briefResponse.ok()) {
    throw new Error(`Expected workflow brief API to load, got ${briefResponse.status()}`);
  }
  const workflowBrief = await briefResponse.json();
  validateWorkflowBriefShape(workflowBrief);
  const refreshRequestResponse = await page.request.get(
    `${baseUrl}/api/workflow-brief/refresh-request?verify=${width}x${height}-${Date.now()}`,
    { headers: { 'cache-control': 'no-cache' }, timeout: API_TIMEOUT_MS },
  );
  if (!refreshRequestResponse.ok()) {
    throw new Error(`Expected workflow refresh-request API to load, got ${refreshRequestResponse.status()}`);
  }
  validateRefreshRequestShape(await refreshRequestResponse.json());
  const evidenceResponse = await page.request.get(
    `${baseUrl}/api/workflow-brief/evidence-snapshot?refresh=1&verify=${width}x${height}-${Date.now()}`,
    { headers: { 'cache-control': 'no-cache' }, timeout: API_TIMEOUT_MS },
  );
  if (!evidenceResponse.ok()) {
    throw new Error(`Expected workflow evidence API to load, got ${evidenceResponse.status()}`);
  }
  validateWorkflowEvidenceShape(await evidenceResponse.json());
  await verifyUserStateApi(page);
  await mockUserStateRoutes(page);

  await page.goto(`${baseUrl}/?verify=${width}x${height}-${Date.now()}`, {
    timeout: API_TIMEOUT_MS,
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('[data-app-ready="true"]', { timeout: 20_000 });
  await page.waitForSelector('[data-testid="command-strip"]', { timeout: 10_000 });

  const workflowCards = page.locator('[data-workflow-card]');
  if (dashboardHasWorkflowSource(dashboard)) {
    await page.waitForSelector('[data-project-plan]', { timeout: 10_000 });
    await page.waitForSelector('[data-plan-digest]', { timeout: 10_000 });
    if ((await page.locator('[data-plan-digest-item]').count()) < 1) {
      throw new Error('Expected compact generated plan digest items');
    }
    await verifyCopyAction({
      button: page.locator('[data-testid="copy-live-plan"]').first(),
      expected: [
        '# Ticketboard live plan packet',
        '## Live plan',
        '## Project pulse',
        '## Project runway',
        '## Lane matrix',
        '## Parallel waves',
        '## Automation readiness',
        '## After focus clears',
        '## Parallel lanes',
        '## Parallel run memory',
        '## Guardrails',
      ],
      page,
    });
    await page.waitForSelector('[data-project-pulse]', { timeout: 10_000 });
    if (
      dashboard.linearTickets.some((ticket) => ticket.projectName) &&
      (await page.locator('[data-project-pulse-item]').count()) < 1
    ) {
      throw new Error('Expected project pulse to group workflows by Linear project');
    }
    await page.waitForSelector('[data-project-runway]', { timeout: 10_000 });
    if (
      dashboard.linearTickets.some((ticket) => ticket.projectName) &&
      (await page.locator('[data-project-runway-project]').count()) < 1
    ) {
      throw new Error('Expected project runway to group Linear projects into execution stages');
    }
    if (
      (await page.locator('[data-project-runway-project]').count()) > 0 &&
      (await page.locator('[data-project-runway-stage]').count()) < 4
    ) {
      throw new Error('Expected project runway to expose current, next, blocked, and done stages');
    }
    await page.waitForSelector('[data-lane-load]', { timeout: 10_000 });
    const hasLiveLane =
      dashboard.codexSessions.some((session) => ['goal-active', 'running'].includes(session.status)) ||
      dashboard.tmuxWindows.length > 0 ||
      dashboard.worktrees.some((worktree) => (worktree.dirtyCount ?? 0) > 0 || worktree.prunable);
    if (hasLiveLane && (await page.locator('[data-lane-load-item]').count()) < 1) {
      throw new Error('Expected lane load panel to render active local lanes');
    }
    await page.waitForSelector('[data-lane-matrix]', { timeout: 10_000 });
    if (
      Array.isArray(workflowBrief.brief?.lanes) &&
      workflowBrief.brief.lanes.length > 1 &&
      (await page.locator('[data-lane-matrix-item]').count()) < 1
    ) {
      throw new Error('Expected lane matrix to render pairwise lane compatibility');
    }
    await page.waitForSelector('[data-handoff-ledger]', { timeout: 10_000 });
    if ((await page.locator('[data-handoff-item]').count()) < 1) {
      throw new Error('Expected recent workflow handoffs to render');
    }
    if ((await page.locator('[data-handoff-outcome]').count()) < 1) {
      throw new Error('Expected recent handoffs to expose current outcomes');
    }
    await page.waitForSelector('[data-parallel-run-ledger]', { timeout: 10_000 });
    if ((await page.locator('[data-parallel-run]').count()) < 1) {
      throw new Error('Expected grouped parallel run memory to render');
    }
    await page.waitForSelector('[data-unlock-map]', { timeout: 10_000 });
    await page.waitForSelector('[data-completion-forecast]', { timeout: 10_000 });
    if ((await page.locator('[data-completion-forecast-item]').count()) < 1) {
      throw new Error('Expected selected workflow to expose after-focus forecast moves');
    }
    const hasUnlockSource =
      dashboard.tickets.some((ticket) => ticket.state === 'blocked') ||
      dashboard.prs.some((pr) => ['red', 'pending', 'green'].includes(pr.checkSummary?.state)) ||
      dashboard.linearTickets.some((ticket) =>
        ticket.relatedIssues?.some((relation) => /block/i.test(relation.relationType ?? '')),
      );
    if (hasUnlockSource && (await page.locator('[data-unlock-item]').count()) < 1) {
      throw new Error('Expected unlock map to render dependency or PR gates');
    }
    if ((await page.locator('.plan-disclosure [data-plan-item]:visible').count()) > 0) {
      throw new Error('Full live plan rows should be hidden by default');
    }
    await page.waitForSelector('[data-primary-workflow]', { timeout: 10_000 });
    await page.waitForSelector('[data-testid="command-status"]', { timeout: 10_000 });
    await page.waitForSelector('[data-workflow-automation]', { timeout: 10_000 });
    const automationStatus = await page.locator('[data-workflow-automation]').first().getAttribute('data-automation-status');
    if (!['invalid', 'missing', 'ready', 'stale'].includes(automationStatus)) {
      throw new Error(`Expected workflow automation panel to expose brief status, got ${automationStatus}`);
    }
    const refreshOwed = await page.locator('[data-workflow-automation]').first().getAttribute('data-brief-refresh-owed');
    if (!['false', 'true'].includes(refreshOwed)) {
      throw new Error(`Expected workflow automation panel to expose refresh-owed state, got ${refreshOwed}`);
    }
    if ((await page.locator('[data-testid="queue-brief-refresh"]').count()) < 1) {
      throw new Error('Expected workflow automation panel to expose a manual brief refresh queue control');
    }
    if ((await page.locator('[data-testid="command-strip"] .metric-pill').count()) > 0) {
      throw new Error('Workflow command strip should not expose source-count metric pills');
    }
    await assertDefaultVisibleCopy(page, workflowBrief.status === 'ready');
    if (workflowBrief.status === 'ready') {
      await page.waitForSelector('[data-testid="workflow-brief"]', { timeout: 10_000 });
      await assertWorkflowBriefSelection(page, workflowBrief);
      if (Array.isArray(workflowBrief.brief?.lanes) && workflowBrief.brief.lanes.length) {
        await page.waitForSelector('[data-parallel-lanes]', { timeout: 10_000 });
        await page.waitForSelector('[data-parallel-waves]', { timeout: 10_000 });
        await page.waitForSelector('[data-parallel-batch]', { timeout: 10_000 });
        if ((await page.locator('[data-parallel-wave]').count()) < 1) {
          throw new Error('Expected parallel lane panel to render ordered workflow waves');
        }
        if ((await page.locator('[data-parallel-wave-lane]').count()) < 1) {
          throw new Error('Expected parallel waves to name the lanes in each wave');
        }
        if ((await page.locator('[data-batch-lane]').count()) < 1) {
          throw new Error('Expected parallel lane panel to name the current safe batch');
        }
        if ((await page.locator('[data-batch-decision]').count()) < 1) {
          throw new Error('Expected parallel lane panel to explain batch decisions');
        }
        if ((await page.locator('[data-batch-decision-status="ready"], [data-batch-decision-status="guarded"]').count()) < 1) {
          throw new Error('Expected batch decisions to expose ready or guarded candidates');
        }
        if (
          (await page.locator('[data-batch-decision-status="ready"]').count()) > 0 &&
          (await page.locator('[data-testid="run-safe-batch"]').count()) < 1
        ) {
          throw new Error('Expected ready batch decisions to expose a safe-batch runner');
        }
        await verifyCopyAction({
          button: page.locator('[data-testid="copy-batch-packet"]').first(),
          expected: [
            '# Ticketboard safe batch packet',
            '## Run now',
            '## Decision trail',
            '## Guardrails',
          ],
          page,
        });
        if ((await page.locator('[data-parallel-lane]').count()) < 1) {
          throw new Error('Expected workflow brief lanes to render in the parallel lane panel');
        }
        if ((await page.locator('[data-parallel-lane] [data-testid^="run-lane-action-"]').count()) < 1) {
          throw new Error('Expected mapped workflow lanes to expose local action controls');
        }
        if ((await page.locator('[data-parallel-lane] .parallel-safety').count()) < 1) {
          throw new Error('Expected parallel lanes to explain focus safety');
        }
        if ((await page.locator('.parallel-next-action').count()) < 1) {
          throw new Error('Expected parallel lanes to expose a next safe lane control');
        }
      }
    }
    await assertApprovedGreenPrimaryIsNotReview(page, dashboard);
    await assertWorkflowEyebrow(page);
    await page.waitForSelector('[data-source-dossier]', { timeout: 10_000 });
    const dossierSections = await page.locator('[data-source-dossier-section]').count();
    const dossierText = (await page.locator('[data-source-dossier]').innerText()).trim();
    if (!dossierSections && !dossierText.includes('No linked Linear')) {
      throw new Error('Expected source dossier to expose source context or an empty state');
    }
    await page.waitForSelector('[data-lane-contract]', { timeout: 10_000 });
    if ((await page.locator('[data-lane-contract-section]').count()) < 3) {
      throw new Error('Expected lane contract to expose preflight, finish, and after-handoff sections');
    }
    if (width <= 760) {
      await assertPrimaryBeforePlan(page);
    }
    const primaryAction = page.locator('[data-testid="run-workflow-action"]').first();
    if ((await primaryAction.count()) < 1) {
      throw new Error('Expected selected workflow to expose a primary action');
    }
    const advanceMode = await primaryAction.getAttribute('data-advance-on-success');
    if (advanceMode !== 'true' && advanceMode !== 'false') {
      throw new Error('Expected primary action to declare whether it advances after success');
    }
    await page.locator('.plan-disclosure summary').click();
    if ((await page.locator('.plan-disclosure [data-plan-item]:visible').count()) < 1) {
      throw new Error('Expected full live plan rows after opening disclosure');
    }
    await page.locator('.plan-disclosure summary').click();
    await assertSemanticPrimaryAction(primaryAction);
    await page.waitForSelector('[data-testid="workflow-handoff"]', { timeout: 10_000 });
    await assertPrimaryActionBeforeHandoff(page);
    await assertWorkflowHandoffCopy(page);
    await page.waitForSelector('.workflow-handoff >> text=Now', { timeout: 10_000 });
    await page.waitForSelector('text=Done so far', { timeout: 10_000 });
    await verifyDryRunAction(page, dashboard);
    await verifyCleanupCompleteAction(page, dashboard);
    await page.locator('.manual-fallbacks summary').click();
    await verifyCopyAction({
      button: page.locator('[data-testid="copy-packet"]').first(),
      expected: ['# Ticketboard work packet', '## Live handoff', '## Lane contract'],
      page,
    });
    await verifyCopyAction({
      button: page.locator('[data-testid="copy-prompt"]').first(),
      expected: ['Use this Ticketboard packet', 'Live handoff:', 'Lane contract:'],
      page,
    });
    const commandButton = page.locator('[data-testid="copy-commands"]').first();
    if ((await commandButton.count()) > 0) {
      await verifyCopyAction({
        button: commandButton,
        expected: ['cd '],
        page,
      });
    }
    await page.locator('.manual-fallbacks summary').click();

    await page.locator('.queue-disclosure summary').click();
    if ((await workflowCards.count()) < 1) {
      throw new Error('Expected workflow cards inside the explicit queue disclosure');
    }

    for (const mode of ['ship', 'start', 'cleanup', 'now']) {
      await page.locator(`[data-mode-filter="${mode}"]`).click();
      await page.waitForFunction(() => {
        return Boolean(
          globalThis.document.querySelector('[data-workflow-card]') ||
            globalThis.document.querySelector('.queue-empty'),
        );
      });
    }

    await page.getByLabel('Search workflows').fill('definitely-no-workflow-match');
    await page.waitForSelector('.queue-empty', { timeout: 10_000 });
    await page.getByLabel('Search workflows').fill('');
    await page.waitForFunction(() => {
      return Boolean(
        globalThis.document.querySelector('[data-workflow-card]') ||
          globalThis.document.querySelector('.queue-empty'),
      );
    });
    await page.locator('.queue-disclosure summary').click();
  } else {
    await page.waitForSelector('.empty-workspace', { timeout: 10_000 });
  }

  await page.screenshot({ fullPage: true, path: screenshot, timeout: SCREENSHOT_TIMEOUT_MS });
  try {
    await verifySafeBatchRevalidation(page, dashboard, workflowBrief);
    await verifyMockedActionAdvance(page, workflowBrief.status === 'ready');
  } finally {
    await page
      .evaluate(() => {
        globalThis.localStorage.removeItem('ticketboard-simple-state-v1');
      })
      .catch(() => undefined);
  }
  await page.close();
}

async function verifyDependencyGuardedBatch() {
  const dashboard = mockDependencyDashboard();
  const workflowBrief = mockDependencyBrief(dashboard.generatedAt);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });
  page.on('pageerror', (error) => errors.push(error.message));

  await page.route('**/api/dashboard**', async (route) => {
    await route.fulfill({
      body: JSON.stringify(dashboard),
      contentType: 'application/json',
      status: 200,
    });
  });
  await page.route('**/api/workflow-brief**', async (route) => {
    const url = new globalThis.URL(route.request().url());
    if (url.pathname.endsWith('/refresh-request')) {
      await route.fulfill({
        body: JSON.stringify({ active: false, path: '/tmp/ticketboard-dependency.refresh' }),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }
    if (url.pathname.endsWith('/evidence-snapshot')) {
      await route.fulfill({
        body: JSON.stringify(mockDependencyEvidenceSnapshot(workflowBrief)),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }
    await route.fulfill({
      body: JSON.stringify(workflowBrief),
      contentType: 'application/json',
      status: 200,
    });
  });
  await mockUserStateRoutes(page);

  try {
    await page.goto(`${baseUrl}/?dependency-guard=${Date.now()}`, {
      timeout: API_TIMEOUT_MS,
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector('[data-app-ready="true"]', { timeout: 20_000 });
    await page.waitForSelector('[data-parallel-batch]', { timeout: 10_000 });

    const guarded = page.locator('[data-batch-decision-status="guarded"]');
    if ((await guarded.count()) < 1) {
      throw new Error('Expected dependency-blocked parallel lane to render a guarded batch decision');
    }
    const guardedText = await guarded.allInnerTexts();
    const dependencyGuardText = guardedText.join('\n');
    for (const phrase of ['DEP-1', 'DEP-2']) {
      if (!dependencyGuardText.includes(phrase)) {
        throw new Error(`Expected guarded dependency decision to include ${phrase}`);
      }
    }
    if (!/blocks|serialize/i.test(dependencyGuardText)) {
      throw new Error(`Expected guarded dependency decision to explain serialization, got "${dependencyGuardText}"`);
    }
    if ((await page.locator('[data-testid="run-safe-batch"]').count()) > 0) {
      throw new Error('Expected dependency-guarded batch to hide the safe-batch runner');
    }

    await page.waitForSelector('[data-lane-matrix-item]', { timeout: 10_000 });
    const matrixText = await page.locator('[data-lane-matrix]').innerText();
    if (!/Linear dependency|DEP-1 blocks DEP-2/i.test(matrixText)) {
      throw new Error(`Expected lane matrix to expose Linear dependency serialization, got "${matrixText}"`);
    }
  } finally {
    await page.close();
  }
}

async function mockUserStateRoutes(page) {
  const state = {
    dismissed: {},
    handoffs: [
      {
        batchId: 'verify-batch',
        batchTitle: 'Verify parallel run',
        command: 'tmux new-window ...',
        id: 'verify-handoff',
        kind: 'resume-codex',
        message: 'Resumed Codex in tmux session phoebe.',
        prNumber: null,
        ranAt: new Date().toISOString(),
        ticketId: 'PHO-000',
        title: 'Resume current lane',
        workflowId: 'ticket:PHO-000',
      },
      {
        batchId: 'verify-batch',
        batchTitle: 'Verify parallel run',
        command: 'tmux new-window ...',
        id: 'verify-handoff-2',
        kind: 'launch-codex',
        message: 'Started Codex in tmux session phoebe.',
        prNumber: null,
        ranAt: new Date(Date.now() - 30_000).toISOString(),
        ticketId: 'PHO-001',
        title: 'Start sibling lane',
        workflowId: 'ticket:PHO-001',
      },
    ],
  };
  await page.route('**/api/user-state**', async (route) => {
    const request = route.request();
    const url = new globalThis.URL(request.url());
    const method = request.method();

    if (url.pathname === '/api/user-state' && method === 'GET') {
      await route.fulfill({
        body: JSON.stringify(state),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    if (url.pathname === '/api/user-state/dismiss' && method === 'POST') {
      const payload = parseJsonRequest(request);
      const id = String(payload.id ?? '');
      if (id) {
        const now = new Date();
        state.dismissed[id] = {
          createdAt: now.toISOString(),
          kind: payload.kind === 'dismiss' ? 'dismiss' : 'snooze',
          until:
            payload.kind === 'dismiss'
              ? null
              : new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
        };
      }
      await route.fulfill({
        body: JSON.stringify(state),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    if (url.pathname.startsWith('/api/user-state/dismiss/') && method === 'DELETE') {
      const id = decodeURIComponent(url.pathname.replace('/api/user-state/dismiss/', ''));
      delete state.dismissed[id];
      await route.fulfill({
        body: JSON.stringify(state),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    await route.continue();
  });
}

function mockDependencyDashboard() {
  const now = new Date().toISOString();
  return {
    codexSessions: [],
    diagnostics: [],
    generatedAt: now,
    linearTickets: [
      mockLinearTicket({
        relatedIssues: [
          {
            issue: mockLinkedIssue({
              stateName: 'Todo',
              stateType: 'unstarted',
              ticketId: 'DEP-2',
              title: 'Build dependent workflow',
            }),
            relationType: 'blocks',
          },
        ],
        stateName: 'In Progress',
        stateType: 'started',
        ticketId: 'DEP-1',
        title: 'Build dependency first',
      }),
      mockLinearTicket({
        relatedIssues: [],
        stateName: 'Todo',
        stateType: 'unstarted',
        ticketId: 'DEP-2',
        title: 'Build dependent workflow',
      }),
    ],
    prs: [],
    repo: {
      nameWithOwner: 'you/project',
      path: '/tmp/ticketboard-dependency-project',
      url: 'https://github.com/you/project',
    },
    scope: {
      githubLogin: 'you',
      linearOwners: ['you'],
    },
    tickets: [
      mockTicketRow({
        nextAction: 'Finish the dependency lane first.',
        state: 'active',
        ticketId: 'DEP-1',
        title: 'Build dependency first',
      }),
      mockTicketRow({
        nextAction: 'Start the dependent lane only after DEP-1 clears.',
        state: 'active',
        ticketId: 'DEP-2',
        title: 'Build dependent workflow',
      }),
    ],
    tmuxWindows: [],
    worktrees: [],
  };
}

function mockDependencyBrief(dashboardGeneratedAt) {
  const now = new Date().toISOString();
  return {
    ageSeconds: 5,
    automation: {
      briefTtlSeconds: 600,
      evidenceFingerprint: 'dependency-fingerprint',
      fingerprintPath: '/tmp/ticketboard-dependency.fingerprint.json',
      fingerprintStatus: 'fresh',
      fingerprintUpdatedAt: now,
      intervalSeconds: 600,
      lockActive: false,
      lockAgeSeconds: null,
      lockPath: '/tmp/ticketboard-dependency.lock',
      lockStale: false,
      lockTtlSeconds: 1800,
      refreshRequest: {
        active: false,
        path: '/tmp/ticketboard-dependency.refresh',
      },
      snapshotPath: '/tmp/ticketboard-dependency-snapshot.json',
    },
    brief: {
      blocked: [],
      generatedAt: now,
      lanes: [
        {
          action: 'Work on the dependency first.',
          automation: 'Human checkpoint',
          confidence: 'high',
          evidence: ['DEP-1 blocks DEP-2'],
          laneId: 'focus:DEP-1',
          parallelSafe: true,
          role: 'focus',
          status: 'Focus',
          ticketId: 'DEP-1',
          title: 'Build dependency first',
          workflowId: 'ticket:DEP-1',
          why: 'It unlocks the dependent lane.',
        },
        {
          action: 'Start the dependent lane.',
          automation: 'Start Codex lane',
          confidence: 'high',
          evidence: ['Brief says safe, Linear says blocked'],
          laneId: 'parallel:DEP-2',
          parallelSafe: true,
          role: 'parallel',
          status: 'Brief-safe',
          ticketId: 'DEP-2',
          title: 'Build dependent workflow',
          workflowId: 'ticket:DEP-2',
          why: 'This should be serialized by Linear dependency data.',
        },
      ],
      next: [],
      notes: [],
      now: {
        action: 'Work on the dependency first.',
        confidence: 'high',
        evidence: ['DEP-1 blocks DEP-2'],
        finishedWhen: 'DEP-1 is completed or handed off.',
        ticketId: 'DEP-1',
        title: 'Build dependency first',
        workflowId: 'ticket:DEP-1',
        why: 'It blocks DEP-2.',
      },
      operatingMode: {
        maxActiveLanes: 3,
        rationale: 'The dependent lane should not run until its blocker clears.',
        recommendedActiveLanes: 3,
        summary: 'Run only unblocked dependency work.',
      },
      source: {
        dashboardGeneratedAt,
        evidenceFingerprint: 'dependency-fingerprint',
        evidenceSnapshotPath: '/tmp/ticketboard-dependency-snapshot.json',
        parallelReadinessFingerprint: 'dependency-readiness-fingerprint',
        planDocPath: null,
        planDocPaths: [],
      },
      staleSignals: [],
      version: 1,
    },
    parallelReadiness: mockDependencyParallelReadiness(),
    parallelReadinessFingerprint: 'dependency-readiness-fingerprint',
    path: '/tmp/ticketboard-dependency-brief.json',
    reason: null,
    status: 'ready',
    ttlSeconds: 600,
  };
}

function mockDependencyEvidenceSnapshot(workflowBrief) {
  return {
    briefPath: workflowBrief.path,
    fingerprint: 'dependency-fingerprint',
    path: '/tmp/ticketboard-dependency-snapshot.json',
    snapshot: {
      parallelRuns: [],
      parallelReadiness: mockDependencyParallelReadiness(),
      parallelReadinessFingerprint: 'dependency-readiness-fingerprint',
      planDocs: [],
      planningSignals: {
        docs: [],
        sections: [],
        ticketIds: ['DEP-1', 'DEP-2'],
      },
      prs: [],
      recentHandoffs: [],
      refreshRequest: {
        active: false,
        path: '/tmp/ticketboard-dependency.refresh',
      },
      sourceDossiers: [],
      verification: {
        commands: {
          git: [],
          github: [],
          tmux: [],
        },
        mcpHints: [],
      },
    },
  };
}

function mockDependencyParallelReadiness() {
  return {
    blockerEdges: [
      {
        blockedId: 'DEP-2',
        blockedStateName: 'Todo',
        blockedStateType: 'unstarted',
        blockedTitle: 'Build dependent workflow',
        blockerId: 'DEP-1',
        blockerStateName: 'In Progress',
        blockerStateType: 'started',
        blockerTitle: 'Build dependency first',
        relationType: 'blocks',
        sourceTicketId: 'DEP-1',
      },
    ],
    candidateCount: 2,
    candidates: [
      {
        activeLane: false,
        activeReasons: [],
        blockedBy: [],
        blocks: [],
        changedPaths: ['src/dependency.ts'],
        changedZones: ['src'],
        priority: 2,
        projectName: 'Dependency Project',
        prNumbers: [],
        status: 'ready',
        ticketIds: ['DEP-1'],
        title: 'Build dependency first',
        workflowId: 'ticket:DEP-1',
      },
      {
        activeLane: false,
        activeReasons: [],
        blockedBy: [],
        blocks: [],
        changedPaths: ['server/dependent.py'],
        changedZones: ['server'],
        priority: 2,
        projectName: 'Dependency Project',
        prNumbers: [],
        status: 'blocked',
        ticketIds: ['DEP-2'],
        title: 'Build dependent workflow',
        workflowId: 'ticket:DEP-2',
      },
    ],
    laneLoad: {
      activeCount: 0,
      maxActiveLanes: 3,
      openSlots: 2,
      recommendedActiveLanes: 2,
    },
    pairwise: [
      {
        leftWorkflowId: 'ticket:DEP-1',
        reason: 'DEP-1 blocks DEP-2.',
        rightWorkflowId: 'ticket:DEP-2',
        status: 'blocked',
        type: 'linear-dependency',
      },
    ],
    suggestedWaves: [
      {
        id: 'wave:ready',
        reason: 'Only unblocked work is safe.',
        title: 'Ready parallel wave',
        workflowIds: ['ticket:DEP-1'],
      },
    ],
    summary: '2 candidate lane(s); 0 active; 2 open slot(s); 1 blocked; 1 suggested for the next wave.',
  };
}

function mockTicketRow({
  nextAction,
  state,
  ticketId,
  title,
}) {
  return {
    branches: [],
    nextAction,
    prNumbers: [],
    risk: 'medium',
    state,
    ticketId,
    title,
    windows: [],
    worktrees: [],
  };
}

function mockLinearTicket({
  relatedIssues,
  stateName,
  stateType,
  ticketId,
  title,
}) {
  const now = new Date().toISOString();
  return {
    activity: [],
    assignee: 'you',
    assigneeEmail: null,
    assigneeId: null,
    assigneeName: 'you',
    attachments: [],
    branchName: null,
    children: [],
    comments: [],
    completedAt: null,
    createdAt: now,
    creator: null,
    cycleName: null,
    description: `${title}.`,
    detailLevel: 'full',
    dueDate: null,
    labels: [],
    parent: null,
    priority: 2,
    projectName: 'Dependency Project',
    projectUrl: 'https://linear.app/example/project/dependency-project',
    relatedIssues,
    startedAt: stateType === 'started' ? now : null,
    stateName,
    stateType,
    teamName: 'Engineering',
    ticketId,
    title,
    updatedAt: now,
    url: `https://linear.app/example/issue/${ticketId}`,
  };
}

function mockLinkedIssue({
  stateName,
  stateType,
  ticketId,
  title,
}) {
  return {
    stateName,
    stateType,
    ticketId,
    title,
    url: `https://linear.app/example/issue/${ticketId}`,
  };
}

function parseJsonRequest(request) {
  try {
    return request.postDataJSON();
  } catch {
    return {};
  }
}

async function verifyMockedActionAdvance(page, briefPinsSelection) {
  const primary = page.locator('[data-primary-workflow]').first();
  const primaryAction = page.locator('[data-testid="run-workflow-action"]').first();
  if ((await primary.count()) < 1 || (await primaryAction.count()) < 1) return;

  const advanceMode = await primaryAction.getAttribute('data-advance-on-success');
  if (advanceMode !== 'true') return;

  const beforeId = await primary.getAttribute('data-primary-workflow');
  if (!beforeId) return;

  await page.route('**/api/workflow-action', async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        command: ['mock-ticketboard-action'],
        message: 'Mock action complete.',
        ok: true,
      }),
      contentType: 'application/json',
      status: 200,
    });
  });

  await primaryAction.click();
  await page.waitForSelector('text=Handed off', { timeout: 10_000 });
  if (briefPinsSelection) return;
  await page.waitForFunction(
    (previousId) => {
      const current = globalThis.document
        .querySelector('[data-primary-workflow]')
        ?.getAttribute('data-primary-workflow');
      return (
        current !== previousId ||
        Boolean(globalThis.document.querySelector('.empty-workspace'))
      );
    },
    beforeId,
    { timeout: 15_000 },
  );
}

async function verifySafeBatchRevalidation(page, dashboard, workflowBrief) {
  const batchAction = page.locator('[data-testid="run-safe-batch"]').first();
  if ((await batchAction.count()) < 1) return;

  const events = [];
  let currentBriefResponse = workflowBrief;
  const dashboardHandler = async (route) => {
    const request = route.request();
    const url = new globalThis.URL(request.url());
    if (url.pathname === '/api/dashboard' && url.searchParams.get('refresh') === '1') {
      events.push('dashboard-refresh');
      await route.fulfill({
        body: JSON.stringify(dashboard),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }
    await route.continue();
  };
  const briefHandler = async (route) => {
    const request = route.request();
    const url = new globalThis.URL(request.url());
    if (url.pathname === '/api/workflow-brief' && url.searchParams.get('refresh') === '1') {
      events.push('brief-refresh');
      await route.fulfill({
        body: JSON.stringify(currentBriefResponse),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }
    await route.continue();
  };
  const actionHandler = async (route) => {
    const payload = route.request().postDataJSON();
    if (
      !payload ||
      typeof payload.batchId !== 'string' ||
      !payload.batchId.startsWith('batch:') ||
      typeof payload.batchTitle !== 'string' ||
      !payload.batchTitle.trim()
    ) {
      throw new Error('Expected safe batch workflow action to include batch metadata');
    }
    events.push('workflow-action');
    await route.fulfill({
      body: JSON.stringify({
        detail: { error: 'Mock stop after preflight.' },
      }),
      contentType: 'application/json',
      status: 409,
    });
  };

  await page.route('**/api/dashboard**', dashboardHandler);
  await page.route('**/api/workflow-brief**', briefHandler);
  await page.route('**/api/workflow-action', actionHandler);
  try {
    currentBriefResponse = {
      ...workflowBrief,
      status: 'stale',
      reason: 'Parallel-readiness evidence changed while revalidating.',
    };
    await batchAction.click();
    await page.waitForSelector('text=Batch stopped', { timeout: 10_000 });
    await page.waitForSelector('text=Parallel-readiness evidence changed while revalidating.', {
      timeout: 10_000,
    });
    if (events.includes('workflow-action')) {
      throw new Error('Expected stale workflow brief revalidation to stop before workflow-action');
    }

    events.length = 0;
    currentBriefResponse = workflowBrief;
    await batchAction.click();
    const deadline = Date.now() + 10_000;
    while (!events.includes('workflow-action') && Date.now() < deadline) {
      await page.waitForTimeout(50);
    }
    await page.waitForSelector('text=Batch stopped', { timeout: 10_000 });
  } finally {
    await page.unroute('**/api/dashboard**', dashboardHandler).catch(() => undefined);
    await page.unroute('**/api/workflow-brief**', briefHandler).catch(() => undefined);
    await page.unroute('**/api/workflow-action', actionHandler).catch(() => undefined);
  }

  const actionIndex = events.indexOf('workflow-action');
  if (actionIndex < 0) {
    throw new Error('Expected safe batch runner to attempt a workflow action after revalidation');
  }
  for (const required of ['dashboard-refresh', 'brief-refresh']) {
    const index = events.indexOf(required);
    if (index < 0 || index > actionIndex) {
      throw new Error(`Expected safe batch runner to ${required} before workflow-action; got ${events.join(', ')}`);
    }
  }
}

async function verifyUserStateApi(page) {
  const id = `verify-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const response = await page.request.get(
    `${baseUrl}/api/user-state?verify=${Date.now()}`,
    { timeout: API_TIMEOUT_MS },
  );
  if (!response.ok()) {
    throw new Error(`Expected user-state API to load, got ${response.status()}`);
  }
  validateUserStateShape(await response.json());

  try {
    const dismissResponse = await page.request.post(`${baseUrl}/api/user-state/dismiss`, {
      data: { id, kind: 'snooze' },
      headers: { 'content-type': 'application/json' },
      timeout: API_TIMEOUT_MS,
    });
    if (!dismissResponse.ok()) {
      throw new Error(`Expected user-state dismiss to pass, got ${dismissResponse.status()}`);
    }
    const state = await dismissResponse.json();
    validateUserStateShape(state);
    if (state.dismissed?.[id]?.kind !== 'snooze' || !state.dismissed[id].until) {
      throw new Error('Expected user-state dismiss response to include snooze metadata');
    }
  } finally {
    await page.request.delete(
      `${baseUrl}/api/user-state/dismiss/${encodeURIComponent(id)}`,
      { timeout: API_TIMEOUT_MS },
    );
  }
}

async function verifyCopyAction({ button, expected, page }) {
  await button.waitFor({ state: 'visible', timeout: 10_000 });
  const disabled = await button.evaluate((element) => element.disabled === true);
  if (disabled) {
    throw new Error('Expected copy button to be enabled');
  }
  await button.evaluate((element) => {
    element.scrollIntoView({ block: 'center', inline: 'center' });
    element.click();
  });
  const handle = await button.elementHandle();
  if (!handle) {
    throw new Error('Expected copy button to exist');
  }
  await page.waitForFunction(
    (element) => element.getAttribute('data-copy-state') === 'copied',
    handle,
    { timeout: 10_000 },
  );
  const text = await page.evaluate(async () => {
    if (!globalThis.navigator.clipboard?.readText) {
      return '';
    }
    return globalThis.navigator.clipboard.readText();
  });
  for (const phrase of expected) {
    if (!text.includes(phrase)) {
      throw new Error(`Expected clipboard text to include ${phrase}`);
    }
  }
  await page
    .waitForFunction(
      (element) => element.getAttribute('data-copy-state') === 'idle',
      handle,
      { timeout: 3_000 },
    )
    .catch(() => undefined);
}

async function assertPrimaryBeforePlan(page) {
  const positions = await page.evaluate(() => {
    const primary = globalThis.document.querySelector('[data-primary-workflow]');
    const plan = globalThis.document.querySelector('[data-project-plan]');
    return {
      planTop: plan?.getBoundingClientRect().top ?? 0,
      primaryTop: primary?.getBoundingClientRect().top ?? 0,
    };
  });
  if (!positions.primaryTop || !positions.planTop || positions.primaryTop > positions.planTop) {
    throw new Error('Expected selected workflow action to render before live plan on mobile');
  }
}

async function assertWorkflowEyebrow(page) {
  const eyebrow = page.locator('[data-testid="workflow-eyebrow"]').first();
  await eyebrow.waitFor({ timeout: 10_000 });
  const text = (await eyebrow.innerText()).trim();
  if (/\b\d+\s+(PR|Codex|worktree|tmux)\b/i.test(text) || text.includes(' / ')) {
    throw new Error(`Expected workflow status copy instead of source counts, got "${text}"`);
  }
}

async function assertDefaultVisibleCopy(page, allowEvidenceIds = false) {
  const text = await page.evaluate(() => {
    return [
      globalThis.document.querySelector('[data-testid="command-strip"]')?.innerText,
      globalThis.document.querySelector('[data-primary-workflow]')?.innerText,
      globalThis.document.querySelector('[data-plan-digest]')?.innerText,
    ]
      .filter(Boolean)
      .join('\n');
  });
  if (!allowEvidenceIds && /\b[A-Z][A-Z0-9]+-\d+\b|\bPR\s*#\d+\b/i.test(text)) {
    throw new Error(`Expected default visible workflow copy to hide artifact IDs, got "${text}"`);
  }
  if (!allowEvidenceIds && /Linear\s*->|Codex\s*->\s*PR|\bCI\b/.test(text)) {
    throw new Error(`Expected skimmable workflow copy without source jargon, got "${text}"`);
  }
}

async function assertWorkflowBriefSelection(page, response) {
  const brief = response.brief;
  if (!brief?.now) return;
  const primaryId = await page.locator('[data-primary-workflow]').first().getAttribute(
    'data-primary-workflow',
  );
  const expectedId =
    brief.now.workflowId ??
    (brief.now.ticketId ? `ticket:${brief.now.ticketId}` : null) ??
    (typeof brief.now.prNumber === 'number' ? `pr:${brief.now.prNumber}` : null);
  if (expectedId && primaryId !== expectedId) {
    throw new Error(`Expected workflow brief to select ${expectedId}, got ${primaryId}`);
  }
}

async function assertApprovedGreenPrimaryIsNotReview(page, dashboard) {
  const primaryId = await page.locator('[data-primary-workflow]').first().getAttribute(
    'data-primary-workflow',
  );
  const ticketId = primaryId?.replace(/^ticket:/, '');
  if (!ticketId || ticketId === primaryId) return;

  const ticket = dashboard.tickets.find((item) => item.ticketId === ticketId);
  const approvedGreenPr = dashboard.prs.find((pr) => {
    return (
      ticket?.prNumbers?.includes(pr.number) &&
      pr.checkSummary?.state === 'green' &&
      pr.reviewDecision === 'APPROVED' &&
      !pr.reviewComments?.length
    );
  });
  if (!approvedGreenPr) return;

  const visible = await page.locator('[data-primary-workflow]').first().innerText();
  if (/review feedback is waiting|answer the review feedback/i.test(visible)) {
    throw new Error(
      `Expected approved green PR workflow ${ticketId} to be ship/final-read, got "${visible}"`,
    );
  }
}

async function assertPrimaryActionBeforeHandoff(page) {
  const positions = await page.evaluate(() => {
    const card = globalThis.document.querySelector('[data-primary-workflow]');
    const action = card?.querySelector('[data-testid="run-workflow-action"]');
    const handoff = card?.querySelector('[data-testid="workflow-handoff"]');
    return {
      actionTop: action?.getBoundingClientRect().top ?? 0,
      handoffTop: handoff?.getBoundingClientRect().top ?? 0,
    };
  });
  if (!positions.actionTop || !positions.handoffTop || positions.actionTop > positions.handoffTop) {
    throw new Error('Expected primary workflow action to render before the handoff');
  }
}

async function assertWorkflowHandoffCopy(page) {
  const text = (await page.locator('[data-testid="workflow-handoff"]').innerText()).trim();
  if (/\b\d+\s+(Codex|worktree|tmux)\b/i.test(text)) {
    throw new Error(`Expected workflow handoff copy instead of source counts, got "${text}"`);
  }
}

async function assertSemanticPrimaryAction(button) {
  const text = (await button.innerText()).trim();
  if (/^(Focus lane|Launch Codex|Resume Codex|Start Codex lane)$/i.test(text)) {
    throw new Error(`Expected outcome-oriented primary action label, got "${text}"`);
  }
}

function validateDashboardShape(dashboard) {
  for (const key of [
    'prs',
    'linearTickets',
    'codexSessions',
    'tmuxWindows',
    'worktrees',
    'tickets',
    'diagnostics',
  ]) {
    if (!Array.isArray(dashboard[key])) {
      throw new Error(`Expected dashboard.${key} to be an array`);
    }
  }
  if (!dashboard.repo?.path || !dashboard.repo?.nameWithOwner) {
    throw new Error('Expected dashboard repo metadata');
  }
  if (dashboard.tickets.some((ticket) => !ticket.ticketId || !ticket.nextAction)) {
    throw new Error('Expected ticket rows to include ticketId and nextAction');
  }
  if (
    dashboard.prs.some(
      (pr) =>
        typeof pr.number !== 'number' ||
        !pr.checkSummary ||
        !Array.isArray(pr.ticketIds),
    )
  ) {
    throw new Error('Expected PR rows to include check summary and ticket ids');
  }
  if (
    dashboard.codexSessions.some(
      (session) =>
        !session.threadId ||
        !Array.isArray(session.latestMessages) ||
        !Array.isArray(session.recentToolCalls),
    )
  ) {
    throw new Error('Expected Codex sessions to include activity arrays');
  }
  if ('orchestratorPlan' in dashboard) {
    throw new Error('Dashboard should not expose external planning-document metadata');
  }
  validateTmuxPrAssociations(dashboard);
  validateTmuxAssociationsAreNarrow(dashboard);
}

function validateTmuxPrAssociations(dashboard) {
  const prsByNumber = new Map(
    dashboard.prs
      .filter((pr) => typeof pr.number === 'number' && pr.ticketIds?.length)
      .map((pr) => [pr.number, pr]),
  );
  if (!prsByNumber.size) return;

  for (const window of dashboard.tmuxWindows) {
    const windowName = String(window.name ?? '');
    const ticketIds = new Set(window.ticketIds ?? []);
    for (const match of windowName.matchAll(/(?<!\d)#?(\d{3,7})(?!\d)/g)) {
      const pr = prsByNumber.get(Number(match[1]));
      if (!pr) continue;
      const missing = pr.ticketIds.filter((ticketId) => !ticketIds.has(ticketId));
      if (missing.length) {
        throw new Error(
          `Expected tmux window "${windowName}" to inherit ${missing.join(', ')} from PR #${pr.number}`,
        );
      }
    }
  }
}

function validateTmuxAssociationsAreNarrow(dashboard) {
  const currentPrNumbers = new Set(dashboard.prs.map((pr) => pr.number));
  for (const window of dashboard.tmuxWindows) {
    const ticketIds = window.ticketIds ?? [];
    if (ticketIds.length <= 1) continue;

    const identityText = `${window.name ?? ''}\n${window.path ?? ''}`;
    const hasDirectTicket = /\b[A-Z]{2,10}-\d+\b/i.test(
      identityText.replaceAll('_', '-'),
    );
    const hasCurrentPrNumber = [...identityText.matchAll(/(?<!\d)#?(\d{3,7})(?!\d)/g)]
      .some((match) => currentPrNumbers.has(Number(match[1])));

    if (!hasDirectTicket && !hasCurrentPrNumber) {
      throw new Error(
        `Expected tmux window "${window.name}" to avoid broad transcript ticket fan-out, got ${ticketIds.join(', ')}`,
      );
    }
  }
}

function validateUserStateShape(state) {
  if (
    !state ||
    typeof state !== 'object' ||
    typeof state.dismissed !== 'object' ||
    !Array.isArray(state.handoffs)
  ) {
    throw new Error('Expected user-state response to include dismissed workflows and handoffs');
  }
}

function validateWorkflowBriefShape(response) {
  if (!response || typeof response !== 'object') {
    throw new Error('Expected workflow brief response object');
  }
  if (!['invalid', 'missing', 'ready', 'stale'].includes(response.status)) {
    throw new Error(`Unexpected workflow brief status ${response.status}`);
  }
  if (typeof response.path !== 'string') {
    throw new Error('Expected workflow brief response path');
  }
  if (!Number.isFinite(response.ttlSeconds)) {
    throw new Error('Expected workflow brief response ttlSeconds');
  }
  if (
    !response.parallelReadiness ||
    typeof response.parallelReadiness !== 'object'
  ) {
    throw new Error('Expected workflow brief response to expose parallel readiness');
  }
  validateParallelReadinessShape(response.parallelReadiness);
  if (typeof response.parallelReadinessFingerprint !== 'string') {
    throw new Error('Expected workflow brief response to expose parallel readiness fingerprint');
  }
  if (
    !response.automation ||
    typeof response.automation !== 'object' ||
    typeof response.automation.fingerprintPath !== 'string' ||
    typeof response.automation.lockPath !== 'string' ||
    typeof response.automation.lockActive !== 'boolean' ||
    !Number.isFinite(response.automation.intervalSeconds)
  ) {
    throw new Error('Expected workflow brief response automation status');
  }
  validateRefreshRequestShape(response.automation.refreshRequest);
  if (response.status === 'ready') {
    const brief = response.brief;
    if (
      brief?.version !== 1 ||
      typeof brief.generatedAt !== 'string' ||
      typeof brief.now?.action !== 'string' ||
      typeof brief.now?.why !== 'string'
    ) {
      throw new Error('Expected ready workflow brief to include version, generatedAt, now.action, and now.why');
    }
    if (brief.lanes && !Array.isArray(brief.lanes)) {
      throw new Error('Expected workflow brief lanes to be an array');
    }
    for (const [index, lane] of (brief.lanes ?? []).entries()) {
      if (typeof lane.title !== 'string' || typeof lane.action !== 'string') {
        throw new Error(`Expected workflow brief lane ${index} to include title and action`);
      }
    }
  }
}

function validateRefreshRequestShape(refreshRequest) {
  if (
    !refreshRequest ||
    typeof refreshRequest !== 'object' ||
    typeof refreshRequest.active !== 'boolean' ||
    typeof refreshRequest.path !== 'string'
  ) {
    throw new Error('Expected workflow brief automation to expose refresh request status');
  }
}

function validateWorkflowEvidenceShape(response) {
  const recentHandoffs = response?.snapshot?.recentHandoffs;
  const planDocs = response?.snapshot?.planDocs;
  const planningSignals = response?.snapshot?.planningSignals;
  const parallelReadiness = response?.snapshot?.parallelReadiness;
  const parallelReadinessFingerprint = response?.snapshot?.parallelReadinessFingerprint;
  const parallelRuns = response?.snapshot?.parallelRuns;
  const prs = response?.snapshot?.prs;
  const refreshRequest = response?.snapshot?.refreshRequest;
  const sourceDossiers = response?.snapshot?.sourceDossiers;
  const verification = response?.snapshot?.verification;
  if (
    !response ||
    typeof response !== 'object' ||
    typeof response.path !== 'string' ||
    typeof response.fingerprint !== 'string' ||
    !Array.isArray(planDocs) ||
    !planningSignals ||
    typeof planningSignals !== 'object' ||
    !Array.isArray(planningSignals.docs) ||
    !Array.isArray(planningSignals.sections) ||
    !Array.isArray(planningSignals.ticketIds) ||
    !parallelReadiness ||
    typeof parallelReadiness !== 'object' ||
    typeof parallelReadinessFingerprint !== 'string' ||
    !parallelReadiness.laneLoad ||
    typeof parallelReadiness.laneLoad !== 'object' ||
    !Array.isArray(parallelReadiness.candidates) ||
    !Array.isArray(parallelReadiness.blockerEdges) ||
    !Array.isArray(parallelReadiness.pairwise) ||
    !Array.isArray(parallelReadiness.suggestedWaves) ||
    !Array.isArray(parallelRuns) ||
    !Array.isArray(recentHandoffs) ||
    !Array.isArray(prs) ||
    !Array.isArray(sourceDossiers) ||
    !refreshRequest ||
    typeof refreshRequest !== 'object' ||
    !verification ||
    typeof verification !== 'object' ||
    !Array.isArray(verification.mcpHints) ||
    !verification.commands ||
    typeof verification.commands !== 'object'
  ) {
    throw new Error('Expected workflow evidence snapshot to include plan docs, source dossiers, parallel readiness, parallel runs, recent handoffs, refresh requests, PRs, and verification hints');
  }
  validateRefreshRequestShape(refreshRequest);
  validateParallelReadinessShape(parallelReadiness);
  if ('ageSeconds' in refreshRequest) {
    throw new Error('Expected workflow evidence refresh request to omit volatile ageSeconds');
  }
  for (const key of ['git', 'github', 'tmux']) {
    if (!Array.isArray(verification.commands[key])) {
      throw new Error(`Expected workflow evidence verification commands.${key} to be an array`);
    }
  }
  for (const [index, doc] of planDocs.entries()) {
    if (!doc || typeof doc !== 'object' || typeof doc.path !== 'string') {
      throw new Error(`Expected workflow evidence plan doc ${index} to include a path`);
    }
  }
  for (const [index, pr] of prs.entries()) {
    if (!pr || typeof pr !== 'object' || !Array.isArray(pr.files)) {
      throw new Error(`Expected workflow evidence PR ${index} to include changed files`);
    }
  }
  for (const [index, dossier] of sourceDossiers.entries()) {
    if (
      !dossier ||
      typeof dossier !== 'object' ||
      typeof dossier.ticketId !== 'string' ||
      !Array.isArray(dossier.attachments) ||
      !Array.isArray(dossier.latestComments) ||
      !Array.isArray(dossier.relatedIssues) ||
      !dossier.local ||
      typeof dossier.local !== 'object'
    ) {
      throw new Error(`Expected workflow evidence source dossier ${index} to include ticket, docs, relations, and local state`);
    }
  }
  for (const [index, handoff] of recentHandoffs.entries()) {
    if (
      !handoff ||
      typeof handoff !== 'object' ||
      typeof handoff.outcome?.label !== 'string' ||
      typeof handoff.outcome?.detail !== 'string' ||
      typeof handoff.outcome?.tone !== 'string'
    ) {
      throw new Error(`Expected recent handoff ${index} to include current outcome`);
    }
  }
  for (const [index, run] of parallelRuns.entries()) {
    if (
      !run ||
      typeof run !== 'object' ||
      typeof run.batchId !== 'string' ||
      typeof run.batchTitle !== 'string' ||
      typeof run.laneCount !== 'number' ||
      !Array.isArray(run.handoffs)
    ) {
      throw new Error(`Expected parallel run ${index} to include batch metadata and handoffs`);
    }
  }
}

function validateParallelReadinessShape(readiness) {
  for (const key of ['activeCount', 'maxActiveLanes', 'openSlots', 'recommendedActiveLanes']) {
    if (!Number.isFinite(readiness.laneLoad[key])) {
      throw new Error(`Expected parallel readiness laneLoad.${key}`);
    }
  }
  for (const [index, candidate] of readiness.candidates.entries()) {
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      typeof candidate.workflowId !== 'string' ||
      !Array.isArray(candidate.ticketIds) ||
      !Array.isArray(candidate.changedPaths) ||
      !Array.isArray(candidate.changedZones) ||
      !Array.isArray(candidate.blockedBy) ||
      !Array.isArray(candidate.blocks)
    ) {
      throw new Error(`Expected parallel readiness candidate ${index} to include lane evidence`);
    }
  }
  for (const [index, pair] of readiness.pairwise.entries()) {
    if (
      !pair ||
      typeof pair !== 'object' ||
      typeof pair.leftWorkflowId !== 'string' ||
      typeof pair.rightWorkflowId !== 'string' ||
      typeof pair.status !== 'string' ||
      typeof pair.reason !== 'string'
    ) {
      throw new Error(`Expected parallel readiness pair ${index} to include status and reason`);
    }
  }
  for (const [index, wave] of readiness.suggestedWaves.entries()) {
    if (
      !wave ||
      typeof wave !== 'object' ||
      typeof wave.id !== 'string' ||
      !Array.isArray(wave.workflowIds) ||
      typeof wave.reason !== 'string'
    ) {
      throw new Error(`Expected parallel readiness wave ${index} to include workflow ids and reason`);
    }
  }
}

async function verifyDryRunAction(page, dashboard) {
  const action = buildDryRunAction(dashboard);
  if (!action) return;
  const response = await page.request.post(`${baseUrl}/api/workflow-action`, {
    data: {
      ...action,
      dryRun: true,
      workflowId: 'verify:dry-run',
    },
    headers: { 'content-type': 'application/json' },
    timeout: API_TIMEOUT_MS,
  });
  if (!response.ok()) {
    throw new Error(`Expected dry-run workflow action to pass, got ${response.status()}`);
  }
  const payload = await response.json();
  if (!payload.ok || !payload.dryRun || !payload.command || !payload.message) {
    throw new Error('Expected dry-run workflow action response metadata');
  }
}

async function verifyCleanupCompleteAction(page, dashboard) {
  const action = buildCleanupCompleteDryRunAction(dashboard);
  if (!action) return;
  const response = await page.request.post(`${baseUrl}/api/workflow-action`, {
    data: {
      ...action,
      dryRun: true,
      title: 'Verify cleanup',
    },
    headers: { 'content-type': 'application/json' },
    timeout: API_TIMEOUT_MS,
  });
  if (!response.ok()) {
    throw new Error(`Expected dry-run cleanup completion to pass, got ${response.status()}`);
  }
  const payload = await response.json();
  if (
    !payload.ok ||
    !payload.dryRun ||
    !String(payload.message ?? '').includes('No local files')
  ) {
    throw new Error('Expected cleanup completion to be a dry-run bookkeeping action');
  }
}

async function verifyTokensPage({ width, height, screenshot }) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });
  page.on('pageerror', (error) => errors.push(error.message));

  const tokensResponse = await page.request.get(
    `${baseUrl}/api/tokens?verify=${Date.now()}`,
    { headers: { 'cache-control': 'no-cache' }, timeout: API_TIMEOUT_MS },
  );
  if (!tokensResponse.ok()) {
    throw new Error(`Expected token API to load, got ${tokensResponse.status()}`);
  }
  validateTokenShape(await tokensResponse.json());

  await page.goto(`${baseUrl}/tokens?verify=${Date.now()}`, {
    timeout: API_TIMEOUT_MS,
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('[data-tokens-ready="true"]', { timeout: 20_000 });
  await page.waitForSelector('text=Spend, sessions, drift.', { timeout: 10_000 });
  await page.screenshot({ fullPage: true, path: screenshot, timeout: SCREENSHOT_TIMEOUT_MS });
  await page.close();
}

function validateTokenShape(usage) {
  if (
    typeof usage.totalTokens !== 'number' ||
    typeof usage.sessionCount !== 'number' ||
    typeof usage.sessionsWithUsage !== 'number' ||
    !usage.ranges?.all ||
    !usage.ranges?.week ||
    !usage.ranges?.today
  ) {
    throw new Error('Expected token usage summary shape');
  }
  for (const key of ['all', 'week', 'today']) {
    const range = usage.ranges[key];
    if (
      typeof range.totalTokens !== 'number' ||
      typeof range.label !== 'string' ||
      !Array.isArray(range.trend) ||
      !Array.isArray(range.topSessions)
    ) {
      throw new Error(`Expected token range ${key} to include totals and arrays`);
    }
  }
}

function buildDryRunAction(dashboard) {
  const ticket = dashboard.tickets.find((item) => item.ticketId);
  if (ticket && dashboard.repo?.path) {
    const linearTicket = dashboard.linearTickets.find(
      (item) => item.ticketId === ticket.ticketId,
    );
    return {
      branchName: linearTicket?.branchName ?? ticket.branches?.[0],
      kind: 'start-lane',
      prompt: 'Dry-run Ticketboard start-lane verification prompt.',
      ticketId: ticket.ticketId,
      ticketTitle: linearTicket?.title ?? ticket.title,
      title: ticket.ticketId,
    };
  }

  const window = dashboard.tmuxWindows.find(
    (item) => item.session && typeof item.index === 'number',
  );
  if (window) {
    return {
      index: window.index,
      kind: 'focus-tmux',
      session: window.session,
    };
  }

  const pr = dashboard.prs.find((item) => typeof item.number === 'number');
  if (pr) {
    return {
      kind: 'open-pr',
      prNumber: pr.number,
    };
  }

  const session = dashboard.codexSessions.find((item) => item.threadId && item.cwd);
  if (session) {
    return {
      cwd: session.cwd,
      kind: 'resume-codex',
      prompt: 'Dry-run Ticketboard verification prompt.',
      threadId: session.threadId,
      title: 'verify-codex',
    };
  }

  const worktree = dashboard.worktrees.find((item) => item.path);
  if (worktree) {
    return {
      kind: 'open-worktree',
      path: worktree.path,
    };
  }

  return null;
}

function buildCleanupCompleteDryRunAction(dashboard) {
  const worktree = dashboard.worktrees.find((item) => item.path);
  if (worktree) {
    return {
      kind: 'complete-cleanup',
      path: worktree.path,
      workflowId: `worktree:${worktree.path}`,
    };
  }

  const session = dashboard.codexSessions.find((item) => item.threadId);
  if (session) {
    return {
      kind: 'complete-cleanup',
      threadId: session.threadId,
      workflowId: `session:${session.threadId}`,
    };
  }

  const window = dashboard.tmuxWindows.find(
    (item) => item.session && typeof item.index === 'number',
  );
  if (window) {
    return {
      index: window.index,
      kind: 'complete-cleanup',
      session: window.session,
      workflowId: `tmux:${window.session}:${window.index}`,
    };
  }

  const ticket = dashboard.tickets.find((item) => item.ticketId);
  if (ticket) {
    return {
      kind: 'complete-cleanup',
      ticketId: ticket.ticketId,
      workflowId: `ticket:${ticket.ticketId}`,
    };
  }

  const pr = dashboard.prs.find((item) => typeof item.number === 'number');
  if (pr) {
    return {
      kind: 'complete-cleanup',
      prNumber: pr.number,
      workflowId: `pr:${pr.number}`,
    };
  }

  return null;
}

function dashboardHasWorkflowSource(dashboard) {
  return Boolean(
    dashboard.tickets.length ||
      dashboard.prs.length ||
      dashboard.codexSessions.length ||
      dashboard.worktrees.some((worktree) => (worktree.dirtyCount ?? 0) > 0),
  );
}
