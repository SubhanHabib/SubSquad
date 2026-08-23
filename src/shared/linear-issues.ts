/**
 * Wire contracts for the Linear issue integration.
 *
 * Mirrors `src/shared/github-issues.ts` beat for beat, and deliberately does NOT try to share a
 * type with it: the two providers disagree about identity (an int `number` scoped to a repository
 * vs an opaque UUID), about what a column means (a label vs a workflow state) and about what
 * finishing an issue is (a `state` field vs a state whose `type` says so). One merged type would
 * have to be the union of both, and every reader would then have to re-establish which half it is
 * holding. The two providers meet only at the board's card-source registry
 * (`renderer/lib/kanbanSources.ts`), which places each source's own card component in a column —
 * it never asks them to agree on a card shape.
 */

/** Shared, non-secret column→workflow-state mapping. Lives in `.nodeterm/project.json`. */
export interface ProjectKanbanLinear {
  /** The team's key — "ENG". Authoritative: nothing in a git checkout can name a Linear team, so
   *  unlike GitHub's repository there is no detected fallback. */
  teamKey?: string
  columnMappings: Array<{
    columnId: string
    /** The workflow state's NAME, never its id — see `normaliseProjectKanbanLinear`. */
    stateName: string
  }>
}

export interface NormalisedProjectKanbanLinear {
  teamKey?: string
  columnMappings: Array<{ columnId: string; stateName: string }>
  revision: string
}

export type LinearConfigError =
  | 'invalid-shape'
  | 'invalid-team-key'
  | 'unknown-column'
  | 'duplicate-column'
  | 'empty-state'
  | 'state-too-long'
  | 'duplicate-state'

export type LinearConfigResult =
  | { ok: true; value: NormalisedProjectKanbanLinear }
  | { ok: false; reason: LinearConfigError }

/** Where the API key is kept. Same three answers the GitHub store gives, for the same reasons. */
export type LinearSecretAvailability = 'encrypted' | 'restricted-file' | 'unavailable'

export interface LinearProjectApproval {
  localApprovalId: string
  projectId: string
  teamKey: string
  enabled: true
  approvedAt: number
}

export interface LinearControlState {
  version: 1
  revision: number
  approvals: LinearProjectApproval[]
}

/**
 * There is no provider CHOICE here, unlike GitHub's `auto | gh | token`: Linear ships no official
 * CLI, so a personal API key is the only credential this can hold. `authenticated` is therefore a
 * plain boolean rather than an active-provider union.
 */
export interface LinearAuthStatus {
  authenticated: boolean
  keyPresent: boolean
  storage: LinearSecretAvailability
  /** The signed-in user's display name, when a key resolves. */
  name?: string
}

/** One workflow state on a team. `type` is Linear's own closed vocabulary. */
export interface LinearWorkflowState {
  id: string
  name: string
  type: 'triage' | 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled'
  color: string
  position: number
}

export interface LinearTeamSummary {
  id: string
  key: string
  name: string
}

export interface LinearIssueLabel {
  id: string
  name: string
  color: string
}

export interface LinearIssueUser {
  id: string
  name: string
  avatarUrl?: string
}

export interface LinearIssue {
  /** The UUID. Opaque, and the only thing a mutation may be addressed by. */
  id: string
  /** "ENG-123" — human identity, and what the card shows. */
  identifier: string
  /** Per-TEAM sequence number. Display and search only; never an address. */
  number: number
  title: string
  description: string
  url: string
  state: LinearWorkflowState
  labels: LinearIssueLabel[]
  /** Linear has exactly one assignee, not a list. Modelled as 0-or-1 for the card's avatar row. */
  assignee: LinearIssueUser | null
  /** 0 none, 1 urgent, 2 high, 3 medium, 4 low — Linear's own scale, passed through unchanged. */
  priority: number
  estimate: number | null
  dueDate: string | null
  cycleName: string | null
  projectName: string | null
  createdAt: string
  updatedAt: string
}

export interface LinearIssuePageResult {
  items: LinearIssue[]
  /** Relay cursor for the NEXT page of this same scan. Never persisted between refreshes. */
  endCursor?: string
}

/**
 * A Linear card carries NO conflict, and the absence is deliberate.
 *
 * Both of GitHub's conflicts (`multiple-mapped-labels`, `open-with-completion-label`) are
 * structurally impossible here: an issue has exactly one state, and completion is that state's own
 * `type` rather than a column the user nominates. The one remaining mismatch — an issue whose state
 * no column maps to — is NOT a conflict but the normal resting place for triage and backlog work,
 * and a board that does not map those states would otherwise stamp a warning chip on every one of
 * them. Where a real mapping hole does need surfacing (a mapping naming a state the team no longer
 * has), it is a configuration fact, reported once as `LinearControlView.project.unknownStates`
 * rather than per card.
 */
export interface LinearIssueCardView extends LinearIssue {
  columnId: string | null
  avatarDataUrls?: Record<string, string>
}

export interface LinearIssueQuery {
  projectId: string
  columnId: string | null
  pageSize: number
  cursor?: string
  search?: string
  labelFilter?: string[]
}

export interface LinearIssuePage {
  items: LinearIssueCardView[]
  counts: Record<string, number>
  nextCursor?: string
  partial: boolean
  readOnly: boolean
  /**
   * Each mapped column's workflow-state TYPE, resolved host-side at the last refresh.
   *
   * The board needs this to decide whether a drop is an ordinary state change, a completion, a
   * cancellation or a reopen — and those differ in whether they ask first. The renderer cannot
   * derive it: a state's name says nothing about its type, and the states list is a control-scoped
   * read a relay guest may not make. Absent until a refresh has succeeded, which is also exactly
   * when `readOnly` is still true, so no move is ever decided without it.
   */
  columnStateTypes?: Record<string, LinearWorkflowState['type']>
  lastSuccessfulRefreshAt?: number
  lastFullReconciliationAt?: number
}

export type LinearMutationResult =
  | { status: 'confirmed'; issue: LinearIssue }
  | { status: 'refresh-pending'; issue: LinearIssue }
  | { status: 'stale'; issue: LinearIssue }
  | { status: 'configuration-changed' }
  | { status: 'read-only' }
  | { status: 'invalid-target' }
  | { status: 'failed'; message: string }

export interface LinearControlView {
  control: { revision: number }
  auth: LinearAuthStatus
  project?: {
    projectId: string
    teamKey?: string
    approved: boolean
    /** State names the mapping refers to that the team does not (or no longer) has. A mapping is
     *  saved by NAME, so this is the one way a stale mapping becomes visible instead of silently
     *  refusing every move into that column. */
    unknownStates?: string[]
  }
}

export interface LinearIssuesApi {
  subscribe(projectId: string): Promise<LinearIssuePage>
  unsubscribe(projectId: string): Promise<void>
  query(request: LinearIssueQuery): Promise<LinearIssuePage>
  refresh(projectId: string, full?: boolean): Promise<void>
  moveIssue(request: {
    projectId: string
    issueId: string
    toColumnId: string | null
    expectedUpdatedAt: string
  }): Promise<LinearMutationResult>
  clearCache(projectId: string): Promise<void>
  onChanged(projectId: string, listener: (changedIssueIds: string[]) => void): () => void
}

export interface LinearControlApi {
  status(projectId?: string): Promise<LinearControlView>
  approve(input: { projectId: string; teamKey: string; expectedRevision: number }): Promise<LinearControlView>
  revoke(input: { projectId: string; expectedRevision: number }): Promise<LinearControlView>
  saveKey(key: string): Promise<LinearControlView>
  clearKey(): Promise<LinearControlView>
  /** Backs the team picker that replaces GitHub's git-origin detection. */
  teams(): Promise<LinearTeamSummary[]>
  /** The team's workflow states, for the column→state mapping UI. */
  states(teamKey: string): Promise<LinearWorkflowState[]>
}
