import { mkdirSync } from 'node:fs';
import { URL } from 'node:url';

import { chromium } from 'playwright';

const baseUrl = (process.env.TICKETBOARD_URL ?? 'http://127.0.0.1:4317').replace(
  /\/$/,
  '',
);
const outputDir = new URL('../docs/assets/', import.meta.url);

mkdirSync(outputDir, { recursive: true });

const browser = await launchBrowser();

try {
  await captureWorkflows();
  await captureTokens();
} finally {
  await browser.close();
}

console.log('captured README screenshots');

async function launchBrowser() {
  try {
    return await chromium.launch({ channel: 'chrome', headless: true });
  } catch {
    return chromium.launch({ headless: true });
  }
}

async function captureWorkflows() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await installMockRoutes(page);
  await page.goto(`${baseUrl}/`);
  await page.waitForLoadState('networkidle');
  await page.waitForSelector('[data-testid="workflow-brief"]', { timeout: 20_000 });
  await page.screenshot({
    fullPage: true,
    path: new URL('ticketboard-workflows.png', outputDir).pathname,
  });
  await page.close();
}

async function captureTokens() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  await installMockRoutes(page);
  await page.goto(`${baseUrl}/tokens`);
  await page.waitForLoadState('networkidle');
  await page.waitForSelector('[data-tokens-ready="true"]', { timeout: 20_000 });
  await page.screenshot({
    fullPage: true,
    path: new URL('ticketboard-tokens.png', outputDir).pathname,
  });
  await page.close();
}

async function installMockRoutes(page) {
  await page.route('**/api/dashboard**', async (route) => {
    await route.fulfill({
      body: JSON.stringify(mockDashboard()),
      contentType: 'application/json',
      status: 200,
    });
  });
  await page.route('**/api/workflow-brief**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/evidence-snapshot')) {
      await route.fulfill({
        body: JSON.stringify({
          briefPath: '/Users/you/.codex/ticketboard/workflow-brief.json',
          path: '/Users/you/.codex/ticketboard/workflow-evidence-snapshot.json',
          snapshot: {},
        }),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }
    await route.fulfill({
      body: JSON.stringify(mockWorkflowBrief()),
      contentType: 'application/json',
      status: 200,
    });
  });
  await page.route('**/api/user-state**', async (route) => {
    await route.fulfill({
      body: JSON.stringify({ dismissed: {} }),
      contentType: 'application/json',
      status: 200,
    });
  });
  await page.route('**/api/tokens**', async (route) => {
    await route.fulfill({
      body: JSON.stringify(mockTokens()),
      contentType: 'application/json',
      status: 200,
    });
  });
}

function mockDashboard() {
  const now = new Date().toISOString();
  return {
    codexSessions: [
      {
        cwd: '/Users/you/work/product/.codex/worktrees/app-214',
        gitBranch: 'feature/app-214-checkout-retry',
        goalObjective: 'Fix checkout retry behavior and leave the PR ready.',
        goalStatus: 'active',
        goalTokenBudget: null,
        goalTokensUsed: 186_420,
        latestMessages: [
          {
            role: 'assistant',
            text: 'Reproduced the retry failure and isolated it to the payment callback.',
            timestamp: now,
          },
        ],
        model: 'gpt-5.5',
        modelProvider: 'openai',
        preview: 'Working through the checkout retry failure.',
        reasoningEffort: 'high',
        recentToolCalls: [],
        status: 'goal-active',
        threadId: 'demo-thread-app-214',
        ticketIds: ['APP-214'],
        title: '$linear-ticket-to-pr APP-214',
        tokensUsed: 186_420,
        updatedAt: now,
      },
    ],
    diagnostics: [],
    generatedAt: now,
    linearTickets: [
      mockLinearTicket({
        description:
          'Retry failures at checkout are creating duplicate support pings. Keep the change narrow and preserve the existing payment flow.',
        stateName: 'In Progress',
        stateType: 'started',
        ticketId: 'APP-214',
        title: 'Fix checkout retry loop after payment timeout',
      }),
      mockLinearTicket({
        description: 'Replace the stale onboarding API in the next product slice.',
        stateName: 'Backlog',
        stateType: 'unstarted',
        ticketId: 'APP-219',
        title: 'Port onboarding API to the new capability gate',
      }),
    ],
    prs: [
      mockPullRequest({
        checkState: 'red',
        failed: 1,
        number: 128,
        pending: 0,
        reviewDecision: null,
        ticketIds: ['APP-214'],
        title: 'APP-214 Fix checkout retry loop',
      }),
    ],
    repo: {
      nameWithOwner: 'acme/product',
      path: '/Users/you/work/product',
      url: 'https://github.com/acme/product',
    },
    scope: {
      githubLogin: 'you',
      linearOwners: ['you@example.com'],
    },
    tickets: [
      {
        branches: ['feature/app-214-checkout-retry'],
        nextAction: 'Fix failing PR checks',
        prNumbers: [128],
        risk: 'high',
        state: 'blocked',
        ticketId: 'APP-214',
        title: 'Fix checkout retry loop after payment timeout',
        windows: ['product:2'],
        worktrees: ['/Users/you/work/product/.codex/worktrees/app-214'],
      },
      {
        branches: ['feature/app-219-capability-gate'],
        nextAction: 'No immediate action',
        prNumbers: [],
        risk: 'low',
        state: 'quiet',
        ticketId: 'APP-219',
        title: 'Port onboarding API to the new capability gate',
        windows: [],
        worktrees: [],
      },
    ],
    tmuxWindows: [
      {
        active: true,
        command: 'node',
        index: 2,
        isCodexLike: false,
        name: 'work:APP-214',
        paneId: '%2',
        panePid: 42002,
        panePreview: '',
        panePreviewTruncated: false,
        path: '/Users/you/work/product',
        session: 'product',
        ticketIds: ['APP-214'],
      },
      {
        active: false,
        command: 'zsh',
        index: 3,
        isCodexLike: false,
        name: 'stale:APP-198',
        paneId: '%3',
        panePid: 42003,
        panePreview: '',
        panePreviewTruncated: false,
        path: '/Users/you/work/product',
        session: 'product',
        ticketIds: [],
      },
    ],
    worktrees: [
      {
        branch: 'feature/app-214-checkout-retry',
        dirtyCount: 2,
        exists: true,
        head: 'abc1234',
        path: '/Users/you/work/product/.codex/worktrees/app-214',
        prunable: false,
        statusLines: [' M src/payments/retry.ts', ' M tests/payments/retry.test.ts'],
        ticketIds: ['APP-214'],
      },
    ],
  };
}

function mockWorkflowBrief() {
  return {
    ageSeconds: 42,
    brief: {
      generatedAt: new Date().toISOString(),
      lanes: [
        {
          action: 'Fix the failing checkout retry check.',
          automation: 'Resume Codex',
          confidence: 'high',
          evidence: ['PR #128 has one failing check.'],
          handoffWhen: 'Checks are green or the blocker is captured.',
          laneId: 'focus:APP-214',
          parallelSafe: false,
          prNumber: 128,
          role: 'focus',
          status: 'Active terminal lane',
          ticketId: 'APP-214',
          title: 'Checkout retry loop',
          why: 'This is the live interruption and owns focus.',
          workflowId: 'ticket:APP-214',
        },
        {
          action: 'Create the first implementation lane.',
          automation: 'Start Codex lane',
          confidence: 'medium',
          evidence: ['APP-219 has no live lane yet.'],
          handoffWhen: 'A branch exists with a first change or blocker.',
          laneId: 'parallel:APP-219',
          parallelSafe: true,
          role: 'parallel',
          status: 'Ready to start',
          ticketId: 'APP-219',
          title: 'Capability gate',
          why: 'It can proceed independently after the checkout lane is stable.',
          workflowId: 'ticket:APP-219',
        },
      ],
      next: [
        {
          action: 'Prepare the capability-gate slice after checkout is stable.',
          confidence: 'medium',
          evidence: ['APP-219 is next in the planning doc.'],
          ticketId: 'APP-219',
          title: 'Capability gate',
          why: 'It is next, but it has no live lane yet.',
          workflowId: 'ticket:APP-219',
        },
      ],
      now: {
        action: 'Fix the failing checkout retry check.',
        commands: ['tmux select-window -t product:2', 'pnpm test payments/retry'],
        confidence: 'high',
        evidence: [
          'PR #128 has one failing check.',
          'tmux product:2 is the active APP-214 lane.',
          'The worktree has two local payment retry changes.',
        ],
        finishedWhen: 'PR #128 is green or the blocker is captured in the handoff.',
        prNumber: 128,
        ticketId: 'APP-214',
        title: 'Checkout retry loop',
        why:
          'The active tmux lane and PR state both point to APP-214 as the current interruption.',
        workflowId: 'ticket:APP-214',
      },
      notes: ['Demo data is sanitized for README screenshots.'],
      operatingMode: {
        maxActiveLanes: 3,
        rationale: 'One focused fix lane plus one independent starter lane is safe.',
        recommendedActiveLanes: 2,
        summary: 'Keep checkout as focus; prepare one independent lane behind it.',
      },
      source: {
        dashboardGeneratedAt: new Date().toISOString(),
        evidenceSnapshotPath: '/Users/you/.codex/ticketboard/workflow-evidence-snapshot.json',
        planDocPath: '/Users/you/notes/work-plan.md',
      },
      staleSignals: [
        {
          action: 'Ignore until the pane is cleaned up.',
          confidence: 'high',
          evidence: ['The tmux window exists but no current ticket links to it.'],
          title: 'Old terminal lane',
          why: 'It is present in tmux, but not actionable.',
        },
      ],
      version: 1,
    },
    path: '/Users/you/.codex/ticketboard/workflow-brief.json',
    reason: null,
    status: 'ready',
  };
}

function mockTokens() {
  const now = new Date();
  const trend = Array.from({ length: 8 }, (_, index) => ({
    label: `D${index + 1}`,
    timestamp: new Date(now.getTime() - (7 - index) * 86_400_000).toISOString(),
    totalTokens: [82_000, 118_000, 96_000, 164_000, 142_000, 208_000, 132_000, 176_000][index],
  }));
  const topSessions = [
    {
      cwd: '/Users/you/work/product/.codex/worktrees/app-214',
      model: 'gpt-5.5',
      threadId: 'demo-thread-app-214',
      title: 'APP-214 checkout retry',
      tokens: 186_420,
      updatedAt: now.toISOString(),
    },
    {
      cwd: '/Users/you/work/product',
      model: 'gpt-5.5',
      threadId: 'demo-thread-planner',
      title: 'orchestrator planning pass',
      tokens: 94_100,
      updatedAt: new Date(now.getTime() - 3_600_000).toISOString(),
    },
  ];
  return {
    range: 'week',
    ranges: {
      all: {
        label: 'All time',
        periodStart: null,
        topSessions,
        totalTokens: 3_842_000,
        trend,
      },
      today: {
        label: 'Today',
        periodStart: now.toISOString(),
        topSessions: topSessions.slice(0, 1),
        totalTokens: 176_000,
        trend: trend.slice(-3),
      },
      week: {
        label: 'This week',
        periodStart: new Date(now.getTime() - 7 * 86_400_000).toISOString(),
        topSessions,
        totalTokens: 1_118_000,
        trend,
      },
    },
    sessionCount: 42,
    sessionsWithUsage: 31,
    totalTokens: 3_842_000,
    updatedAt: now.toISOString(),
  };
}

function mockLinearTicket({ description, stateName, stateType, ticketId, title }) {
  const now = new Date().toISOString();
  return {
    activity: [],
    assignee: 'You',
    assigneeEmail: 'you@example.com',
    assigneeId: 'user-demo',
    assigneeName: 'You',
    attachments: [],
    branchName: `feature/${ticketId.toLowerCase()}-${slug(title)}`,
    children: [],
    comments: [],
    completedAt: null,
    createdAt: now,
    creator: null,
    cycleName: null,
    description,
    detailLevel: 'summary',
    dueDate: null,
    labels: [],
    parent: null,
    priority: 2,
    projectName: 'Product workflow',
    projectUrl: null,
    relatedIssues: [],
    startedAt: stateType === 'started' ? now : null,
    stateName,
    stateType,
    teamName: 'APP',
    ticketId,
    title,
    updatedAt: now,
    url: `https://linear.app/acme/issue/${ticketId}`,
  };
}

function mockPullRequest({ checkState, failed, number, pending, reviewDecision, ticketIds, title }) {
  const now = new Date().toISOString();
  return {
    additions: 148,
    assignees: [],
    author: 'you',
    baseRefName: 'main',
    bodyPreview: '',
    checkSummary: {
      failed,
      passed: checkState === 'green' ? 8 : 7,
      pending,
      state: checkState,
      total: 8,
    },
    checks: [],
    commentCount: 1,
    commits: [],
    deletions: 32,
    detailLevel: 'summary',
    files: [],
    headRefName: `feature/${ticketIds[0].toLowerCase()}-${slug(title)}`,
    isDraft: false,
    labels: [],
    latestComments: [],
    latestReviews: [],
    mergeStateStatus: checkState === 'red' ? 'BLOCKED' : 'CLEAN',
    milestone: null,
    number,
    reviewComments: [],
    reviewCount: 0,
    reviewDecision,
    reviewRequests: [],
    ticketIds,
    title,
    updatedAt: now,
    url: `https://github.com/acme/product/pull/${number}`,
  };
}

function slug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}
