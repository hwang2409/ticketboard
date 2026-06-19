import {
  AlertTriangle,
  ArrowRight,
  Bot,
  Check,
  ChevronRight,
  Clipboard,
  ExternalLink,
  Loader2,
  Play,
  RefreshCw,
  Search,
  Sparkles,
  SquareTerminal,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { ThemeToggle } from './theme';
import type {
  CodexMessageSummary,
  CodexSessionSummary,
  DashboardData,
  LinearTicketSummary,
  TokenUsageSummary,
  PullRequestSummary,
  TicketRow,
  TmuxWindowSummary,
  WorkflowBrief,
  WorkflowBriefResponse,
  WorkflowActionRequest,
  WorkflowActionResponse,
  WorktreeSummary,
} from './types';

const AUTO_REFRESH_MS = 30_000;
const LOCAL_STATE_KEY = 'ticketboard-simple-state-v1';

type AppLoadState =
  | { data: DashboardData; error: null; loading: false }
  | { data: DashboardData | null; error: string; loading: false }
  | { data: DashboardData | null; error: null; loading: true };

type TokenLoadState =
  | { data: TokenUsageSummary; error: null; loading: false }
  | { data: TokenUsageSummary | null; error: string; loading: false }
  | { data: TokenUsageSummary | null; error: null; loading: true };

type BriefLoadState =
  | { data: WorkflowBriefResponse; error: null; loading: false }
  | { data: WorkflowBriefResponse | null; error: string; loading: false }
  | { data: WorkflowBriefResponse | null; error: null; loading: true };

type WorkflowIntent =
  | 'clean'
  | 'fix-ci'
  | 'review'
  | 'resume'
  | 'ship'
  | 'start'
  | 'watch';

type WorkflowMode = 'cleanup' | 'now' | 'ship' | 'start';

type WorkflowTone = 'calm' | 'hot' | 'ready' | 'warn';

type DismissedWorkflow = {
  createdAt?: string | null;
  kind?: 'dismiss' | 'snooze' | string;
  until?: string | null;
};

type LocalState = {
  dismissed: Record<string, DismissedWorkflow>;
};

type ActionButtonState =
  | { message: string; status: 'done'; title: string }
  | { message: string; status: 'failed'; title: string }
  | { message: string; status: 'idle'; title: string }
  | { message: string; status: 'running'; title: string };

type PlannedWorkflowAction = {
  advanceOnSuccess?: boolean;
  label: string;
  request: WorkflowActionRequest;
  runningLabel: string;
};

type WorkflowHandoff = {
  done: string;
  finish: string;
  next: string;
  now: string;
  reason: string;
};

type WorkflowItem = {
  id: string;
  intent: WorkflowIntent;
  tone: WorkflowTone;
  score: number;
  source: string;
  title: string;
  eyebrow: string;
  subtitle: string;
  nextStep: string;
  reason: string;
  primaryHref: string | null;
  primaryLabel: string;
  ticket: TicketRow | null;
  linearTicket: LinearTicketSummary | null;
  prs: Array<PullRequestSummary>;
  sessions: Array<CodexSessionSummary>;
  worktrees: Array<WorktreeSummary>;
  windows: Array<TmuxWindowSummary>;
  evidence: Array<string>;
  signals: Array<string>;
  commands: Array<string>;
};

type ProjectPlanTone = 'calm' | 'hot' | 'ready' | 'warn';

type ProjectPlanItem = {
  id: string;
  detail: string;
  label: string;
  meta: string;
  tone: ProjectPlanTone;
  workflowId: string | null;
};

type ProjectPlanSection = {
  id: 'cleanup' | 'done' | 'next' | 'now';
  empty: string;
  items: Array<ProjectPlanItem>;
  title: string;
};

type ProjectPlan = {
  summary: string;
  sections: Array<ProjectPlanSection>;
};

type CommandSummary = {
  description: string;
  status: string;
  title: string;
  tone: WorkflowTone;
};

const WORKFLOW_MODES: Array<{ id: WorkflowMode; label: string; hint: string }> = [
  { id: 'now', label: 'Now', hint: 'The smallest useful next move' },
  { id: 'ship', label: 'Ship', hint: 'Reviews and failing checks' },
  { id: 'start', label: 'Start', hint: 'Tickets that need an implementation lane' },
  { id: 'cleanup', label: 'Clean', hint: 'Dirty worktrees and stale sessions' },
];

const INTENT_LABELS: Record<WorkflowIntent, string> = {
  clean: 'Clean up',
  'fix-ci': 'Fix checks',
  review: 'Review',
  resume: 'Resume',
  ship: 'Ship',
  start: 'Start',
  watch: 'Watch',
};

const INTENT_SORT: Record<WorkflowIntent, number> = {
  'fix-ci': 100,
  review: 92,
  ship: 86,
  resume: 72,
  start: 60,
  clean: 54,
  watch: 20,
};

export function App() {
  const [routePath, setRoutePath] = useState(() => window.location.pathname);
  const [loadState, setLoadState] = useState<AppLoadState>({
    data: null,
    error: null,
    loading: true,
  });
  const [briefState, setBriefState] = useState<BriefLoadState>({
    data: null,
    error: null,
    loading: true,
  });
  const [refreshing, setRefreshing] = useState(false);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [mode, setMode] = useState<WorkflowMode>('now');
  const [query, setQuery] = useState('');
  const [localState, setLocalState] = useState<LocalState>(readLocalState);

  useEffect(() => {
    const handleLocationChange = () => setRoutePath(window.location.pathname);
    window.addEventListener('popstate', handleLocationChange);
    return () => window.removeEventListener('popstate', handleLocationChange);
  }, []);

  const refreshDashboard = useCallback(async (force = false) => {
    const controller = new AbortController();
    const url = force ? '/api/dashboard?refresh=1' : '/api/dashboard';
    setRefreshing(true);
    try {
      const response = await fetch(url, {
        headers: { 'cache-control': 'no-cache' },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Dashboard request failed with ${response.status}`);
      }
      const data = (await response.json()) as DashboardData;
      setLoadState({ data, error: null, loading: false });
    } catch (error) {
      setLoadState((previous) => ({
        data: previous.data,
        error: error instanceof Error ? error.message : 'Unable to load dashboard',
        loading: false,
      }));
    } finally {
      setRefreshing(false);
    }
    return () => controller.abort();
  }, []);

  const refreshWorkflowBrief = useCallback(async (force = false) => {
    const url = force ? '/api/workflow-brief?refresh=1' : '/api/workflow-brief';
    try {
      const response = await fetch(url, {
        headers: { 'cache-control': 'no-cache' },
      });
      if (!response.ok) {
        throw new Error(`Workflow brief request failed with ${response.status}`);
      }
      setBriefState({
        data: (await response.json()) as WorkflowBriefResponse,
        error: null,
        loading: false,
      });
    } catch (error) {
      setBriefState((current) => ({
        data: current.data,
        error: error instanceof Error ? error.message : 'Unable to load workflow brief',
        loading: false,
      }));
    }
  }, []);

  useEffect(() => {
    void refreshDashboard(false);
    void refreshWorkflowBrief(false);
    const timer = window.setInterval(() => {
      void refreshDashboard(false);
      void refreshWorkflowBrief(false);
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refreshDashboard, refreshWorkflowBrief]);

  useEffect(() => {
    let cancelled = false;
    void fetchUserState()
      .then((serverState) => {
        if (!cancelled) {
          setLocalState((current) => mergeLocalState(current, serverState));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    writeLocalState(localState);
  }, [localState]);

  const dashboard = loadState.data;
  const skippedIds = useMemo(
    () => new Set(activeSkippedIds(localState)),
    [localState],
  );
  const workflows = useMemo(
    () => (dashboard ? buildWorkflows(dashboard) : []),
    [dashboard],
  );
  const workflowBrief =
    briefState.data?.status === 'ready' ? briefState.data.brief : null;
  const briefWorkflowId = useMemo(
    () => workflowIdFromBrief(workflowBrief, workflows),
    [workflowBrief, workflows],
  );
  const visibleWorkflows = useMemo(
    () =>
      workflows
        .filter((workflow) => !skippedIds.has(workflow.id))
        .filter((workflow) => workflowMatchesMode(workflow, mode))
        .filter((workflow) => workflowMatchesQuery(workflow, query)),
    [mode, query, skippedIds, workflows],
  );
  const selectedWorkflow =
    workflows.find((workflow) => workflow.id === selectedWorkflowId) ??
    workflows.find((workflow) => workflow.id === briefWorkflowId) ??
    visibleWorkflows[0] ??
    workflows.find((workflow) => !skippedIds.has(workflow.id)) ??
    workflows[0] ??
    null;
  const modeCounts = useMemo(
    () => buildModeCounts(workflows, skippedIds, query),
    [query, skippedIds, workflows],
  );
  const hiddenCount = skippedIds.size;
  const projectPlan = useMemo(
    () =>
      dashboard
        ? buildProjectPlan({
            dashboard,
            selectedWorkflow,
            visibleWorkflows,
            workflows,
          })
        : null,
    [dashboard, selectedWorkflow, visibleWorkflows, workflows],
  );
  const commandSummary = useMemo(
    () =>
      buildCommandSummary({
        brief: workflowBrief,
        briefStatus: briefState.data,
        dashboard,
        selectedWorkflow,
      }),
    [briefState.data, dashboard, selectedWorkflow, workflowBrief],
  );

  const handleSkip = useCallback((workflow: WorkflowItem) => {
    setLocalState((current) => dismissWorkflowInState(current, workflow.id));
    setSelectedWorkflowId(null);
    void persistDismissedWorkflow(workflow.id).then((serverState) => {
      if (serverState) {
        setLocalState((current) => mergeLocalState(current, serverState));
      }
    });
  }, []);

  const handleActionComplete = useCallback(
    (workflow: WorkflowItem, shouldAdvance: boolean) => {
      if (shouldAdvance) {
        setLocalState((current) => dismissWorkflowInState(current, workflow.id));
        setSelectedWorkflowId(null);
        void persistDismissedWorkflow(workflow.id).then((serverState) => {
          if (serverState) {
            setLocalState((current) => mergeLocalState(current, serverState));
          }
        });
      }
      void refreshDashboard(true);
      void refreshWorkflowBrief(true);
    },
    [refreshDashboard, refreshWorkflowBrief],
  );

  const handleRestoreSkipped = useCallback(() => {
    const ids = Object.keys(localState.dismissed);
    setLocalState({ dismissed: {} });
    void Promise.all(ids.map((id) => removeDismissedWorkflow(id))).catch(() => undefined);
  }, [localState.dismissed]);

  return (
    <div className="app-shell" data-app-ready={Boolean(dashboard)}>
      <header className="topbar">
        <a className="brand-mark" href="/" aria-label="Ticketboard home">
          <span className="brand-sigil">tb</span>
          <span>
            <strong>Ticketboard</strong>
            <em>one move at a time</em>
          </span>
        </a>
        <div className="topbar-actions">
          <nav className="topbar-nav" aria-label="Ticketboard views">
            <a aria-current={routePath !== '/tokens' ? 'page' : undefined} href="/">
              Workflows
            </a>
            <a aria-current={routePath === '/tokens' ? 'page' : undefined} href="/tokens">
              Tokens
            </a>
          </nav>
          {dashboard ? (
            <span className="sync-note">
              Synced {formatRelativeTime(dashboard.generatedAt)}
              {briefState.data?.status === 'ready'
                ? ` / brief ${formatRelativeTime(briefState.data.brief?.generatedAt ?? '')}`
                : ''}
            </span>
          ) : null}
          <button
            className="ghost-button"
            disabled={refreshing}
            onClick={() => {
              void refreshDashboard(true);
              void refreshWorkflowBrief(true);
            }}
            type="button"
          >
            {refreshing ? (
              <Loader2 aria-hidden="true" className="spin" size={15} />
            ) : (
              <RefreshCw aria-hidden="true" size={15} />
            )}
            Refresh
          </button>
          <ThemeToggle />
        </div>
      </header>

      {routePath === '/tokens' ? (
        <TokensPage />
      ) : (
        <main className="workspace">
          <CommandStrip summary={commandSummary} />

          {loadState.loading && !dashboard ? <LoadingState /> : null}
          {loadState.error ? <ErrorState message={loadState.error} /> : null}

          {dashboard && selectedWorkflow && projectPlan ? (
            <div className="operator-grid">
              <PrimaryWorkflow
                dashboard={dashboard}
                workflowBrief={
                  workflowBrief && briefAppliesToWorkflow(workflowBrief, selectedWorkflow)
                    ? workflowBrief
                    : null
                }
                workflowBriefStatus={briefState.data}
                onActionComplete={(shouldAdvance) =>
                  handleActionComplete(selectedWorkflow, shouldAdvance)
                }
                onSkip={handleSkip}
                workflow={selectedWorkflow}
              />
              <ProjectPlanRail
                hiddenCount={hiddenCount}
                mode={mode}
                modeCounts={modeCounts}
                onModeChange={setMode}
                onQueryChange={setQuery}
                onRestoreSkipped={handleRestoreSkipped}
                onSelect={setSelectedWorkflowId}
                plan={projectPlan}
                query={query}
                selectedWorkflowId={selectedWorkflow.id}
                visibleWorkflows={visibleWorkflows}
                workflows={workflows}
              />
            </div>
          ) : null}

          {dashboard && !selectedWorkflow ? (
            <EmptyWorkflowState
              hiddenCount={hiddenCount}
              onRestoreSkipped={handleRestoreSkipped}
            />
          ) : null}
        </main>
      )}
    </div>
  );
}

function CommandStrip({ summary }: { summary: CommandSummary }) {
  return (
    <section
      className={`command-strip command-strip-${summary.tone}`}
      aria-label="Workflow command surface"
      data-testid="command-strip"
    >
      <span className="section-kicker">{'Work -> handoff -> ship'}</span>
      <div className="command-copy">
        <strong>{summary.title}</strong>
        <p>{summary.description}</p>
      </div>
      <span className="command-status" data-testid="command-status">
        {summary.status}
      </span>
    </section>
  );
}

function buildCommandSummary({
  brief,
  briefStatus,
  dashboard,
  selectedWorkflow,
}: {
  brief: WorkflowBrief | null;
  briefStatus: WorkflowBriefResponse | null;
  dashboard: DashboardData | null;
  selectedWorkflow: WorkflowItem | null;
}): CommandSummary {
  if (!dashboard || !selectedWorkflow) {
    return {
      description: 'Ticketboard is reading live workflow signals.',
      status: 'Loading',
      title: 'Finding the next move.',
      tone: 'calm',
    };
  }

  const action = buildWorkflowAction(
    selectedWorkflow,
    dashboard,
    buildCodexPrompt(selectedWorkflow),
  );

  if (brief && briefAppliesToWorkflow(brief, selectedWorkflow)) {
    return {
      description: brief.now.why,
      status: brief.now.action,
      title: 'Codex brief is driving this move.',
      tone: selectedWorkflow.tone,
    };
  }

  if (briefStatus && briefStatus.status !== 'ready') {
    return {
      description: selectedWorkflow.nextStep,
      status: briefStatus.status === 'missing' ? 'No brief yet' : 'Brief needs refresh',
      title: 'Next up from live signals.',
      tone: selectedWorkflow.tone,
    };
  }

  return {
    description: selectedWorkflow.nextStep,
    status: action?.label ?? selectedWorkflow.primaryLabel,
    title: 'Next up.',
    tone: selectedWorkflow.tone,
  };
}

function MetricPill({
  label,
  tone = 'neutral',
  value,
}: {
  label: string;
  tone?: 'hot' | 'neutral';
  value: number | string;
}) {
  return (
    <span className={`metric-pill metric-pill-${tone}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </span>
  );
}

function TokensPage() {
  const [state, setState] = useState<TokenLoadState>({
    data: null,
    error: null,
    loading: true,
  });

  const refreshTokens = useCallback(async () => {
    setState((current) => ({ data: current.data, error: null, loading: true }));
    try {
      const response = await fetch('/api/tokens', {
        headers: { 'cache-control': 'no-cache' },
      });
      if (!response.ok) {
        throw new Error(`Token request failed with ${response.status}`);
      }
      setState({
        data: (await response.json()) as TokenUsageSummary,
        error: null,
        loading: false,
      });
    } catch (error) {
      setState((current) => ({
        data: current.data,
        error: error instanceof Error ? error.message : 'Unable to load token usage',
        loading: false,
      }));
    }
  }, []);

  useEffect(() => {
    void refreshTokens();
  }, [refreshTokens]);

  const usage = state.data;
  const activeRange = usage?.ranges[usage.range ?? 'week'] ?? usage?.ranges.week;

  return (
    <main className="workspace tokens-workspace" data-tokens-ready={Boolean(usage)}>
      <section className="hero-strip tokens-hero" aria-label="Codex token usage">
        <div className="hero-copy">
          <span className="section-kicker">Codex tokens</span>
          <h1>Spend, sessions, drift.</h1>
          <p>
            A compact read on Codex usage so the workflow stays fast without hiding
            runaway sessions.
          </p>
        </div>
        {usage ? (
          <div className="snapshot-pills">
            <MetricPill label="All tokens" value={formatCompactNumber(usage.totalTokens)} />
            <MetricPill label="Sessions" value={usage.sessionCount} />
            <MetricPill label="With usage" value={usage.sessionsWithUsage} />
            <MetricPill label="Today" value={formatCompactNumber(usage.ranges.today.totalTokens)} />
          </div>
        ) : null}
      </section>

      {state.loading && !usage ? <LoadingState /> : null}
      {state.error ? <ErrorState message={state.error} /> : null}

      {usage && activeRange ? (
        <section className="tokens-grid">
          <div className="token-panel token-panel-primary">
            <div className="panel-head">
              <span className="section-kicker">{activeRange.label}</span>
              <button className="ghost-button" onClick={() => void refreshTokens()} type="button">
                <RefreshCw aria-hidden="true" size={15} />
                Refresh
              </button>
            </div>
            <strong>{formatNumber(activeRange.totalTokens)}</strong>
            <p>tokens in this range</p>
            <TokenTrend points={activeRange.trend} />
          </div>

          <div className="token-panel">
            <div className="panel-head">
              <span className="section-kicker">Top sessions</span>
            </div>
            <div className="token-session-list">
              {activeRange.topSessions.length ? (
                activeRange.topSessions.slice(0, 8).map((session) => (
                  <div className="token-session" key={session.threadId}>
                    <span>
                      <strong>{session.title}</strong>
                      <em>{shortPath(session.cwd)}</em>
                    </span>
                    <b>{formatCompactNumber(session.tokens)}</b>
                  </div>
                ))
              ) : (
                <p>No token-bearing Codex sessions in this range.</p>
              )}
            </div>
          </div>
        </section>
      ) : null}
    </main>
  );
}

function TokenTrend({
  points,
}: {
  points: TokenUsageSummary['ranges']['week']['trend'];
}) {
  const max = Math.max(1, ...points.map((point) => point.totalTokens));
  return (
    <div className="token-trend" aria-label="Token usage trend">
      {points.slice(-14).map((point) => (
        <span key={point.timestamp} title={`${point.label}: ${formatNumber(point.totalTokens)}`}>
          <i style={{ height: `${Math.max(4, (point.totalTokens / max) * 100)}%` }} />
          <em>{point.label}</em>
        </span>
      ))}
    </div>
  );
}

function LoadingState() {
  return (
    <section className="state-panel">
      <Loader2 aria-hidden="true" className="spin" size={18} />
      <div>
        <strong>Loading your workflow</strong>
        <p>Reading Linear, Codex, PR, tmux, and worktree signals.</p>
      </div>
    </section>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <section className="state-panel state-panel-error">
      <AlertTriangle aria-hidden="true" size={18} />
      <div>
        <strong>Dashboard data is stale or unavailable</strong>
        <p>{message}</p>
      </div>
    </section>
  );
}

function EmptyWorkflowState({
  hiddenCount,
  onRestoreSkipped,
}: {
  hiddenCount: number;
  onRestoreSkipped: () => void;
}) {
  return (
    <section className="empty-workspace">
      <Sparkles aria-hidden="true" size={22} />
      <h2>No workflow needs attention right now.</h2>
      <p>
        There are no actionable Linear, Codex, PR, or worktree bundles in the
        current view.
      </p>
      {hiddenCount ? (
        <button className="ghost-button" onClick={onRestoreSkipped} type="button">
          Restore {hiddenCount} skipped
        </button>
      ) : null}
    </section>
  );
}

function PrimaryWorkflow({
  dashboard,
  onActionComplete,
  onSkip,
  workflow,
  workflowBrief,
  workflowBriefStatus,
}: {
  dashboard: DashboardData;
  onActionComplete: (shouldAdvance: boolean) => void;
  onSkip: (workflow: WorkflowItem) => void;
  workflow: WorkflowItem;
  workflowBrief: WorkflowBrief | null;
  workflowBriefStatus: WorkflowBriefResponse | null;
}) {
  const packet = useMemo(
    () => buildWorkflowPacket(workflow, dashboard),
    [dashboard, workflow],
  );
  const handoff = useMemo(
    () =>
      workflowBrief
        ? buildBriefHandoff(workflowBrief, workflow)
        : buildWorkflowHandoff(workflow),
    [workflow, workflowBrief],
  );
  const prompt = useMemo(() => buildCodexPrompt(workflow), [workflow]);
  const commands = workflow.commands.join('\n');
  const action = useMemo(
    () => buildWorkflowAction(workflow, dashboard, prompt),
    [dashboard, prompt, workflow],
  );

  return (
    <section
      className={`primary-workflow primary-workflow-${workflow.tone}`}
      data-primary-workflow={workflow.id}
    >
      <div className="primary-head">
        <span className={`intent-chip intent-${workflow.intent}`}>
          {INTENT_LABELS[workflow.intent]}
        </span>
        <span data-testid="workflow-eyebrow">{workflow.eyebrow}</span>
      </div>
      <div className="primary-launch">
        <div className="primary-title">
          <h2>{workflow.title}</h2>
          <p>{workflow.subtitle}</p>
        </div>

        <div className="action-row">
          {action ? (
            <WorkflowActionButton
              action={action}
              onActionComplete={onActionComplete}
            />
          ) : (
            <CopyButton
              className="solid-button"
              icon="packet"
              label="Copy packet"
              text={packet}
              testId="copy-packet"
            />
          )}
        </div>
      </div>

      {workflowBrief ? <WorkflowBriefPanel brief={workflowBrief} /> : null}
      {!workflowBrief && workflowBriefStatus?.status ? (
        <WorkflowBriefStatus status={workflowBriefStatus} />
      ) : null}

      <WorkflowHandoffPanel handoff={handoff} />

      <details className="manual-fallbacks">
        <summary>Manual fallback and context</summary>
        <div className="fallback-actions">
          {action ? (
            <CopyButton
              className="ghost-button"
              icon="packet"
              label="Copy packet"
              text={packet}
              testId="copy-packet"
            />
          ) : null}
          <CopyButton
            className="ghost-button"
            icon="prompt"
            label="Copy Codex prompt"
            text={prompt}
            testId="copy-prompt"
          />
          {commands ? (
            <CopyButton
              className="ghost-button"
              icon="terminal"
              label="Copy commands"
              text={commands}
              testId="copy-commands"
            />
          ) : null}
          {workflow.primaryHref ? (
            <a
              className="open-link"
              href={workflow.primaryHref}
              rel="noreferrer"
              target="_blank"
            >
              {workflow.primaryLabel}
              <ExternalLink aria-hidden="true" size={15} />
            </a>
          ) : null}
          <button
            className="skip-button"
            onClick={() => onSkip(workflow)}
            type="button"
          >
            <Trash2 aria-hidden="true" size={14} />
            Skip today
          </button>
        </div>
        <div className="automation-grid">
          <InfoColumn icon="evidence" items={workflow.evidence} title="Why this" />
          <InfoColumn icon="signal" items={workflow.signals} title="Latest signal" />
          <InfoColumn icon="terminal" items={workflow.commands} title="Terminal" mono />
        </div>
      </details>
    </section>
  );
}

function WorkflowHandoffPanel({ handoff }: { handoff: WorkflowHandoff }) {
  return (
    <section className="workflow-handoff" data-testid="workflow-handoff">
      <div className="handoff-now">
        <span>Now</span>
        <p>
          <strong>{handoff.now}</strong>
          <em>{handoff.reason}</em>
        </p>
      </div>
      <div>
        <span>Done so far</span>
        <p>{handoff.done}</p>
      </div>
      <div>
        <span>Then</span>
        <p>{handoff.next}</p>
      </div>
      <div>
        <span>Finished when</span>
        <p>{handoff.finish}</p>
      </div>
    </section>
  );
}

function WorkflowBriefPanel({ brief }: { brief: WorkflowBrief }) {
  const nextItems = brief.next?.slice(0, 3) ?? [];
  const staleItems = brief.staleSignals?.slice(0, 3) ?? [];
  const evidence = brief.now.evidence?.slice(0, 4) ?? [];

  return (
    <section className="workflow-brief" data-testid="workflow-brief">
      <div className="brief-head">
        <span className="section-kicker">Codex brief</span>
        <em>
          {formatRelativeTime(brief.generatedAt)} / {brief.now.confidence} confidence
        </em>
      </div>
      <div className="brief-now">
        <strong>{brief.now.action}</strong>
        <p>{brief.now.why}</p>
      </div>
      <div className="brief-grid">
        <div>
          <span>Evidence</span>
          {evidence.length ? (
            <ul>
              {evidence.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : (
            <p>No evidence lines supplied.</p>
          )}
        </div>
        <div>
          <span>After</span>
          {nextItems.length ? (
            <ul>
              {nextItems.map((item) => (
                <li key={`${item.title}:${item.action}`}>
                  <strong>{item.title}</strong>
                  {item.action}
                </li>
              ))}
            </ul>
          ) : (
            <p>No follow-up move supplied.</p>
          )}
        </div>
        <div>
          <span>Watch</span>
          {staleItems.length ? (
            <ul>
              {staleItems.map((item) => (
                <li key={`${item.title}:${item.action}`}>
                  <strong>{item.title}</strong>
                  {item.why}
                </li>
              ))}
            </ul>
          ) : (
            <p>No stale signals called out.</p>
          )}
        </div>
      </div>
    </section>
  );
}

function WorkflowBriefStatus({ status }: { status: WorkflowBriefResponse }) {
  if (status.status === 'ready') return null;
  return (
    <section className={`workflow-brief-status brief-status-${status.status}`}>
      <span className="section-kicker">Codex brief</span>
      <p>{status.reason ?? 'No current local brief is available.'}</p>
      <code>{status.path}</code>
    </section>
  );
}

function InfoColumn({
  icon,
  items,
  mono = false,
  title,
}: {
  icon: 'evidence' | 'signal' | 'terminal';
  items: Array<string>;
  mono?: boolean;
  title: string;
}) {
  const Icon =
    icon === 'terminal' ? SquareTerminal : icon === 'signal' ? Bot : ChevronRight;
  return (
    <section className="info-column">
      <h3>
        <Icon aria-hidden="true" size={15} />
        {title}
      </h3>
      {items.length ? (
        <ul className={mono ? 'mono-list' : undefined}>
          {items.slice(0, 5).map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : (
        <p>No extra context needed.</p>
      )}
    </section>
  );
}

function ProjectPlanRail({
  hiddenCount,
  mode,
  modeCounts,
  onModeChange,
  onQueryChange,
  onRestoreSkipped,
  onSelect,
  plan,
  query,
  selectedWorkflowId,
  visibleWorkflows,
  workflows,
}: {
  hiddenCount: number;
  mode: WorkflowMode;
  modeCounts: Record<WorkflowMode, number>;
  onModeChange: (mode: WorkflowMode) => void;
  onQueryChange: (query: string) => void;
  onRestoreSkipped: () => void;
  onSelect: (id: string) => void;
  plan: ProjectPlan;
  query: string;
  selectedWorkflowId: string;
  visibleWorkflows: Array<WorkflowItem>;
  workflows: Array<WorkflowItem>;
}) {
  return (
    <aside className="workflow-queue plan-rail" aria-label="Generated project plan" data-project-plan>
      <div className="queue-head">
        <div>
          <span className="section-kicker">Live plan</span>
          <h2>What happens next</h2>
          <p>{plan.summary}</p>
        </div>
        {hiddenCount ? (
          <button className="restore-button" onClick={onRestoreSkipped} type="button">
            Restore {hiddenCount}
          </button>
        ) : null}
      </div>

      <PlanDigest
        onSelect={onSelect}
        plan={plan}
        selectedWorkflowId={selectedWorkflowId}
      />

      <details className="plan-disclosure">
        <summary>Open full live plan</summary>
        <PlanSections
          onSelect={onSelect}
          plan={plan}
          selectedWorkflowId={selectedWorkflowId}
        />
      </details>

      <details className="queue-disclosure">
        <summary>Explore other moves ({visibleWorkflows.length})</summary>

        <div className="mode-tabs" aria-label="Workflow mode">
          {WORKFLOW_MODES.map((item) => (
            <button
              aria-pressed={mode === item.id}
              data-mode-filter={item.id}
              key={item.id}
              onClick={() => onModeChange(item.id)}
              title={item.hint}
              type="button"
            >
              <span>{item.label}</span>
              <strong>{modeCounts[item.id]}</strong>
            </button>
          ))}
        </div>

        <label className="queue-search">
          <Search aria-hidden="true" size={15} />
          <input
            aria-label="Search workflows"
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search ticket, PR, branch, session"
            value={query}
          />
        </label>

        <div className="queue-list">
          {visibleWorkflows.length ? (
            visibleWorkflows.slice(0, 8).map((workflow, index) => (
              <WorkflowCard
                index={index}
                key={workflow.id}
                onSelect={onSelect}
                selected={workflow.id === selectedWorkflowId}
                workflow={workflow}
              />
            ))
          ) : (
            <div className="queue-empty">
              <strong>No matches.</strong>
              <p>
                {workflows.length
                  ? 'Try another mode or clear the search.'
                  : 'No Linear, Codex, PR, or worktree signals were found.'}
              </p>
            </div>
          )}
        </div>
      </details>
    </aside>
  );
}

function PlanDigest({
  onSelect,
  plan,
  selectedWorkflowId,
}: {
  onSelect: (id: string) => void;
  plan: ProjectPlan;
  selectedWorkflowId: string;
}) {
  const done = plan.sections.find((section) => section.id === 'done');
  const next = plan.sections.find((section) => section.id === 'next');
  const cleanup = plan.sections.find((section) => section.id === 'cleanup');
  const digestRows = [
    digestRowFromSection(done, 'Done so far'),
    digestRowFromSection(next, 'After this'),
    digestRowFromSection(cleanup, 'Cleanup later'),
  ].filter((row): row is ProjectPlanItem & { digestLabel: string } => Boolean(row));

  return (
    <div className="plan-digest" data-plan-digest>
      {digestRows.length ? (
        digestRows.map((item) => (
          <PlanDigestItem
            item={item}
            key={`${item.digestLabel}:${item.id}`}
            onSelect={onSelect}
            selectedWorkflowId={selectedWorkflowId}
          />
        ))
      ) : (
        <p className="plan-empty">No follow-up plan is visible.</p>
      )}
    </div>
  );
}

function PlanDigestItem({
  item,
  onSelect,
  selectedWorkflowId,
}: {
  item: ProjectPlanItem & { digestLabel: string };
  onSelect: (id: string) => void;
  selectedWorkflowId: string;
}) {
  const className = `plan-digest-item plan-digest-item-${item.tone}`;
  const content = (
    <>
      <span>{item.digestLabel}</span>
      <strong>{item.label}</strong>
      <small>{item.detail}</small>
    </>
  );

  if (item.workflowId) {
    return (
      <button
        aria-pressed={item.workflowId === selectedWorkflowId}
        className={className}
        data-plan-digest-item={item.id}
        onClick={() => onSelect(item.workflowId as string)}
        type="button"
      >
        {content}
      </button>
    );
  }

  return (
    <span className={className} data-plan-digest-item={item.id}>
      {content}
    </span>
  );
}

function PlanSections({
  onSelect,
  plan,
  selectedWorkflowId,
}: {
  onSelect: (id: string) => void;
  plan: ProjectPlan;
  selectedWorkflowId: string;
}) {
  return (
    <div className="plan-sections">
      {plan.sections.map((section) => (
        <section className="plan-section" key={section.id}>
          <h3>{section.title}</h3>
          {section.items.length ? (
            <ol className="plan-list">
              {section.items.map((item, index) => (
                <li key={item.id}>
                  <PlanItem
                    index={index}
                    item={item}
                    onSelect={onSelect}
                    selectedWorkflowId={selectedWorkflowId}
                  />
                </li>
              ))}
            </ol>
          ) : (
            <p className="plan-empty">{section.empty}</p>
          )}
        </section>
      ))}
    </div>
  );
}

function PlanItem({
  index,
  item,
  onSelect,
  selectedWorkflowId,
}: {
  index: number;
  item: ProjectPlanItem;
  onSelect: (id: string) => void;
  selectedWorkflowId: string;
}) {
  const content = (
    <>
      <span>{String(index + 1).padStart(2, '0')}</span>
      <strong>{item.label}</strong>
      <small>{item.detail}</small>
      <em>{item.meta}</em>
    </>
  );

  if (item.workflowId) {
    return (
      <button
        aria-pressed={item.workflowId === selectedWorkflowId}
        className={`plan-item plan-item-${item.tone}`}
        data-plan-item={item.id}
        onClick={() => onSelect(item.workflowId as string)}
        type="button"
      >
        {content}
      </button>
    );
  }

  return (
    <span className={`plan-item plan-item-${item.tone}`} data-plan-item={item.id}>
      {content}
    </span>
  );
}

function digestRowFromSection(
  section: ProjectPlanSection | undefined,
  digestLabel: string,
) {
  const item = section?.items[0];
  return item ? { ...item, digestLabel } : null;
}

function WorkflowCard({
  index,
  onSelect,
  selected,
  workflow,
}: {
  index: number;
  onSelect: (id: string) => void;
  selected: boolean;
  workflow: WorkflowItem;
}) {
  return (
    <button
      aria-pressed={selected}
      className={`workflow-card workflow-card-${workflow.tone}`}
      data-workflow-card={workflow.id}
      onClick={() => onSelect(workflow.id)}
      type="button"
    >
      <span className="queue-rank">{String(index + 1).padStart(2, '0')}</span>
      <span className="workflow-card-body">
        <span>
          <strong>{workflow.title}</strong>
          <em>{INTENT_LABELS[workflow.intent]}</em>
        </span>
        <small>{workflow.nextStep}</small>
      </span>
      <ArrowRight aria-hidden="true" size={15} />
    </button>
  );
}

function CopyButton({
  className,
  icon,
  label,
  testId,
  text,
}: {
  className: string;
  icon: 'packet' | 'prompt' | 'terminal';
  label: string;
  testId: string;
  text: string;
}) {
  const [state, setState] = useState<'copied' | 'failed' | 'idle'>('idle');
  const Icon = icon === 'terminal' ? SquareTerminal : icon === 'prompt' ? Bot : Clipboard;

  const handleCopy = useCallback(() => {
    void copyPlainText(text)
      .then(() => {
        setState('copied');
        window.setTimeout(() => setState('idle'), 1400);
      })
      .catch(() => {
        setState('failed');
        window.setTimeout(() => setState('idle'), 1800);
      });
  }, [text]);

  return (
    <button
      className={className}
      data-copy-state={state}
      data-testid={testId}
      onClick={handleCopy}
      type="button"
    >
      {state === 'copied' ? (
        <Check aria-hidden="true" size={15} />
      ) : (
        <Icon aria-hidden="true" size={15} />
      )}
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}
    </button>
  );
}

function WorkflowActionButton({
  action,
  onActionComplete,
}: {
  action: PlannedWorkflowAction;
  onActionComplete: (shouldAdvance: boolean) => void;
}) {
  const [state, setState] = useState<ActionButtonState>({
    message: '',
    status: 'idle',
    title: '',
  });

  useEffect(() => {
    setState({ message: '', status: 'idle', title: '' });
  }, [action.request.workflowId, action.request.kind]);

  const runAction = useCallback(async () => {
    setState({
      message: 'Running local action...',
      status: 'running',
      title: action.runningLabel,
    });
    try {
      const response = await fetch('/api/workflow-action', {
        body: JSON.stringify(action.request),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      const payload = (await response.json()) as Partial<WorkflowActionResponse> & {
        error?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error ?? `Action failed with ${response.status}`);
      }
      setState({
        message: action.advanceOnSuccess
          ? `${payload.message ?? 'Action complete.'} Moving to the next workflow.`
          : payload.message ?? 'Action complete.',
        status: 'done',
        title: action.advanceOnSuccess ? 'Handed off' : 'Done',
      });
      window.setTimeout(() => onActionComplete(Boolean(action.advanceOnSuccess)), 900);
    } catch (error) {
      setState({
        message: error instanceof Error ? error.message : 'Unable to run action',
        status: 'failed',
        title: 'Needs manual fallback',
      });
    }
  }, [action, onActionComplete]);

  return (
    <>
      <button
        className="solid-button action-button"
        data-advance-on-success={action.advanceOnSuccess ? 'true' : 'false'}
        data-action-state={state.status}
        data-testid="run-workflow-action"
        disabled={state.status === 'running'}
        onClick={() => void runAction()}
        title="Run the local action for this workflow"
        type="button"
      >
        {state.status === 'running' ? (
          <Loader2 aria-hidden="true" className="spin" size={15} />
        ) : state.status === 'done' ? (
          <Check aria-hidden="true" size={15} />
        ) : (
          <Play aria-hidden="true" size={15} />
        )}
        {state.status === 'running' ? action.runningLabel : action.label}
      </button>
      {state.status !== 'idle' ? (
        <div
          className={`action-result action-result-${state.status}`}
          data-testid="workflow-action-result"
          role="status"
        >
          <strong>{state.title}</strong>
          <span>{state.message}</span>
        </div>
      ) : null}
    </>
  );
}

function buildWorkflows(dashboard: DashboardData): Array<WorkflowItem> {
  const workflows: Array<WorkflowItem> = [];
  const seenPrs = new Set<number>();
  const seenSessions = new Set<string>();
  const seenWorktrees = new Set<string>();
  const linearByTicket = new Map(
    dashboard.linearTickets.map((ticket) => [ticket.ticketId, ticket]),
  );

  for (const ticket of dashboard.tickets) {
    const linearTicket = linearByTicket.get(ticket.ticketId) ?? null;
    const prs = dashboard.prs.filter(
      (pr) =>
        ticket.prNumbers.includes(pr.number) ||
        pr.ticketIds.includes(ticket.ticketId),
    );
    const sessions = dashboard.codexSessions.filter((session) =>
      session.ticketIds.includes(ticket.ticketId),
    );
    const worktrees = dashboard.worktrees.filter((worktree) =>
      worktree.ticketIds.includes(ticket.ticketId),
    );
    const windows = dashboard.tmuxWindows.filter((window) =>
      window.ticketIds.includes(ticket.ticketId),
    );
    prs.forEach((pr) => seenPrs.add(pr.number));
    sessions.forEach((session) => seenSessions.add(session.threadId));
    worktrees.forEach((worktree) => seenWorktrees.add(worktree.path));
    const workflow = buildTicketWorkflow({
      dashboard,
      linearTicket,
      prs,
      sessions,
      ticket,
      windows,
      worktrees,
    });
    if (workflow) {
      workflows.push(workflow);
    }
  }

  for (const pr of dashboard.prs) {
    if (seenPrs.has(pr.number)) continue;
    workflows.push(buildPrWorkflow(pr, dashboard));
  }

  for (const session of dashboard.codexSessions) {
    if (seenSessions.has(session.threadId) || session.ticketIds.length) continue;
    workflows.push(buildSessionWorkflow(session, dashboard));
  }

  for (const worktree of dashboard.worktrees) {
    if (seenWorktrees.has(worktree.path) || worktree.ticketIds.length) continue;
    const dirtyCount = worktree.dirtyCount ?? 0;
    if (dirtyCount > 0 || worktree.prunable) {
      workflows.push(buildWorktreeWorkflow(worktree, dashboard));
    }
  }

  return workflows
    .filter((workflow) => workflow.intent !== 'watch' || workflow.score > 28)
    .sort((left, right) => right.score - left.score);
}

function workflowIdFromBrief(
  brief: WorkflowBrief | null,
  workflows: Array<WorkflowItem>,
): string | null {
  if (!brief) return null;
  const explicitWorkflowId = brief.now.workflowId?.trim();
  if (explicitWorkflowId && workflows.some((workflow) => workflow.id === explicitWorkflowId)) {
    return explicitWorkflowId;
  }

  const ticketId = brief.now.ticketId?.trim().toUpperCase();
  if (ticketId) {
    const ticketWorkflow = workflows.find(
      (workflow) => workflow.ticket?.ticketId === ticketId,
    );
    if (ticketWorkflow) return ticketWorkflow.id;
  }

  if (typeof brief.now.prNumber === 'number') {
    const prWorkflow = workflows.find((workflow) =>
      workflow.prs.some((pr) => pr.number === brief.now.prNumber),
    );
    if (prWorkflow) return prWorkflow.id;
  }

  return null;
}

function briefAppliesToWorkflow(
  brief: WorkflowBrief | null,
  workflow: WorkflowItem | null,
) {
  if (!brief || !workflow) return false;
  const matchingId = workflowIdFromBrief(brief, [workflow]);
  return matchingId === workflow.id;
}

function buildBriefHandoff(
  brief: WorkflowBrief,
  workflow: WorkflowItem,
): WorkflowHandoff {
  const firstNext = brief.next?.[0] ?? null;
  const evidence = brief.now.evidence?.filter(Boolean).slice(0, 3) ?? [];
  return {
    done: evidence.length ? joinSentenceParts(evidence) : doneSoFarForWorkflow(workflow),
    finish: brief.now.finishedWhen || finishLineForWorkflow(workflow),
    next: firstNext
      ? `${firstNext.title}: ${firstNext.action}`
      : followUpForWorkflow(workflow),
    now: brief.now.action,
    reason: brief.now.why,
  };
}

function joinSentenceParts(parts: Array<string>) {
  const cleaned = parts
    .map((part) => part.trim().replace(/[.;\s]+$/u, ''))
    .filter(Boolean);
  return cleaned.length ? `${cleaned.join('; ')}.` : '';
}

function buildProjectPlan({
  dashboard,
  selectedWorkflow,
  visibleWorkflows,
  workflows,
}: {
  dashboard: DashboardData;
  selectedWorkflow: WorkflowItem | null;
  visibleWorkflows: Array<WorkflowItem>;
  workflows: Array<WorkflowItem>;
}): ProjectPlan {
  const selectedId = selectedWorkflow?.id ?? null;
  const nextWorkflows = visibleWorkflows
    .filter((workflow) => workflow.id !== selectedId)
    .filter((workflow) => workflow.intent !== 'clean' && workflow.intent !== 'watch')
    .slice(0, 4);
  const cleanupWorkflows = workflows
    .filter((workflow) => workflow.intent === 'clean')
    .slice(0, 2);
  const doneItems = dashboard.linearTickets
    .filter((ticket) => ticket.completedAt)
    .sort((left, right) => timestampMs(right.completedAt ?? '') - timestampMs(left.completedAt ?? ''))
    .slice(0, 3)
    .map<ProjectPlanItem>((ticket) => ({
      detail: ticket.completedAt
        ? `Completed ${formatRelativeTime(ticket.completedAt)}`
        : ticket.stateName,
      id: `done:${ticket.ticketId}`,
      label: readableTitle(ticket.title),
      meta: ticket.projectName ?? ticket.stateName,
      tone: 'ready',
      workflowId: null,
    }));

  const currentItems = selectedWorkflow
    ? [workflowToPlanItem(selectedWorkflow, 'now')]
    : [];
  const nextItems = nextWorkflows.map((workflow) => workflowToPlanItem(workflow, 'next'));
  const cleanupItems = cleanupWorkflows.map((workflow) =>
    workflowToPlanItem(workflow, 'cleanup'),
  );

  return {
    sections: [
      {
        empty: 'No completed work is present in the current scope.',
        id: 'done',
        items: doneItems,
        title: 'Done recently',
      },
      {
        empty: 'Nothing needs action right now.',
        id: 'now',
        items: currentItems,
        title: 'Current move',
      },
      {
        empty: 'No ordered follow-up work is visible.',
        id: 'next',
        items: nextItems,
        title: 'Next in order',
      },
      {
        empty: 'No cleanup lanes are calling for attention.',
        id: 'cleanup',
        items: cleanupItems,
        title: 'Cleanup',
      },
    ],
    summary: projectPlanSummary({
      cleanupCount: cleanupItems.length,
      doneCount: doneItems.length,
      nextCount: nextItems.length,
      selectedWorkflow,
      totalCount: workflows.length,
    }),
  };
}

function projectPlanSummary({
  cleanupCount,
  doneCount,
  nextCount,
  selectedWorkflow,
  totalCount,
}: {
  cleanupCount: number;
  doneCount: number;
  nextCount: number;
  selectedWorkflow: WorkflowItem | null;
  totalCount: number;
}) {
  if (!selectedWorkflow) {
    return totalCount
      ? `${moveCount(totalCount)} ranked; choose one to see the handoff order.`
      : 'No active workflow is visible.';
  }

  const parts = [
    `${INTENT_LABELS[selectedWorkflow.intent]} is first`,
    nextCount ? `${moveCount(nextCount)} queued after it` : 'no follow-up move visible',
    cleanupCount ? `${moveCount(cleanupCount, 'cleanup item')} after delivery` : '',
    doneCount ? `${moveCount(doneCount, 'recent completion')} already closed` : '',
  ].filter(Boolean);

  return `${parts.join('; ')}.`;
}

function moveCount(count: number, noun = 'move') {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function workflowToPlanItem(
  workflow: WorkflowItem,
  prefix: ProjectPlanSection['id'],
): ProjectPlanItem {
  return {
    detail: workflow.nextStep,
    id: `${prefix}:${workflow.id}`,
    label: workflow.title,
    meta: INTENT_LABELS[workflow.intent],
    tone: workflow.tone,
    workflowId: workflow.id,
  };
}

function buildTicketWorkflow({
  dashboard,
  linearTicket,
  prs,
  sessions,
  ticket,
  windows,
  worktrees,
}: {
  dashboard: DashboardData;
  linearTicket: LinearTicketSummary | null;
  prs: Array<PullRequestSummary>;
  sessions: Array<CodexSessionSummary>;
  ticket: TicketRow;
  windows: Array<TmuxWindowSummary>;
  worktrees: Array<WorktreeSummary>;
}): WorkflowItem | null {
  const failingPr = prs.find((pr) => pr.checkSummary.state === 'red') ?? null;
  const reviewPr =
    prs.find(
      (pr) =>
        pr.reviewDecision === 'CHANGES_REQUESTED' ||
        pr.reviewComments.length > 0 ||
        pr.latestReviews.some((review) => review.state === 'CHANGES_REQUESTED'),
    ) ?? null;
  const shippablePr =
    prs.find(
      (pr) =>
        !pr.isDraft &&
        pr.checkSummary.state === 'green' &&
        (pr.reviewDecision === 'APPROVED' || pr.reviewDecision === null),
    ) ?? null;
  const dirtyWorktree = worktrees.find((worktree) => (worktree.dirtyCount ?? 0) > 0);
  const activeSession = sessions.find((session) =>
    ['goal-active', 'running'].includes(session.status),
  );
  const terminalState = isTerminalLinearTicket(linearTicket);
  const canceledState = linearTicket?.stateType === 'canceled';
  const hasResidualWork = Boolean(
    prs.length ||
      activeSession ||
      dirtyWorktree ||
      windows.length ||
      worktrees.some((worktree) => worktree.prunable),
  );

  if (terminalState && !hasResidualWork) {
    return null;
  }

  let intent: WorkflowIntent = 'watch';
  if (terminalState) {
    if (failingPr) intent = 'fix-ci';
    else if (shippablePr && !canceledState) intent = 'ship';
    else intent = 'clean';
  } else if (failingPr) intent = 'fix-ci';
  else if (shippablePr || ticket.state === 'green') intent = 'ship';
  else if (reviewPr || ticket.state === 'review') intent = 'review';
  else if (ticket.state === 'blocked') intent = 'resume';
  else if (activeSession || dirtyWorktree || ticket.state === 'active') intent = 'resume';
  else if (!prs.length && !sessions.length && !worktrees.length) intent = 'start';

  const primaryPr = failingPr ?? reviewPr ?? shippablePr ?? prs[0] ?? null;
  const title = readableTitle(ticket.title ?? linearTicket?.title ?? 'Untitled work');
  const nextStep = nextStepForTicket({
    dirtyWorktree,
    intent,
    linearTicket,
    primaryPr,
    ticket,
    terminalState,
  });
  const score =
    scoreWorkflow({
      intent,
      recency: latestTimestamp([
        linearTicket?.updatedAt,
        ...prs.map((pr) => pr.updatedAt),
        ...sessions.map((session) => session.updatedAt),
      ]),
      risk: ticket.risk,
    }) - (terminalState && intent === 'clean' ? 18 : 0);

  return {
    id: `ticket:${ticket.ticketId}`,
    intent,
    tone: toneForIntent(intent, ticket.risk),
    score,
    source: 'ticket',
    title,
    eyebrow: workflowStatusLine({
      dirtyWorktree,
      intent,
      linearTicket,
      primaryPr,
      sessions,
      terminalState,
      ticket,
    }),
    subtitle: linearTicket?.description
      ? readableSubtitle(linearTicket.description)
      : readableSentence(ticket.nextAction),
    nextStep,
    reason: reasonForTicket({
      dirtyWorktree,
      intent,
      linearTicket,
      primaryPr,
      sessions,
      terminalState,
      ticket,
    }),
    primaryHref: primaryPr?.url ?? linearTicket?.url ?? null,
    primaryLabel: primaryPr ? 'Open review' : 'Open source',
    ticket,
    linearTicket,
    prs,
    sessions,
    worktrees,
    windows,
    evidence: evidenceForWorkflow({
      linearTicket,
      prs,
      sessions,
      ticket,
      windows,
      worktrees,
    }),
    signals: latestSignals({ linearTicket, prs, sessions }),
    commands: commandsForWorkflow({ dashboard, primaryPr, windows, worktrees }),
  };
}

function buildPrWorkflow(
  pr: PullRequestSummary,
  dashboard: DashboardData,
): WorkflowItem {
  const intent: WorkflowIntent =
    pr.checkSummary.state === 'red'
      ? 'fix-ci'
      : pr.reviewDecision === 'CHANGES_REQUESTED'
        ? 'review'
        : pr.checkSummary.state === 'green' && !pr.isDraft
          ? 'ship'
          : 'review';
  return {
    id: `pr:${pr.number}`,
    intent,
    tone: toneForIntent(intent, 'medium'),
    score: scoreWorkflow({ intent, recency: pr.updatedAt, risk: 'medium' }),
    source: 'pr',
    title: readableTitle(pr.title),
    eyebrow: 'Review needs a home',
    subtitle: pr.bodyPreview
      ? readableSubtitle(pr.bodyPreview)
      : readableSentence(`${pr.headRefName} into ${pr.baseRefName}`),
    nextStep: nextStepForPr(pr),
    reason: `${plainCheckState(pr)}; ${formatReviewState(pr)}.`,
    primaryHref: pr.url,
    primaryLabel: 'Open review',
    ticket: null,
    linearTicket: null,
    prs: [pr],
    sessions: [],
    worktrees: [],
    windows: [],
    evidence: [`PR #${pr.number} has no linked Ticketboard ticket`, formatCheckState(pr)],
    signals: latestSignals({ linearTicket: null, prs: [pr], sessions: [] }),
    commands: commandsForWorkflow({ dashboard, primaryPr: pr, windows: [], worktrees: [] }),
  };
}

function buildSessionWorkflow(
  session: CodexSessionSummary,
  dashboard: DashboardData,
): WorkflowItem {
  const intent: WorkflowIntent =
    session.status === 'running' || session.status === 'goal-active'
      ? 'resume'
      : session.tokensUsed > 250_000
        ? 'clean'
        : 'watch';
  return {
    id: `session:${session.threadId}`,
    intent,
    tone: toneForIntent(intent, 'low'),
    score: scoreWorkflow({ intent, recency: session.updatedAt, risk: 'low' }),
    source: 'codex',
    title: readableTitle(session.title || 'Untitled Codex session'),
    eyebrow: 'Unmapped Codex session',
    subtitle: readableSubtitle(session.preview || session.cwd),
    nextStep:
      intent === 'clean'
        ? 'Summarize or stop this large unmapped session.'
        : 'Open the session only if it owns work that still matters.',
    reason: `${formatSessionStatus(session)} with ${formatNumber(session.tokensUsed)} tokens.`,
    primaryHref: null,
    primaryLabel: 'Open session',
    ticket: null,
    linearTicket: null,
    prs: [],
    sessions: [session],
    worktrees: [],
    windows: [],
    evidence: [
      `${formatSessionStatus(session)} Codex session`,
      `${formatNumber(session.tokensUsed)} tokens used`,
      shortPath(session.cwd),
    ],
    signals: latestSignals({ linearTicket: null, prs: [], sessions: [session] }),
    commands: commandsForWorkflow({ dashboard, primaryPr: null, windows: [], worktrees: [] }),
  };
}

function buildWorktreeWorkflow(
  worktree: WorktreeSummary,
  dashboard: DashboardData,
): WorkflowItem {
  const dirtyCount = worktree.dirtyCount ?? 0;
  return {
    id: `worktree:${worktree.path}`,
    intent: 'clean',
    tone: dirtyCount > 0 ? 'warn' : 'calm',
    score: dirtyCount > 0 ? 58 : 32,
    source: 'worktree',
    title: shortPath(worktree.path),
    eyebrow: 'Unlinked local worktree',
    subtitle: worktree.branch ?? worktree.head ?? 'No branch',
    nextStep:
      dirtyCount > 0
        ? 'Decide whether to commit, stash, or delete these local changes.'
        : 'Prune this worktree if it is no longer useful.',
    reason:
      dirtyCount > 0
        ? `${dirtyCount} local changes are not attached to a current ticket.`
        : 'The worktree is prunable and not attached to a current ticket.',
    primaryHref: null,
    primaryLabel: 'Open worktree',
    ticket: null,
    linearTicket: null,
    prs: [],
    sessions: [],
    worktrees: [worktree],
    windows: [],
    evidence: [
      `${dirtyCount} dirty files`,
      worktree.branch ? `Branch ${worktree.branch}` : 'No branch detected',
      worktree.prunable ? 'Marked prunable' : 'Still present',
    ],
    signals: worktree.statusLines.slice(0, 4),
    commands: commandsForWorkflow({
      dashboard,
      primaryPr: null,
      windows: [],
      worktrees: [worktree],
    }),
  };
}

function nextStepForTicket({
  dirtyWorktree,
  intent,
  linearTicket,
  primaryPr,
  ticket,
  terminalState,
}: {
  dirtyWorktree: WorktreeSummary | undefined;
  intent: WorkflowIntent;
  linearTicket: LinearTicketSummary | null;
  primaryPr: PullRequestSummary | null;
  ticket: TicketRow;
  terminalState: boolean;
}) {
  if (terminalState && intent === 'clean') {
    return `Close or archive leftover work for this ${linearTicket?.stateName ?? 'finished'} item.`;
  }
  if (intent === 'fix-ci' && primaryPr) {
    return 'Fix the failing check, then push.';
  }
  if (intent === 'review' && primaryPr) {
    return 'Answer the review feedback.';
  }
  if (intent === 'ship' && primaryPr) {
    return 'Do the final read, then merge or hand off.';
  }
  if (dirtyWorktree) {
    return 'Finish or clean the local lane.';
  }
  if (intent === 'start') {
    return 'Start the work and create the working lane.';
  }
  return readableSentence(ticket.nextAction || 'Decide the next concrete move.');
}

function workflowStatusLine({
  dirtyWorktree,
  intent,
  linearTicket,
  primaryPr,
  sessions,
  terminalState,
  ticket,
}: {
  dirtyWorktree: WorktreeSummary | undefined;
  intent: WorkflowIntent;
  linearTicket: LinearTicketSummary | null;
  primaryPr: PullRequestSummary | null;
  sessions: Array<CodexSessionSummary>;
  terminalState: boolean;
  ticket: TicketRow;
}) {
  if (terminalState && intent === 'clean') {
    return `${linearTicket?.stateName ?? 'Closed'}; cleanup remains`;
  }
  if (primaryPr && intent === 'fix-ci') {
    return 'Checks are failing';
  }
  if (primaryPr && intent === 'review') {
    return 'Review feedback is waiting';
  }
  if (primaryPr && intent === 'ship') {
    return 'Ready for final read';
  }
  if (dirtyWorktree) {
    return 'Local changes are waiting';
  }
  if (
    sessions.some(
      (session) => session.status === 'goal-active' || session.status === 'running',
    )
  ) {
    return 'Work is already active';
  }
  if (sessions.length) {
    return 'Existing context is ready';
  }
  if (intent === 'start') {
    return 'Ready for a fresh implementation lane';
  }
  if (ticket.state === 'blocked') {
    return 'Blocked ticket needs a handoff';
  }
  return `${INTENT_LABELS[intent]} is the next move`;
}

function reasonForTicket({
  dirtyWorktree,
  intent,
  linearTicket,
  primaryPr,
  sessions,
  terminalState,
  ticket,
}: {
  dirtyWorktree: WorktreeSummary | undefined;
  intent: WorkflowIntent;
  linearTicket: LinearTicketSummary | null;
  primaryPr: PullRequestSummary | null;
  sessions: Array<CodexSessionSummary>;
  terminalState: boolean;
  ticket: TicketRow;
}) {
  if (terminalState && intent === 'clean') {
    return `${linearTicket?.stateName ?? 'Finished'}, but local context still exists.`;
  }
  if (primaryPr && intent === 'fix-ci') return plainCheckState(primaryPr);
  if (primaryPr && intent === 'review') return formatReviewState(primaryPr);
  if (primaryPr && intent === 'ship') return 'Checks are green and the change is ready.';
  if (dirtyWorktree) return `${dirtyWorktree.dirtyCount ?? 0} local changes are waiting.`;
  if (sessions.length) return 'Existing work context is ready.';
  if (intent === 'start') return 'No implementation lane is attached yet.';
  return `${readableSentence(ticket.state)} work with ${ticket.risk} risk.`;
}

function evidenceForWorkflow({
  linearTicket,
  prs,
  sessions,
  ticket,
  windows,
  worktrees,
}: {
  linearTicket: LinearTicketSummary | null;
  prs: Array<PullRequestSummary>;
  sessions: Array<CodexSessionSummary>;
  ticket: TicketRow | null;
  windows: Array<TmuxWindowSummary>;
  worktrees: Array<WorktreeSummary>;
}) {
  const lines = [
    ticket ? `Linear state: ${linearTicket?.stateName ?? ticket.state}` : '',
    prs.length ? `${prs.length} PR(s): ${prs.map((pr) => `#${pr.number}`).join(', ')}` : '',
    prs[0] ? formatCheckState(prs[0]) : '',
    sessions.length ? `${sessions.length} Codex session(s)` : '',
    worktrees.length
      ? `${worktrees.length} worktree(s), ${worktrees.reduce(
          (total, worktree) => total + (worktree.dirtyCount ?? 0),
          0,
        )} dirty files`
      : '',
    windows.length ? `${windows.length} tmux window(s)` : '',
  ].filter(Boolean);
  return lines.length ? lines : ['No linked source objects beyond this workflow.'];
}

function latestSignals({
  linearTicket,
  prs,
  sessions,
}: {
  linearTicket: LinearTicketSummary | null;
  prs: Array<PullRequestSummary>;
  sessions: Array<CodexSessionSummary>;
}) {
  const signals: Array<{ at: string; text: string }> = [];
  for (const comment of linearTicket?.comments ?? []) {
    signals.push({
      at: comment.createdAt,
      text: `Linear ${comment.author}: ${truncate(stripBasicMarkdown(comment.body), 120)}`,
    });
  }
  for (const pr of prs) {
    for (const review of pr.latestReviews) {
      signals.push({
        at: review.submittedAt,
        text: `PR #${pr.number} ${review.state}: ${truncate(stripBasicMarkdown(review.body || review.author), 120)}`,
      });
    }
    for (const comment of pr.latestComments) {
      signals.push({
        at: comment.createdAt ?? pr.updatedAt,
        text: `PR #${pr.number} ${comment.author}: ${truncate(stripBasicMarkdown(comment.body), 120)}`,
      });
    }
  }
  for (const session of sessions) {
    const message = latestReadableMessage(session.latestMessages);
    if (message) {
      signals.push({
        at: message.timestamp,
        text: `Codex ${message.role}: ${truncate(stripBasicMarkdown(message.text), 120)}`,
      });
    }
  }
  return signals
    .sort((left, right) => timestampMs(right.at) - timestampMs(left.at))
    .slice(0, 5)
    .map((signal) => signal.text || 'Empty signal');
}

function latestReadableMessage(messages: Array<CodexMessageSummary>) {
  return [...messages]
    .reverse()
    .find((message) => message.text.trim() && message.role !== 'system');
}

function commandsForWorkflow({
  dashboard,
  primaryPr,
  windows,
  worktrees,
}: {
  dashboard: DashboardData;
  primaryPr: PullRequestSummary | null;
  windows: Array<TmuxWindowSummary>;
  worktrees: Array<WorktreeSummary>;
}) {
  const commands = new Set<string>();
  const primaryWorktree = worktrees[0];
  commands.add(`cd ${shellQuote(primaryWorktree?.path ?? dashboard.repo.path)}`);
  if (primaryPr) {
    commands.add(`gh pr view ${primaryPr.number} --web`);
    if (primaryPr.checkSummary.state === 'red') {
      commands.add(`gh pr checks ${primaryPr.number}`);
    }
  }
  if (primaryWorktree) {
    commands.add('git status --short');
  }
  if (windows[0]) {
    const target = `${windows[0].session}:${windows[0].index}`;
    commands.add(`tmux select-window -t ${shellQuote(target)}`);
    commands.add(`tmux attach -t ${shellQuote(windows[0].session)}`);
  }
  return [...commands].slice(0, 6);
}

function buildWorkflowHandoff(workflow: WorkflowItem): WorkflowHandoff {
  return {
    done: doneSoFarForWorkflow(workflow),
    finish: finishLineForWorkflow(workflow),
    next: followUpForWorkflow(workflow),
    now: workflow.nextStep,
    reason: workflow.reason,
  };
}

function doneSoFarForWorkflow(workflow: WorkflowItem) {
  const parts: Array<string> = [];
  const primaryPr = workflow.prs[0] ?? null;
  const dirtyCount = workflow.worktrees.reduce(
    (total, worktree) => total + (worktree.dirtyCount ?? 0),
    0,
  );

  if (primaryPr) {
    if (primaryPr.checkSummary.state === 'red') {
      parts.push('Failing checks are identified');
    } else if (primaryPr.reviewDecision === 'APPROVED') {
      parts.push('The review is approved');
    } else if (
      primaryPr.reviewDecision === 'CHANGES_REQUESTED' ||
      primaryPr.reviewComments.length ||
      primaryPr.latestReviews.some((review) => review.state === 'CHANGES_REQUESTED')
    ) {
      parts.push('Review feedback is waiting');
    } else if (primaryPr.checkSummary.state === 'green') {
      parts.push('Checks are green');
    } else {
      parts.push('The review branch is open');
    }
  }
  if (workflow.sessions.length) {
    parts.push(
      workflow.sessions.some(
        (session) => session.status === 'goal-active' || session.status === 'running',
      )
        ? 'Work is already active'
        : 'Existing work context is ready',
    );
  }
  if (workflow.worktrees.length) {
    parts.push(
      dirtyCount
        ? 'Local changes are waiting'
        : 'The local lane is ready',
    );
  }
  if (workflow.windows.length) {
    parts.push('A terminal lane is available');
  }
  if (!parts.length && workflow.linearTicket) {
    parts.push(`${workflow.linearTicket.stateName} in source`);
  }
  if (!parts.length && workflow.ticket) {
    parts.push(`${workflow.ticket.state} work is visible`);
  }

  return parts.length
    ? `${parts.slice(0, 3).join('; ')}.`
    : 'No implementation lane exists yet.';
}

function followUpForWorkflow(workflow: WorkflowItem) {
  const primaryPr = workflow.prs[0] ?? null;
  if (workflow.intent === 'fix-ci') {
    return primaryPr
      ? 'Push the fix, wait for checks to turn green, then hand it back to review.'
      : 'Run the failing command, push the fix, then reconnect it to the work item.';
  }
  if (workflow.intent === 'review') {
    return primaryPr
      ? 'After responding, leave the change ready for another look.'
      : 'After responding, capture the review decision and refresh the next move.';
  }
  if (workflow.intent === 'ship') {
    return 'After merge or handoff, clear any leftover local lane.';
  }
  if (workflow.intent === 'start') {
    return 'Let Codex create the first implementation slice, then prepare the review.';
  }
  if (workflow.intent === 'resume') {
    return primaryPr
      ? 'Finish the active slice, push it, and refresh the handoff.'
      : 'Finish the active slice, prepare the review or leave a concrete handoff, then refresh.';
  }
  if (workflow.intent === 'clean') {
    return 'Preserve any useful handoff, then remove the stale local lane from the active queue.';
  }
  return 'Leave it parked unless a fresh Linear, PR, or Codex signal changes priority.';
}

function finishLineForWorkflow(workflow: WorkflowItem) {
  if (workflow.intent === 'fix-ci') {
    return 'checks are green and no new failure signal is visible.';
  }
  if (workflow.intent === 'review') {
    return 'review feedback is answered and the change is ready for another look.';
  }
  if (workflow.intent === 'ship') {
    return 'the change is merged or explicitly handed off, and local residue is gone.';
  }
  if (workflow.intent === 'start') {
    return 'a working lane exists with a first change or concrete blocker.';
  }
  if (workflow.intent === 'resume') {
    return 'the active context has produced a push or clear next handoff.';
  }
  if (workflow.intent === 'clean') {
    return 'Ticketboard no longer surfaces this lane as active work.';
  }
  return 'the workflow has a concrete owner, blocker, or next action.';
}

function buildWorkflowPacket(workflow: WorkflowItem, dashboard: DashboardData) {
  const handoff = buildWorkflowHandoff(workflow);
  return [
    `# Ticketboard work packet - ${workflow.title}`,
    '',
    `Generated: ${new Date().toISOString()}`,
    `Repo: ${dashboard.repo.nameWithOwner} (${dashboard.repo.path})`,
    `Intent: ${INTENT_LABELS[workflow.intent]}`,
    `Next move: ${workflow.nextStep}`,
    `Why: ${workflow.reason}`,
    '',
    '## Live handoff',
    `Done so far: ${handoff.done}`,
    `Do now: ${handoff.now}`,
    `Then: ${handoff.next}`,
    `Finished when: ${handoff.finish}`,
    '',
    '## Links',
    workflow.linearTicket ? `- Linear: ${workflow.linearTicket.url}` : '',
    ...workflow.prs.map((pr) => `- PR #${pr.number}: ${pr.url}`),
    '',
    '## Context',
    ...workflow.evidence.map((line) => `- ${line}`),
    '',
    '## Latest signal',
    ...(workflow.signals.length
      ? workflow.signals.map((line) => `- ${line}`)
      : ['- No recent comments or messages.']),
    '',
    '## Terminal',
    ...(workflow.commands.length
      ? workflow.commands.map((command) => `- ${command}`)
      : ['- No local command needed.']),
    '',
    '## Codex prompt',
    buildCodexPrompt(workflow),
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function buildCodexPrompt(workflow: WorkflowItem) {
  const handoff = buildWorkflowHandoff(workflow);
  return [
    `Use this Ticketboard packet for ${workflow.title}.`,
    `Do now: ${workflow.nextStep}`,
    `Reason: ${workflow.reason}`,
    '',
    'Live handoff:',
    `- Done so far: ${handoff.done}`,
    `- Do now: ${handoff.now}`,
    `- Then: ${handoff.next}`,
    `- Finished when: ${handoff.finish}`,
    '',
    'Rules:',
    '- Work only on this workflow unless the linked sources prove it is obsolete.',
    '- Prefer the existing worktree/session context when it exists.',
    '- End with the exact validation run and the next handoff state.',
    '',
    'Source context:',
    ...workflow.evidence.map((line) => `- ${line}`),
    ...workflow.signals.slice(0, 3).map((line) => `- Latest: ${line}`),
  ].join('\n');
}

function buildWorkflowAction(
  workflow: WorkflowItem,
  dashboard: DashboardData,
  prompt: string,
): PlannedWorkflowAction | null {
  const primaryPr = workflow.prs[0] ?? null;
  const primarySession = workflow.sessions[0] ?? null;
  const primaryWorktree = workflow.worktrees[0] ?? null;
  const window = workflow.windows[0] ?? null;
  const cwd = primaryWorktree?.path ?? primarySession?.cwd ?? dashboard.repo.path;
  const ticketId = workflow.ticket?.ticketId ?? workflow.linearTicket?.ticketId;
  const title = ticketId ?? (primaryPr ? `pr-${primaryPr.number}` : workflowTitleSlug(workflow));
  const actionPrompt = buildActionPrompt(workflow, prompt);

  if (primarySession && workflow.intent !== 'ship') {
    const label = sessionActionLabel(workflow);
    return {
      advanceOnSuccess: true,
      label,
      request: {
        cwd: primarySession.cwd,
        kind: 'resume-codex',
        prompt: actionPrompt,
        threadId: primarySession.threadId,
        title,
        workflowId: workflow.id,
      },
      runningLabel: runningLabelFor(label),
    };
  }

  if (workflow.intent === 'ship' && primaryPr) {
    return {
      label: 'Open review',
      request: {
        kind: 'open-pr',
        prNumber: primaryPr.number,
        workflowId: workflow.id,
      },
      runningLabel: 'Opening review',
    };
  }

  if (workflow.intent === 'start' && ticketId) {
    return {
      advanceOnSuccess: true,
      label: 'Start lane',
      request: {
        branchName: workflow.linearTicket?.branchName ?? workflow.ticket?.branches[0],
        kind: 'start-lane',
        prompt: actionPrompt,
        ticketId,
        ticketTitle: workflow.linearTicket?.title ?? workflow.ticket?.title,
        title,
        workflowId: workflow.id,
      },
      runningLabel: 'Starting lane',
    };
  }

  if (window) {
    const label = laneActionLabel(workflow);
    return {
      label,
      request: {
        index: window.index,
        kind: 'focus-tmux',
        session: window.session,
        workflowId: workflow.id,
      },
      runningLabel: runningLabelFor(label),
    };
  }

  if (
    ['fix-ci', 'review', 'resume'].includes(workflow.intent) ||
    ticketId ||
    primaryPr
  ) {
    const label = launchActionLabel(workflow);
    return {
      advanceOnSuccess: true,
      label,
      request: {
        cwd,
        kind: 'launch-codex',
        prNumber: primaryPr?.number,
        prompt: actionPrompt,
        ticketId,
        title,
        workflowId: workflow.id,
      },
      runningLabel: runningLabelFor(label),
    };
  }

  if (primaryWorktree) {
    return {
      label: 'Open worktree',
      request: {
        kind: 'open-worktree',
        path: primaryWorktree.path,
        workflowId: workflow.id,
      },
      runningLabel: 'Opening worktree',
    };
  }

  if (workflow.primaryHref) {
    return {
      label: workflow.primaryLabel,
      request: {
        kind: 'open-url',
        url: workflow.primaryHref,
        workflowId: workflow.id,
      },
      runningLabel: 'Opening source',
    };
  }

  return null;
}

function buildActionPrompt(workflow: WorkflowItem, prompt: string) {
  return [
    `Ticketboard selected this as the next workflow: ${workflow.title}.`,
    '',
    prompt,
    '',
    'Treat this as the active handoff. Start immediately, keep scope tight, and finish with validation plus the PR or handoff state.',
  ].join('\n');
}

function laneActionLabel(workflow: WorkflowItem) {
  if (workflow.intent === 'fix-ci') return 'Fix checks in lane';
  if (workflow.intent === 'review') return 'Review in lane';
  if (workflow.intent === 'ship') return 'Ship from lane';
  if (workflow.intent === 'clean') return 'Clean lane';
  return 'Open working lane';
}

function sessionActionLabel(workflow: WorkflowItem) {
  if (workflow.intent === 'fix-ci') return 'Resume check fix';
  if (workflow.intent === 'review') return 'Resume review';
  if (workflow.intent === 'clean') return 'Resume cleanup';
  return 'Resume work';
}

function launchActionLabel(workflow: WorkflowItem) {
  if (workflow.intent === 'fix-ci') return 'Start check fix';
  if (workflow.intent === 'review') return 'Start review';
  if (workflow.intent === 'resume') return 'Start handoff';
  if (workflow.intent === 'clean') return 'Start cleanup';
  if (workflow.intent === 'start') return 'Start lane';
  return 'Start workflow';
}

function runningLabelFor(label: string) {
  return label.replace(/^(Open|Start|Resume|Fix|Review|Ship|Clean)\b/, (verb) => {
    const gerunds: Record<string, string> = {
      Clean: 'Cleaning',
      Fix: 'Fixing',
      Open: 'Opening',
      Resume: 'Resuming',
      Review: 'Reviewing',
      Ship: 'Shipping',
      Start: 'Starting',
    };
    return gerunds[verb] ?? verb;
  });
}

function workflowTitleSlug(workflow: WorkflowItem) {
  return workflow.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
}

function scoreWorkflow({
  intent,
  recency,
  risk,
}: {
  intent: WorkflowIntent;
  recency: string | null;
  risk: TicketRow['risk'];
}) {
  const riskBoost = risk === 'high' ? 14 : risk === 'medium' ? 6 : 0;
  const ageHours = recency ? (Date.now() - timestampMs(recency)) / 3_600_000 : 96;
  const recencyBoost = Math.max(0, 12 - Math.min(12, ageHours / 8));
  return INTENT_SORT[intent] + riskBoost + recencyBoost;
}

function toneForIntent(intent: WorkflowIntent, risk: TicketRow['risk']): WorkflowTone {
  if (intent === 'fix-ci' || risk === 'high') return 'hot';
  if (intent === 'review' || intent === 'clean' || risk === 'medium') return 'warn';
  if (intent === 'ship') return 'ready';
  return 'calm';
}

function isTerminalLinearTicket(ticket: LinearTicketSummary | null) {
  return ticket?.stateType === 'completed' || ticket?.stateType === 'canceled';
}

function buildModeCounts(
  workflows: Array<WorkflowItem>,
  skippedIds: Set<string>,
  query: string,
) {
  return WORKFLOW_MODES.reduce(
    (counts, item) => {
      counts[item.id] = workflows.filter(
        (workflow) =>
          !skippedIds.has(workflow.id) &&
          workflowMatchesMode(workflow, item.id) &&
          workflowMatchesQuery(workflow, query),
      ).length;
      return counts;
    },
    { cleanup: 0, now: 0, ship: 0, start: 0 } satisfies Record<WorkflowMode, number>,
  );
}

function workflowMatchesMode(workflow: WorkflowItem, mode: WorkflowMode) {
  if (mode === 'now') return workflow.intent !== 'watch';
  if (mode === 'ship') {
    return ['fix-ci', 'review', 'ship'].includes(workflow.intent);
  }
  if (mode === 'start') {
    return ['resume', 'start'].includes(workflow.intent);
  }
  return workflow.intent === 'clean' || workflow.intent === 'watch';
}

function workflowMatchesQuery(workflow: WorkflowItem, query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [
    workflow.title,
    workflow.subtitle,
    workflow.nextStep,
    workflow.reason,
    workflow.ticket?.ticketId,
    workflow.linearTicket?.title,
    workflow.prs.map((pr) => `${pr.number} ${pr.title} ${pr.headRefName}`).join(' '),
    workflow.sessions.map((session) => `${session.title} ${session.cwd}`).join(' '),
    workflow.worktrees.map((worktree) => `${worktree.path} ${worktree.branch}`).join(' '),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .includes(normalized);
}

function readableTitle(value: string | null | undefined) {
  const title = readableSentence(value || 'Untitled work');
  return title || 'Untitled work';
}

function readableSubtitle(value: string) {
  return truncate(readableSentence(stripBasicMarkdown(value)), 140);
}

function readableSentence(value: string | null | undefined) {
  return humanizeWorkflowJargon(stripArtifactIds(value || ''))
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .trim();
}

function stripArtifactIds(value: string) {
  return value
    .replace(/\b[A-Z][A-Z0-9]+-\d+\b:?\s*/g, '')
    .replace(/\bPR\s*#\d+\b:?\s*/gi, 'the review')
    .replace(/\bpull request\s*#\d+\b:?\s*/gi, 'the review');
}

function humanizeWorkflowJargon(value: string) {
  return value
    .replace(/\bPRs?\b/g, 'reviews')
    .replace(/\bpull requests?\b/gi, 'reviews')
    .replace(/\bCI\b/g, 'checks')
    .replace(/\btmux\b/gi, 'terminal')
    .replace(/\bworktrees?\b/gi, 'local lanes')
    .replace(/\bLinear\b/g, 'source')
    .replace(/\bsubagent\/probe QA\b/gi, 'agent QA')
    .replace(/\bsubagent\/probe\b/gi, 'agent QA')
    .replace(/\bsubagents?\b/gi, 'agents')
    .replace(/\bprobes?\b/gi, 'checks')
    .replace(/\bquiet-output\b/gi, 'quiet output')
    .replace(/\benforcement\b/gi, 'rule')
    .replace(/\bagent QA QA\b/gi, 'agent QA')
    .replace(/\bmerge-shaped\b/gi, 'ready to merge');
}

function nextStepForPr(pr: PullRequestSummary) {
  if (pr.checkSummary.state === 'red') {
    return 'Fix the failing checks.';
  }
  if (pr.reviewDecision === 'CHANGES_REQUESTED') {
    return 'Address the requested changes.';
  }
  if (pr.checkSummary.state === 'green' && !pr.isDraft) {
    return 'Do a final review and ship it.';
  }
  return 'Open the review and decide the next move.';
}

function formatCheckState(pr: PullRequestSummary) {
  const { failed, passed, pending, total } = pr.checkSummary;
  if (!total) return `PR #${pr.number} has no checks reported`;
  if (failed) return `PR #${pr.number}: ${failed} failing, ${pending} pending, ${passed} passing`;
  if (pending) return `PR #${pr.number}: ${pending} pending, ${passed} passing`;
  return `PR #${pr.number}: all ${passed} checks passing`;
}

function plainCheckState(pr: PullRequestSummary) {
  const { failed, passed, pending, total } = pr.checkSummary;
  if (!total) return 'No checks are reported yet';
  if (failed) {
    return `${failed} failing, ${pending} pending, ${passed} passing`;
  }
  if (pending) return `${pending} pending, ${passed} passing`;
  return `All ${passed} checks are passing`;
}

function formatReviewState(pr: PullRequestSummary) {
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'Changes requested';
  if (pr.reviewDecision === 'APPROVED') return 'Approved';
  if (pr.reviewComments.length) return `${pr.reviewComments.length} review comments`;
  if (pr.latestComments.length) return `${pr.latestComments.length} recent comments`;
  return 'No review decision yet';
}

function formatSessionStatus(session: CodexSessionSummary) {
  if (session.status === 'goal-active') return 'Active goal';
  if (session.status === 'running') return 'Running';
  if (session.status === 'idle') return 'Idle';
  return 'Unknown';
}

function latestTimestamp(values: Array<string | null | undefined>) {
  let latest: string | null = null;
  for (const value of values) {
    if (!value) continue;
    if (!latest || timestampMs(value) > timestampMs(latest)) {
      latest = value;
    }
  }
  return latest;
}

function readLocalState(): LocalState {
  try {
    const raw = window.localStorage.getItem(LOCAL_STATE_KEY);
    if (!raw) return { dismissed: {} };
    return normalizeLocalState(JSON.parse(raw));
  } catch {
    return { dismissed: {} };
  }
}

function writeLocalState(state: LocalState) {
  try {
    window.localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

function activeSkippedIds(state: LocalState) {
  const now = Date.now();
  return Object.entries(state.dismissed)
    .filter(([, entry]) => dismissedEntryIsActive(entry, now))
    .map(([id]) => id);
}

function dismissWorkflowInState(state: LocalState, id: string): LocalState {
  const now = new Date();
  return {
    dismissed: {
      ...state.dismissed,
      [id]: {
        createdAt: now.toISOString(),
        kind: 'snooze',
        until: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      },
    },
  };
}

function dismissedEntryIsActive(entry: DismissedWorkflow, now: number) {
  if (entry.kind === 'dismiss') return true;
  if (entry.until) {
    const until = timestampMs(entry.until);
    return Number.isFinite(until) && until > now;
  }
  if (entry.createdAt) {
    const createdAt = timestampMs(entry.createdAt);
    return Number.isFinite(createdAt) && now - createdAt < 24 * 60 * 60 * 1000;
  }
  return false;
}

function normalizeLocalState(value: unknown): LocalState {
  if (!value || typeof value !== 'object') return { dismissed: {} };
  const data = value as {
    dismissed?: Record<string, DismissedWorkflow>;
    skipped?: Record<string, string>;
  };
  if (data.dismissed && typeof data.dismissed === 'object') {
    return { dismissed: normalizeDismissedMap(data.dismissed) };
  }
  if (data.skipped && typeof data.skipped === 'object') {
    return { dismissed: skippedMapToDismissed(data.skipped) };
  }
  return { dismissed: {} };
}

function normalizeDismissedMap(value: Record<string, DismissedWorkflow>) {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([id, entry]) => Boolean(id) && Boolean(entry) && typeof entry === 'object',
    ),
  );
}

function skippedMapToDismissed(skipped: Record<string, string>) {
  const entries = Object.entries(skipped)
    .filter(([id, createdAt]) => Boolean(id) && typeof createdAt === 'string')
    .map(([id, createdAt]) => {
      const createdAtMs = timestampMs(createdAt);
      return [
        id,
        {
          createdAt,
          kind: 'snooze',
          until: Number.isFinite(createdAtMs)
            ? new Date(createdAtMs + 24 * 60 * 60 * 1000).toISOString()
            : null,
        } satisfies DismissedWorkflow,
      ];
    });
  return Object.fromEntries(entries);
}

function mergeLocalState(left: LocalState, right: LocalState): LocalState {
  return {
    dismissed: {
      ...left.dismissed,
      ...right.dismissed,
    },
  };
}

async function fetchUserState() {
  const response = await fetch('/api/user-state', {
    headers: { 'cache-control': 'no-cache' },
  });
  if (!response.ok) {
    throw new Error(`User state request failed with ${response.status}`);
  }
  return normalizeLocalState(await response.json());
}

async function persistDismissedWorkflow(id: string) {
  try {
    const response = await fetch('/api/user-state/dismiss', {
      body: JSON.stringify({ id, kind: 'snooze' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    if (!response.ok) return null;
    return normalizeLocalState(await response.json());
  } catch {
    return null;
  }
}

async function removeDismissedWorkflow(id: string) {
  await fetch(`/api/user-state/dismiss/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

async function copyPlainText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.setAttribute('readonly', 'true');
  textArea.style.position = 'fixed';
  textArea.style.opacity = '0';
  document.body.appendChild(textArea);
  textArea.select();
  try {
    const copied = document.execCommand('copy');
    if (!copied) throw new Error('copy command failed');
  } finally {
    textArea.remove();
  }
}

function stripBasicMarkdown(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_~>#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trim()}...`;
}

function shortPath(path: string) {
  const parts = path.split('/').filter(Boolean);
  return parts.slice(-2).join('/') || path;
}

function shellQuote(value: string) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function timestampMs(value: string) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function formatRelativeTime(value: string) {
  const ms = timestampMs(value);
  if (!ms) return 'unknown';
  const diffSeconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (diffSeconds < 60) return 'just now';
  const minutes = Math.round(diffSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('en-US').format(value);
}

function formatCompactNumber(value: number) {
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 1,
    notation: 'compact',
  }).format(value);
}
