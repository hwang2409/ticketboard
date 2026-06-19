from typing import Literal, NotRequired, TypedDict


class PrCheckSummary(TypedDict):
    total: int
    passed: int
    failed: int
    pending: int
    state: Literal["green", "red", "pending", "unknown"]


class PrCheckRunSummary(TypedDict):
    name: str
    workflowName: str | None
    status: str
    conclusion: str | None
    startedAt: str | None
    completedAt: str | None
    url: str | None


class PrCheckLogSummary(TypedDict):
    prNumber: int
    checkKey: str
    checkName: str
    workflowName: str | None
    url: str | None
    command: str
    log: str
    truncated: bool


class PrReviewCommentSummary(TypedDict):
    id: int
    author: str
    body: str
    path: str
    line: int | None
    originalLine: int | None
    side: str | None
    createdAt: str
    updatedAt: str
    url: str


class PrLabelSummary(TypedDict):
    name: str
    color: str | None
    description: str | None


class PrActorSummary(TypedDict):
    login: str
    name: str | None
    url: str | None


class PrReviewRequestSummary(TypedDict):
    name: str
    kind: str
    url: str | None


class PrMilestoneSummary(TypedDict):
    title: str
    dueOn: str | None
    state: str | None
    url: str | None


class PrLatestReviewSummary(TypedDict):
    author: str
    state: str
    submittedAt: str
    body: str


class PrCommitSummary(TypedDict):
    oid: str
    shortOid: str
    headline: str
    bodyPreview: str
    author: str
    authoredAt: str
    committedAt: str
    url: str


class PrCommentSummary(TypedDict):
    author: str
    body: str
    kind: Literal["comment", "review"]
    authorAssociation: NotRequired[str]
    createdAt: NotRequired[str]
    url: NotRequired[str]


class PrFileSummary(TypedDict):
    path: str
    additions: int
    deletions: int
    changeType: str


class PullRequestSummary(TypedDict):
    detailLevel: NotRequired[Literal["full", "summary"]]
    number: int
    title: str
    url: str
    bodyPreview: str
    headRefName: str
    baseRefName: str
    author: str
    isDraft: bool
    mergeStateStatus: str
    reviewDecision: str | None
    updatedAt: str
    additions: int
    deletions: int
    ticketIds: list[str]
    checkSummary: PrCheckSummary
    commentCount: int
    reviewCount: int
    latestComments: list[PrCommentSummary]
    reviewComments: list[PrReviewCommentSummary]
    labels: list[PrLabelSummary]
    assignees: list[PrActorSummary]
    reviewRequests: list[PrReviewRequestSummary]
    milestone: PrMilestoneSummary | None
    latestReviews: list[PrLatestReviewSummary]
    commits: list[PrCommitSummary]
    files: list[PrFileSummary]
    checks: list[PrCheckRunSummary]


class PrDiffLine(TypedDict):
    kind: Literal["add", "context", "meta", "remove"]
    content: str
    oldLine: int | None
    newLine: int | None


class PrDiffHunk(TypedDict):
    header: str
    lines: list[PrDiffLine]


class PrDiffFileSummary(PrFileSummary):
    oldPath: str | None
    hunks: list[PrDiffHunk]


class PrDiffSummary(TypedDict):
    number: int
    files: list[PrDiffFileSummary]
    totalLines: int
    truncated: bool


class LinearCommentSummary(TypedDict):
    id: str
    author: str
    body: str
    createdAt: str
    url: str | None


class LinearLabelSummary(TypedDict):
    name: str
    color: str | None


class LinearActorSummary(TypedDict):
    id: str | None
    name: str
    displayName: str | None
    email: str | None


class LinearAttachmentSummary(TypedDict):
    id: str
    title: str
    subtitle: str | None
    url: str
    createdAt: str


class LinearActivitySummary(TypedDict):
    id: str
    actor: str
    createdAt: str
    summary: str


class LinearLinkedIssueSummary(TypedDict):
    ticketId: str
    title: str
    url: str
    stateName: str
    stateType: str


class LinearIssueRelationSummary(TypedDict):
    relationType: str
    issue: LinearLinkedIssueSummary


class LinearTicketSummary(TypedDict):
    detailLevel: NotRequired[Literal["full", "summary"]]
    ticketId: str
    title: str
    description: str
    url: str
    stateName: str
    stateType: str
    createdAt: str
    startedAt: str | None
    completedAt: str | None
    dueDate: str | None
    branchName: str | None
    creator: LinearActorSummary | None
    priority: int | None
    assignee: str | None
    assigneeId: NotRequired[str | None]
    assigneeEmail: NotRequired[str | None]
    assigneeName: NotRequired[str | None]
    teamName: str | None
    projectName: str | None
    projectUrl: str | None
    cycleName: str | None
    labels: list[LinearLabelSummary]
    parent: LinearLinkedIssueSummary | None
    children: list[LinearLinkedIssueSummary]
    relatedIssues: list[LinearIssueRelationSummary]
    updatedAt: str
    comments: list[LinearCommentSummary]
    attachments: list[LinearAttachmentSummary]
    activity: list[LinearActivitySummary]


class TmuxWindowSummary(TypedDict):
    session: str
    index: int
    name: str
    paneId: str
    path: str
    command: str
    active: bool
    panePid: int | None
    ticketIds: list[str]
    isCodexLike: bool
    panePreview: str
    panePreviewTruncated: bool


class WorktreeSummary(TypedDict):
    path: str
    branch: str | None
    head: str | None
    prunable: bool
    exists: bool
    dirtyCount: int | None
    statusLines: list[str]
    ticketIds: list[str]


class WorktreeDetailSummary(WorktreeSummary):
    stagedStat: str
    unstagedStat: str
    stagedDiff: str
    unstagedDiff: str
    untrackedFiles: list[str]
    truncated: bool


CodexSessionStatus = Literal["goal-active", "idle", "running", "unknown"]


class CodexToolCallSummary(TypedDict):
    callId: str
    name: str
    status: Literal["started", "completed"]
    argumentsPreview: str
    outputPreview: str
    timestamp: str
    arguments: NotRequired[str]
    argumentsTruncated: NotRequired[bool]
    output: NotRequired[str]
    outputTruncated: NotRequired[bool]


class CodexMessageSummary(TypedDict):
    role: Literal["assistant", "developer", "system", "user", "unknown"]
    text: str
    timestamp: str


class CodexTimelineEvent(TypedDict):
    id: str
    kind: Literal["message", "system", "tool_call", "tool_output"]
    timestamp: str
    title: str
    detail: str
    status: NotRequired[Literal["completed", "started"]]


class CodexSessionSummary(TypedDict):
    threadId: str
    title: str
    preview: str
    firstUserMessage: NotRequired[str]
    cwd: str
    gitBranch: str | None
    gitSha: NotRequired[str | None]
    rolloutPath: NotRequired[str]
    model: str | None
    modelProvider: str
    reasoningEffort: str | None
    tokensUsed: int
    createdAt: NotRequired[str]
    updatedAt: str
    goalObjective: str | None
    goalStatus: str | None
    goalTokensUsed: int | None
    goalTokenBudget: int | None
    ticketIds: list[str]
    status: CodexSessionStatus
    recentToolCalls: list[CodexToolCallSummary]
    latestMessages: list[CodexMessageSummary]


class CodexSessionDetail(TypedDict):
    threadId: str
    title: str
    rolloutPath: str
    events: list[CodexTimelineEvent]
    toolCalls: list[CodexToolCallSummary]
    messages: list[CodexMessageSummary]
    totalParsedEvents: int
    truncated: bool
    summary: NotRequired[CodexSessionSummary]


class TicketRow(TypedDict):
    ticketId: str
    title: str | None
    prNumbers: list[int]
    windows: list[str]
    worktrees: list[str]
    branches: list[str]
    state: Literal["active", "review", "green", "blocked", "quiet"]
    nextAction: str
    risk: Literal["low", "medium", "high"]


class DashboardData(TypedDict):
    generatedAt: str
    scope: dict[str, str | list[str] | None]
    repo: dict[str, str]
    prs: list[PullRequestSummary]
    linearTickets: list[LinearTicketSummary]
    codexSessions: list[CodexSessionSummary]
    tmuxWindows: list[TmuxWindowSummary]
    worktrees: list[WorktreeSummary]
    tickets: list[TicketRow]
    diagnostics: list[str]
