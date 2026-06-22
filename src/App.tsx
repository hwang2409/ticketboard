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
  LinearLinkedIssueSummary,
  LinearTicketSummary,
  ParallelReadiness,
  TokenUsageSummary,
  PullRequestSummary,
  TicketRow,
  TmuxWindowSummary,
  WorkflowBrief,
  WorkflowBriefItem,
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

type HandoffEvent = {
  batchId?: string | null;
  batchTitle?: string | null;
  command?: string;
  id: string;
  kind: string;
  message: string;
  prNumber?: number | null;
  ranAt: string;
  ticketId?: string | null;
  title: string;
  workflowId: string;
};

type LocalState = {
  dismissed: Record<string, DismissedWorkflow>;
  handoffs: Array<HandoffEvent>;
};

type HandoffOutcome = {
  detail: string;
  label: string;
  tone: 'cleared' | 'live' | 'quiet';
};

type ParallelRunGroup = {
  id: string;
  items: Array<HandoffEvent & { outcome: HandoffOutcome }>;
  ranAt: string;
  summary: string;
  title: string;
  tone: HandoffOutcome['tone'];
  workflowId: string | null;
};

type ActionButtonState =
  | { message: string; status: 'done'; title: string }
  | { message: string; status: 'failed'; title: string }
  | { message: string; status: 'idle'; title: string }
  | { message: string; status: 'running'; title: string };

type BatchActionButtonState = ActionButtonState & {
  completed: number;
  total: number;
};

type WorkflowActionErrorPayload = Partial<WorkflowActionResponse> & {
  detail?: { error?: string } | string;
  error?: string;
};

type PlannedWorkflowAction = {
  advanceOnSuccess?: boolean;
  label: string;
  request: WorkflowActionRequest;
  runningLabel: string;
};

type LaneActionGuard = {
  kind: 'capacity' | 'checkpoint' | 'safety';
  label: string;
  reason: string;
  runnable: boolean;
};

type RunnableLaneAction = {
  action: PlannedWorkflowAction;
  guard: LaneActionGuard;
  lane: ParallelLane;
  workflow: WorkflowItem;
};

type BatchActionPreparation = {
  actions: Array<RunnableLaneAction>;
  detail: string;
};

type WorkflowHandoff = {
  done: string;
  finish: string;
  next: string;
  now: string;
  reason: string;
};

type SourceDossierItem = {
  detail: string;
  href?: string | null;
  label: string;
};

type SourceDossierSection = {
  id: string;
  items: Array<SourceDossierItem>;
  title: string;
};

type LaneContractStep = {
  detail: string;
  label: string;
};

type LaneContractSection = {
  id: 'after' | 'finish' | 'preflight';
  items: Array<LaneContractStep>;
  title: string;
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

type UnlockTone = 'blocked' | 'ready' | 'waiting';

type UnlockItem = {
  detail: string;
  id: string;
  meta: string;
  title: string;
  tone: UnlockTone;
  workflowId: string | null;
};

type UnlockMap = {
  items: Array<UnlockItem>;
  summary: string;
};

type CompletionForecastItem = {
  detail: string;
  id: string;
  meta: string;
  title: string;
  tone: UnlockTone;
  workflowId: string | null;
};

type CompletionForecast = {
  items: Array<CompletionForecastItem>;
  summary: string;
};

type ProjectPulseItem = {
  activeCount: number;
  detail: string;
  id: string;
  meta: string;
  title: string;
  tone: ProjectPlanTone;
  workflowCount: number;
  workflowId: string;
};

type ProjectPulse = {
  items: Array<ProjectPulseItem>;
  summary: string;
};

type ProjectRunwayStage = 'blocked' | 'current' | 'done' | 'next';

type ProjectRunwayEntry = {
  detail: string;
  id: string;
  meta: string;
  stage: ProjectRunwayStage;
  title: string;
  tone: ProjectPlanTone;
  workflowId: string | null;
};

type ProjectRunwayItem = {
  blocked: Array<ProjectRunwayEntry>;
  current: Array<ProjectRunwayEntry>;
  done: Array<ProjectRunwayEntry>;
  id: string;
  next: Array<ProjectRunwayEntry>;
  summary: string;
  title: string;
  tone: ProjectPlanTone;
  workflowId: string | null;
};

type ProjectRunway = {
  items: Array<ProjectRunwayItem>;
  summary: string;
};

const PROJECT_RUNWAY_STAGES: Array<{ id: ProjectRunwayStage; label: string }> = [
  { id: 'current', label: 'Current' },
  { id: 'next', label: 'Next' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'done', label: 'Done' },
];

type LaneLoadTone = 'active' | 'over' | 'warn';

type LaneLoadItem = {
  detail: string;
  id: string;
  meta: string;
  title: string;
  tone: LaneLoadTone;
  workflowId: string;
};

type LaneLoad = {
  activeCount: number;
  capacityLabel: string;
  dirtyCount: number;
  items: Array<LaneLoadItem>;
  maxActive: number;
  recommendedActive: number;
  runningCount: number;
  summary: string;
  terminalCount: number;
};

type ParallelLaneRole = 'cleanup' | 'focus' | 'parallel' | 'waiting' | 'watch';

type ParallelLane = {
  action: string;
  automation: string;
  detail: string;
  evidence: Array<string>;
  id: string;
  meta: string;
  parallelSafe: boolean;
  role: ParallelLaneRole;
  safety: ParallelSafety;
  source: 'brief' | 'live';
  status: string;
  title: string;
  tone: WorkflowTone;
  workflowId: string | null;
};

type ParallelSafetyLevel = 'blocked' | 'focus' | 'safe' | 'unknown' | 'waiting';

type ParallelSafety = {
  detail: string;
  label: string;
  level: ParallelSafetyLevel;
  paths: Array<string>;
  zones: Array<string>;
};

type ParallelPlan = {
  lanes: Array<ParallelLane>;
  maxActive: number;
  recommendedActive: number;
  source: 'brief' | 'live';
  summary: string;
};

type ParallelBatchLane = {
  id: string;
  label: string;
  role: ParallelLaneRole;
  workflowId: string | null;
};

type ParallelBatchDecisionStatus = 'focus' | 'guarded' | 'ready' | 'waiting';

type ParallelBatchDecision = ParallelBatchLane & {
  reason: string;
  status: ParallelBatchDecisionStatus;
};

type ParallelBatch = {
  decisions: Array<ParallelBatchDecision>;
  detail: string;
  guardedCount: number;
  lanes: Array<ParallelBatchLane>;
  title: string;
};

type ParallelWaveTone = 'blocked' | 'ready' | 'waiting';

type ParallelWaveLane = ParallelBatchLane & {
  reason: string;
  status: ParallelBatchDecisionStatus;
};

type ParallelWave = {
  detail: string;
  id: string;
  lanes: Array<ParallelWaveLane>;
  title: string;
  tone: ParallelWaveTone;
};

type ParallelWavePlan = {
  items: Array<ParallelWave>;
  summary: string;
};

type LaneMatrixTone = 'blocked' | 'ready' | 'waiting';

type LaneMatrixItem = {
  detail: string;
  id: string;
  meta: string;
  title: string;
  tone: LaneMatrixTone;
  workflowIds: Array<string>;
};

type LaneMatrix = {
  blockedCount: number;
  items: Array<LaneMatrixItem>;
  readyCount: number;
  summary: string;
  waitingCount: number;
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

  const queueWorkflowBriefRefresh = useCallback(
    async (workflow: WorkflowItem | null) => {
      try {
        const response = await fetch('/api/workflow-brief/refresh-request', {
          body: JSON.stringify({
            kind: 'manual-refresh',
            prNumber: workflow?.prs[0]?.number ?? null,
            reason: workflow
              ? `Manual Codex plan refresh requested from Ticketboard for ${workflow.title}.`
              : 'Manual Codex plan refresh requested from Ticketboard.',
            source: 'ticketboard-ui',
            ticketId: workflow?.ticket?.ticketId ?? workflow?.linearTicket?.ticketId ?? null,
            title: workflow?.title ?? 'Manual Codex plan refresh',
            workflowId: workflow?.id ?? null,
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        });
        if (!response.ok) {
          throw new Error(`Refresh request failed with ${response.status}`);
        }
        await refreshWorkflowBrief(false);
      } catch (error) {
        setBriefState((current) => ({
          data: current.data,
          error: error instanceof Error ? error.message : 'Unable to queue workflow brief refresh',
          loading: false,
        }));
      }
    },
    [refreshWorkflowBrief],
  );

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
  const parallelPlan = useMemo(
    () =>
      dashboard
        ? buildParallelPlan({
            brief: workflowBrief,
            selectedWorkflow,
            workflows,
          })
        : null,
    [dashboard, selectedWorkflow, workflowBrief, workflows],
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
      void fetchUserState()
        .then((serverState) => {
          setLocalState((current) => mergeLocalState(current, serverState));
        })
        .catch(() => undefined);
    },
    [refreshDashboard, refreshWorkflowBrief],
  );

  const handleBatchActionComplete = useCallback(
    (completedWorkflows: Array<WorkflowItem>) => {
      const advanceIds = completedWorkflows.map((workflow) => workflow.id);
      if (advanceIds.length) {
        setLocalState((current) =>
          advanceIds.reduce(
            (state, id) => dismissWorkflowInState(state, id),
            current,
          ),
        );
        setSelectedWorkflowId(null);
        void Promise.all(advanceIds.map((id) => persistDismissedWorkflow(id)))
          .then((serverStates) => {
            setLocalState((current) =>
              serverStates
                .filter((state): state is LocalState => Boolean(state))
                .reduce(
                  (merged, serverState) => mergeLocalState(merged, serverState),
                  current,
                ),
            );
          })
          .catch(() => undefined);
      }
      void refreshDashboard(true);
      void refreshWorkflowBrief(true);
      void fetchUserState()
        .then((serverState) => {
          setLocalState((current) => mergeLocalState(current, serverState));
        })
        .catch(() => undefined);
    },
    [refreshDashboard, refreshWorkflowBrief],
  );

  const prepareSafeBatchActions = useCallback(async (): Promise<BatchActionPreparation> => {
    setRefreshing(true);
    try {
      const [dashboardResponse, briefResponse] = await Promise.all([
        fetch('/api/dashboard?refresh=1', { headers: { 'cache-control': 'no-cache' } }),
        fetch('/api/workflow-brief?refresh=1', { headers: { 'cache-control': 'no-cache' } }),
      ]);
      if (!dashboardResponse.ok) {
        throw new Error(`Dashboard request failed with ${dashboardResponse.status}`);
      }
      if (!briefResponse.ok) {
        throw new Error(`Workflow brief request failed with ${briefResponse.status}`);
      }

      const freshDashboard = (await dashboardResponse.json()) as DashboardData;
      const freshBriefResponse = (await briefResponse.json()) as WorkflowBriefResponse;
      setLoadState({ data: freshDashboard, error: null, loading: false });
      setBriefState({ data: freshBriefResponse, error: null, loading: false });

      if (briefStatusStopsSafeBatch(freshBriefResponse.status)) {
        return {
          actions: [],
          detail: safeBatchBriefStopReason(freshBriefResponse),
        };
      }

      const freshWorkflows = buildWorkflows(freshDashboard);
      const freshBrief =
        freshBriefResponse.status === 'ready' ? freshBriefResponse.brief : null;
      const freshBriefWorkflowId = workflowIdFromBrief(freshBrief, freshWorkflows);
      const freshSelectedWorkflow =
        freshWorkflows.find((workflow) => workflow.id === selectedWorkflowId) ??
        freshWorkflows.find((workflow) => workflow.id === freshBriefWorkflowId) ??
        freshWorkflows.find((workflow) => !skippedIds.has(workflow.id)) ??
        freshWorkflows[0] ??
        null;
      const freshParallelPlan = buildParallelPlan({
        brief: freshBrief,
        selectedWorkflow: freshSelectedWorkflow,
        workflows: freshWorkflows,
      });
      const freshLaneLoad = buildLaneLoad({
        parallelPlan: freshParallelPlan,
        workflows: freshWorkflows,
      });
      const freshBatch = parallelBatchFor({
        dashboard: freshDashboard,
        laneLoad: freshLaneLoad,
        lanes: freshParallelPlan.lanes,
        readiness: freshBriefResponse.parallelReadiness ?? null,
        recommendedActive: freshParallelPlan.recommendedActive,
        workflows: freshWorkflows,
      });
      const actions = safeBatchLaneActions({
        batch: freshBatch,
        dashboard: freshDashboard,
        laneLoad: freshLaneLoad,
        lanes: freshParallelPlan.lanes,
        workflows: freshWorkflows,
      });
      const capacityStopReason = safeBatchProjectedCapacityStopReason(actions, freshLaneLoad);

      return {
        actions: capacityStopReason ? [] : actions,
        detail: capacityStopReason ?? freshBatch.detail,
      };
    } finally {
      setRefreshing(false);
    }
  }, [selectedWorkflowId, skippedIds]);

  const handleRestoreSkipped = useCallback(() => {
    const ids = Object.keys(localState.dismissed);
    setLocalState((current) => ({ ...current, dismissed: {} }));
    void Promise.all(ids.map((id) => removeDismissedWorkflow(id))).catch(() => undefined);
  }, [localState.dismissed]);

  return (
    <div className="app-shell" data-app-ready={Boolean(dashboard)}>
      <header className="topbar">
        <a className="brand-mark" href="/" aria-label="Ticketboard home">
          <span className="brand-sigil">tb</span>
          <span>
            <strong>Ticketboard</strong>
            <em>one focus, many lanes</em>
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
                handoffs={localState.handoffs}
                onQueueBriefRefresh={() => {
                  void queueWorkflowBriefRefresh(selectedWorkflow);
                }}
                onRefreshBrief={() => {
                  void refreshWorkflowBrief(true);
                }}
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
                dashboard={dashboard}
                handoffs={localState.handoffs}
                hiddenCount={hiddenCount}
                mode={mode}
                modeCounts={modeCounts}
                onModeChange={setMode}
                onQueryChange={setQuery}
                onPrepareSafeBatchActions={prepareSafeBatchActions}
                onRestoreSkipped={handleRestoreSkipped}
                onSelect={setSelectedWorkflowId}
                onWorkflowBatchComplete={handleBatchActionComplete}
                onWorkflowActionComplete={handleActionComplete}
                parallelPlan={parallelPlan}
                plan={projectPlan}
                query={query}
                selectedWorkflowId={selectedWorkflow.id}
                visibleWorkflows={visibleWorkflows}
                workflowBriefStatus={briefState.data}
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
    const laneCount = brief.lanes?.length ?? 0;
    return {
      description: brief.now.why,
      status: brief.now.action,
      title: laneCount > 1
        ? `Codex brief is coordinating ${laneCount} lanes.`
        : 'Codex brief is driving this move.',
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
  handoffs,
  onActionComplete,
  onQueueBriefRefresh,
  onRefreshBrief,
  onSkip,
  workflow,
  workflowBrief,
  workflowBriefStatus,
}: {
  dashboard: DashboardData;
  handoffs: Array<HandoffEvent>;
  onActionComplete: (shouldAdvance: boolean) => void;
  onQueueBriefRefresh: () => void;
  onRefreshBrief: () => void;
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
  const cleanupCompleteAction = useMemo(
    () => buildCleanupCompleteAction(workflow),
    [workflow],
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
          {cleanupCompleteAction ? (
            <WorkflowActionButton
              action={cleanupCompleteAction}
              className="ghost-button action-button cleanup-complete-button"
              onActionComplete={onActionComplete}
              testId="complete-cleanup-action"
              title="Mark this cleanup lane handled without changing local files"
            />
          ) : null}
        </div>
      </div>

      {workflowBrief ? <WorkflowBriefPanel brief={workflowBrief} /> : null}
      {!workflowBrief && workflowBriefStatus?.status ? (
        <WorkflowBriefStatus status={workflowBriefStatus} />
      ) : null}

      <WorkflowAutomationPanel
        handoffs={handoffs}
        onQueueRefresh={onQueueBriefRefresh}
        onRefresh={onRefreshBrief}
        status={workflowBriefStatus}
      />

      <WorkflowHandoffPanel handoff={handoff} />

      <WorkflowSourceDossier workflow={workflow} />

      <WorkflowLaneContract workflow={workflow} />

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

function WorkflowSourceDossier({ workflow }: { workflow: WorkflowItem }) {
  const sections = sourceDossierSections(workflow);

  return (
    <section className="source-dossier" data-source-dossier>
      <div className="source-dossier-head">
        <span className="section-kicker">Source dossier</span>
        <small>{sourceDossierSummary(sections)}</small>
      </div>
      <div className="source-dossier-grid">
        {sections.length ? sections.map((section) => (
          <div className="source-dossier-section" data-source-dossier-section={section.id} key={section.id}>
            <span>{section.title}</span>
            <ul>
              {section.items.map((item) => (
                <li key={`${section.id}:${item.label}:${item.detail}`}>
                  {item.href ? (
                    <a href={item.href} rel="noreferrer" target="_blank">
                      <strong>{sourceDossierDisplayText(item.label)}</strong>
                      <em>{sourceDossierDisplayText(item.detail)}</em>
                      <ExternalLink aria-hidden="true" size={13} />
                    </a>
                  ) : (
                    <>
                      <strong>{sourceDossierDisplayText(item.label)}</strong>
                      <em>{sourceDossierDisplayText(item.detail)}</em>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )) : (
          <p>No linked Linear, PR, doc, Codex, tmux, or worktree context is visible.</p>
        )}
      </div>
    </section>
  );
}

function WorkflowLaneContract({ workflow }: { workflow: WorkflowItem }) {
  const sections = laneContractSections(workflow);

  return (
    <section className="lane-contract" data-lane-contract>
      <div className="lane-contract-head">
        <span className="section-kicker">Lane contract</span>
        <small>{laneContractSummary(sections)}</small>
      </div>
      <div className="lane-contract-grid">
        {sections.map((section) => (
          <div className="lane-contract-section" data-lane-contract-section={section.id} key={section.id}>
            <span>{section.title}</span>
            <ol>
              {section.items.map((item) => (
                <li key={`${section.id}:${item.label}:${item.detail}`}>
                  <strong>{item.label}</strong>
                  <em>{sourceDossierDisplayText(item.detail)}</em>
                </li>
              ))}
            </ol>
          </div>
        ))}
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

function WorkflowAutomationPanel({
  handoffs,
  onQueueRefresh,
  onRefresh,
  status,
}: {
  handoffs: Array<HandoffEvent>;
  onQueueRefresh: () => void;
  onRefresh: () => void;
  status: WorkflowBriefResponse | null;
}) {
  if (!status) return null;

  const automation = status.automation;
  const ageSeconds = status.ageSeconds ?? null;
  const ttlSeconds = status.ttlSeconds ?? automation?.briefTtlSeconds ?? null;
  const remainingSeconds =
    ageSeconds !== null && ttlSeconds !== null
      ? Math.max(0, ttlSeconds - ageSeconds)
      : null;
  const lockState = automation?.lockActive
    ? 'active'
    : automation?.lockStale
      ? 'stale'
      : 'idle';
  const fingerprintStatus = automation?.fingerprintStatus ?? 'none';
  const pendingHandoff = latestHandoffAfterBrief(handoffs, status);
  const queuedRefreshRequest = activeBriefRefreshRequest(status);
  const briefRefreshOwed = Boolean(pendingHandoff || queuedRefreshRequest);

  return (
    <section
      className={`workflow-automation workflow-automation-${status.status}`}
      data-automation-lock-state={lockState}
      data-automation-status={status.status}
      data-brief-refresh-owed={briefRefreshOwed ? 'true' : 'false'}
      data-workflow-automation
    >
      <div className="automation-head">
        <span className="section-kicker">Brief automation</span>
        <div className="automation-actions">
          <button
            className="ghost-button"
            disabled={Boolean(queuedRefreshRequest || automation?.lockActive)}
            onClick={onQueueRefresh}
            type="button"
            data-testid="queue-brief-refresh"
          >
            <Bot aria-hidden="true" size={14} />
            {queuedRefreshRequest ? 'Plan queued' : 'Queue plan'}
          </button>
          <button className="ghost-button" onClick={onRefresh} type="button">
            <RefreshCw aria-hidden="true" size={14} />
            Refresh brief
          </button>
        </div>
      </div>
      <div className="automation-summary">
        <Bot aria-hidden="true" size={17} />
        <p>
          <strong>
            {briefStatusLabel(status.status)} / {lockStateLabel(lockState)}
          </strong>
          <em>
            {briefAutomationSummary(
              status,
              remainingSeconds,
              pendingHandoff,
              queuedRefreshRequest,
            )}
          </em>
        </p>
      </div>
      <div className="automation-facts">
        <span>
          <b>{formatDurationSeconds(ageSeconds)}</b>
          <em>brief age</em>
        </span>
        <span>
          <b>{formatDurationSeconds(ttlSeconds)}</b>
          <em>fresh window</em>
        </span>
        <span>
          <b>{formatDurationSeconds(automation?.intervalSeconds ?? null)}</b>
          <em>watch cadence</em>
        </span>
        <span>
          <b>
            {queuedRefreshRequest
              ? 'queued'
              : briefRefreshOwed
                ? 'owed'
                : fingerprintStatusLabel(fingerprintStatus)}
          </b>
          <em>
            {queuedRefreshRequest
              ? `request ${formatRelativeTime(queuedRefreshRequest.requestedAt ?? '')}`
              : pendingHandoff
                ? `${handoffKindLabel(pendingHandoff.kind)} ${formatRelativeTime(pendingHandoff.ranAt)}`
              : shortFingerprint(automation?.evidenceFingerprint ?? null)}
          </em>
        </span>
      </div>
      <code>{automation?.fingerprintPath ?? status.path}</code>
    </section>
  );
}

function briefStatusLabel(status: WorkflowBriefResponse['status']) {
  if (status === 'ready') return 'Fresh';
  if (status === 'stale') return 'Stale';
  if (status === 'invalid') return 'Invalid';
  return 'Missing';
}

function briefStatusStopsSafeBatch(status: WorkflowBriefResponse['status']) {
  return status === 'stale' || status === 'invalid';
}

function safeBatchBriefStopReason(status: WorkflowBriefResponse) {
  const label = briefStatusLabel(status.status).toLowerCase();
  const reason = status.reason?.trim();
  return reason
    ? `Workflow brief revalidated as ${label}: ${reason}`
    : `Workflow brief revalidated as ${label}; regenerate the brief before running a safe batch.`;
}

function fingerprintStatusLabel(status: string) {
  if (status === 'generated') return 'gen';
  if (status === 'refreshed') return 'refresh';
  if (status === 'none') return 'none';
  return truncate(status, 8);
}

function lockStateLabel(state: 'active' | 'idle' | 'stale') {
  if (state === 'active') return 'Codex running';
  if (state === 'stale') return 'stale lock';
  return 'Codex idle';
}

function briefAutomationSummary(
  status: WorkflowBriefResponse,
  remainingSeconds: number | null,
  pendingHandoff: HandoffEvent | null,
  refreshRequest: ActiveBriefRefreshRequest | null,
) {
  if (status.automation?.lockActive) {
    return 'A Codex generator lock is active, so another watcher should wait.';
  }
  if (refreshRequest) {
    const target = refreshRequest.batchTitle
      ? `parallel run ${sourceDossierDisplayText(refreshRequest.batchTitle)}`
      : refreshRequest.workflowId || refreshRequest.title || 'the latest handoff';
    return `A Codex brief refresh is queued for ${target}; the watcher should run it before normal cadence.`;
  }
  if (pendingHandoff) {
    return `A ${handoffKindLabel(pendingHandoff.kind).toLowerCase()} handoff landed after this brief; the watcher should regenerate from that new evidence.`;
  }
  if (status.status === 'ready') {
    return remainingSeconds !== null && remainingSeconds > 0
      ? `Watcher should skip Codex for about ${formatDurationSeconds(remainingSeconds)} unless evidence changes.`
      : 'Watcher can re-check evidence before deciding whether Codex is needed.';
  }
  if (status.status === 'stale') {
    return status.reason ?? 'Watcher should compare evidence before starting Codex.';
  }
  if (status.status === 'invalid') {
    return status.reason ?? 'The next watcher pass should regenerate the brief.';
  }
  return 'Start pnpm brief:watch or run pnpm brief:codex to generate the first brief.';
}

type ActiveBriefRefreshRequest = NonNullable<
  NonNullable<WorkflowBriefResponse['automation']>['refreshRequest']
> & {
  active: true;
};

function activeBriefRefreshRequest(
  status: WorkflowBriefResponse,
): ActiveBriefRefreshRequest | null {
  const request = status.automation?.refreshRequest;
  return request?.active ? { ...request, active: true } : null;
}

function latestHandoffAfterBrief(
  handoffs: Array<HandoffEvent>,
  status: WorkflowBriefResponse,
) {
  const briefUpdatedAt = Math.max(
    timestampMs(status.brief?.generatedAt ?? ''),
    timestampMs(status.automation?.fingerprintUpdatedAt ?? ''),
  );
  if (!briefUpdatedAt) return null;

  let latest: HandoffEvent | null = null;
  for (const handoff of handoffs) {
    const ranAt = timestampMs(handoff.ranAt);
    if (ranAt <= briefUpdatedAt) continue;
    if (!latest || ranAt > timestampMs(latest.ranAt)) {
      latest = handoff;
    }
  }
  return latest;
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
  dashboard,
  handoffs,
  hiddenCount,
  mode,
  modeCounts,
  onModeChange,
  onQueryChange,
  onPrepareSafeBatchActions,
  onRestoreSkipped,
  onSelect,
  onWorkflowBatchComplete,
  onWorkflowActionComplete,
  parallelPlan,
  plan,
  query,
  selectedWorkflowId,
  visibleWorkflows,
  workflowBriefStatus,
  workflows,
}: {
  dashboard: DashboardData;
  handoffs: Array<HandoffEvent>;
  hiddenCount: number;
  mode: WorkflowMode;
  modeCounts: Record<WorkflowMode, number>;
  onModeChange: (mode: WorkflowMode) => void;
  onQueryChange: (query: string) => void;
  onPrepareSafeBatchActions: () => Promise<BatchActionPreparation>;
  onRestoreSkipped: () => void;
  onSelect: (id: string) => void;
  onWorkflowBatchComplete: (workflows: Array<WorkflowItem>) => void;
  onWorkflowActionComplete: (workflow: WorkflowItem, shouldAdvance: boolean) => void;
  parallelPlan: ParallelPlan | null;
  plan: ProjectPlan;
  query: string;
  selectedWorkflowId: string;
  visibleWorkflows: Array<WorkflowItem>;
  workflowBriefStatus: WorkflowBriefResponse | null;
  workflows: Array<WorkflowItem>;
}) {
  const laneLoad = buildLaneLoad({ parallelPlan, workflows });
  const projectPulse = buildProjectPulse(workflows);
  const projectRunway = buildProjectRunway({ dashboard, workflows });
  const unlockMap = buildUnlockMap({ dashboard, workflows });
  const selectedWorkflow =
    workflows.find((workflow) => workflow.id === selectedWorkflowId) ?? null;
  const parallelBatch = parallelPlan
    ? parallelBatchFor({
        dashboard,
        laneLoad,
        lanes: parallelPlan.lanes,
        readiness: workflowBriefStatus?.parallelReadiness ?? null,
        recommendedActive: parallelPlan.recommendedActive,
        workflows,
      })
    : null;
  const laneMatrix = parallelPlan
    ? buildLaneMatrix({
        lanes: parallelPlan.lanes,
        readiness: workflowBriefStatus?.parallelReadiness ?? null,
        workflows,
      })
    : emptyLaneMatrix();
  const parallelRuns = buildParallelRunGroups(handoffs, workflows);
  const completionForecast = buildCompletionForecast({
    dashboard,
    parallelBatch,
    selectedWorkflow,
    unlockMap,
    workflows,
  });
  const parallelWaves = parallelBatch ? buildParallelWaves(parallelBatch) : null;
  const livePlanPacket = buildLivePlanPacket({
    completionForecast,
    dashboard,
    handoffs,
    laneMatrix,
    laneLoad,
    parallelBatch,
    parallelPlan,
    parallelRuns,
    parallelWaves,
    plan,
    projectPulse,
    projectRunway,
    unlockMap,
    workflowBriefStatus,
    workflows,
  });

  return (
    <aside className="workflow-queue plan-rail" aria-label="Generated project plan" data-project-plan>
      <div className="queue-head">
        <div>
          <span className="section-kicker">Live plan</span>
          <h2>What happens next</h2>
          <p>{plan.summary}</p>
        </div>
        <div className="queue-actions">
          <CopyButton
            className="ghost-button restore-button"
            icon="packet"
            label="Copy live plan"
            text={livePlanPacket}
            testId="copy-live-plan"
          />
          {hiddenCount ? (
            <button className="restore-button" onClick={onRestoreSkipped} type="button">
              Restore {hiddenCount}
            </button>
          ) : null}
        </div>
      </div>

      <PlanDigest
        onSelect={onSelect}
        plan={plan}
        selectedWorkflowId={selectedWorkflowId}
      />

      <ProjectPulsePanel onSelect={onSelect} pulse={projectPulse} />

      <ProjectRunwayPanel onSelect={onSelect} runway={projectRunway} />

      <LaneMatrixPanel matrix={laneMatrix} onSelect={onSelect} />

      <LaneLoadPanel
        load={laneLoad}
        onSelect={onSelect}
      />

      <HandoffLedger handoffs={handoffs} onSelect={onSelect} workflows={workflows} />

      <ParallelRunLedger groups={parallelRuns} onSelect={onSelect} />

      <CompletionForecastPanel forecast={completionForecast} onSelect={onSelect} />

      <UnlockMapPanel
        onSelect={onSelect}
        unlockMap={unlockMap}
      />

      {parallelPlan && parallelBatch ? (
        <ParallelLanesPanel
          batch={parallelBatch}
          dashboard={dashboard}
          laneLoad={laneLoad}
          onActionComplete={onWorkflowActionComplete}
          onBatchComplete={onWorkflowBatchComplete}
          onPrepareActions={onPrepareSafeBatchActions}
          onSelect={onSelect}
          plan={parallelPlan}
          readiness={workflowBriefStatus?.parallelReadiness ?? null}
          selectedWorkflowId={selectedWorkflowId}
          workflows={workflows}
        />
      ) : null}

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

function ProjectPulsePanel({
  onSelect,
  pulse,
}: {
  onSelect: (id: string) => void;
  pulse: ProjectPulse;
}) {
  return (
    <section className="project-pulse" data-project-pulse>
      <div className="project-pulse-head">
        <span className="section-kicker">Project pulse</span>
        <small>{pulse.summary}</small>
      </div>
      <div className="project-pulse-list">
        {pulse.items.length ? (
          pulse.items.map((item) => (
            <button
              className={`project-pulse-item project-pulse-item-${item.tone}`}
              data-project-pulse-item={item.id}
              key={item.id}
              onClick={() => onSelect(item.workflowId)}
              type="button"
            >
              <span>
                <strong>{item.title}</strong>
                <em>{item.detail}</em>
              </span>
              <small>{item.meta}</small>
            </button>
          ))
        ) : (
          <p>No Linear project grouping is visible.</p>
        )}
      </div>
    </section>
  );
}

function ProjectRunwayPanel({
  onSelect,
  runway,
}: {
  onSelect: (id: string) => void;
  runway: ProjectRunway;
}) {
  return (
    <section className="project-runway" data-project-runway>
      <div className="project-pulse-head">
        <span className="section-kicker">Project runway</span>
        <small>{runway.summary}</small>
      </div>
      <div className="project-runway-list">
        {runway.items.length ? (
          runway.items.map((item) => (
            <div
              className={`project-runway-project project-runway-project-${item.tone}`}
              data-project-runway-project={item.id}
              key={item.id}
            >
              <div className="project-runway-title">
                <button
                  disabled={!item.workflowId}
                  onClick={() => item.workflowId && onSelect(item.workflowId)}
                  type="button"
                >
                  <strong>{item.title}</strong>
                  <em>{item.summary}</em>
                </button>
              </div>
              <div className="project-runway-stages">
                {PROJECT_RUNWAY_STAGES.map((stage) => (
                  <ProjectRunwayStageCell
                    entries={item[stage.id]}
                    key={stage.id}
                    label={stage.label}
                    onSelect={onSelect}
                    stage={stage.id}
                  />
                ))}
              </div>
            </div>
          ))
        ) : (
          <p>No project runway is visible.</p>
        )}
      </div>
    </section>
  );
}

function ProjectRunwayStageCell({
  entries,
  label,
  onSelect,
  stage,
}: {
  entries: Array<ProjectRunwayEntry>;
  label: string;
  onSelect: (id: string) => void;
  stage: ProjectRunwayStage;
}) {
  const entry = entries[0] ?? null;
  const content = entry ? (
    <>
      <b>{entry.title}</b>
      <em>{entry.detail}</em>
      <small>{entry.meta}</small>
    </>
  ) : (
    <>
      <b>Clear</b>
      <em>No item in this stage.</em>
      <small>{label}</small>
    </>
  );

  return entry?.workflowId ? (
    <button
      className={`project-runway-stage project-runway-stage-${stage} project-runway-stage-${entry.tone}`}
      data-project-runway-stage={stage}
      onClick={() => onSelect(entry.workflowId as string)}
      title={entry.detail}
      type="button"
    >
      <span>{label}</span>
      {content}
    </button>
  ) : (
    <span
      className={`project-runway-stage project-runway-stage-${stage}${entry ? ` project-runway-stage-${entry.tone}` : ''}`}
      data-project-runway-stage={stage}
      title={entry?.detail}
    >
      <span>{label}</span>
      {content}
    </span>
  );
}

function LaneLoadPanel({
  load,
  onSelect,
}: {
  load: LaneLoad;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="lane-load" data-lane-load>
      <div className="lane-load-head">
        <span className="section-kicker">Lane load</span>
        <small>{load.summary}</small>
      </div>
      <div className="lane-load-facts">
        <span>
          <b>{load.activeCount}</b>
          <em>active</em>
        </span>
        <span>
          <b>{load.runningCount}</b>
          <em>Codex</em>
        </span>
        <span>
          <b>{load.dirtyCount}</b>
          <em>dirty</em>
        </span>
        <span>
          <b>{load.recommendedActive}/{load.maxActive}</b>
          <em>{load.capacityLabel}</em>
        </span>
      </div>
      <div className="lane-load-list">
        {load.items.length ? (
          load.items.map((item) => (
            <button
              className={`lane-load-item lane-load-item-${item.tone}`}
              data-lane-load-item={item.id}
              key={item.id}
              onClick={() => onSelect(item.workflowId)}
              type="button"
            >
              <span>
                <strong>{item.title}</strong>
                <em>{item.detail}</em>
              </span>
              <small>{item.meta}</small>
            </button>
          ))
        ) : (
          <p>No active Codex, terminal, or dirty local lanes are visible.</p>
        )}
      </div>
    </section>
  );
}

function LaneMatrixPanel({
  matrix,
  onSelect,
}: {
  matrix: LaneMatrix;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="lane-matrix" data-lane-matrix>
      <div className="lane-matrix-head">
        <span className="section-kicker">Lane matrix</span>
        <small>{matrix.summary}</small>
      </div>
      <div className="lane-matrix-facts">
        <span>
          <b>{matrix.readyCount}</b>
          <em>together</em>
        </span>
        <span>
          <b>{matrix.waitingCount}</b>
          <em>guarded</em>
        </span>
        <span>
          <b>{matrix.blockedCount}</b>
          <em>serialized</em>
        </span>
      </div>
      <div className="lane-matrix-list">
        {matrix.items.length ? (
          matrix.items.map((item) => (
            <button
              className={`lane-matrix-item lane-matrix-item-${item.tone}`}
              data-lane-matrix-item={item.id}
              key={item.id}
              onClick={() => onSelect(item.workflowIds[0])}
              type="button"
            >
              <span>
                <strong>{item.title}</strong>
                <em>{item.detail}</em>
              </span>
              <small>{item.meta}</small>
            </button>
          ))
        ) : (
          <p>Need at least two actionable lanes to compare.</p>
        )}
      </div>
    </section>
  );
}

function HandoffLedger({
  handoffs,
  onSelect,
  workflows,
}: {
  handoffs: Array<HandoffEvent>;
  onSelect: (id: string) => void;
  workflows: Array<WorkflowItem>;
}) {
  const recent = handoffs.slice(0, 4);
  if (!recent.length) return null;
  const workflowsById = new Map(workflows.map((workflow) => [workflow.id, workflow]));

  return (
    <section className="handoff-ledger" data-handoff-ledger>
      <div className="handoff-head">
        <span className="section-kicker">Recent handoffs</span>
        <small>{moveCount(recent.length, 'event')}</small>
      </div>
      <div className="handoff-list">
        {recent.map((handoff) => {
          const workflow = workflowsById.get(handoff.workflowId) ?? null;
          const outcome = handoffOutcome(workflow);
          return (
            <button
              className={`handoff-item handoff-item-${outcome.tone}`}
              data-handoff-item={handoff.id}
              data-handoff-outcome={outcome.tone}
              key={handoff.id}
              onClick={() => onSelect(handoff.workflowId)}
              title={outcome.detail}
              type="button"
            >
              <span>
                <strong>{readableTitle(handoff.title || handoff.workflowId)}</strong>
                <em>{handoff.message}</em>
                <i>{outcome.detail}</i>
              </span>
              <small>
                {outcome.label} / {handoffKindLabel(handoff.kind)} / {formatRelativeTime(handoff.ranAt)}
              </small>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function buildParallelRunGroups(
  handoffs: Array<HandoffEvent>,
  workflows: Array<WorkflowItem>,
): Array<ParallelRunGroup> {
  const workflowsById = new Map(workflows.map((workflow) => [workflow.id, workflow]));
  const grouped = new Map<string, ParallelRunGroup>();

  for (const handoff of handoffs) {
    const batchId = handoff.batchId?.trim();
    if (!batchId) continue;
    const outcome = handoffOutcome(workflowsById.get(handoff.workflowId) ?? null);
    const existing = grouped.get(batchId);
    if (!existing) {
      grouped.set(batchId, {
        id: batchId,
        items: [{ ...handoff, outcome }],
        ranAt: handoff.ranAt,
        summary: '',
        title: handoff.batchTitle?.trim() || 'Parallel run',
        tone: outcome.tone,
        workflowId: workflowsById.has(handoff.workflowId) ? handoff.workflowId : null,
      });
      continue;
    }
    existing.items.push({ ...handoff, outcome });
    if (timestampMs(handoff.ranAt) > timestampMs(existing.ranAt)) {
      existing.ranAt = handoff.ranAt;
    }
    if (!existing.workflowId && workflowsById.has(handoff.workflowId)) {
      existing.workflowId = handoff.workflowId;
    }
  }

  return [...grouped.values()]
    .map((group) => {
      const liveCount = group.items.filter((item) => item.outcome.tone === 'live').length;
      const quietCount = group.items.filter((item) => item.outcome.tone === 'quiet').length;
      const clearedCount = group.items.filter((item) => item.outcome.tone === 'cleared').length;
      const outcomeParts = [
        liveCount ? `${liveCount} live` : '',
        quietCount ? `${quietCount} idle` : '',
        clearedCount ? `${clearedCount} cleared` : '',
      ].filter(Boolean);
      const tone: HandoffOutcome['tone'] = liveCount
        ? 'live'
        : quietCount
          ? 'quiet'
          : 'cleared';
      return {
        ...group,
        items: group.items.sort(
          (left, right) => timestampMs(right.ranAt) - timestampMs(left.ranAt),
        ),
        summary: [
          moveCount(group.items.length, 'lane'),
          ...outcomeParts,
        ].join(' / '),
        tone,
      };
    })
    .sort((left, right) => timestampMs(right.ranAt) - timestampMs(left.ranAt))
    .slice(0, 4);
}

function ParallelRunLedger({
  groups,
  onSelect,
}: {
  groups: Array<ParallelRunGroup>;
  onSelect: (id: string) => void;
}) {
  if (!groups.length) return null;

  return (
    <section className="handoff-ledger parallel-run-ledger" data-parallel-run-ledger>
      <div className="handoff-head">
        <span className="section-kicker">Parallel runs</span>
        <small>{moveCount(groups.length, 'batch')}</small>
      </div>
      <div className="handoff-list">
        {groups.map((group) => {
          const details = group.items
            .map((item) =>
              `${handoffKindLabel(item.kind)}: ${sourceDossierDisplayText(item.title || item.workflowId)}`,
            )
            .join(' / ');
          const content = (
            <>
              <span>
                <strong>{sourceDossierDisplayText(readableTitle(group.title))}</strong>
                <em>{details}</em>
                <i>{group.summary}</i>
              </span>
              <small>
                {group.tone} / {formatRelativeTime(group.ranAt)}
              </small>
            </>
          );
          return group.workflowId ? (
            <button
              className={`handoff-item handoff-item-${group.tone}`}
              data-parallel-run={group.id}
              data-parallel-run-outcome={group.tone}
              key={group.id}
              onClick={() => onSelect(group.workflowId as string)}
              type="button"
            >
              {content}
            </button>
          ) : (
            <span
              className={`handoff-item handoff-item-${group.tone}`}
              data-parallel-run={group.id}
              data-parallel-run-outcome={group.tone}
              key={group.id}
            >
              {content}
            </span>
          );
        })}
      </div>
    </section>
  );
}

function UnlockMapPanel({
  onSelect,
  unlockMap,
}: {
  onSelect: (id: string) => void;
  unlockMap: UnlockMap;
}) {
  return (
    <section className="unlock-map" data-unlock-map>
      <div className="unlock-head">
        <span className="section-kicker">Unlock map</span>
        <small>{unlockMap.summary}</small>
      </div>
      <div className="unlock-list">
        {unlockMap.items.length ? (
          unlockMap.items.map((item) =>
            item.workflowId ? (
              <button
                className={`unlock-item unlock-item-${item.tone}`}
                data-unlock-item={item.id}
                key={item.id}
                onClick={() => onSelect(item.workflowId as string)}
                type="button"
              >
                <span>
                  <strong>{item.title}</strong>
                  <em>{item.detail}</em>
                </span>
                <small>{item.meta}</small>
              </button>
            ) : (
              <span
                className={`unlock-item unlock-item-${item.tone}`}
                data-unlock-item={item.id}
                key={item.id}
              >
                <span>
                  <strong>{item.title}</strong>
                  <em>{item.detail}</em>
                </span>
                <small>{item.meta}</small>
              </span>
            ),
          )
        ) : (
          <p>No explicit Linear blockers or PR gates are visible.</p>
        )}
      </div>
    </section>
  );
}

function CompletionForecastPanel({
  forecast,
  onSelect,
}: {
  forecast: CompletionForecast;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="completion-forecast" data-completion-forecast>
      <div className="unlock-head">
        <span className="section-kicker">After focus clears</span>
        <small>{forecast.summary}</small>
      </div>
      <div className="unlock-list">
        {forecast.items.length ? (
          forecast.items.map((item) =>
            item.workflowId ? (
              <button
                className={`unlock-item unlock-item-${item.tone}`}
                data-completion-forecast-item={item.id}
                key={item.id}
                onClick={() => onSelect(item.workflowId as string)}
                type="button"
              >
                <span>
                  <strong>{item.title}</strong>
                  <em>{item.detail}</em>
                </span>
                <small>{item.meta}</small>
              </button>
            ) : (
              <span
                className={`unlock-item unlock-item-${item.tone}`}
                data-completion-forecast-item={item.id}
                key={item.id}
              >
                <span>
                  <strong>{item.title}</strong>
                  <em>{item.detail}</em>
                </span>
                <small>{item.meta}</small>
              </span>
            ),
          )
        ) : (
          <p>No follow-up is visible for the selected workflow.</p>
        )}
      </div>
    </section>
  );
}

function ParallelLanesPanel({
  batch,
  dashboard,
  laneLoad,
  onActionComplete,
  onBatchComplete,
  onPrepareActions,
  onSelect,
  plan,
  readiness,
  selectedWorkflowId,
  workflows,
}: {
  batch: ParallelBatch;
  dashboard: DashboardData;
  laneLoad: LaneLoad;
  onActionComplete: (workflow: WorkflowItem, shouldAdvance: boolean) => void;
  onBatchComplete: (workflows: Array<WorkflowItem>) => void;
  onPrepareActions: () => Promise<BatchActionPreparation>;
  onSelect: (id: string) => void;
  plan: ParallelPlan;
  readiness: ParallelReadiness | null;
  selectedWorkflowId: string;
  workflows: Array<WorkflowItem>;
}) {
  if (!plan.lanes.length) return null;
  const nextLaneAction = nextSafeLaneAction({
    dashboard,
    laneLoad,
    lanes: plan.lanes,
    readiness,
    workflows,
  });
  const batchPacket = buildParallelBatchPacket({ batch, dashboard, plan, workflows });
  const batchLaneActions = safeBatchLaneActions({
    batch,
    dashboard,
    laneLoad,
    lanes: plan.lanes,
    workflows,
  });
  const nextLaneUnavailableReason = nextLaneAction
    ? null
    : nextSafeLaneUnavailableReason(batch);
  const waves = buildParallelWaves(batch);

  return (
    <section className="parallel-lanes" data-parallel-lanes={plan.source}>
      <div className="parallel-head">
        <span className="section-kicker">Parallel lanes</span>
        <p>{plan.summary}</p>
        <div className="parallel-capacity" aria-label="Parallel workflow capacity">
          <span>
            <strong>{plan.recommendedActive}</strong>
            active
          </span>
          <span>
            <strong>{plan.maxActive}</strong>
            max
          </span>
        </div>
        <div className="parallel-next-action">
          {nextLaneAction ? (
            <WorkflowActionButton
              action={{
                ...nextLaneAction.action,
                label: 'Run next lane',
              }}
              className="ghost-button action-button lane-action-button"
              onActionComplete={(shouldAdvance) => {
                onActionComplete(nextLaneAction.workflow, shouldAdvance);
              }}
              testId="run-next-safe-lane"
              title={`Run next safe lane: ${nextLaneAction.guard.reason}`}
            />
          ) : (
            <span
              className="parallel-next-blocked"
              title={nextLaneUnavailableReason ?? undefined}
            >
              <b>No safe Codex lane</b>
              <em>{nextLaneUnavailableReason}</em>
            </span>
          )}
        </div>
      </div>
      <ParallelWavesPanel onSelect={onSelect} waves={waves} />
      <div
        className="parallel-batch"
        data-guarded-count={batch.guardedCount}
        data-parallel-batch
      >
        <div className="parallel-batch-copy">
          <span className="section-kicker">Safe batch</span>
          <p>
            <strong>{batch.title}</strong>
            <em>{batch.detail}</em>
          </p>
          <div className="parallel-batch-actions">
            <CopyButton
              className="ghost-button parallel-batch-copy-button"
              icon="packet"
              label="Copy batch packet"
              text={batchPacket}
              testId="copy-batch-packet"
            />
            {batchLaneActions.length ? (
              <BatchWorkflowActionButton
                actions={batchLaneActions}
                onBatchComplete={onBatchComplete}
                onPrepareActions={onPrepareActions}
              />
            ) : null}
          </div>
        </div>
        <div className="parallel-batch-lanes">
          {batch.lanes.map((lane) => (
            lane.workflowId ? (
              <button
                className={`parallel-batch-lane parallel-role-${lane.role}`}
                data-batch-lane={lane.id}
                key={lane.id}
                onClick={() => onSelect(lane.workflowId as string)}
                type="button"
              >
                {lane.label}
              </button>
            ) : (
              <span
                className={`parallel-batch-lane parallel-role-${lane.role}`}
                data-batch-lane={lane.id}
                key={lane.id}
              >
                {lane.label}
              </span>
            )
          ))}
        </div>
        <div className="parallel-batch-decisions" aria-label="Safe batch decision trail">
          {batch.decisions.slice(0, 6).map((decision) =>
            decision.workflowId ? (
              <button
                className={`parallel-batch-decision parallel-batch-decision-${decision.status}`}
                data-batch-decision={decision.id}
                data-batch-decision-status={decision.status}
                key={decision.id}
                onClick={() => onSelect(decision.workflowId as string)}
                type="button"
              >
                <small>{batchDecisionLabel(decision)}</small>
                <strong>{decision.label}</strong>
                <em>{decision.reason}</em>
              </button>
            ) : (
              <span
                className={`parallel-batch-decision parallel-batch-decision-${decision.status}`}
                data-batch-decision={decision.id}
                data-batch-decision-status={decision.status}
                key={decision.id}
              >
                <small>{batchDecisionLabel(decision)}</small>
                <strong>{decision.label}</strong>
                <em>{decision.reason}</em>
              </span>
            ),
          )}
        </div>
      </div>

      <div className="parallel-lane-list">
        {plan.lanes.slice(0, 6).map((lane) => (
          <ParallelLaneRow
            dashboard={dashboard}
            key={lane.id}
            laneLoad={laneLoad}
            lane={lane}
            onActionComplete={onActionComplete}
            onSelect={onSelect}
            selectedWorkflowId={selectedWorkflowId}
            workflows={workflows}
          />
        ))}
      </div>
    </section>
  );
}

function ParallelWavesPanel({
  onSelect,
  waves,
}: {
  onSelect: (id: string) => void;
  waves: ParallelWavePlan;
}) {
  return (
    <section className="parallel-waves" data-parallel-waves>
      <div className="parallel-waves-head">
        <span className="section-kicker">Parallel waves</span>
        <small>{waves.summary}</small>
      </div>
      <div className="parallel-wave-list">
        {waves.items.length ? waves.items.map((wave) => (
          <div
            className={`parallel-wave parallel-wave-${wave.tone}`}
            data-parallel-wave={wave.id}
            key={wave.id}
          >
            <div className="parallel-wave-copy">
              <strong>{wave.title}</strong>
              <em>{wave.detail}</em>
            </div>
            <div className="parallel-wave-lanes">
              {wave.lanes.map((lane) =>
                lane.workflowId ? (
                  <button
                    className={`parallel-wave-lane parallel-role-${lane.role}`}
                    data-parallel-wave-lane={lane.id}
                    key={`${wave.id}:${lane.id}`}
                    onClick={() => onSelect(lane.workflowId as string)}
                    title={lane.reason}
                    type="button"
                  >
                    <span>{batchDecisionLabel(lane)}</span>
                    <strong>{lane.label}</strong>
                  </button>
                ) : (
                  <span
                    className={`parallel-wave-lane parallel-role-${lane.role}`}
                    data-parallel-wave-lane={lane.id}
                    key={`${wave.id}:${lane.id}`}
                    title={lane.reason}
                  >
                    <span>{batchDecisionLabel(lane)}</span>
                    <strong>{lane.label}</strong>
                  </span>
                ),
              )}
            </div>
          </div>
        )) : (
          <p>No parallel wave order is visible.</p>
        )}
      </div>
    </section>
  );
}

function ParallelLaneRow({
  dashboard,
  lane,
  laneLoad,
  onActionComplete,
  onSelect,
  selectedWorkflowId,
  workflows,
}: {
  dashboard: DashboardData;
  lane: ParallelLane;
  laneLoad: LaneLoad;
  onActionComplete: (workflow: WorkflowItem, shouldAdvance: boolean) => void;
  onSelect: (id: string) => void;
  selectedWorkflowId: string;
  workflows: Array<WorkflowItem>;
}) {
  const workflow = lane.workflowId
    ? workflows.find((candidate) => candidate.id === lane.workflowId) ?? null
    : null;
  const laneAction = laneActionFor({ dashboard, lane, laneLoad, workflow });
  const content = (
    <>
      <span className={`parallel-role parallel-role-${lane.role}`}>
        {laneRoleLabel(lane.role)}
      </span>
      <span className="parallel-lane-copy">
        <strong>{lane.title}</strong>
        <small>{lane.action}</small>
        <em>{lane.detail}</em>
      </span>
      <span className="parallel-lane-meta">
        <b>{lane.automation}</b>
        <span className={`parallel-safety parallel-safety-${lane.safety.level}`}>
          {lane.safety.label}
        </span>
        <i title={lane.safety.detail}>{lane.safety.detail}</i>
      </span>
    </>
  );

  if (lane.workflowId) {
    return (
      <div
        className={`parallel-lane parallel-lane-${lane.tone}`}
        data-parallel-lane={lane.id}
        data-selected={lane.workflowId === selectedWorkflowId ? 'true' : 'false'}
      >
        <button
          aria-label={`Select ${lane.title}`}
          aria-pressed={lane.workflowId === selectedWorkflowId}
          className="parallel-lane-select"
          onClick={() => onSelect(lane.workflowId as string)}
          type="button"
        >
          {content}
        </button>
        <div className="parallel-lane-action">
          {laneAction?.guard.runnable ? (
            <WorkflowActionButton
              action={laneAction.action}
              className="ghost-button action-button lane-action-button"
              onActionComplete={(shouldAdvance) => {
                onActionComplete(laneAction.workflow, shouldAdvance);
              }}
              testId={`run-lane-action-${lane.role}`}
              title={`Run ${laneRoleLabel(lane.role).toLowerCase()} lane action`}
            />
          ) : laneAction ? (
            <button
              className="ghost-button lane-action-button lane-action-guard"
              data-lane-action-guard={laneAction.guard.kind}
              onClick={() => onSelect(lane.workflowId as string)}
              title={laneAction.guard.reason}
              type="button"
            >
              <AlertTriangle aria-hidden="true" size={14} />
              {laneAction.guard.label}
            </button>
          ) : (
            <span>No local action</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <span className={`parallel-lane parallel-lane-${lane.tone}`} data-parallel-lane={lane.id}>
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
  className = 'solid-button action-button',
  onActionComplete,
  testId = 'run-workflow-action',
  title = 'Run the local action for this workflow',
}: {
  action: PlannedWorkflowAction;
  className?: string;
  onActionComplete: (shouldAdvance: boolean) => void;
  testId?: string;
  title?: string;
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
      const payload = (await response.json()) as WorkflowActionErrorPayload;
      if (!response.ok || !payload.ok) {
        throw new Error(workflowActionErrorMessage(payload, response.status));
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
        className={className}
        data-advance-on-success={action.advanceOnSuccess ? 'true' : 'false'}
        data-action-state={state.status}
        data-testid={testId}
        disabled={state.status === 'running'}
        onClick={() => void runAction()}
        title={title}
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

function workflowActionErrorMessage(payload: WorkflowActionErrorPayload, status: number) {
  if (payload.error) return payload.error;
  if (typeof payload.detail === 'string' && payload.detail.trim()) {
    return payload.detail;
  }
  if (
    payload.detail &&
    typeof payload.detail === 'object' &&
    typeof payload.detail.error === 'string' &&
    payload.detail.error.trim()
  ) {
    return payload.detail.error;
  }
  return `Action failed with ${status}`;
}

function BatchWorkflowActionButton({
  actions,
  onBatchComplete,
  onPrepareActions,
}: {
  actions: Array<RunnableLaneAction>;
  onBatchComplete: (workflows: Array<WorkflowItem>) => void;
  onPrepareActions: () => Promise<BatchActionPreparation>;
}) {
  const actionSignature = useMemo(
    () =>
      actions
        .map((item) => `${item.workflow.id}:${JSON.stringify(item.action.request)}`)
        .join('|'),
    [actions],
  );
  const [state, setState] = useState<BatchActionButtonState>({
    completed: 0,
    message: '',
    status: 'idle',
    title: '',
    total: actions.length,
  });

  useEffect(() => {
    setState({
      completed: 0,
      message: '',
      status: 'idle',
      title: '',
      total: actions.length,
    });
  }, [actionSignature, actions.length]);

  const runBatch = useCallback(async () => {
    const completed: Array<WorkflowItem> = [];
    setState({
      completed: 0,
      message: 'Refreshing dashboard and brief before launch.',
      status: 'running',
      title: 'Revalidating safe batch',
      total: actions.length,
    });

    try {
      const prepared = await onPrepareActions();
      const runnableActions = prepared.actions;
      if (!runnableActions.length) {
        throw new Error(`Batch revalidated; no lanes remain safe to run. ${prepared.detail}`);
      }
      const batchRun = safeBatchRunMetadata(runnableActions);
      setState({
        completed: 0,
        message: `${moveCount(runnableActions.length, 'lane')} still safe after fresh evidence. Checking local actions.`,
        status: 'running',
        title: 'Preflighting safe batch',
        total: runnableActions.length,
      });

      for (const [index, item] of runnableActions.entries()) {
        setState({
          completed: 0,
          message: item.workflow.title,
          status: 'running',
          title: `Preflight ${index + 1}/${runnableActions.length}`,
          total: runnableActions.length,
        });
        const response = await fetch('/api/workflow-action', {
          body: JSON.stringify({
            ...item.action.request,
            batchId: batchRun.id,
            batchTitle: batchRun.title,
            dryRun: true,
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        });
        const payload = (await response.json()) as WorkflowActionErrorPayload;
        if (!response.ok || !payload.ok) {
          throw new Error(
            `${item.workflow.title} preflight: ${workflowActionErrorMessage(payload, response.status)}`,
          );
        }
      }

      for (const [index, item] of runnableActions.entries()) {
        setState({
          completed: index,
          message: item.workflow.title,
          status: 'running',
          title: `Running ${index + 1}/${runnableActions.length}`,
          total: runnableActions.length,
        });
        const response = await fetch('/api/workflow-action', {
          body: JSON.stringify({
            ...item.action.request,
            batchId: batchRun.id,
            batchTitle: batchRun.title,
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        });
        const payload = (await response.json()) as WorkflowActionErrorPayload;
        if (!response.ok || !payload.ok) {
          throw new Error(
            `${item.workflow.title}: ${workflowActionErrorMessage(payload, response.status)}`,
          );
        }
        completed.push(item.workflow);
      }

      setState({
        completed: completed.length,
        message: `${moveCount(completed.length, 'lane')} handed off. Moving them out of the queue.`,
        status: 'done',
        title: 'Safe batch handed off',
        total: runnableActions.length,
      });
      window.setTimeout(() => onBatchComplete(completed), 900);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to run safe batch';
      setState({
        completed: completed.length,
        message: completed.length
          ? `${moveCount(completed.length, 'lane')} handed off before stop. ${message}`
          : message,
        status: 'failed',
        title: 'Batch stopped',
        total: Math.max(actions.length, completed.length),
      });
      if (completed.length) {
        window.setTimeout(() => onBatchComplete(completed), 1200);
      }
    }
  }, [actions, onBatchComplete, onPrepareActions]);

  return (
    <>
      <button
        className="ghost-button action-button parallel-batch-copy-button parallel-batch-run-button"
        data-action-state={state.status}
        data-testid="run-safe-batch"
        disabled={state.status === 'running' || !actions.length}
        onClick={() => void runBatch()}
        title={`Run ${moveCount(actions.length, 'safe lane')} from this batch`}
        type="button"
      >
        {state.status === 'running' ? (
          <Loader2 aria-hidden="true" className="spin" size={14} />
        ) : state.status === 'done' ? (
          <Check aria-hidden="true" size={14} />
        ) : (
          <Play aria-hidden="true" size={14} />
        )}
        {state.status === 'running'
          ? `Running ${state.completed + 1}/${state.total}`
          : 'Run safe batch'}
      </button>
      {state.status !== 'idle' ? (
        <div
          className={`action-result action-result-${state.status}`}
          data-testid="safe-batch-action-result"
          role="status"
        >
          <strong>{state.title}</strong>
          <span>{state.message}</span>
        </div>
      ) : null}
    </>
  );
}

function safeBatchRunMetadata(actions: Array<RunnableLaneAction>) {
  const signature = actions.map((item) => item.workflow.id).join('|');
  const titleBase = actions
    .map((item) => sourceDossierDisplayText(item.workflow.title))
    .slice(0, 3)
    .join(' + ');
  const extraCount = Math.max(0, actions.length - 3);
  return {
    id: `batch:${Date.now().toString(36)}:${shortHashCode(signature || 'empty')}`,
    title: `${titleBase || 'Safe batch'}${extraCount ? ` + ${extraCount} more` : ''}`,
  };
}

function shortHashCode(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(31, hash) + value.charCodeAt(index);
  }
  return Math.abs(hash).toString(36);
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
  return workflowIdFromBriefItem(brief.now, workflows);
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

function buildParallelPlan({
  brief,
  selectedWorkflow,
  workflows,
}: {
  brief: WorkflowBrief | null;
  selectedWorkflow: WorkflowItem | null;
  workflows: Array<WorkflowItem>;
}): ParallelPlan {
  const briefLanes = brief?.lanes ?? [];
  if (briefLanes.length) {
    const lanes = briefLanes
      .slice(0, 8)
      .map((lane, index) =>
        parallelLaneFromBrief(lane, index, workflows, selectedWorkflow),
      );
    if (selectedWorkflow && !lanes.some((lane) => lane.workflowId === selectedWorkflow.id)) {
      lanes.unshift(parallelLaneFromWorkflow(selectedWorkflow, 'focus', selectedWorkflow));
    }
    const hintedRecommendedActive = boundedLaneCount(
      brief?.operatingMode?.recommendedActiveLanes,
    );
    const fallbackRecommendedActive = Math.min(
      2,
      lanes.filter((lane) => lane.role !== 'waiting').length || 1,
    );
    const maxActive =
      boundedLaneCount(brief?.operatingMode?.maxActiveLanes) ??
      Math.max(hintedRecommendedActive ?? fallbackRecommendedActive, 3);
    const recommendedActive = Math.min(
      hintedRecommendedActive ?? fallbackRecommendedActive,
      maxActive,
    );
    return {
      lanes,
      maxActive,
      recommendedActive,
      source: 'brief',
      summary:
        brief?.operatingMode?.summary ||
        parallelPlanSummary({ lanes, source: 'brief' }),
    };
  }

  const selectedId = selectedWorkflow?.id ?? null;
  const lanes: Array<ParallelLane> = [];
  if (selectedWorkflow) {
    lanes.push(parallelLaneFromWorkflow(selectedWorkflow, 'focus', selectedWorkflow));
  }
  const parallelCandidates = workflows
    .filter((workflow) => workflow.id !== selectedId)
    .filter((workflow) => ['fix-ci', 'review', 'resume', 'ship', 'start'].includes(workflow.intent))
    .slice(0, 4)
    .map((workflow) =>
      parallelLaneFromWorkflow(
        workflow,
        roleForParallelWorkflow(workflow),
        selectedWorkflow,
      ),
    );
  const cleanupCandidates = workflows
    .filter((workflow) => workflow.id !== selectedId)
    .filter((workflow) => workflow.intent === 'clean' || workflow.intent === 'watch')
    .slice(0, 2)
    .map((workflow) =>
      parallelLaneFromWorkflow(
        workflow,
        roleForParallelWorkflow(workflow),
        selectedWorkflow,
      ),
    );
  lanes.push(...parallelCandidates, ...cleanupCandidates);

  const recommendedActive = Math.min(
    2,
    Math.max(1, lanes.filter((lane) => lane.role === 'focus' || lane.role === 'parallel').length),
  );
  return {
    lanes: lanes.slice(0, 6),
    maxActive: Math.max(3, recommendedActive),
    recommendedActive,
    source: 'live',
    summary: parallelPlanSummary({ lanes, source: 'live' }),
  };
}

function parallelLaneFromBrief(
  item: NonNullable<WorkflowBrief['lanes']>[number],
  index: number,
  workflows: Array<WorkflowItem>,
  focusWorkflow: WorkflowItem | null,
): ParallelLane {
  const workflowId = workflowIdFromBriefItem(item, workflows);
  const workflow = workflowId
    ? workflows.find((candidate) => candidate.id === workflowId) ?? null
    : null;
  const role = normalizeLaneRole(item.role, index);
  const automation = item.automation || (workflow ? automationForWorkflow(workflow, role) : 'Manual handoff');
  const title = readableTitle(item.title || workflow?.title);
  const fallbackSafety = safetyFromBriefHint(item, role);
  const safety = workflow
    ? analyzeParallelSafety({
        candidate: workflow,
        focus: focusWorkflow,
        hintedSafe: item.parallelSafe,
        role,
      })
    : fallbackSafety;
  return {
    action: readableSentence(item.action || workflow?.nextStep || 'Decide the next move.'),
    automation,
    detail: readableSentence(item.why || item.finishedWhen || workflow?.reason || ''),
    evidence: item.evidence?.filter(Boolean).slice(0, 4) ?? workflow?.evidence.slice(0, 4) ?? [],
    id: item.laneId || workflowId || `${role}:${index}:${title}`,
    meta: item.confidence ? `${item.confidence} confidence` : laneRoleLabel(role),
    parallelSafe: safety.level === 'safe',
    role,
    safety,
    source: 'brief',
    status: item.status || item.handoffWhen || item.finishedWhen || laneRoleLabel(role),
    title,
    tone: workflow?.tone ?? toneForLaneRole(role),
    workflowId,
  };
}

function parallelLaneFromWorkflow(
  workflow: WorkflowItem,
  role: ParallelLaneRole,
  focusWorkflow: WorkflowItem | null,
): ParallelLane {
  const safety = analyzeParallelSafety({
    candidate: workflow,
    focus: focusWorkflow,
    hintedSafe: undefined,
    role,
  });
  return {
    action: workflow.nextStep,
    automation: automationForWorkflow(workflow, role),
    detail: workflow.reason,
    evidence: workflow.evidence.slice(0, 4),
    id: `${role}:${workflow.id}`,
    meta: INTENT_LABELS[workflow.intent],
    parallelSafe: safety.level === 'safe',
    role,
    safety,
    source: 'live',
    status: workflow.eyebrow,
    title: workflow.title,
    tone: workflow.tone,
    workflowId: workflow.id,
  };
}

function analyzeParallelSafety({
  candidate,
  focus,
  hintedSafe,
  role,
}: {
  candidate: WorkflowItem;
  focus: WorkflowItem | null;
  hintedSafe?: boolean;
  role: ParallelLaneRole;
}): ParallelSafety {
  if (role === 'focus' || candidate.id === focus?.id) {
    return {
      detail: 'Owns the focus lane.',
      label: 'Focus owner',
      level: 'focus',
      paths: [],
      zones: [],
    };
  }

  if (role === 'waiting') {
    return {
      detail: 'Waiting on review, checks, or a human checkpoint.',
      label: 'Checkpoint',
      level: 'waiting',
      paths: [],
      zones: [],
    };
  }

  if (role === 'watch') {
    return {
      detail: 'Watch-only lane; no Codex handoff is needed.',
      label: 'Watch only',
      level: 'waiting',
      paths: [],
      zones: [],
    };
  }

  const candidatePaths = workflowChangedPaths(candidate);
  const focusPaths = focus ? workflowChangedPaths(focus) : [];
  const overlap = intersectPaths(candidatePaths, focusPaths);
  const candidateZones = changedPathZones(candidatePaths);
  const focusZones = changedPathZones(focusPaths);
  const sharedZones = intersectPaths(candidateZones, focusZones);

  if (overlap.length) {
    return {
      detail: `Touches focus files: ${overlap.slice(0, 3).join(', ')}${overlap.length > 3 ? ', ...' : ''}.`,
      label: 'File overlap',
      level: 'blocked',
      paths: overlap,
      zones: sharedZones,
    };
  }

  if (candidatePaths.length && focusPaths.length && sharedZones.length) {
    return {
      detail: `Shares ${sharedZones.slice(0, 3).join(', ')} with focus; no exact file overlap across ${moveCount(candidatePaths.length, 'lane file')}.`,
      label: 'Same area',
      level: 'unknown',
      paths: candidatePaths.slice(0, 6),
      zones: sharedZones,
    };
  }

  if (candidatePaths.length && focusPaths.length) {
    return {
      detail: `No overlap with ${moveCount(focusPaths.length, 'focus file')} across ${moveCount(candidatePaths.length, 'lane file')}.`,
      label: 'No file overlap',
      level: 'safe',
      paths: candidatePaths.slice(0, 6),
      zones: candidateZones.slice(0, 6),
    };
  }

  if (hintedSafe === true) {
    return {
      detail: 'Codex marked this lane safe; no changed-file conflict is visible.',
      label: 'Brief-safe',
      level: 'safe',
      paths: candidatePaths.slice(0, 6),
      zones: candidateZones.slice(0, 6),
    };
  }

  if (hintedSafe === false) {
    return {
      detail: 'Codex marked this lane serialized with the focus lane.',
      label: 'Serialized',
      level: 'blocked',
      paths: [],
      zones: [],
    };
  }

  if (role === 'cleanup') {
    return {
      detail: candidatePaths.length
        ? 'Cleanup touches no known focus files.'
        : 'Cleanup lane has no changed-file detail yet.',
      label: candidatePaths.length ? 'Cleanup-safe' : 'Check first',
      level: candidatePaths.length ? 'safe' : 'unknown',
      paths: candidatePaths.slice(0, 6),
      zones: candidateZones.slice(0, 6),
    };
  }

  return {
    detail: candidatePaths.length
      ? 'Focus file data is unavailable, so treat this as a guarded handoff.'
      : 'No changed-file detail yet; verify before running beside focus.',
    label: 'Verify first',
    level: 'unknown',
    paths: candidatePaths.slice(0, 6),
    zones: candidateZones.slice(0, 6),
  };
}

function safetyFromBriefHint(
  item: NonNullable<WorkflowBrief['lanes']>[number],
  role: ParallelLaneRole,
): ParallelSafety {
  if (role === 'focus') {
    return {
      detail: 'Owns the focus lane.',
      label: 'Focus owner',
      level: 'focus',
      paths: [],
      zones: [],
    };
  }
  if (item.parallelSafe === true) {
    return {
      detail: item.status || item.handoffWhen || 'Codex marked this lane safe with focus.',
      label: 'Brief-safe',
      level: 'safe',
      paths: [],
      zones: [],
    };
  }
  if (role === 'waiting') {
    return {
      detail: item.status || item.handoffWhen || 'Waiting on a checkpoint.',
      label: 'Checkpoint',
      level: 'waiting',
      paths: [],
      zones: [],
    };
  }
  return {
    detail: item.status || item.handoffWhen || 'No current workflow mapping to verify file overlap.',
    label: item.parallelSafe === false ? 'Serialized' : 'Verify first',
    level: item.parallelSafe === false ? 'blocked' : 'unknown',
    paths: [],
    zones: [],
  };
}

function workflowChangedPaths(workflow: WorkflowItem): Array<string> {
  const paths = new Set<string>();
  for (const pr of workflow.prs) {
    for (const file of pr.files) {
      addNormalizedPath(paths, file.path);
    }
  }
  for (const worktree of workflow.worktrees) {
    for (const line of worktree.statusLines) {
      for (const path of pathsFromStatusLine(line)) {
        addNormalizedPath(paths, path);
      }
    }
  }
  return [...paths].sort((left, right) => left.localeCompare(right));
}

function addNormalizedPath(paths: Set<string>, value: string | null | undefined) {
  const normalized = normalizeChangedPath(value);
  if (normalized) {
    paths.add(normalized);
  }
}

function pathsFromStatusLine(line: string): Array<string> {
  const stripped = line.trim().replace(/^[ MADRCU?!]{1,2}\s+/u, '');
  if (!stripped) return [];
  if (stripped.includes(' -> ')) {
    return stripped.split(' -> ').map((part) => unquoteStatusPath(part));
  }
  return [unquoteStatusPath(stripped)];
}

function unquoteStatusPath(value: string) {
  return value.trim().replace(/^"|"$/gu, '');
}

function normalizeChangedPath(value: string | null | undefined) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  return trimmed.replace(/^\.\/+/u, '');
}

function changedPathZones(paths: Array<string>) {
  const zones = new Set<string>();
  for (const path of paths) {
    const zone = changedPathZone(path);
    if (zone) zones.add(zone);
  }
  return [...zones].sort((left, right) => left.localeCompare(right));
}

function changedPathZone(path: string) {
  const normalized = normalizeChangedPath(path);
  if (!normalized) return null;
  const parts = normalized.split('/').filter(Boolean);
  if (!parts.length) return null;
  if (parts.length === 1) return parts[0];
  return parts.slice(0, -1).join('/');
}

function intersectPaths(left: Array<string>, right: Array<string>) {
  if (!left.length || !right.length) return [];
  const rightSet = new Set(right);
  return left.filter((path) => rightSet.has(path));
}

function workflowIdFromBriefItem(
  item: Partial<Pick<WorkflowBriefItem, 'prNumber' | 'ticketId' | 'workflowId'>>,
  workflows: Array<WorkflowItem>,
) {
  const explicitWorkflowId = item.workflowId?.trim();
  if (explicitWorkflowId && workflows.some((workflow) => workflow.id === explicitWorkflowId)) {
    return explicitWorkflowId;
  }

  const ticketId = item.ticketId?.trim().toUpperCase();
  if (ticketId) {
    const ticketWorkflow = workflows.find(
      (workflow) => workflow.ticket?.ticketId === ticketId,
    );
    if (ticketWorkflow) return ticketWorkflow.id;
  }

  if (typeof item.prNumber === 'number') {
    const prWorkflow = workflows.find((workflow) =>
      workflow.prs.some((pr) => pr.number === item.prNumber),
    );
    if (prWorkflow) return prWorkflow.id;
  }

  return explicitWorkflowId || null;
}

function normalizeLaneRole(
  value: string | undefined,
  index: number,
): ParallelLaneRole {
  if (
    value === 'cleanup' ||
    value === 'focus' ||
    value === 'parallel' ||
    value === 'waiting' ||
    value === 'watch'
  ) {
    return value;
  }
  return index === 0 ? 'focus' : 'parallel';
}

function roleForParallelWorkflow(workflow: WorkflowItem): ParallelLaneRole {
  if (workflow.intent === 'clean') return 'cleanup';
  if (workflow.intent === 'watch') return 'watch';
  if (workflow.intent === 'ship' || workflow.intent === 'review') return 'waiting';
  return 'parallel';
}

function automationForWorkflow(workflow: WorkflowItem, role: ParallelLaneRole) {
  if (role === 'cleanup') return 'Cleanup lane';
  if (role === 'watch') return 'Watch only';
  if (workflow.sessions.some((session) => session.status === 'goal-active' || session.status === 'running')) {
    return 'Resume Codex';
  }
  if (workflow.intent === 'ship' || workflow.intent === 'review') return 'Human checkpoint';
  if (workflow.intent === 'start') return 'Start Codex lane';
  if (workflow.intent === 'fix-ci') return 'Codex fix lane';
  return 'Codex handoff';
}

function toneForLaneRole(role: ParallelLaneRole): WorkflowTone {
  if (role === 'cleanup' || role === 'waiting') return 'warn';
  if (role === 'parallel') return 'calm';
  if (role === 'focus') return 'hot';
  return 'calm';
}

function laneRoleLabel(role: ParallelLaneRole) {
  const labels: Record<ParallelLaneRole, string> = {
    cleanup: 'Cleanup',
    focus: 'Focus',
    parallel: 'Parallel',
    waiting: 'Waiting',
    watch: 'Watch',
  };
  return labels[role];
}

function laneActionFor({
  dashboard,
  lane,
  laneLoad,
  workflow,
}: {
  dashboard: DashboardData;
  lane: ParallelLane;
  laneLoad: LaneLoad;
  workflow: WorkflowItem | null;
}): RunnableLaneAction | null {
  if (!workflow) return null;
  const action = buildWorkflowAction(
    workflow,
    dashboard,
    buildLaneCodexPrompt(lane, workflow),
  );
  if (!action) return null;
  return {
    action,
    guard: laneActionGuard(lane, action, workflow, laneLoad),
    lane,
    workflow,
  };
}

function nextSafeLaneAction({
  dashboard,
  laneLoad,
  lanes,
  readiness,
  workflows,
}: {
  dashboard: DashboardData;
  laneLoad: LaneLoad;
  lanes: Array<ParallelLane>;
  readiness: ParallelReadiness | null;
  workflows: Array<WorkflowItem>;
}): RunnableLaneAction | null {
  const focusLane = lanes.find((lane) => lane.role === 'focus') ?? null;
  const focusWorkflow = focusLane?.workflowId
    ? workflows.find((candidate) => candidate.id === focusLane.workflowId) ?? null
    : null;
  const dependencyEdges = workflows.flatMap((workflow) => workflowDependencyEdges(workflow));
  for (const lane of lanes) {
    if (lane.role !== 'parallel' && lane.role !== 'cleanup') continue;
    if (lane.safety.level !== 'safe') continue;
    const workflow = lane.workflowId
      ? workflows.find((candidate) => candidate.id === lane.workflowId) ?? null
      : null;
    if (!workflow || unresolvedWorkflowBlocker(workflow, dependencyEdges)) continue;
    if (readinessCandidateGuardReason(workflow.id, readiness)) continue;
    if (focusWorkflow && workflowDependencyConflict(workflow, focusWorkflow)) continue;
    if (
      focusWorkflow &&
      readinessPairGuardReason(workflow.id, focusWorkflow.id, readiness)
    ) {
      continue;
    }
    const laneAction = laneActionFor({ dashboard, lane, laneLoad, workflow });
    if (
      laneAction?.guard.runnable &&
      automatedActionKind(laneAction.action.request.kind)
    ) {
      return laneAction;
    }
  }
  return null;
}

function nextSafeLaneUnavailableReason(batch: ParallelBatch) {
  const blockedDecision =
    batch.decisions.find(
      (decision) =>
        decision.status === 'guarded' &&
        (decision.role === 'parallel' || decision.role === 'cleanup'),
    ) ??
    batch.decisions.find(
      (decision) =>
        decision.status === 'waiting' &&
        (decision.role === 'parallel' || decision.role === 'cleanup'),
    ) ??
    batch.decisions.find((decision) => decision.status === 'guarded') ??
    batch.decisions.find((decision) => decision.status === 'waiting');
  return blockedDecision?.reason ?? 'No lane fits the current capacity and safety checks.';
}

function safeBatchLaneActions({
  batch,
  dashboard,
  laneLoad,
  lanes,
  workflows,
}: {
  batch: ParallelBatch;
  dashboard: DashboardData;
  laneLoad: LaneLoad;
  lanes: Array<ParallelLane>;
  workflows: Array<WorkflowItem>;
}): Array<RunnableLaneAction> {
  const laneById = new Map(lanes.map((lane) => [lane.id, lane]));
  const actions: Array<RunnableLaneAction> = [];

  for (const decision of batch.decisions) {
    if (decision.status !== 'ready') continue;
    const lane = laneById.get(decision.id);
    const workflow = decision.workflowId
      ? workflows.find((candidate) => candidate.id === decision.workflowId) ?? null
      : null;
    if (!lane || !workflow) continue;
    const laneAction = laneActionFor({ dashboard, lane, laneLoad, workflow });
    if (
      laneAction?.guard.runnable &&
      automatedActionKind(laneAction.action.request.kind)
    ) {
      actions.push(laneAction);
    }
  }

  return actions;
}

function safeBatchProjectedCapacityStopReason(
  actions: Array<RunnableLaneAction>,
  laneLoad: LaneLoad,
) {
  if (!actions.length) return null;
  const projectedActive = laneLoad.activeCount + actions.length;
  if (projectedActive > laneLoad.maxActive) {
    return `Batch revalidated over the hard lane limit: ${moveCount(projectedActive, 'active lane')} would exceed ${moveCount(laneLoad.maxActive, 'lane')}.`;
  }
  if (projectedActive > laneLoad.recommendedActive) {
    return `Batch revalidated over the planned lane budget: ${moveCount(projectedActive, 'active lane')} would exceed ${moveCount(laneLoad.recommendedActive, 'planned lane')}.`;
  }
  return null;
}

function parallelBatchFor({
  dashboard,
  laneLoad,
  lanes,
  readiness,
  recommendedActive,
  workflows,
}: {
  dashboard: DashboardData;
  laneLoad: LaneLoad;
  lanes: Array<ParallelLane>;
  readiness: ParallelReadiness | null;
  recommendedActive: number;
  workflows: Array<WorkflowItem>;
}): ParallelBatch {
  const focusLane = lanes.find((lane) => lane.role === 'focus') ?? null;
  const workflowById = new Map(workflows.map((workflow) => [workflow.id, workflow]));
  const focusWorkflow = focusLane?.workflowId
    ? workflowById.get(focusLane.workflowId) ?? null
    : null;
  const dependencyEdges = workflows.flatMap((workflow) => workflowDependencyEdges(workflow));
  const extraSlots = Math.max(0, recommendedActive - laneLoad.activeCount);
  const decisions: Array<ParallelBatchDecision> = [];
  const selected: Array<{
    lane: ParallelLane;
    paths: Array<string>;
    workflow: WorkflowItem;
  }> = [];
  let guardedCount = 0;

  if (focusLane) {
    decisions.push(batchDecision(focusLane, 'focus', 'Owns the current focus lane.'));
  }

  for (const lane of lanes) {
    if (lane.id === focusLane?.id) continue;
    if (lane.role !== 'parallel' && lane.role !== 'cleanup') {
      decisions.push(batchDecision(lane, 'waiting', lane.safety.detail));
      continue;
    }
    const workflow = lane.workflowId
      ? workflowById.get(lane.workflowId) ?? null
      : null;

    if (lane.safety.level !== 'safe') {
      guardedCount += 1;
      decisions.push(batchDecision(lane, 'guarded', lane.safety.detail));
      continue;
    }

    if (!workflow) {
      guardedCount += 1;
      decisions.push(batchDecision(lane, 'waiting', 'No workflow is mapped for this lane.'));
      continue;
    }

    const unresolvedBlocker = unresolvedWorkflowBlocker(workflow, dependencyEdges);
    if (unresolvedBlocker) {
      guardedCount += 1;
      decisions.push(batchDecision(lane, 'guarded', unresolvedBlocker.reason));
      continue;
    }

    const readinessGuard = readinessCandidateGuardReason(workflow.id, readiness);
    if (readinessGuard) {
      guardedCount += 1;
      decisions.push(batchDecision(lane, 'guarded', readinessGuard));
      continue;
    }

    const dependencyConflict = batchDependencyConflictReason(
      lane,
      workflow,
      [
        ...(focusLane && focusWorkflow ? [{ lane: focusLane, workflow: focusWorkflow }] : []),
        ...selected,
      ],
    );
    if (dependencyConflict) {
      guardedCount += 1;
      decisions.push(batchDecision(lane, 'guarded', dependencyConflict));
      continue;
    }

    const readinessConflict = batchReadinessConflictReason(
      lane,
      workflow,
      [
        ...(focusLane && focusWorkflow ? [{ lane: focusLane, workflow: focusWorkflow }] : []),
        ...selected,
      ],
      readiness,
    );
    if (readinessConflict) {
      guardedCount += 1;
      decisions.push(batchDecision(lane, 'guarded', readinessConflict));
      continue;
    }

    const laneAction = laneActionFor({ dashboard, lane, laneLoad, workflow });

    if (!laneAction) {
      guardedCount += 1;
      decisions.push(batchDecision(lane, 'waiting', 'No local action is mapped for this lane.'));
      continue;
    }

    if (!laneAction.guard.runnable) {
      guardedCount += 1;
      decisions.push(batchDecision(lane, 'guarded', laneAction.guard.reason));
      continue;
    }

    if (!automatedActionKind(laneAction.action.request.kind)) {
      guardedCount += 1;
      decisions.push(batchDecision(lane, 'waiting', laneAction.guard.reason));
      continue;
    }

    const paths = changedPathsForLane(lane, workflow);
    const conflict = selected.find((candidate) =>
      intersectPaths(paths, candidate.paths).length > 0,
    );
    if (conflict) {
      guardedCount += 1;
      decisions.push(batchDecision(
        lane,
        'guarded',
        batchConflictReason(lane, paths, conflict),
      ));
      continue;
    }

    if (selected.length < extraSlots) {
      selected.push({ lane, paths, workflow });
      decisions.push(batchDecision(
        lane,
        'ready',
        'Fits the open Codex lane budget with no changed-file or Linear dependency conflict.',
      ));
      continue;
    }

    decisions.push(batchDecision(
      lane,
      'waiting',
      'Safe after the current batch; capacity is already assigned.',
    ));
  }

  const batchLanes = [
    ...(focusLane ? [focusLane] : []),
    ...selected.map((candidate) => candidate.lane),
  ];
  const labels = batchLanes.map(batchLaneLabel);
  const extraCount = selected.length;

  return {
    decisions,
    detail: batchDetail({
      activeCount: laneLoad.activeCount,
      extraCount,
      guardedCount,
      recommendedActive,
    }),
    guardedCount,
    lanes: batchLanes.map((lane) => ({
      id: lane.id,
      label: batchLaneLabel(lane),
      role: lane.role,
      workflowId: lane.workflowId,
    })),
    title: labels.length
      ? labels.join(' + ')
      : 'No lane is ready to run in parallel',
  };
}

function buildParallelWaves(batch: ParallelBatch): ParallelWavePlan {
  const decisionsById = new Map(batch.decisions.map((decision) => [decision.id, decision]));
  const currentWave = batch.lanes
    .map((lane) => {
      const decision = decisionsById.get(lane.id);
      return decision
        ? parallelWaveLane(decision)
        : {
            ...lane,
            reason: 'Selected for the current batch.',
            status: 'ready' as const,
          };
    });
  const onDeck = batch.decisions
    .filter((decision) => decision.status === 'waiting')
    .filter((decision) => decision.role === 'parallel' || decision.role === 'cleanup')
    .map(parallelWaveLane);
  const checkpoints = batch.decisions
    .filter((decision) => decision.status === 'waiting')
    .filter((decision) => decision.role !== 'parallel' && decision.role !== 'cleanup')
    .map(parallelWaveLane);
  const guarded = batch.decisions
    .filter((decision) => decision.status === 'guarded')
    .map(parallelWaveLane);
  const items: Array<ParallelWave> = [];

  if (currentWave.length) {
    items.push({
      detail: 'Run these lanes together now; focus stays first and ready lanes fit current capacity.',
      id: 'wave:now',
      lanes: currentWave,
      title: 'Wave 1 / run together',
      tone: currentWave.some((lane) => lane.status === 'ready') ? 'ready' : 'waiting',
    });
  }
  if (onDeck.length) {
    items.push({
      detail: 'Start these after a current slot clears; they are safe enough to queue next.',
      id: 'wave:on-deck',
      lanes: onDeck,
      title: 'Wave 2 / on deck',
      tone: 'ready',
    });
  }
  if (checkpoints.length) {
    items.push({
      detail: 'These need a human checkpoint, review state, or watch decision before Codex work.',
      id: 'wave:checkpoint',
      lanes: checkpoints,
      title: 'Checkpoint wave',
      tone: 'waiting',
    });
  }
  if (guarded.length) {
    items.push({
      detail: 'Do not start these beside the current batch until the guard reason is resolved.',
      id: 'wave:guarded',
      lanes: guarded,
      title: 'Guarded / serialized',
      tone: 'blocked',
    });
  }

  return {
    items,
    summary: parallelWaveSummary({
      guardedCount: guarded.length,
      nowCount: currentWave.length,
      onDeckCount: onDeck.length,
    }),
  };
}

function parallelWaveLane(decision: ParallelBatchDecision): ParallelWaveLane {
  return {
    id: decision.id,
    label: decision.label,
    reason: decision.reason,
    role: decision.role,
    status: decision.status,
    workflowId: decision.workflowId,
  };
}

function parallelWaveSummary({
  guardedCount,
  nowCount,
  onDeckCount,
}: {
  guardedCount: number;
  nowCount: number;
  onDeckCount: number;
}) {
  const parts = [
    nowCount ? `${moveCount(nowCount, 'lane')} now` : '',
    onDeckCount ? `${moveCount(onDeckCount, 'lane')} on deck` : '',
    guardedCount ? `${moveCount(guardedCount, 'lane')} guarded` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' / ') : 'No wave order visible';
}

function buildLaneMatrix({
  lanes,
  readiness,
  workflows,
}: {
  lanes: Array<ParallelLane>;
  readiness: ParallelReadiness | null;
  workflows: Array<WorkflowItem>;
}): LaneMatrix {
  const workflowById = new Map(workflows.map((workflow) => [workflow.id, workflow]));
  const candidates = lanes
    .filter((lane) =>
      Boolean(lane.workflowId) &&
      (lane.role === 'focus' || lane.role === 'parallel' || lane.role === 'cleanup'),
    )
    .slice(0, 5);
  const items: Array<LaneMatrixItem> = [];

  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const item = laneMatrixItem({
        left: candidates[leftIndex],
        readiness,
        right: candidates[rightIndex],
        workflowById,
      });
      if (item) items.push(item);
    }
  }

  const readyCount = items.filter((item) => item.tone === 'ready').length;
  const waitingCount = items.filter((item) => item.tone === 'waiting').length;
  const blockedCount = items.filter((item) => item.tone === 'blocked').length;
  const visibleItems = items
    .sort(
      (left, right) =>
        laneMatrixToneRank(left.tone) - laneMatrixToneRank(right.tone) ||
        left.title.localeCompare(right.title),
    )
    .slice(0, 6);

  return {
    blockedCount,
    items: visibleItems,
    readyCount,
    summary: items.length
      ? `${moveCount(readyCount, 'pair')} can run together`
      : 'No lane pairs visible',
    waitingCount,
  };
}

function emptyLaneMatrix(): LaneMatrix {
  return {
    blockedCount: 0,
    items: [],
    readyCount: 0,
    summary: 'No lane pairs visible',
    waitingCount: 0,
  };
}

function laneMatrixItem({
  left,
  readiness,
  right,
  workflowById,
}: {
  left: ParallelLane;
  readiness: ParallelReadiness | null;
  right: ParallelLane;
  workflowById: Map<string, WorkflowItem>;
}): LaneMatrixItem | null {
  if (!left.workflowId || !right.workflowId) return null;
  const leftWorkflow = workflowById.get(left.workflowId) ?? null;
  const rightWorkflow = workflowById.get(right.workflowId) ?? null;
  if (!leftWorkflow || !rightWorkflow) return null;

  const leftPaths = changedPathsForLane(left, leftWorkflow);
  const rightPaths = changedPathsForLane(right, rightWorkflow);
  const dependency = workflowDependencyConflict(leftWorkflow, rightWorkflow);
  const overlap = intersectPaths(leftPaths, rightPaths);
  const leftZones = changedPathZones(leftPaths);
  const rightZones = changedPathZones(rightPaths);
  const sharedZones = intersectPaths(leftZones, rightZones);
  const title = `${matrixLaneLabel(left)} + ${matrixLaneLabel(right)}`;
  const readinessConflict = readinessPairGuardReason(
    left.workflowId,
    right.workflowId,
    readiness,
  );
  if (readinessConflict) {
    return {
      detail: readinessConflict.reason,
      id: `matrix:${left.id}:${right.id}:readiness`,
      meta: 'Parallel readiness',
      title,
      tone: readinessConflict.status === 'blocked' ? 'blocked' : 'waiting',
      workflowIds: [left.workflowId, right.workflowId],
    };
  }

  if (dependency) {
    return {
      detail: dependency.reason,
      id: `matrix:${left.id}:${right.id}:dependency`,
      meta: 'Linear dependency',
      title,
      tone: 'blocked',
      workflowIds: [left.workflowId, right.workflowId],
    };
  }

  if (overlap.length) {
    return {
      detail: `Serialize these lanes; both touch ${overlap.slice(0, 3).join(', ')}${overlap.length > 3 ? ', ...' : ''}.`,
      id: `matrix:${left.id}:${right.id}`,
      meta: 'File overlap',
      title,
      tone: 'blocked',
      workflowIds: [left.workflowId, right.workflowId],
    };
  }

  if (sharedZones.length) {
    return {
      detail: `Guard before parallel work; both lanes touch ${sharedZones.slice(0, 3).join(', ')}.`,
      id: `matrix:${left.id}:${right.id}`,
      meta: 'Same area',
      title,
      tone: 'waiting',
      workflowIds: [left.workflowId, right.workflowId],
    };
  }

  if (!leftPaths.length || !rightPaths.length) {
    return {
      detail: 'Changed-file evidence is missing for one or both lanes; verify before running together.',
      id: `matrix:${left.id}:${right.id}`,
      meta: 'Verify',
      title,
      tone: 'waiting',
      workflowIds: [left.workflowId, right.workflowId],
    };
  }

  return {
    detail: `No changed-file overlap across ${moveCount(leftPaths.length + rightPaths.length, 'file')}.`,
    id: `matrix:${left.id}:${right.id}`,
    meta: 'Can run',
    title,
    tone: 'ready',
    workflowIds: [left.workflowId, right.workflowId],
  };
}

function matrixLaneLabel(lane: ParallelLane) {
  return `${laneRoleLabel(lane.role)}: ${truncate(lane.title, 24)}`;
}

function laneMatrixToneRank(tone: LaneMatrixTone) {
  if (tone === 'ready') return 0;
  if (tone === 'waiting') return 1;
  return 2;
}

function changedPathsForLane(
  lane: ParallelLane,
  workflow: WorkflowItem | null,
) {
  const workflowPaths = workflow ? workflowChangedPaths(workflow) : [];
  return workflowPaths.length ? workflowPaths : lane.safety.paths;
}

function unresolvedWorkflowBlocker(
  workflow: WorkflowItem,
  edges = workflowDependencyEdges(workflow),
) {
  const ticketIds = workflowTicketIds(workflow);
  if (!ticketIds.size) return null;
  for (const edge of edges) {
    const blockedId = edge.blocked.ticketId.toUpperCase();
    const blockerId = edge.blocker.ticketId.toUpperCase();
    if (
      ticketIds.has(blockedId) &&
      !ticketIds.has(blockerId) &&
      !isLinearIssueDone(edge.blocker)
    ) {
      return {
        blockerId: edge.blocker.ticketId,
        reason: `${edge.blocker.ticketId} blocks ${edge.blocked.ticketId}; finish or re-plan that dependency before starting this lane.`,
      };
    }
  }
  return null;
}

function batchDependencyConflictReason(
  lane: ParallelLane,
  workflow: WorkflowItem,
  selected: Array<{ lane: ParallelLane; workflow: WorkflowItem }>,
) {
  for (const item of selected) {
    const conflict = workflowDependencyConflict(workflow, item.workflow);
    if (conflict) {
      return `${batchLaneLabel(lane)} must serialize with ${batchLaneLabel(item.lane)}; ${conflict.reason}`;
    }
  }
  return null;
}

function batchReadinessConflictReason(
  lane: ParallelLane,
  workflow: WorkflowItem,
  selected: Array<{ lane: ParallelLane; workflow: WorkflowItem }>,
  readiness: ParallelReadiness | null,
) {
  for (const item of selected) {
    const conflict = readinessPairGuardReason(workflow.id, item.workflow.id, readiness);
    if (conflict) {
      return `${batchLaneLabel(lane)} must serialize with ${batchLaneLabel(item.lane)}; ${conflict.reason}`;
    }
  }
  return null;
}

function readinessCandidateGuardReason(
  workflowId: string,
  readiness: ParallelReadiness | null,
) {
  const candidate = readiness?.candidates.find((item) => item.workflowId === workflowId);
  if (!candidate) return null;
  const blocker = candidate.blockedBy[0];
  if (blocker) {
    return `Parallel readiness says ${blocker.blockerId} blocks ${blocker.blockedId}.`;
  }
  if (candidate.status === 'blocked') {
    return 'Parallel readiness marks this lane blocked.';
  }
  return null;
}

function readinessPairGuardReason(
  leftWorkflowId: string | null,
  rightWorkflowId: string | null,
  readiness: ParallelReadiness | null,
) {
  if (!leftWorkflowId || !rightWorkflowId || !readiness) return null;
  const pair = readiness.pairwise.find((item) =>
    (item.leftWorkflowId === leftWorkflowId && item.rightWorkflowId === rightWorkflowId) ||
      (item.leftWorkflowId === rightWorkflowId && item.rightWorkflowId === leftWorkflowId),
  );
  if (!pair || (pair.status !== 'blocked' && pair.status !== 'guarded')) {
    return null;
  }
  return {
    reason: `Parallel readiness says ${pair.type}: ${pair.reason}`,
    status: pair.status,
  };
}

function workflowDependencyConflict(
  left: WorkflowItem,
  right: WorkflowItem,
) {
  const leftIds = workflowTicketIds(left);
  const rightIds = workflowTicketIds(right);
  const edges = [
    ...workflowDependencyEdges(left),
    ...workflowDependencyEdges(right),
  ];
  for (const edge of edges) {
    if (isLinearIssueDone(edge.blocker)) continue;
    const blockedId = edge.blocked.ticketId.toUpperCase();
    const blockerId = edge.blocker.ticketId.toUpperCase();
    const leftOwnsBlocked = leftIds.has(blockedId);
    const rightOwnsBlocked = rightIds.has(blockedId);
    const leftOwnsBlocker = leftIds.has(blockerId);
    const rightOwnsBlocker = rightIds.has(blockerId);
    if (
      (leftOwnsBlocked && rightOwnsBlocker) ||
      (rightOwnsBlocked && leftOwnsBlocker)
    ) {
      return {
        blockedId: edge.blocked.ticketId,
        blockerId: edge.blocker.ticketId,
        reason: `${edge.blocker.ticketId} blocks ${edge.blocked.ticketId}.`,
      };
    }
  }
  return null;
}

function workflowDependencyEdges(workflow: WorkflowItem) {
  const ticket = workflow.linearTicket;
  if (!ticket) return [];
  return ticket.relatedIssues
    .map((relation) => unlockEdgeFromRelation(ticket, relation))
    .filter((edge): edge is NonNullable<ReturnType<typeof unlockEdgeFromRelation>> =>
      Boolean(edge),
    );
}

function batchLaneLabel(lane: ParallelLane) {
  const title = truncate(lane.title, 28);
  return lane.role === 'focus' ? `Focus: ${title}` : title;
}

function batchDecision(
  lane: ParallelLane,
  status: ParallelBatchDecisionStatus,
  reason: string,
): ParallelBatchDecision {
  return {
    id: lane.id,
    label: batchLaneLabel(lane),
    reason,
    role: lane.role,
    status,
    workflowId: lane.workflowId,
  };
}

function batchConflictReason(
  lane: ParallelLane,
  paths: Array<string>,
  conflict: { lane: ParallelLane; paths: Array<string> },
) {
  const overlap = intersectPaths(paths, conflict.paths).slice(0, 2).join(', ');
  const suffix = overlap ? `: ${overlap}` : '.';
  return `${batchLaneLabel(lane)} overlaps ${batchLaneLabel(conflict.lane)}${suffix}`;
}

function batchDecisionLabel(decision: ParallelBatchDecision) {
  const labels: Record<ParallelBatchDecisionStatus, string> = {
    focus: 'Focus lane',
    guarded: 'Guarded',
    ready: 'Ready now',
    waiting: 'Waiting',
  };
  return labels[decision.status];
}

function batchDetail({
  activeCount,
  extraCount,
  guardedCount,
  recommendedActive,
}: {
  activeCount: number;
  extraCount: number;
  guardedCount: number;
  recommendedActive: number;
}) {
  const budget = `Budget is ${moveCount(recommendedActive, 'active lane')}`;
  if (extraCount > 0) {
    const guarded = guardedCount
      ? ` ${moveCount(guardedCount, 'lane')} stay guarded.`
      : ' No guarded runnable lanes remain.';
    return `${budget}; ${moveCount(extraCount, 'extra Codex lane')} can run beside focus.${guarded}`;
  }
  if (guardedCount > 0) {
    if (activeCount >= recommendedActive) {
      return `${budget} and it is full; finish or clean a lane before starting another.`;
    }
    return `${budget}, but every extra lane needs review before it runs beside focus.`;
  }
  return `${budget}; no extra Codex lane is queued yet.`;
}

function automatedActionKind(kind: WorkflowActionRequest['kind']) {
  return kind === 'launch-codex' || kind === 'resume-codex' || kind === 'start-lane';
}

function laneActionGuard(
  lane: ParallelLane,
  action: PlannedWorkflowAction,
  workflow: WorkflowItem,
  laneLoad: LaneLoad,
): LaneActionGuard {
  if (!automatedActionKind(action.request.kind)) {
    return {
      kind: 'checkpoint',
      label: action.label,
      reason: 'Human checkpoint action.',
      runnable: true,
    };
  }
  if (
    lane.role === 'focus' ||
    lane.safety.level === 'focus' ||
    workflowHasLiveLane(workflow)
  ) {
    return {
      kind: 'safety',
      label: action.label,
      reason: lane.safety.detail,
      runnable: true,
    };
  }
  if (lane.safety.level === 'blocked') {
    return {
      kind: 'safety',
      label: 'Review first',
      reason: `Guarded because ${lane.safety.detail}`,
      runnable: false,
    };
  }
  if (lane.safety.level !== 'safe') {
    return {
      kind: 'safety',
      label: 'Check first',
      reason: `Guarded because ${lane.safety.detail}`,
      runnable: false,
    };
  }
  const capacityGuard = capacityGuardForNewLane(laneLoad);
  if (capacityGuard) return capacityGuard;
  return {
    kind: 'safety',
    label: action.label,
    reason: lane.safety.detail,
    runnable: true,
  };
}

function capacityGuardForNewLane(laneLoad: LaneLoad): LaneActionGuard | null {
  if (laneLoad.activeCount >= laneLoad.maxActive) {
    return {
      kind: 'capacity',
      label: 'At max',
      reason: `Guarded because the current load is ${moveCount(laneLoad.activeCount, 'active lane')} and the hard limit is ${moveCount(laneLoad.maxActive, 'lane')}. Finish or clean a lane before starting another Codex handoff.`,
      runnable: false,
    };
  }
  if (laneLoad.activeCount >= laneLoad.recommendedActive) {
    return {
      kind: 'capacity',
      label: 'At capacity',
      reason: `Guarded because the current load is ${moveCount(laneLoad.activeCount, 'active lane')} and the plan is ${moveCount(laneLoad.recommendedActive, 'lane')}. Finish or clean a lane before starting another Codex handoff.`,
      runnable: false,
    };
  }
  return null;
}

function handoffKindLabel(kind: string) {
  const labels: Record<string, string> = {
    'complete-cleanup': 'Marked cleanup',
    'focus-tmux': 'Focused',
    'launch-codex': 'Started Codex',
    'open-pr': 'Opened PR',
    'open-url': 'Opened source',
    'open-worktree': 'Opened worktree',
    'resume-codex': 'Resumed Codex',
    'start-lane': 'Started lane',
  };
  return labels[kind] ?? readableTitle(kind);
}

function boundedLaneCount(value: number | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(1, Math.min(6, Math.round(value)));
}

function parallelPlanSummary({
  lanes,
  source,
}: {
  lanes: Array<ParallelLane>;
  source: ParallelPlan['source'];
}) {
  const parallelCount = lanes.filter((lane) => lane.role === 'parallel').length;
  const waitingCount = lanes.filter((lane) => lane.role === 'waiting').length;
  const cleanupCount = lanes.filter((lane) => lane.role === 'cleanup').length;
  const prefix = source === 'brief' ? 'Codex sees' : 'Live signals show';
  const parts = [
    parallelCount ? `${moveCount(parallelCount, 'parallel lane')}` : 'no extra parallel lane',
    waitingCount ? `${moveCount(waitingCount, 'waiting checkpoint')}` : '',
    cleanupCount ? `${moveCount(cleanupCount, 'cleanup lane')}` : '',
  ].filter(Boolean);
  return `${prefix} ${parts.join('; ')}.`;
}

function buildProjectPulse(workflows: Array<WorkflowItem>): ProjectPulse {
  const groups = new Map<string, Array<WorkflowItem>>();
  for (const workflow of workflows) {
    const projectName = projectNameForWorkflow(workflow);
    if (!projectName) continue;
    groups.set(projectName, [...(groups.get(projectName) ?? []), workflow]);
  }

  const items = [...groups.entries()]
    .map(([projectName, projectWorkflows]) =>
      projectPulseItem(projectName, projectWorkflows),
    )
    .filter((item): item is ProjectPulseItem => Boolean(item))
    .sort(
      (left, right) =>
        projectPulseToneRank(left.tone) - projectPulseToneRank(right.tone) ||
        right.activeCount - left.activeCount ||
        right.workflowCount - left.workflowCount,
    )
    .slice(0, 4);

  return {
    items,
    summary: items.length
      ? `${moveCount(items.length, 'project lane')} active`
      : 'No project lanes visible',
  };
}

function projectPulseItem(
  projectName: string,
  workflows: Array<WorkflowItem>,
): ProjectPulseItem | null {
  const ordered = [...workflows].sort((left, right) => right.score - left.score);
  const top = ordered[0] ?? null;
  if (!top) return null;
  const activeCount = ordered.filter(workflowHasLiveLane).length;
  const hotCount = ordered.filter((workflow) => workflow.tone === 'hot').length;
  const tone: ProjectPlanTone = hotCount
    ? 'hot'
    : activeCount
      ? 'warn'
      : top.intent === 'ship'
        ? 'ready'
        : 'calm';
  const pressure = activeCount
    ? `${moveCount(activeCount, 'active lane')}; `
    : '';

  return {
    activeCount,
    detail: `${pressure}${truncate(top.nextStep, 84)}`,
    id: `project:${slugify(projectName)}`,
    meta: moveCount(ordered.length, 'workflow'),
    title: projectName,
    tone,
    workflowCount: ordered.length,
    workflowId: top.id,
  };
}

function projectNameForWorkflow(workflow: WorkflowItem) {
  const projectName = workflow.linearTicket?.projectName?.trim();
  return projectName || null;
}

function projectPulseToneRank(tone: ProjectPlanTone) {
  if (tone === 'hot') return 0;
  if (tone === 'warn') return 1;
  if (tone === 'ready') return 2;
  return 3;
}

function buildProjectRunway({
  dashboard,
  workflows,
}: {
  dashboard: DashboardData;
  workflows: Array<WorkflowItem>;
}): ProjectRunway {
  const groups = new Map<string, {
    tickets: Array<LinearTicketSummary>;
    workflows: Array<WorkflowItem>;
  }>();
  const ensureGroup = (projectName: string) => {
    const normalized = projectName.trim() || 'No project';
    const existing = groups.get(normalized);
    if (existing) return existing;
    const next = { tickets: [], workflows: [] };
    groups.set(normalized, next);
    return next;
  };

  for (const ticket of dashboard.linearTickets) {
    if (!ticket.projectName) continue;
    ensureGroup(ticket.projectName).tickets.push(ticket);
  }
  for (const workflow of workflows) {
    const projectName = projectNameForWorkflow(workflow);
    if (!projectName) continue;
    ensureGroup(projectName).workflows.push(workflow);
  }

  const items = [...groups.entries()]
    .map(([projectName, group]) =>
      projectRunwayItem(projectName, group.workflows, group.tickets),
    )
    .filter((item): item is ProjectRunwayItem => Boolean(item))
    .sort(
      (left, right) =>
        projectPulseToneRank(left.tone) - projectPulseToneRank(right.tone) ||
        right.blocked.length - left.blocked.length ||
        right.current.length - left.current.length ||
        right.next.length - left.next.length,
    )
    .slice(0, 4);

  const activeProjects = items.filter((item) => item.current.length || item.blocked.length).length;
  return {
    items,
    summary: items.length
      ? `${moveCount(items.length, 'project')} / ${moveCount(activeProjects, 'active')}`
      : 'No project runway visible',
  };
}

function projectRunwayItem(
  projectName: string,
  workflows: Array<WorkflowItem>,
  tickets: Array<LinearTicketSummary>,
): ProjectRunwayItem | null {
  const seen = new Set<string>();
  const entries: Record<ProjectRunwayStage, Array<ProjectRunwayEntry>> = {
    blocked: [],
    current: [],
    done: [],
    next: [],
  };
  const add = (entry: ProjectRunwayEntry) => {
    if (seen.has(entry.id)) return;
    seen.add(entry.id);
    entries[entry.stage].push(entry);
  };

  for (const workflow of [...workflows].sort((left, right) => right.score - left.score)) {
    add(projectRunwayEntryFromWorkflow(workflow));
  }

  const workflowTicketIds = new Set(
    workflows.flatMap((workflow) => [...workflowTicketIdsArray(workflow)]),
  );
  for (const ticket of [...tickets].sort(sortLinearTicketsForRunway)) {
    if (workflowTicketIds.has(ticket.ticketId.toUpperCase())) continue;
    add(projectRunwayEntryFromTicket(ticket));
  }

  const current = entries.current.slice(0, 2);
  const next = entries.next.slice(0, 2);
  const blocked = entries.blocked.slice(0, 2);
  const done = entries.done.slice(0, 1);
  if (!current.length && !next.length && !blocked.length && !done.length) return null;

  const tone: ProjectPlanTone = blocked.length
    ? 'hot'
    : current.some((entry) => entry.tone === 'warn' || entry.tone === 'hot')
      ? 'warn'
      : next.length
        ? 'ready'
        : 'calm';
  const workflowId =
    current.find((entry) => entry.workflowId)?.workflowId ??
    blocked.find((entry) => entry.workflowId)?.workflowId ??
    next.find((entry) => entry.workflowId)?.workflowId ??
    done.find((entry) => entry.workflowId)?.workflowId ??
    null;

  return {
    blocked,
    current,
    done,
    id: `project-runway:${slugify(projectName)}`,
    next,
    summary: [
      current.length ? `${current.length} current` : '',
      next.length ? `${next.length} next` : '',
      blocked.length ? `${blocked.length} blocked` : '',
      done.length ? `${done.length} done` : '',
    ].filter(Boolean).join(' / '),
    title: projectName,
    tone,
    workflowId,
  };
}

function projectRunwayEntryFromWorkflow(workflow: WorkflowItem): ProjectRunwayEntry {
  const stage = projectRunwayStageForWorkflow(workflow);
  return {
    detail: truncate(workflow.nextStep, 84),
    id: `workflow:${workflow.id}`,
    meta: projectRunwayWorkflowMeta(workflow),
    stage,
    title: readableTitle(workflow.title),
    tone: workflow.tone,
    workflowId: workflow.id,
  };
}

function projectRunwayEntryFromTicket(ticket: LinearTicketSummary): ProjectRunwayEntry {
  const stage = projectRunwayStageForTicket(ticket);
  return {
    detail: projectRunwayTicketDetail(ticket, stage),
    id: `linear:${ticket.ticketId}`,
    meta: ticket.cycleName || ticket.stateName || 'Linear',
    stage,
    title: readableTitle(ticket.title || ticket.ticketId),
    tone: projectRunwayToneForStage(stage, ticket.priority),
    workflowId: null,
  };
}

function projectRunwayStageForWorkflow(workflow: WorkflowItem): ProjectRunwayStage {
  if (workflowBlocked(workflow)) return 'blocked';
  if (workflow.linearTicket && projectRunwayStageForTicket(workflow.linearTicket) === 'done') {
    return 'done';
  }
  if (
    workflowHasLiveLane(workflow) ||
    ['clean', 'fix-ci', 'resume', 'review', 'ship'].includes(workflow.intent)
  ) {
    return 'current';
  }
  return 'next';
}

function projectRunwayStageForTicket(ticket: LinearTicketSummary): ProjectRunwayStage {
  if (ticket.stateType === 'completed' || ticket.stateType === 'canceled' || ticket.completedAt) {
    return 'done';
  }
  if (linearTicketBlocked(ticket)) return 'blocked';
  if (ticket.stateType === 'backlog' || ticket.stateType === 'unstarted') {
    return 'next';
  }
  return 'current';
}

function projectRunwayToneForStage(
  stage: ProjectRunwayStage,
  priority: number | null,
): ProjectPlanTone {
  if (stage === 'blocked') return 'hot';
  if (stage === 'current') return priority === 1 || priority === 2 ? 'hot' : 'warn';
  if (stage === 'next') return 'ready';
  return 'calm';
}

function workflowBlocked(workflow: WorkflowItem) {
  return Boolean(
    workflow.ticket?.state === 'blocked' ||
      (workflow.linearTicket && linearTicketBlocked(workflow.linearTicket)) ||
      workflow.prs.some((pr) => pr.checkSummary.state === 'red'),
  );
}

function linearTicketBlocked(ticket: LinearTicketSummary) {
  const stateName = ticket.stateName.toLowerCase();
  if (stateName.includes('block')) return true;
  return ticket.relatedIssues.some((relation) => {
    const edge = unlockEdgeFromRelation(ticket, relation);
    return Boolean(edge && edge.blocked.ticketId === ticket.ticketId && !isLinearIssueDone(edge.blocker));
  });
}

function projectRunwayWorkflowMeta(workflow: WorkflowItem) {
  const live = workflowHasLiveLane(workflow) ? 'Live lane' : INTENT_LABELS[workflow.intent];
  const prState = workflow.prs.find((pr) => pr.checkSummary.state !== 'unknown')?.checkSummary.state;
  return prState ? `${live} / ${prState}` : live;
}

function projectRunwayTicketDetail(
  ticket: LinearTicketSummary,
  stage: ProjectRunwayStage,
) {
  if (stage === 'done') {
    return ticket.completedAt
      ? `Completed ${formatRelativeTime(ticket.completedAt)}.`
      : `State is ${ticket.stateName}.`;
  }
  if (stage === 'blocked') {
    const blocker = ticket.relatedIssues
      .map((relation) => unlockEdgeFromRelation(ticket, relation))
      .find((edge) => edge && edge.blocked.ticketId === ticket.ticketId && !isLinearIssueDone(edge.blocker));
    return blocker
      ? `Waiting on ${blocker.blocker.ticketId}: ${blocker.blocker.title}.`
      : `State is ${ticket.stateName}.`;
  }
  if (stage === 'next') {
    return ticket.dueDate ? `Queued; due ${ticket.dueDate}.` : 'Queued behind current project work.';
  }
  return ticket.startedAt
    ? `Started ${formatRelativeTime(ticket.startedAt)}.`
    : `State is ${ticket.stateName}.`;
}

function sortLinearTicketsForRunway(
  left: LinearTicketSummary,
  right: LinearTicketSummary,
) {
  return (
    projectRunwayStageRank(projectRunwayStageForTicket(left)) -
    projectRunwayStageRank(projectRunwayStageForTicket(right)) ||
    linearPriorityRank(left.priority) - linearPriorityRank(right.priority) ||
    timestampMs(right.updatedAt) - timestampMs(left.updatedAt)
  );
}

function projectRunwayStageRank(stage: ProjectRunwayStage) {
  if (stage === 'blocked') return 0;
  if (stage === 'current') return 1;
  if (stage === 'next') return 2;
  return 3;
}

function linearPriorityRank(priority: number | null) {
  return typeof priority === 'number' && priority > 0 ? priority : 99;
}

function workflowTicketIdsArray(workflow: WorkflowItem) {
  return [...workflowTicketIds(workflow)];
}

function buildLaneLoad({
  parallelPlan,
  workflows,
}: {
  parallelPlan: ParallelPlan | null;
  workflows: Array<WorkflowItem>;
}): LaneLoad {
  const recommendedActive = parallelPlan?.recommendedActive ?? 1;
  const maxActive = parallelPlan?.maxActive ?? Math.max(3, recommendedActive);
  const items = workflows
    .map(laneLoadItemFromWorkflow)
    .filter((item): item is LaneLoadItem => Boolean(item))
    .sort((left, right) => laneLoadToneRank(left.tone) - laneLoadToneRank(right.tone))
    .slice(0, 5);
  const activeCount = workflows.filter(workflowHasLiveLane).length;
  const runningCount = workflows.filter((workflow) =>
    workflow.sessions.some(isActiveCodexSession),
  ).length;
  const dirtyCount = workflows.filter((workflow) =>
    workflow.worktrees.some((worktree) => (worktree.dirtyCount ?? 0) > 0),
  ).length;
  const terminalCount = workflows.filter((workflow) => workflow.windows.length > 0).length;
  const capacityLabel =
    activeCount > maxActive
      ? 'over max'
      : activeCount > recommendedActive
        ? 'above plan'
        : activeCount === recommendedActive
          ? 'at plan'
          : 'room';

  return {
    activeCount,
    capacityLabel,
    dirtyCount,
    items,
    maxActive,
    recommendedActive,
    runningCount,
    summary: laneLoadSummary({ activeCount, maxActive, recommendedActive }),
    terminalCount,
  };
}

function laneLoadItemFromWorkflow(workflow: WorkflowItem): LaneLoadItem | null {
  const activeSessions = workflow.sessions.filter(isActiveCodexSession);
  const dirtyFiles = workflow.worktrees.reduce(
    (sum, worktree) => sum + (worktree.dirtyCount ?? 0),
    0,
  );
  const prunableCount = workflow.worktrees.filter((worktree) => worktree.prunable).length;
  const terminalCount = workflow.windows.length;
  if (!activeSessions.length && !dirtyFiles && !prunableCount && !terminalCount) {
    return null;
  }

  const detailParts = [
    activeSessions.length ? moveCount(activeSessions.length, 'active Codex session') : '',
    terminalCount ? moveCount(terminalCount, 'terminal lane') : '',
    dirtyFiles ? moveCount(dirtyFiles, 'dirty file') : '',
    prunableCount ? moveCount(prunableCount, 'prunable worktree') : '',
  ].filter(Boolean);

  return {
    detail: detailParts.join('; '),
    id: `lane-load:${workflow.id}`,
    meta: laneLoadMeta(workflow),
    title: laneLoadTitle(workflow),
    tone: laneLoadTone(workflow, activeSessions.length, dirtyFiles, prunableCount),
    workflowId: workflow.id,
  };
}

function workflowHasLiveLane(workflow: WorkflowItem) {
  return Boolean(
    workflow.sessions.some(isActiveCodexSession) ||
      workflow.windows.length ||
      workflow.worktrees.some((worktree) => (worktree.dirtyCount ?? 0) > 0 || worktree.prunable),
  );
}

function isActiveCodexSession(session: CodexSessionSummary) {
  return session.status === 'goal-active' || session.status === 'running';
}

function laneLoadTitle(workflow: WorkflowItem) {
  const ticketId = workflow.ticket?.ticketId ?? workflow.linearTicket?.ticketId;
  if (ticketId) return `${ticketId}: ${truncate(workflow.title, 42)}`;
  return truncate(workflow.title, 52);
}

function laneLoadMeta(workflow: WorkflowItem) {
  if (workflow.intent === 'clean') return 'Cleanup';
  if (workflow.intent === 'fix-ci') return 'Fix checks';
  if (workflow.intent === 'ship') return 'Ship';
  if (workflow.intent === 'review') return 'Review';
  return INTENT_LABELS[workflow.intent];
}

function laneLoadTone(
  workflow: WorkflowItem,
  activeSessions: number,
  dirtyFiles: number,
  prunableCount: number,
): LaneLoadTone {
  if (workflow.intent === 'clean' || prunableCount) return 'warn';
  if (dirtyFiles && !activeSessions) return 'warn';
  if (workflow.tone === 'hot') return 'over';
  return 'active';
}

function laneLoadToneRank(tone: LaneLoadTone) {
  if (tone === 'over') return 0;
  if (tone === 'warn') return 1;
  return 2;
}

function laneLoadSummary({
  activeCount,
  maxActive,
  recommendedActive,
}: {
  activeCount: number;
  maxActive: number;
  recommendedActive: number;
}) {
  if (activeCount > maxActive) {
    return `${moveCount(activeCount, 'active lane')}; over max ${maxActive}`;
  }
  if (activeCount > recommendedActive) {
    return `${moveCount(activeCount, 'active lane')}; above planned ${recommendedActive}`;
  }
  if (activeCount === recommendedActive) {
    return `${moveCount(activeCount, 'active lane')}; at plan`;
  }
  return `${moveCount(activeCount, 'active lane')}; ${moveCount(recommendedActive - activeCount, 'open slot')}`;
}

function buildUnlockMap({
  dashboard,
  workflows,
}: {
  dashboard: DashboardData;
  workflows: Array<WorkflowItem>;
}): UnlockMap {
  const ticketWorkflows = workflowByTicketId(workflows);
  const items: Array<UnlockItem> = [];
  const seen = new Set<string>();

  for (const ticket of dashboard.linearTickets) {
    for (const relation of ticket.relatedIssues) {
      const edge = unlockEdgeFromRelation(ticket, relation);
      if (!edge) continue;
      const blockerWorkflow = ticketWorkflows.get(edge.blocker.ticketId) ?? null;
      const blockedWorkflow = ticketWorkflows.get(edge.blocked.ticketId) ?? null;
      const blockerDone = isLinearIssueDone(edge.blocker);
      const id = `linear:${edge.blocker.ticketId}:${edge.blocked.ticketId}:${edge.relationType}`;
      if (seen.has(id)) continue;
      seen.add(id);
      items.push({
        detail: blockerDone
          ? `${edge.blocker.ticketId} is done; ${edge.blocked.ticketId} can move next.`
          : `${edge.blocker.ticketId} is ${edge.blocker.stateName || 'not done'}; finish it before ${edge.blocked.ticketId}.`,
        id,
        meta: relationLabel(edge.relationType),
        title: `${edge.blocked.ticketId} waits on ${edge.blocker.ticketId}`,
        tone: blockerDone ? 'ready' : 'blocked',
        workflowId: blockerDone
          ? blockedWorkflow?.id ?? blockerWorkflow?.id ?? null
          : blockerWorkflow?.id ?? blockedWorkflow?.id ?? null,
      });
    }
  }

  for (const pr of dashboard.prs) {
    const item = unlockItemFromPr(pr, workflows);
    if (item && !seen.has(item.id)) {
      seen.add(item.id);
      items.push(item);
    }
  }

  for (const ticket of dashboard.tickets) {
    if (ticket.state !== 'blocked') continue;
    const id = `ticket:${ticket.ticketId}:blocked`;
    if (seen.has(id)) continue;
    const workflow = ticketWorkflows.get(ticket.ticketId) ?? null;
    items.push({
      detail: ticket.nextAction,
      id,
      meta: ticket.risk === 'high' ? 'High risk' : 'Blocked',
      title: `${ticket.ticketId} is blocked`,
      tone: 'blocked',
      workflowId: workflow?.id ?? null,
    });
  }

  const sorted = items
    .sort((left, right) => unlockToneRank(left.tone) - unlockToneRank(right.tone))
    .slice(0, 4);

  return {
    items: sorted,
    summary: sorted.length
      ? `${moveCount(sorted.length, 'unlock checkpoint')} visible`
      : 'No dependency blockers visible',
  };
}

function buildCompletionForecast({
  dashboard,
  parallelBatch,
  selectedWorkflow,
  unlockMap,
  workflows,
}: {
  dashboard: DashboardData;
  parallelBatch: ParallelBatch | null;
  selectedWorkflow: WorkflowItem | null;
  unlockMap: UnlockMap;
  workflows: Array<WorkflowItem>;
}): CompletionForecast {
  if (!selectedWorkflow) {
    return {
      items: [],
      summary: 'Select a workflow',
    };
  }

  const byTicket = workflowByTicketId(workflows);
  const selectedTicketIds = workflowTicketIds(selectedWorkflow);
  const items: Array<CompletionForecastItem> = [];
  const seen = new Set<string>();
  const add = (item: CompletionForecastItem) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    items.push(item);
  };

  for (const ticket of dashboard.linearTickets) {
    for (const relation of ticket.relatedIssues) {
      const edge = unlockEdgeFromRelation(ticket, relation);
      if (!edge || !selectedTicketIds.has(edge.blocker.ticketId.toUpperCase())) {
        continue;
      }
      const blockedWorkflow = byTicket.get(edge.blocked.ticketId.toUpperCase()) ?? null;
      add({
        detail: `${edge.blocked.ticketId} can move once ${edge.blocker.ticketId} is finished or handed off.`,
        id: `forecast:linear:${edge.blocker.ticketId}:${edge.blocked.ticketId}`,
        meta: relationLabel(edge.relationType),
        title: `Unlock ${edge.blocked.ticketId}`,
        tone: 'ready',
        workflowId: blockedWorkflow?.id ?? null,
      });
    }
  }

  for (const pr of selectedWorkflow.prs) {
    if (pr.checkSummary.state === 'green' && !pr.isDraft) {
      add({
        detail: pr.reviewDecision === 'CHANGES_REQUESTED'
          ? 'Checks are green, but review changes still need a response.'
          : 'After merge, refresh Ticketboard and clear any leftover local lane.',
        id: `forecast:pr:${pr.number}:green`,
        meta: pr.reviewDecision === 'APPROVED' ? 'Approved' : 'Green',
        title: `Ship PR #${pr.number}`,
        tone: pr.reviewDecision === 'CHANGES_REQUESTED' ? 'waiting' : 'ready',
        workflowId: selectedWorkflow.id,
      });
    } else if (pr.checkSummary.state === 'red') {
      add({
        detail: `${moveCount(pr.checkSummary.failed, 'failing check')} must pass before this unlocks follow-up work.`,
        id: `forecast:pr:${pr.number}:red`,
        meta: 'Checks failing',
        title: `Unblock PR #${pr.number}`,
        tone: 'blocked',
        workflowId: selectedWorkflow.id,
      });
    } else if (pr.checkSummary.state === 'pending') {
      add({
        detail: `${moveCount(pr.checkSummary.pending, 'pending check')} still needs a result before the lane can ship.`,
        id: `forecast:pr:${pr.number}:pending`,
        meta: 'Waiting',
        title: `Watch PR #${pr.number}`,
        tone: 'waiting',
        workflowId: selectedWorkflow.id,
      });
    }
  }

  const readyDecision = parallelBatch?.decisions.find(
    (decision) =>
      decision.status === 'ready' &&
      decision.workflowId &&
      decision.workflowId !== selectedWorkflow.id,
  );
  if (readyDecision) {
    add({
      detail: readyDecision.reason,
      id: `forecast:batch:${readyDecision.id}`,
      meta: 'Parallel slot',
      title: `Start ${readyDecision.label}`,
      tone: 'ready',
      workflowId: readyDecision.workflowId,
    });
  }

  const directUnlock = unlockMap.items.find(
    (item) => item.workflowId && item.workflowId !== selectedWorkflow.id,
  );
  if (directUnlock) {
    add({
      detail: directUnlock.detail,
      id: `forecast:unlock:${directUnlock.id}`,
      meta: directUnlock.meta,
      title: directUnlock.title,
      tone: directUnlock.tone,
      workflowId: directUnlock.workflowId,
    });
  }

  if (workflowHasLiveLane(selectedWorkflow)) {
    add({
      detail: 'After the handoff or merge, close stale tmux panes and clean or archive local changes.',
      id: `forecast:cleanup:${selectedWorkflow.id}`,
      meta: 'Cleanup',
      title: 'Clear local residue',
      tone: 'waiting',
      workflowId: selectedWorkflow.id,
    });
  }

  const nextWorkflow = workflows.find(
    (workflow) =>
      workflow.id !== selectedWorkflow.id &&
      workflow.intent !== 'clean' &&
      workflow.intent !== 'watch',
  );
  if (nextWorkflow) {
    add({
      detail: nextWorkflow.nextStep,
      id: `forecast:next:${nextWorkflow.id}`,
      meta: INTENT_LABELS[nextWorkflow.intent],
      title: `Queue ${truncate(nextWorkflow.title, 42)}`,
      tone: 'waiting',
      workflowId: nextWorkflow.id,
    });
  }

  const limited = items
    .sort((left, right) => unlockToneRank(left.tone) - unlockToneRank(right.tone))
    .slice(0, 4);

  return {
    items: limited,
    summary: limited.length
      ? `${moveCount(limited.length, 'move')} after focus`
      : 'No follow-up visible',
  };
}

function workflowTicketIds(workflow: WorkflowItem) {
  const ticketIds = new Set<string>();
  for (const ticketId of [
    workflow.ticket?.ticketId,
    workflow.linearTicket?.ticketId,
    ...workflow.prs.flatMap((pr) => pr.ticketIds),
    ...workflow.sessions.flatMap((session) => session.ticketIds),
    ...workflow.worktrees.flatMap((worktree) => worktree.ticketIds),
    ...workflow.windows.flatMap((window) => window.ticketIds),
  ]) {
    if (ticketId) ticketIds.add(ticketId.toUpperCase());
  }
  return ticketIds;
}

function workflowByTicketId(workflows: Array<WorkflowItem>) {
  const byTicket = new Map<string, WorkflowItem>();
  for (const workflow of workflows) {
    const ticketIds = new Set([
      workflow.ticket?.ticketId,
      workflow.linearTicket?.ticketId,
      ...workflow.prs.flatMap((pr) => pr.ticketIds),
      ...workflow.sessions.flatMap((session) => session.ticketIds),
      ...workflow.worktrees.flatMap((worktree) => worktree.ticketIds),
      ...workflow.windows.flatMap((window) => window.ticketIds),
    ]);
    for (const ticketId of ticketIds) {
      if (ticketId) byTicket.set(ticketId.toUpperCase(), workflow);
    }
  }
  return byTicket;
}

function unlockEdgeFromRelation(
  ticket: LinearTicketSummary,
  relation: LinearTicketSummary['relatedIssues'][number],
) {
  const relationType = normalizeRelationType(relation.relationType);
  const related = relation.issue;
  if (!related?.ticketId) return null;
  if (relationType === 'blocked_by' || relationType === 'blocks_this') {
    return {
      blocked: linearLinkForTicket(ticket),
      blocker: related,
      relationType,
    };
  }
  if (relationType === 'blocks' || relationType === 'this_blocks') {
    return {
      blocked: related,
      blocker: linearLinkForTicket(ticket),
      relationType,
    };
  }
  return null;
}

function normalizeRelationType(value: string | null | undefined) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/gu, '_');
  if (normalized === 'blocked' || normalized === 'blocked_by') return 'blocked_by';
  if (normalized === 'blocks') return 'blocks';
  return normalized;
}

function linearLinkForTicket(ticket: LinearTicketSummary) {
  return {
    stateName: ticket.stateName,
    stateType: ticket.stateType,
    ticketId: ticket.ticketId,
    title: ticket.title,
    url: ticket.url,
  };
}

function isLinearIssueDone(issue: LinearLinkedIssueSummary) {
  return issue.stateType === 'completed' || issue.stateType === 'canceled';
}

function relationLabel(value: string) {
  if (value === 'blocked_by' || value === 'blocks_this') return 'Blocked by';
  if (value === 'blocks' || value === 'this_blocks') return 'Blocks';
  return readableTitle(value);
}

function unlockItemFromPr(
  pr: PullRequestSummary,
  workflows: Array<WorkflowItem>,
): UnlockItem | null {
  const workflow =
    workflows.find((candidate) => candidate.prs.some((candidatePr) => candidatePr.number === pr.number)) ??
    null;
  const ticketLabel = pr.ticketIds[0] ?? `PR #${pr.number}`;
  if (pr.checkSummary.state === 'red') {
    return {
      detail: `${moveCount(pr.checkSummary.failed, 'failing check')} must pass before this can ship.`,
      id: `pr:${pr.number}:red`,
      meta: 'Checks failing',
      title: `PR #${pr.number} blocks ${ticketLabel}`,
      tone: 'blocked',
      workflowId: workflow?.id ?? null,
    };
  }
  if (pr.reviewDecision === 'CHANGES_REQUESTED') {
    return {
      detail: 'Review changes are requested; resolve them before this unlocks.',
      id: `pr:${pr.number}:changes-requested`,
      meta: 'Review gate',
      title: `PR #${pr.number} blocks ${ticketLabel}`,
      tone: 'blocked',
      workflowId: workflow?.id ?? null,
    };
  }
  if (pr.checkSummary.state === 'pending') {
    return {
      detail: `${moveCount(pr.checkSummary.pending, 'pending check')} still running.`,
      id: `pr:${pr.number}:pending`,
      meta: 'Waiting',
      title: `PR #${pr.number} is waiting`,
      tone: 'waiting',
      workflowId: workflow?.id ?? null,
    };
  }
  if (
    pr.checkSummary.state === 'green' &&
    !pr.isDraft &&
    (pr.reviewDecision === 'APPROVED' || pr.reviewDecision === null)
  ) {
    return {
      detail: 'Checks are green and review is clear enough to ship or merge.',
      id: `pr:${pr.number}:ready`,
      meta: pr.reviewDecision === 'APPROVED' ? 'Approved' : 'Green',
      title: `PR #${pr.number} can unlock ${ticketLabel}`,
      tone: 'ready',
      workflowId: workflow?.id ?? null,
    };
  }
  return null;
}

function unlockToneRank(tone: UnlockTone) {
  if (tone === 'blocked') return 0;
  if (tone === 'waiting') return 1;
  return 2;
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

function handoffOutcome(workflow: WorkflowItem | null): HandoffOutcome {
  if (!workflow) {
    return {
      detail: 'The handed-off workflow no longer appears in the active board.',
      label: 'Cleared',
      tone: 'cleared',
    };
  }
  if (workflow.sessions.some(isActiveCodexSession)) {
    return {
      detail: 'Codex is still active on this handoff.',
      label: 'Live',
      tone: 'live',
    };
  }
  if (workflow.windows.length) {
    return {
      detail: 'A terminal lane is still open for this handoff.',
      label: 'Live',
      tone: 'live',
    };
  }
  if (workflow.worktrees.some((worktree) => (worktree.dirtyCount ?? 0) > 0)) {
    return {
      detail: 'Local changes still exist after this handoff.',
      label: 'Still dirty',
      tone: 'live',
    };
  }
  if (workflow.intent === 'ship' || workflow.intent === 'clean') {
    return {
      detail: workflow.nextStep,
      label: workflow.intent === 'ship' ? 'Ready' : 'Cleanup',
      tone: 'quiet',
    };
  }
  return {
    detail: `No active lane is visible; next visible move is: ${workflow.nextStep}`,
    label: 'Quiet',
    tone: 'quiet',
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

function sourceDossierSections(workflow: WorkflowItem): Array<SourceDossierSection> {
  const sections = [
    sourceDossierLinearSection(workflow),
    sourceDossierDocsSection(workflow),
    sourceDossierPrSection(workflow),
    sourceDossierLocalSection(workflow),
  ].filter((section): section is SourceDossierSection => Boolean(section?.items.length));
  return sections;
}

function sourceDossierLinearSection(workflow: WorkflowItem): SourceDossierSection | null {
  const ticket = workflow.linearTicket;
  if (!ticket) return null;
  const labels = ticket.labels.map((label) => label.name).filter(Boolean);
  const relations = ticket.relatedIssues.slice(0, 4).map((relation) => ({
    detail: `${relationLabel(relation.relationType)} ${relation.issue.stateName || 'unknown'} / ${truncate(relation.issue.title, 90)}`,
    href: relation.issue.url,
    label: relation.issue.ticketId,
  }));
  const items: Array<SourceDossierItem> = [
    {
      detail: [
        ticket.projectName ? `Project ${ticket.projectName}` : '',
        ticket.cycleName ? `Cycle ${ticket.cycleName}` : '',
        ticket.priority ? `P${ticket.priority}` : '',
      ].filter(Boolean).join(' / ') || 'No project, cycle, or priority metadata.',
      href: ticket.projectUrl,
      label: 'Planning lane',
    },
    {
      detail: [
        ticket.stateName,
        ticket.assignee ? `Owner ${ticket.assignee}` : '',
        ticket.dueDate ? `Due ${ticket.dueDate}` : '',
      ].filter(Boolean).join(' / '),
      href: ticket.url,
      label: ticket.ticketId,
    },
    labels.length
      ? {
          detail: labels.slice(0, 6).join(', '),
          label: 'Labels',
        }
      : null,
    ticket.parent
      ? {
          detail: `${ticket.parent.stateName || 'unknown'} / ${truncate(ticket.parent.title, 90)}`,
          href: ticket.parent.url,
          label: `Parent ${ticket.parent.ticketId}`,
        }
      : null,
    ...relations,
    ticket.children.length
      ? {
          detail: ticket.children
            .slice(0, 4)
            .map((child) => `${child.ticketId} ${child.stateName || ''}`.trim())
            .join(', '),
          label: 'Children',
        }
      : null,
  ].filter((item): item is SourceDossierItem => Boolean(item?.detail));
  return { id: 'linear', items, title: 'Linear' };
}

function sourceDossierDocsSection(workflow: WorkflowItem): SourceDossierSection | null {
  const ticket = workflow.linearTicket;
  if (!ticket) return null;
  const comments = [...ticket.comments]
    .sort((left, right) => timestampMs(right.createdAt) - timestampMs(left.createdAt))
    .slice(0, 2)
    .map((comment) => ({
      detail: truncate(stripBasicMarkdown(comment.body), 120) || 'Empty comment',
      href: comment.url,
      label: `Comment ${comment.author}`,
    }));
  const items: Array<SourceDossierItem> = [
    ...ticket.attachments.slice(0, 4).map((attachment) => ({
      detail: attachment.subtitle || formatRelativeTime(attachment.createdAt),
      href: attachment.url,
      label: attachment.title || 'Attachment',
    })),
    ...comments,
    ...ticket.activity.slice(0, 2).map((activity) => ({
      detail: activity.summary,
      href: null,
      label: `Activity ${activity.actor}`,
    })),
  ].filter((item) => item.detail || item.href);
  return { id: 'docs', items, title: 'Docs and notes' };
}

function sourceDossierPrSection(workflow: WorkflowItem): SourceDossierSection | null {
  const items: Array<SourceDossierItem> = workflow.prs.slice(0, 3).map((pr) => {
    const zones = changedPathZones(pr.files.map((file) => file.path)).slice(0, 4);
    return {
      detail: [
        plainCheckState(pr),
        formatReviewState(pr),
        zones.length ? `Touches ${zones.join(', ')}` : '',
      ].filter(Boolean).join(' / '),
      href: pr.url,
      label: `PR #${pr.number}`,
    };
  });
  return { id: 'prs', items, title: 'PRs' };
}

function sourceDossierLocalSection(workflow: WorkflowItem): SourceDossierSection | null {
  const items: Array<SourceDossierItem> = [
    ...workflow.sessions.slice(0, 3).map((session) => ({
      detail: `${formatSessionStatus(session)} / ${shortPath(session.cwd)} / ${formatNumber(session.tokensUsed)} tokens`,
      label: `Codex ${session.threadId.slice(0, 8)}`,
    })),
    ...workflow.worktrees.slice(0, 3).map((worktree) => ({
      detail: `${worktree.branch ?? worktree.head ?? 'No branch'} / ${worktree.dirtyCount ?? 0} dirty files`,
      label: shortPath(worktree.path),
    })),
    ...workflow.windows.slice(0, 3).map((window) => ({
      detail: `${window.command || 'terminal'} / ${shortPath(window.path)}`,
      label: `${window.session}:${window.index}`,
    })),
  ];
  return { id: 'local', items, title: 'Local lane' };
}

function sourceDossierSummary(sections: Array<SourceDossierSection>) {
  const itemCount = sections.reduce((total, section) => total + section.items.length, 0);
  return `${moveCount(sections.length, 'source')} / ${moveCount(itemCount, 'item')}`;
}

function sourceDossierDisplayText(value: string) {
  return value
    .replace(/\b[A-Z][A-Z0-9]+-\d+\b/gu, 'source issue')
    .replace(/\bPR\s*#\d+\b/giu, 'pull request');
}

function sourceDossierPacketLines(workflow: WorkflowItem) {
  const sections = sourceDossierSections(workflow);
  if (!sections.length) return ['- No source dossier is linked to this workflow.'];
  return sections.flatMap((section) => [
    `- ${section.title}`,
    ...section.items.map((item) =>
      `  - ${item.label}: ${item.detail}${item.href ? ` (${item.href})` : ''}`,
    ),
  ]);
}

function sourceDossierPromptLines(workflow: WorkflowItem) {
  return sourceDossierPacketLines(workflow).slice(0, 14);
}

function laneContractSections(workflow: WorkflowItem): Array<LaneContractSection> {
  return [
    {
      id: 'preflight',
      items: lanePreflightSteps(workflow),
      title: 'Preflight',
    },
    {
      id: 'finish',
      items: laneFinishSteps(workflow),
      title: 'Finish proof',
    },
    {
      id: 'after',
      items: laneAfterSteps(workflow),
      title: 'After handoff',
    },
  ];
}

function lanePreflightSteps(workflow: WorkflowItem): Array<LaneContractStep> {
  const primaryPr = workflow.prs[0] ?? null;
  const primarySession = workflow.sessions[0] ?? null;
  const primaryWorktree = workflow.worktrees[0] ?? null;
  const steps: Array<LaneContractStep> = [];

  if (workflow.linearTicket || workflow.ticket) {
    steps.push({
      detail: workflow.linearTicket
        ? `Confirm source issue is still ${workflow.linearTicket.stateName}.`
        : `Confirm source issue is still ${workflow.ticket?.state}.`,
      label: 'Confirm source state',
    });
  }
  if (primaryPr) {
    steps.push({
      detail: `${plainCheckState(primaryPr)} ${formatReviewState(primaryPr)}.`,
      label: 'Confirm review gate',
    });
  }
  if (primaryWorktree) {
    steps.push({
      detail: `${shortPath(primaryWorktree.path)} has ${primaryWorktree.dirtyCount ?? 0} dirty files.`,
      label: 'Inspect local changes',
    });
  } else if (primarySession) {
    steps.push({
      detail: `${formatSessionStatus(primarySession)} in ${shortPath(primarySession.cwd)}.`,
      label: 'Resume existing context',
    });
  }
  if (!steps.length) {
    steps.push({
      detail: 'No source objects need extra preflight before this handoff.',
      label: 'Ready to start',
    });
  }
  return steps.slice(0, 4);
}

function laneFinishSteps(workflow: WorkflowItem): Array<LaneContractStep> {
  const steps: Array<LaneContractStep> = [
    {
      detail: finishLineForWorkflow(workflow),
      label: 'Done means',
    },
  ];
  const primaryPr = workflow.prs[0] ?? null;
  if (workflow.intent === 'fix-ci' && primaryPr) {
    steps.push({
      detail: 'All checks are passing and no new failure is visible.',
      label: 'Checks proof',
    });
  } else if (workflow.intent === 'review') {
    steps.push({
      detail: 'Requested changes or review comments are answered with a concise note.',
      label: 'Review proof',
    });
  } else if (workflow.intent === 'ship') {
    steps.push({
      detail: 'The change is merged or explicitly handed off, then local residue is cleaned.',
      label: 'Ship proof',
    });
  } else if (workflow.intent === 'start' || workflow.intent === 'resume') {
    steps.push({
      detail: 'Leave a push, PR, validation result, or exact blocker for the next pass.',
      label: 'Implementation proof',
    });
  } else if (workflow.intent === 'clean') {
    steps.push({
      detail: 'No stale terminal, worktree, or source issue remains in the active queue.',
      label: 'Cleanup proof',
    });
  }
  return steps.slice(0, 3);
}

function laneAfterSteps(workflow: WorkflowItem): Array<LaneContractStep> {
  const steps: Array<LaneContractStep> = [
    {
      detail: 'Refresh Ticketboard so lane load, safe batch, and wave order use fresh evidence.',
      label: 'Refresh board',
    },
    {
      detail: 'Leave the exact validation command, result, and next handoff state.',
      label: 'Record handoff',
    },
  ];
  if (workflow.intent === 'ship' || workflow.intent === 'clean') {
    steps.push({
      detail: 'Clear leftover worktrees or tmux lanes after preserving useful context.',
      label: 'Clear residue',
    });
  } else {
    steps.push({
      detail: 'Regenerate the Codex brief if source, checks, reviews, or planning docs changed.',
      label: 'Regenerate plan',
    });
  }
  return steps;
}

function laneContractSummary(sections: Array<LaneContractSection>) {
  const stepCount = sections.reduce((total, section) => total + section.items.length, 0);
  return `${moveCount(stepCount, 'step')} / preflight to handoff`;
}

function laneContractPacketLines(workflow: WorkflowItem) {
  return laneContractSections(workflow).flatMap((section) => [
    `- ${section.title}`,
    ...section.items.map((item) => `  - ${item.label}: ${item.detail}`),
  ]);
}

function laneContractPromptLines(workflow: WorkflowItem) {
  return laneContractPacketLines(workflow).slice(0, 12);
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
    '## Source dossier',
    ...sourceDossierPacketLines(workflow),
    '',
    '## Lane contract',
    ...laneContractPacketLines(workflow),
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

function buildLivePlanPacket({
  completionForecast,
  dashboard,
  handoffs,
  laneMatrix,
  laneLoad,
  parallelBatch,
  parallelPlan,
  parallelRuns,
  parallelWaves,
  plan,
  projectPulse,
  projectRunway,
  unlockMap,
  workflowBriefStatus,
  workflows,
}: {
  completionForecast: CompletionForecast;
  dashboard: DashboardData;
  handoffs: Array<HandoffEvent>;
  laneMatrix: LaneMatrix;
  laneLoad: LaneLoad;
  parallelBatch: ParallelBatch | null;
  parallelPlan: ParallelPlan | null;
  parallelRuns: Array<ParallelRunGroup>;
  parallelWaves: ParallelWavePlan | null;
  plan: ProjectPlan;
  projectPulse: ProjectPulse;
  projectRunway: ProjectRunway;
  unlockMap: UnlockMap;
  workflowBriefStatus: WorkflowBriefResponse | null;
  workflows: Array<WorkflowItem>;
}) {
  const workflowById = new Map(workflows.map((workflow) => [workflow.id, workflow]));
  const readiness = workflowBriefStatus?.parallelReadiness ?? null;

  return [
    '# Ticketboard live plan packet',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Repo: ${dashboard.repo.nameWithOwner} (${dashboard.repo.path})`,
    `Summary: ${plan.summary}`,
    '',
    '## Live plan',
    ...plan.sections.flatMap(planSectionPacketLines),
    '',
    '## Project pulse',
    ...(projectPulse.items.length
      ? projectPulse.items.map(
          (item) => `- ${item.title}: ${item.detail} (${item.meta})`,
        )
      : ['- No Linear project grouping is visible.']),
    '',
    '## Project runway',
    ...(projectRunway.items.length
      ? projectRunway.items.flatMap(projectRunwayPacketLines)
      : ['- No project runway is visible.']),
    '',
    '## Lane load',
    `- ${laneLoad.summary}; ${laneLoad.runningCount} Codex; ${laneLoad.dirtyCount} dirty; capacity ${laneLoad.recommendedActive}/${laneLoad.maxActive} (${laneLoad.capacityLabel})`,
    ...(laneLoad.items.length
      ? laneLoad.items.map((item) => `- ${item.title}: ${item.detail} (${item.meta})`)
      : ['- No active local lanes are visible.']),
    '',
    '## Lane matrix',
    ...(laneMatrix.items.length
      ? [
          `- ${moveCount(laneMatrix.readyCount, 'pair')} can run together; ${moveCount(laneMatrix.waitingCount, 'pair')} guarded; ${moveCount(laneMatrix.blockedCount, 'pair')} serialized`,
          ...laneMatrix.items.map(
            (item) => `- ${item.title}: ${item.detail} (${item.meta})`,
          ),
        ]
      : ['- Need at least two actionable lanes to compare.']),
    '',
    '## Parallel waves',
    ...(parallelWaves?.items.length
      ? [
          `- ${parallelWaves.summary}`,
          ...parallelWaves.items.flatMap((wave) => [
            `- ${wave.title}: ${wave.detail}`,
            ...wave.lanes.map(
              (lane) =>
                `  - ${batchDecisionLabel(lane)}: ${lane.label} - ${lane.reason}`,
            ),
          ]),
        ]
      : ['- No parallel wave order is visible.']),
    '',
    '## Automation readiness',
    ...parallelReadinessPacketLines(readiness, workflowById),
    '',
    '## Unlock map',
    ...(unlockMap.items.length
      ? unlockMap.items.map((item) => `- ${item.title}: ${item.detail} (${item.meta})`)
      : ['- No explicit dependency blockers or PR gates are visible.']),
    '',
    '## After focus clears',
    ...(completionForecast.items.length
      ? completionForecast.items.map(
          (item) => `- ${item.title}: ${item.detail} (${item.meta})`,
        )
      : ['- No follow-up is visible for the selected workflow.']),
    '',
    '## Parallel lanes',
    ...(parallelPlan
      ? [
          `- ${parallelPlan.summary}`,
          `- Capacity: ${moveCount(parallelPlan.recommendedActive, 'active lane')} planned; ${moveCount(parallelPlan.maxActive, 'lane')} max`,
          ...(parallelBatch
            ? [
                `- Safe batch: ${parallelBatch.title}`,
                `- Batch detail: ${parallelBatch.detail}`,
                ...parallelBatch.decisions.map(
                  (decision) =>
                    `- ${batchDecisionLabel(decision)}: ${decision.label} - ${decision.reason}`,
                ),
              ]
            : []),
        ]
      : ['- No parallel lane plan is visible.']),
    '',
    '## Parallel run memory',
    ...(parallelRuns.length
      ? parallelRuns.map(
          (group) =>
            `- ${sourceDossierDisplayText(group.title)}: ${group.summary}; ${formatRelativeTime(group.ranAt)}`,
        )
      : ['- No grouped parallel runs are recorded.']),
    '',
    '## Recent handoffs',
    ...(handoffs.length
      ? handoffs
          .slice(0, 5)
          .map((handoff) => {
            const outcome = handoffOutcome(workflowById.get(handoff.workflowId) ?? null);
            return `- ${outcome.label}: ${handoffKindLabel(handoff.kind)} ${formatRelativeTime(handoff.ranAt)} - ${handoff.title}; ${outcome.detail}`;
          })
      : ['- No recent local handoff events are recorded.']),
    '',
    '## Guardrails',
    '- Keep exactly one focus lane responsible for merge, ship, or scope changes.',
    '- Start or resume parallel lanes only when the safe-batch decision says they are ready.',
    '- Treat capacity, dirty worktrees, and active Codex sessions as real lane load.',
    '- After each PR merge, push, blocker, cleanup, or Codex handoff, refresh Ticketboard and regenerate this packet.',
  ].join('\n');
}

function parallelReadinessPacketLines(
  readiness: ParallelReadiness | null,
  workflowById: Map<string, WorkflowItem>,
) {
  if (!readiness) {
    return ['- No backend parallel-readiness evidence is attached to this brief status.'];
  }

  const laneLoad = readiness.laneLoad;
  const guardedPairs = readiness.pairwise
    .filter((pair) => pair.status !== 'safe')
    .slice(0, 8);
  const candidates = readiness.candidates.slice(0, 8);
  const waves = readiness.suggestedWaves.slice(0, 2);

  return [
    `- ${readiness.summary}`,
    `- Lane load: ${moveCount(laneLoad.activeCount, 'active lane')}; ${moveCount(laneLoad.openSlots, 'open slot')}; capacity ${laneLoad.recommendedActiveLanes}/${laneLoad.maxActiveLanes}`,
    ...(waves.length
      ? waves.flatMap((wave) => [
          `- ${wave.title}: ${wave.reason}`,
          ...(wave.workflowIds.length
            ? [`  - ${wave.workflowIds.map((id) => packetWorkflowLabel(id, workflowById)).join(', ')}`]
            : []),
        ])
      : ['- No suggested backend wave is visible.']),
    ...(readiness.blockerEdges.length
      ? readiness.blockerEdges.slice(0, 6).map(
          (edge) =>
            `- Blocker: ${edge.blockerId} blocks ${edge.blockedId}${edge.blockedTitle ? ` (${edge.blockedTitle})` : ''}`,
        )
      : ['- No Linear blocker edges are visible.']),
    ...(guardedPairs.length
      ? guardedPairs.map(
          (pair) =>
            `- ${readableTitle(pair.status)} pair: ${packetWorkflowLabel(pair.leftWorkflowId, workflowById)} + ${packetWorkflowLabel(pair.rightWorkflowId, workflowById)} - ${pair.reason}`,
        )
      : ['- No guarded pairwise conflicts are visible.']),
    ...(candidates.length
      ? candidates.map((candidate) =>
          [
            `- Candidate: ${packetWorkflowLabel(candidate.workflowId, workflowById)}`,
            candidate.status ? `status ${candidate.status}` : '',
            candidate.projectName ? `project ${candidate.projectName}` : '',
            candidate.changedZones.length ? `zones ${candidate.changedZones.slice(0, 3).join(', ')}` : '',
            candidate.blockedBy.length ? `blocked by ${candidate.blockedBy.map((edge) => edge.blockerId).join(', ')}` : '',
          ]
            .filter(Boolean)
            .join('; '),
        )
      : ['- No backend parallel candidates are visible.']),
  ];
}

function packetWorkflowLabel(
  workflowId: string,
  workflowById: Map<string, WorkflowItem>,
) {
  const workflow = workflowById.get(workflowId);
  if (!workflow) return workflowId;
  const ticketId = workflow.ticket?.ticketId ?? workflow.linearTicket?.ticketId;
  return ticketId ? `${ticketId}: ${workflow.title}` : workflow.title;
}

function planSectionPacketLines(section: ProjectPlanSection) {
  if (!section.items.length) return [`### ${section.title}`, `- ${section.empty}`];
  return [
    `### ${section.title}`,
    ...section.items.map(
      (item, index) =>
        `${index + 1}. ${item.label}: ${item.detail}${item.meta ? ` (${item.meta})` : ''}`,
    ),
  ];
}

function projectRunwayPacketLines(item: ProjectRunwayItem) {
  const stageLines = PROJECT_RUNWAY_STAGES.flatMap((stage) => {
    const entries = item[stage.id];
    return entries.length
      ? entries.map(
          (entry) =>
            `  - ${stage.label}: ${entry.title} - ${entry.detail} (${entry.meta})`,
        )
      : [`  - ${stage.label}: clear`];
  });
  return [`- ${item.title}: ${item.summary}`, ...stageLines];
}

function buildParallelBatchPacket({
  batch,
  dashboard,
  plan,
  workflows,
}: {
  batch: ParallelBatch;
  dashboard: DashboardData;
  plan: ParallelPlan;
  workflows: Array<WorkflowItem>;
}) {
  const laneById = new Map(plan.lanes.map((lane) => [lane.id, lane]));
  const workflowById = new Map(workflows.map((workflow) => [workflow.id, workflow]));
  const activeLanes = batch.lanes
    .map((lane) => laneById.get(lane.id))
    .filter((lane): lane is ParallelLane => Boolean(lane));

  return [
    '# Ticketboard safe batch packet',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Repo: ${dashboard.repo.nameWithOwner} (${dashboard.repo.path})`,
    `Plan source: ${plan.source}`,
    `Capacity: ${moveCount(plan.recommendedActive, 'active lane')} planned; ${moveCount(plan.maxActive, 'lane')} max`,
    `Batch: ${batch.title}`,
    `Why: ${batch.detail}`,
    '',
    '## Run now',
    ...(activeLanes.length
      ? activeLanes.flatMap((lane, index) =>
          parallelBatchLanePacket({
            index,
            lane,
            workflow: lane.workflowId ? workflowById.get(lane.workflowId) ?? null : null,
          }),
        )
      : ['- No runnable lane is selected right now.']),
    '',
    '## Decision trail',
    ...batch.decisions.map(
      (decision) =>
        `- ${batchDecisionLabel(decision)}: ${decision.label} - ${decision.reason}`,
    ),
    '',
    '## Guardrails',
    '- Keep the focus lane as the only lane allowed to merge, ship, or redefine scope.',
    '- Start only lanes marked Ready now unless fresh evidence changes the batch.',
    '- Do not touch another active lane unless the linked ticket, PR, or failing check requires it.',
    '- Stop each lane at its finish condition and leave a concrete validation/handoff note.',
    '- Refresh Ticketboard after a lane starts, resumes, ships, blocks, or produces new PR/check evidence.',
  ].join('\n');
}

function parallelBatchLanePacket({
  index,
  lane,
  workflow,
}: {
  index: number;
  lane: ParallelLane;
  workflow: WorkflowItem | null;
}) {
  const handoff = workflow ? buildWorkflowHandoff(workflow) : null;
  return [
    `### ${index + 1}. ${batchLaneLabel(lane)}`,
    `Role: ${laneRoleLabel(lane.role)}`,
    `Action: ${lane.action}`,
    `Why: ${lane.detail}`,
    `Automation: ${lane.automation}`,
    `Safety: ${lane.safety.label} - ${lane.safety.detail}`,
    `Finish: ${workflow ? finishLineForWorkflow(workflow) : lane.status}`,
    workflow ? `Workflow: ${workflow.title}` : '',
    workflow ? `Next move: ${workflow.nextStep}` : '',
    handoff ? `Then: ${handoff.next}` : '',
    workflow?.linearTicket ? `Linear: ${workflow.linearTicket.url}` : '',
    ...(workflow?.prs.map((pr) => `PR #${pr.number}: ${pr.url}`) ?? []),
    workflow ? 'Source dossier:' : '',
    ...(workflow ? sourceDossierPacketLines(workflow).slice(0, 10) : []),
    workflow ? 'Lane contract:' : '',
    ...(workflow ? laneContractPacketLines(workflow).slice(0, 10) : []),
    lane.evidence.length ? 'Evidence:' : '',
    ...lane.evidence.map((line) => `- ${line}`),
    '',
  ].filter((line) => line !== '');
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
    '- Follow the lane contract before starting and before handing off.',
    '',
    'Source context:',
    ...workflow.evidence.map((line) => `- ${line}`),
    ...workflow.signals.slice(0, 3).map((line) => `- Latest: ${line}`),
    '',
    'Source dossier:',
    ...sourceDossierPromptLines(workflow),
    '',
    'Lane contract:',
    ...laneContractPromptLines(workflow),
  ].join('\n');
}

function buildLaneCodexPrompt(lane: ParallelLane, workflow: WorkflowItem) {
  const basePrompt = buildCodexPrompt(workflow);
  return [
    `Use this Ticketboard ${laneRoleLabel(lane.role).toLowerCase()} lane packet for ${workflow.title}.`,
    `Lane role: ${laneRoleLabel(lane.role)}`,
    `Lane action: ${lane.action}`,
    `Lane reason: ${lane.detail || workflow.reason}`,
    `Parallel safety: ${lane.safety.label} - ${lane.safety.detail}`,
    `Automation mode: ${lane.automation}`,
    '',
    'Lane rules:',
    '- Stay inside this lane unless live evidence proves it is obsolete.',
    '- Do not modify another active lane unless the ticket or PR explicitly requires it.',
    '- End with the validation run, merge/readiness state, and the next handoff.',
    '',
    'Lane evidence:',
    ...lane.evidence.map((line) => `- ${line}`),
    '',
    basePrompt,
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

  if (workflow.intent === 'clean' && primaryWorktree) {
    return {
      label: 'Open cleanup',
      request: {
        kind: 'open-worktree',
        path: primaryWorktree.path,
        workflowId: workflow.id,
      },
      runningLabel: 'Opening cleanup',
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

function buildCleanupCompleteAction(workflow: WorkflowItem): PlannedWorkflowAction | null {
  if (workflow.intent !== 'clean') return null;
  const primaryPr = workflow.prs[0] ?? null;
  const primarySession = workflow.sessions[0] ?? null;
  const primaryWorktree = workflow.worktrees[0] ?? null;
  const window = workflow.windows[0] ?? null;
  const ticketId = workflow.ticket?.ticketId ?? workflow.linearTicket?.ticketId;
  return {
    advanceOnSuccess: true,
    label: 'Mark handled',
    request: {
      index: window?.index,
      kind: 'complete-cleanup',
      path: primaryWorktree?.path ?? primarySession?.cwd,
      prNumber: primaryPr?.number,
      session: window?.session,
      threadId: primarySession?.threadId,
      ticketId,
      title: workflow.title,
      workflowId: workflow.id,
    },
    runningLabel: 'Marking handled',
  };
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
  return slugify(workflow.title).slice(0, 32);
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'unknown';
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
    if (!raw) return emptyLocalState();
    return normalizeLocalState(JSON.parse(raw));
  } catch {
    return emptyLocalState();
  }
}

function emptyLocalState(): LocalState {
  return { dismissed: {}, handoffs: [] };
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
    ...state,
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
  if (!value || typeof value !== 'object') return emptyLocalState();
  const data = value as {
    dismissed?: Record<string, DismissedWorkflow>;
    handoffs?: Array<HandoffEvent>;
    skipped?: Record<string, string>;
  };
  const handoffs = Array.isArray(data.handoffs)
    ? normalizeHandoffEvents(data.handoffs)
    : [];
  if (data.dismissed && typeof data.dismissed === 'object') {
    return { dismissed: normalizeDismissedMap(data.dismissed), handoffs };
  }
  if (data.skipped && typeof data.skipped === 'object') {
    return { dismissed: skippedMapToDismissed(data.skipped), handoffs };
  }
  return { dismissed: {}, handoffs };
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

function normalizeHandoffEvents(value: Array<HandoffEvent>) {
  return value
    .filter((event) =>
      Boolean(event) &&
      typeof event === 'object' &&
      typeof event.id === 'string' &&
      typeof event.workflowId === 'string' &&
      typeof event.message === 'string' &&
      typeof event.ranAt === 'string',
    )
    .map((event) => ({
      batchId: typeof event.batchId === 'string' ? event.batchId : null,
      batchTitle: typeof event.batchTitle === 'string' ? event.batchTitle : null,
      command: typeof event.command === 'string' ? event.command : '',
      id: event.id,
      kind: typeof event.kind === 'string' ? event.kind : '',
      message: event.message,
      prNumber: typeof event.prNumber === 'number' ? event.prNumber : null,
      ranAt: event.ranAt,
      ticketId: typeof event.ticketId === 'string' ? event.ticketId : null,
      title: typeof event.title === 'string' ? event.title : event.workflowId,
      workflowId: event.workflowId,
    }))
    .slice(0, 30);
}

function mergeHandoffEvents(
  left: Array<HandoffEvent>,
  right: Array<HandoffEvent>,
) {
  const events = new Map<string, HandoffEvent>();
  for (const event of [...right, ...left]) {
    events.set(event.id, event);
  }
  return [...events.values()]
    .sort((leftEvent, rightEvent) => timestampMs(rightEvent.ranAt) - timestampMs(leftEvent.ranAt))
    .slice(0, 30);
}

function mergeLocalState(left: LocalState, right: LocalState): LocalState {
  return {
    dismissed: {
      ...left.dismissed,
      ...right.dismissed,
    },
    handoffs: mergeHandoffEvents(left.handoffs, right.handoffs),
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

function formatDurationSeconds(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return 'unknown';
  }
  const seconds = Math.max(0, Math.round(value));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

function shortFingerprint(value: string | null | undefined) {
  if (!value) return 'no fingerprint';
  return value.slice(0, 8);
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
