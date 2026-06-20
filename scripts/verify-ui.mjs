import { chromium } from 'playwright';

const url = process.env.TICKETBOARD_URL ?? 'http://localhost:4317';
const baseUrl = url.replace(/\/$/, '');
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
    { headers: { 'cache-control': 'no-cache' } },
  );
  if (!dashboardResponse.ok()) {
    throw new Error(`Expected dashboard API to load, got ${dashboardResponse.status()}`);
  }
  const dashboard = await dashboardResponse.json();
  validateDashboardShape(dashboard);
  const briefResponse = await page.request.get(
    `${baseUrl}/api/workflow-brief?verify=${width}x${height}-${Date.now()}`,
    { headers: { 'cache-control': 'no-cache' } },
  );
  if (!briefResponse.ok()) {
    throw new Error(`Expected workflow brief API to load, got ${briefResponse.status()}`);
  }
  const workflowBrief = await briefResponse.json();
  validateWorkflowBriefShape(workflowBrief);
  const evidenceResponse = await page.request.get(
    `${baseUrl}/api/workflow-brief/evidence-snapshot?refresh=1&verify=${width}x${height}-${Date.now()}`,
    { headers: { 'cache-control': 'no-cache' } },
  );
  if (!evidenceResponse.ok()) {
    throw new Error(`Expected workflow evidence API to load, got ${evidenceResponse.status()}`);
  }
  validateWorkflowEvidenceShape(await evidenceResponse.json());
  await verifyUserStateApi(page);
  await mockUserStateRoutes(page);

  await page.goto(`${baseUrl}/?verify=${width}x${height}-${Date.now()}`);
  await page.waitForLoadState('networkidle');
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
        '## Lane matrix',
        '## After focus clears',
        '## Parallel lanes',
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
    if ((await page.locator('[data-testid="command-strip"] .metric-pill').count()) > 0) {
      throw new Error('Workflow command strip should not expose source-count metric pills');
    }
    await assertDefaultVisibleCopy(page, workflowBrief.status === 'ready');
    if (workflowBrief.status === 'ready') {
      await page.waitForSelector('[data-testid="workflow-brief"]', { timeout: 10_000 });
      await assertWorkflowBriefSelection(page, workflowBrief);
      if (Array.isArray(workflowBrief.brief?.lanes) && workflowBrief.brief.lanes.length) {
        await page.waitForSelector('[data-parallel-lanes]', { timeout: 10_000 });
        await page.waitForSelector('[data-parallel-batch]', { timeout: 10_000 });
        if ((await page.locator('[data-batch-lane]').count()) < 1) {
          throw new Error('Expected parallel lane panel to name the current safe batch');
        }
        if ((await page.locator('[data-batch-decision]').count()) < 1) {
          throw new Error('Expected parallel lane panel to explain batch decisions');
        }
        if ((await page.locator('[data-batch-decision-status="ready"], [data-batch-decision-status="guarded"]').count()) < 1) {
          throw new Error('Expected batch decisions to expose ready or guarded candidates');
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
    await page.locator('.manual-fallbacks summary').click();
    await verifyCopyAction({
      button: page.locator('[data-testid="copy-packet"]').first(),
      expected: ['# Ticketboard work packet', '## Live handoff', '## Context'],
      page,
    });
    await verifyCopyAction({
      button: page.locator('[data-testid="copy-prompt"]').first(),
      expected: ['Use this Ticketboard packet', 'Live handoff:', 'Source context:'],
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

  await page.screenshot({ fullPage: true, path: screenshot });
  try {
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

async function mockUserStateRoutes(page) {
  const state = {
    dismissed: {},
    handoffs: [
      {
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

async function verifyUserStateApi(page) {
  const id = `verify-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const response = await page.request.get(`${baseUrl}/api/user-state?verify=${Date.now()}`);
  if (!response.ok()) {
    throw new Error(`Expected user-state API to load, got ${response.status()}`);
  }
  validateUserStateShape(await response.json());

  try {
    const dismissResponse = await page.request.post(`${baseUrl}/api/user-state/dismiss`, {
      data: { id, kind: 'snooze' },
      headers: { 'content-type': 'application/json' },
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
    );
  }
}

async function verifyCopyAction({ button, expected, page }) {
  await button.click();
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
    !response.automation ||
    typeof response.automation !== 'object' ||
    typeof response.automation.fingerprintPath !== 'string' ||
    typeof response.automation.lockPath !== 'string' ||
    typeof response.automation.lockActive !== 'boolean' ||
    !Number.isFinite(response.automation.intervalSeconds)
  ) {
    throw new Error('Expected workflow brief response automation status');
  }
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

function validateWorkflowEvidenceShape(response) {
  const recentHandoffs = response?.snapshot?.recentHandoffs;
  const planDocs = response?.snapshot?.planDocs;
  const planningSignals = response?.snapshot?.planningSignals;
  const prs = response?.snapshot?.prs;
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
    !Array.isArray(recentHandoffs) ||
    !Array.isArray(prs)
  ) {
    throw new Error('Expected workflow evidence snapshot to include plan docs, recent handoffs, and PRs');
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
  });
  if (!response.ok()) {
    throw new Error(`Expected dry-run workflow action to pass, got ${response.status()}`);
  }
  const payload = await response.json();
  if (!payload.ok || !payload.dryRun || !payload.command || !payload.message) {
    throw new Error('Expected dry-run workflow action response metadata');
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
    { headers: { 'cache-control': 'no-cache' } },
  );
  if (!tokensResponse.ok()) {
    throw new Error(`Expected token API to load, got ${tokensResponse.status()}`);
  }
  validateTokenShape(await tokensResponse.json());

  await page.goto(`${baseUrl}/tokens?verify=${Date.now()}`);
  await page.waitForLoadState('networkidle');
  await page.waitForSelector('[data-tokens-ready="true"]', { timeout: 20_000 });
  await page.waitForSelector('text=Spend, sessions, drift.', { timeout: 10_000 });
  await page.screenshot({ fullPage: true, path: screenshot });
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

function dashboardHasWorkflowSource(dashboard) {
  return Boolean(
    dashboard.tickets.length ||
      dashboard.prs.length ||
      dashboard.codexSessions.length ||
      dashboard.worktrees.some((worktree) => (worktree.dirtyCount ?? 0) > 0),
  );
}
