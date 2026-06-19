export type PrCheckSummary = {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  state: 'green' | 'red' | 'pending' | 'unknown';
};

export type PrCheckRunSummary = {
  name: string;
  workflowName: string | null;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  url: string | null;
};

export type PrCheckLogSummary = {
  prNumber: number;
  checkKey: string;
  checkName: string;
  workflowName: string | null;
  url: string | null;
  command: string;
  log: string;
  truncated: boolean;
};

export type PrReviewCommentSummary = {
  id: number;
  author: string;
  body: string;
  path: string;
  line: number | null;
  originalLine: number | null;
  side: string | null;
  createdAt: string;
  updatedAt: string;
  url: string;
};

export type PrLabelSummary = {
  name: string;
  color: string | null;
  description: string | null;
};

export type PrActorSummary = {
  login: string;
  name: string | null;
  url: string | null;
};

export type PrReviewRequestSummary = {
  name: string;
  kind: string;
  url: string | null;
};

export type PrMilestoneSummary = {
  title: string;
  dueOn: string | null;
  state: string | null;
  url: string | null;
};

export type PrLatestReviewSummary = {
  author: string;
  state: string;
  submittedAt: string;
  body: string;
};

export type PrCommitSummary = {
  oid: string;
  shortOid: string;
  headline: string;
  bodyPreview: string;
  author: string;
  authoredAt: string;
  committedAt: string;
  url: string;
};

export type PullRequestSummary = {
  detailLevel?: 'full' | 'summary';
  number: number;
  title: string;
  url: string;
  bodyPreview: string;
  headRefName: string;
  baseRefName: string;
  author: string;
  isDraft: boolean;
  mergeStateStatus: string;
  reviewDecision: string | null;
  updatedAt: string;
  additions: number;
  deletions: number;
  ticketIds: Array<string>;
  checkSummary: PrCheckSummary;
  commentCount: number;
  reviewCount: number;
  latestComments: Array<PrCommentSummary>;
  reviewComments: Array<PrReviewCommentSummary>;
  labels: Array<PrLabelSummary>;
  assignees: Array<PrActorSummary>;
  reviewRequests: Array<PrReviewRequestSummary>;
  milestone: PrMilestoneSummary | null;
  latestReviews: Array<PrLatestReviewSummary>;
  commits: Array<PrCommitSummary>;
  files: Array<PrFileSummary>;
  checks: Array<PrCheckRunSummary>;
};

export type PrCommentSummary = {
  author: string;
  authorAssociation?: string;
  body: string;
  createdAt?: string;
  url?: string;
  kind: 'comment' | 'review';
};

export type PrFileSummary = {
  path: string;
  additions: number;
  deletions: number;
  changeType: string;
};

export type PrDiffLine = {
  kind: 'add' | 'context' | 'meta' | 'remove';
  content: string;
  oldLine: number | null;
  newLine: number | null;
};

export type PrDiffHunk = {
  header: string;
  lines: Array<PrDiffLine>;
};

export type PrDiffFileSummary = PrFileSummary & {
  oldPath: string | null;
  hunks: Array<PrDiffHunk>;
};

export type PrDiffSummary = {
  number: number;
  files: Array<PrDiffFileSummary>;
  totalLines: number;
  truncated: boolean;
};

export type LinearCommentSummary = {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  url: string | null;
};

export type LinearLabelSummary = {
  name: string;
  color: string | null;
};

export type LinearActorSummary = {
  id: string | null;
  name: string;
  displayName: string | null;
  email: string | null;
};

export type LinearAttachmentSummary = {
  id: string;
  title: string;
  subtitle: string | null;
  url: string;
  createdAt: string;
};

export type LinearActivitySummary = {
  id: string;
  actor: string;
  createdAt: string;
  summary: string;
};

export type LinearLinkedIssueSummary = {
  ticketId: string;
  title: string;
  url: string;
  stateName: string;
  stateType: string;
};

export type LinearIssueRelationSummary = {
  relationType: string;
  issue: LinearLinkedIssueSummary;
};

export type LinearTicketSummary = {
  detailLevel?: 'full' | 'summary';
  ticketId: string;
  title: string;
  description: string;
  url: string;
  stateName: string;
  stateType: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  dueDate: string | null;
  branchName: string | null;
  creator: LinearActorSummary | null;
  priority: number | null;
  assignee: string | null;
  assigneeId?: string | null;
  assigneeEmail?: string | null;
  assigneeName?: string | null;
  teamName: string | null;
  projectName: string | null;
  projectUrl: string | null;
  cycleName: string | null;
  labels: Array<LinearLabelSummary>;
  parent: LinearLinkedIssueSummary | null;
  children: Array<LinearLinkedIssueSummary>;
  relatedIssues: Array<LinearIssueRelationSummary>;
  updatedAt: string;
  comments: Array<LinearCommentSummary>;
  attachments: Array<LinearAttachmentSummary>;
  activity: Array<LinearActivitySummary>;
};

export type TmuxWindowSummary = {
  session: string;
  index: number;
  name: string;
  paneId: string;
  path: string;
  command: string;
  active: boolean;
  panePid: number | null;
  ticketIds: Array<string>;
  isCodexLike: boolean;
  panePreview: string;
  panePreviewTruncated: boolean;
};

export type WorktreeSummary = {
  path: string;
  branch: string | null;
  head: string | null;
  prunable: boolean;
  exists: boolean;
  dirtyCount: number | null;
  statusLines: Array<string>;
  ticketIds: Array<string>;
};

export type WorktreeDetailSummary = WorktreeSummary & {
  stagedStat: string;
  unstagedStat: string;
  stagedDiff: string;
  unstagedDiff: string;
  untrackedFiles: Array<string>;
  truncated: boolean;
};

export type CodexSessionStatus = 'goal-active' | 'idle' | 'running' | 'unknown';

export type CodexToolCallSummary = {
  callId: string;
  name: string;
  status: 'started' | 'completed';
  argumentsPreview: string;
  outputPreview: string;
  arguments?: string;
  argumentsTruncated?: boolean;
  output?: string;
  outputTruncated?: boolean;
  timestamp: string;
};

export type CodexMessageSummary = {
  role: 'assistant' | 'developer' | 'system' | 'user' | 'unknown';
  text: string;
  timestamp: string;
};

export type CodexTimelineEventKind =
  | 'message'
  | 'system'
  | 'tool_call'
  | 'tool_output';

export type CodexTimelineEvent = {
  id: string;
  kind: CodexTimelineEventKind;
  timestamp: string;
  title: string;
  detail: string;
  status?: 'completed' | 'started';
};

export type CodexSessionDetail = {
  threadId: string;
  title: string;
  rolloutPath: string;
  events: Array<CodexTimelineEvent>;
  toolCalls: Array<CodexToolCallSummary>;
  messages: Array<CodexMessageSummary>;
  totalParsedEvents: number;
  truncated: boolean;
  summary?: CodexSessionSummary;
};

export type CodexSessionSummary = {
  threadId: string;
  title: string;
  preview: string;
  firstUserMessage?: string;
  cwd: string;
  gitBranch: string | null;
  gitSha?: string | null;
  rolloutPath?: string;
  model: string | null;
  modelProvider: string;
  reasoningEffort: string | null;
  tokensUsed: number;
  createdAt?: string;
  updatedAt: string;
  goalObjective: string | null;
  goalStatus: string | null;
  goalTokensUsed: number | null;
  goalTokenBudget: number | null;
  ticketIds: Array<string>;
  status: CodexSessionStatus;
  recentToolCalls: Array<CodexToolCallSummary>;
  latestMessages: Array<CodexMessageSummary>;
};

export type TokenUsageSummary = {
  totalTokens: number;
  sessionCount: number;
  sessionsWithUsage: number;
  range: 'all' | 'week' | 'today';
  ranges: Record<
    'all' | 'week' | 'today',
    {
      totalTokens: number;
      label: string;
      periodStart: string | null;
      trend: Array<{
        timestamp: string;
        label: string;
        totalTokens: number;
      }>;
      topSessions: Array<{
        threadId: string;
        title: string;
        cwd: string;
        model: string | null;
        tokens: number;
        updatedAt: string;
      }>;
    }
  >;
  updatedAt: string;
};

export type TicketRow = {
  ticketId: string;
  title: string | null;
  prNumbers: Array<number>;
  windows: Array<string>;
  worktrees: Array<string>;
  branches: Array<string>;
  state: 'active' | 'review' | 'green' | 'blocked' | 'quiet';
  nextAction: string;
  risk: 'low' | 'medium' | 'high';
};

export type DashboardData = {
  generatedAt: string;
  scope: {
    githubLogin: string | null;
    linearOwners: Array<string>;
  };
  repo: {
    path: string;
    nameWithOwner: string;
    url: string;
  };
  prs: Array<PullRequestSummary>;
  linearTickets: Array<LinearTicketSummary>;
  codexSessions: Array<CodexSessionSummary>;
  tmuxWindows: Array<TmuxWindowSummary>;
  worktrees: Array<WorktreeSummary>;
  tickets: Array<TicketRow>;
  diagnostics: Array<string>;
};

export type WorkflowBriefItem = {
  workflowId?: string;
  ticketId?: string;
  prNumber?: number;
  title: string;
  action: string;
  why: string;
  confidence: 'high' | 'medium' | 'low' | string;
  evidence?: Array<string>;
  commands?: Array<string>;
  finishedWhen?: string;
};

export type WorkflowBriefLane = WorkflowBriefItem & {
  laneId?: string;
  role?: 'cleanup' | 'focus' | 'parallel' | 'waiting' | 'watch' | string;
  automation?: string;
  parallelSafe?: boolean;
  blockedBy?: Array<string>;
  handoffWhen?: string;
  owner?: string;
  status?: string;
};

export type WorkflowBrief = {
  version: 1;
  generatedAt: string;
  source?: {
    dashboardGeneratedAt?: string;
    evidenceFingerprint?: string;
    evidenceSnapshotPath?: string;
    planDocPath?: string | null;
  };
  operatingMode?: {
    summary?: string;
    recommendedActiveLanes?: number;
    maxActiveLanes?: number;
    rationale?: string;
  };
  now: WorkflowBriefItem;
  lanes?: Array<WorkflowBriefLane>;
  next?: Array<WorkflowBriefItem>;
  blocked?: Array<WorkflowBriefItem>;
  staleSignals?: Array<WorkflowBriefItem>;
  notes?: Array<string>;
};

export type WorkflowBriefResponse = {
  status: 'invalid' | 'missing' | 'ready' | 'stale';
  brief: WorkflowBrief | null;
  path: string;
  reason: string | null;
  ageSeconds?: number | null;
};

export type WorkflowActionKind =
  | 'focus-tmux'
  | 'launch-codex'
  | 'open-pr'
  | 'open-url'
  | 'open-worktree'
  | 'resume-codex'
  | 'start-lane';

export type WorkflowActionRequest = {
  kind: WorkflowActionKind;
  workflowId: string;
  cwd?: string;
  dryRun?: boolean;
  branchName?: string | null;
  index?: number;
  path?: string;
  prNumber?: number;
  prompt?: string;
  session?: string;
  ticketTitle?: string | null;
  threadId?: string;
  ticketId?: string;
  title?: string;
  url?: string;
};

export type WorkflowActionResponse = {
  ok: boolean;
  dryRun: boolean;
  message: string;
  command: string;
  output: string;
  ranAt: string;
};
