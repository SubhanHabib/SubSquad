import type {
  LinearIssue,
  LinearIssueCardView,
  LinearIssuePage,
  LinearIssuePageResult,
  LinearIssueQuery,
  LinearMutationResult,
  LinearWorkflowState,
  NormalisedProjectKanbanLinear
} from '../../shared/linear-issues'
import { foldStateName } from './config'
import {
  MAX_LINEAR_ISSUES,
  type LinearCompleteSnapshot,
  type LinearIssueCache
} from './cache'
import type { LinearRequestCoordinator } from './request-coordinator'

const MAX_CACHE_BYTES = 64 * 1024 * 1024
const FULL_REFRESH_AGE = 24 * 60 * 60_000
const POLL_MS = 60_000
const PAGE_SIZE = 100
/** How long one team's workflow states are reused. States change when somebody edits the team's
 *  workflow — rare — and every move needs them, so a short memo keeps a drag from spending an
 *  extra query while still noticing an edit within a minute. */
const STATES_CACHE_MS = 60_000

/** Same floors as the GitHub service, and for the same reason: `refresh` is reachable from the
 *  renderer AND from a relay guest, `state.refresh` coalesces only CONCURRENT calls, and Linear
 *  meters a complexity budget shared across the whole workspace — a caller restarting a full scan
 *  as fast as the previous one finishes would spend it. Both sit under POLL_MS so the background
 *  poll is never what they throttle. */
export const REFRESH_MIN_INTERVAL_MS = 30_000
export const FULL_REFRESH_MIN_INTERVAL_MS = 120_000

export interface LinearIssuesClientLike {
  listIssues(teamKey: string, options: {
    first: number
    after?: string
    updatedSince?: string
  }): Promise<LinearIssuePageResult>
  getIssue(issueId: string): Promise<LinearIssue>
  updateIssueState(issueId: string, stateId: string): Promise<LinearIssue>
  listWorkflowStates(teamKey: string): Promise<LinearWorkflowState[]>
}

export interface LinearIssueProjectContext {
  localApprovalId: string
  projectId: string
  teamKey: string
  config: NormalisedProjectKanbanLinear
  controlRevision: number
  columnColors: Record<string, string>
}

export interface LinearIssueServiceContext extends LinearIssueProjectContext {
  credentialGeneration: number
  userId: string
  client: LinearIssuesClientLike
}

type TimerId = ReturnType<typeof setInterval> | number
type ServiceOptions = {
  cache: LinearIssueCache
  coordinator: LinearRequestCoordinator
  contextForProject(projectId: string): Promise<LinearIssueServiceContext>
  projectContextForCache?(projectId: string): Promise<LinearIssueProjectContext>
  projectContextForCacheDeletion?(projectId: string): Promise<LinearIssueProjectContext>
  now?: () => number
  setInterval?: (fn: () => void, milliseconds: number) => TimerId
  clearInterval?: (timer: TimerId) => void
  onDelta?: (uiId: number, projectId: string, changedIssueIds: string[]) => void
}

type TeamState = {
  snapshot?: LinearCompleteSnapshot
  /** The team's workflow states as of the last successful refresh, so `query` — which has no
   *  client and must not make a network call — can tell the board each column's state type. */
  states?: LinearWorkflowState[]
  partialIssues?: LinearIssue[]
  incomplete: boolean
  subscribers: Map<string, Set<number>>
  timer?: TimerId
  refresh?: Promise<void>
  cacheGeneration: number
}

type TeamControl = {
  generation: number
  clearCutoff: number
  deletion?: Promise<void>
}

function teamStateKey(context: LinearIssueServiceContext): string {
  return `${context.userId}\0${context.teamKey}`
}

function epoch(context: LinearIssueServiceContext): string {
  return JSON.stringify([
    context.localApprovalId,
    context.projectId,
    context.teamKey,
    context.config.revision,
    context.controlRevision,
    context.credentialGeneration,
    context.userId
  ])
}

/**
 * Which column an issue belongs in.
 *
 * Far simpler than the GitHub mapping, and structurally so: an issue has exactly ONE state, so
 * there is nothing to disambiguate, no completion column to special-case and no conflict to
 * report. A state no column maps to lands in Ungrouped, which is where triage and backlog work
 * belongs on a board that has not mapped them.
 */
function mapping(
  issue: LinearIssue,
  config: NormalisedProjectKanbanLinear
): { columnId: string | null } {
  const folded = foldStateName(issue.state.name)
  const match = config.columnMappings.find((item) => foldStateName(item.stateName) === folded)
  return { columnId: match?.columnId ?? null }
}

function mutationChain<T>(
  chains: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve()
  let resolveResult: (value: T) => void
  let rejectResult: (error: unknown) => void
  const result = new Promise<T>((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
  const next = previous.then(async () => {
    try { resolveResult(await operation()) } catch (error) { rejectResult(error) }
  })
  chains.set(key, next)
  void next.finally(() => { if (chains.get(key) === next) chains.delete(key) })
  return result
}

export class LinearIssueService {
  private readonly teams = new Map<string, TeamState>()
  private readonly projectKeys = new Map<string, string>()
  private readonly issueChains = new Map<string, Promise<void>>()
  private readonly teamControls = new Map<string, TeamControl>()
  private readonly statePreparations = new Map<string, Set<Promise<TeamState>>>()
  private readonly refreshFloors = new Map<string, { any: number; full: number }>()
  private readonly workflowStates = new Map<string, { at: number; states: LinearWorkflowState[] }>()
  private operationSequence = 0
  private readonly now: () => number
  private readonly schedule: NonNullable<ServiceOptions['setInterval']>
  private readonly unschedule: NonNullable<ServiceOptions['clearInterval']>

  constructor(private readonly options: ServiceOptions) {
    this.now = options.now ?? Date.now
    this.schedule = options.setInterval ?? ((fn, milliseconds) => setInterval(fn, milliseconds))
    this.unschedule = options.clearInterval ??
      ((timer) => clearInterval(timer as ReturnType<typeof setInterval>))
  }

  async subscribe(uiId: number, request: { projectId: string }): Promise<LinearIssuePage> {
    const context = await this.cacheContext(request.projectId)
    const { key, state } = await this.cachedState(context)
    const firstSubscriber = this.subscriberCount(state) === 0
    let subscribers = state.subscribers.get(request.projectId)
    if (!subscribers) {
      subscribers = new Set()
      state.subscribers.set(request.projectId, subscribers)
    }
    subscribers.add(uiId)
    this.projectKeys.set(request.projectId, key)
    if (firstSubscriber) {
      if (!state.snapshot && !state.partialIssues) {
        try { await this.refresh({ projectId: request.projectId }) } catch { /* offline cache remains readable */ }
      } else {
        void this.refresh({ projectId: request.projectId }).catch(() => undefined)
      }
    }
    const activeKey = this.projectKeys.get(request.projectId)
    this.ensureTimer(activeKey ? this.teams.get(activeKey) ?? state : state)
    return this.query({ projectId: request.projectId, columnId: null, pageSize: 50 })
  }

  unsubscribe(uiId: number, projectId: string): void {
    const key = this.projectKeys.get(projectId)
    const state = key ? this.teams.get(key) : undefined
    if (!state) return
    const subscribers = state.subscribers.get(projectId)
    subscribers?.delete(uiId)
    if (subscribers?.size === 0) state.subscribers.delete(projectId)
    if (this.subscriberCount(state) === 0 && state.timer) {
      this.unschedule(state.timer)
      delete state.timer
    }
  }

  dropClient(uiId: number): void {
    for (const state of this.teams.values()) {
      for (const [projectId, subscribers] of state.subscribers) {
        subscribers.delete(uiId)
        if (subscribers.size === 0) state.subscribers.delete(projectId)
      }
      if (this.subscriberCount(state) === 0 && state.timer) {
        this.unschedule(state.timer)
        delete state.timer
      }
    }
  }

  async refresh(request: { projectId: string; full?: boolean }): Promise<void> {
    // Checked BEFORE contextForProject on purpose: resolving a context runs the credential chain
    // (a `viewer` query when the memo is cold), so a throttle placed after it would still pay the
    // expensive half of every call it rejects.
    const full = request.full === true
    const startedAt = this.now()
    const previousFloor = this.refreshFloors.get(request.projectId)
    if (previousFloor && startedAt < (full ? previousFloor.full : previousFloor.any)) return
    this.refreshFloors.set(request.projectId, {
      any: startedAt + REFRESH_MIN_INTERVAL_MS,
      full: full ? startedAt + FULL_REFRESH_MIN_INTERVAL_MS : previousFloor?.full ?? 0
    })
    try {
      return await this.refreshWithinFloor(request, startedAt)
    } catch (error) {
      // A refresh that FAILED bought nothing, so it must not hold the floor — otherwise the first
      // network blip disables the board's own Retry button for the next 30 seconds.
      if (this.refreshFloors.get(request.projectId)?.any === startedAt + REFRESH_MIN_INTERVAL_MS) {
        if (previousFloor) this.refreshFloors.set(request.projectId, previousFloor)
        else this.refreshFloors.delete(request.projectId)
      }
      throw error
    }
  }

  private async refreshWithinFloor(
    request: { projectId: string; full?: boolean },
    startedAt = this.now()
  ): Promise<void> {
    const operationId = ++this.operationSequence
    const captured = await this.options.contextForProject(request.projectId)
    const control = this.teamControl(captured.teamKey)
    if (control.deletion || operationId <= control.clearCutoff) return
    const teamGeneration = control.generation
    let state: TeamState
    try {
      state = await this.state(captured, operationId, teamGeneration)
    } catch (error) {
      if (error instanceof TeamClearedError) return
      throw error
    }
    if (state.refresh) return state.refresh
    const cacheGeneration = state.cacheGeneration
    const work = this.refreshTeam(
      captured, state, request.full === true, cacheGeneration, operationId, teamGeneration, startedAt
    )
    state.refresh = work
    try { await work } finally { if (state.refresh === work) delete state.refresh }
  }

  async query(request: LinearIssueQuery): Promise<LinearIssuePage> {
    if (!Number.isSafeInteger(request.pageSize) || request.pageSize < 1 || request.pageSize > 50) {
      throw new Error('invalid-query')
    }
    const context = await this.cacheContext(request.projectId)
    const { state } = await this.cachedState(context)
    const source = state.snapshot?.issues ?? state.partialIssues ?? []
    const mapped = source.map((issue): LinearIssueCardView => ({
      ...issue,
      ...mapping(issue, context.config)
    }))
    const search = request.search?.trim().toLocaleLowerCase('en-US') ?? ''
    const filters = new Set((request.labelFilter ?? []).map((item) =>
      foldStateName(item.replace(/^linear:/, ''))))
    const filtered = mapped
      .filter((item) => !search ||
        item.title.toLocaleLowerCase('en-US').includes(search) ||
        item.identifier.toLocaleLowerCase('en-US').includes(search))
      .filter((item) => filters.size === 0 || item.labels.some((label) =>
        filters.has(foldStateName(label.name))))
    const visible = filtered.filter((item) => item.columnId === request.columnId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.number - a.number)
    const offset = request.cursor ? Number(request.cursor) : 0
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid-query')
    const page = visible.slice(offset, offset + request.pageSize)
    const counts: Record<string, number> = {}
    for (const item of filtered) {
      counts[item.columnId ?? 'ungrouped'] = (counts[item.columnId ?? 'ungrouped'] ?? 0) + 1
    }
    const columnStateTypes: Record<string, LinearWorkflowState['type']> = {}
    for (const item of context.config.columnMappings) {
      const state = (this.teams.get(this.projectKeys.get(request.projectId) ?? '')?.states ?? [])
        .find((candidate) => foldStateName(candidate.name) === foldStateName(item.stateName))
      if (state) columnStateTypes[item.columnId] = state.type
    }
    return {
      items: page,
      counts,
      ...(Object.keys(columnStateTypes).length ? { columnStateTypes } : {}),
      ...(offset + page.length < visible.length ? { nextCursor: String(offset + page.length) } : {}),
      partial: !state.snapshot && !!state.partialIssues,
      // No `completionColumnId` clause, unlike GitHub: a Linear state carries its own completion
      // semantics, so there is no configuration the board must have before a move is meaningful.
      readOnly: state.incomplete || !state.snapshot,
      ...(state.snapshot ? {
        lastSuccessfulRefreshAt: state.snapshot.lastSuccessfulRefreshAt,
        lastFullReconciliationAt: state.snapshot.lastFullReconciliationAt
      } : {})
    }
  }

  moveIssue(request: {
    projectId: string
    issueId: string
    toColumnId: string | null
    expectedUpdatedAt: string
  }): Promise<LinearMutationResult> {
    const operationId = ++this.operationSequence
    return mutationChain(this.issueChains, `${request.projectId}:${request.issueId}`, async () => {
      const captured = await this.options.contextForProject(request.projectId)
      const capturedEpoch = epoch(captured)
      const teamGeneration = this.teamControl(captured.teamKey).generation
      let state: TeamState
      try {
        state = await this.state(captured, operationId, teamGeneration)
      } catch (error) {
        if (error instanceof TeamClearedError) return { status: 'read-only' }
        throw error
      }
      const cacheGeneration = state.cacheGeneration
      if (state.incomplete || !state.snapshot) return { status: 'read-only' }
      if (!state.snapshot.issues.some((item) => item.id === request.issueId)) {
        return { status: 'invalid-target' }
      }
      // Ungrouped is not a legal destination: every Linear issue is always in exactly one state,
      // so there is no write that means "no state". The renderer refuses this before asking, and
      // this is the same refusal on the other side of the wire.
      if (request.toColumnId === null) return { status: 'invalid-target' }
      const destination = captured.config.columnMappings.find((item) =>
        item.columnId === request.toColumnId)
      if (!destination) return { status: 'invalid-target' }
      if (capturedEpoch !== epoch(await this.options.contextForProject(request.projectId))) {
        return { status: 'configuration-changed' }
      }
      const states = await this.teamWorkflowStates(captured)
        .catch((error: unknown) => error instanceof ConfigurationChangedError ? null : Promise.reject(error))
      if (!states) return { status: 'configuration-changed' }
      const target = states.find((item) =>
        foldStateName(item.name) === foldStateName(destination.stateName))
      // The mapping stores a NAME, so a state renamed or deleted in Linear resolves to nothing.
      // That is a configuration problem the user can fix (Settings shows it as an unknown state),
      // never a reason to guess at a different state.
      if (!target) return { status: 'invalid-target' }
      const latest = await this.readWithEpoch(captured, () => captured.client.getIssue(request.issueId))
        .catch((error: unknown) => error instanceof ConfigurationChangedError ? null : Promise.reject(error))
      if (!latest) return { status: 'configuration-changed' }
      if (latest.updatedAt !== request.expectedUpdatedAt) {
        if (cacheGeneration !== state.cacheGeneration ||
            !this.teamWriteAllowed(captured.teamKey, operationId, teamGeneration)) {
          return { status: 'stale', issue: latest }
        }
        state.snapshot = {
          ...state.snapshot,
          issues: state.snapshot.issues.map((item) => item.id === latest.id ? latest : item)
        }
        try {
          await this.options.cache.saveComplete(captured.userId, captured.teamKey, state.snapshot)
        } catch { /* the validated in-memory issue remains available for this process */ }
        this.emitDelta(state, [latest.id])
        return { status: 'stale', issue: latest }
      }
      if (latest.state.id === target.id) {
        // Already there — a drag that landed where the issue already sits. Writing anyway would
        // move it to the bottom of the state's manual ordering in Linear for no reason the user
        // asked for, the same class of unasked-for side effect GitHub's state_reason rule avoids.
        return { status: 'confirmed', issue: latest }
      }
      if (capturedEpoch !== epoch(await this.options.contextForProject(request.projectId))) {
        return { status: 'configuration-changed' }
      }
      const updated = await this.options.coordinator.runMutation(captured.userId, async () => {
        if (capturedEpoch !== epoch(await this.options.contextForProject(request.projectId))) {
          throw new ConfigurationChangedError()
        }
        return captured.client.updateIssueState(request.issueId, target.id)
      }).catch((error: unknown) => {
        if (error instanceof ConfigurationChangedError) return null
        throw error
      })
      if (!updated) return { status: 'configuration-changed' }
      if (updated.state.id !== target.id) throw new Error('mutation-not-confirmed')
      if (capturedEpoch !== epoch(await this.options.contextForProject(request.projectId))) {
        return { status: 'confirmed', issue: updated }
      }
      if (cacheGeneration !== state.cacheGeneration) {
        return { status: 'refresh-pending', issue: updated }
      }
      if (!this.teamWriteAllowed(captured.teamKey, operationId, teamGeneration)) {
        return { status: 'refresh-pending', issue: updated }
      }
      const snapshot = state.snapshot ?? {
        issues: [], lastSuccessfulRefreshAt: this.now(), lastFullReconciliationAt: 0
      }
      const issues = snapshot.issues.some((item) => item.id === updated.id)
        ? snapshot.issues.map((item) => item.id === updated.id ? updated : item)
        : [...snapshot.issues, updated]
      state.snapshot = { ...snapshot, issues, lastSuccessfulRefreshAt: this.now() }
      state.partialIssues = undefined
      try {
        await this.options.cache.saveComplete(captured.userId, captured.teamKey, state.snapshot)
      } catch {
        return { status: 'refresh-pending', issue: updated }
      }
      this.emitDelta(state, [updated.id])
      return { status: 'confirmed', issue: updated }
    })
  }

  async clearCache(request: { projectId: string }): Promise<void> {
    const clearOperationId = ++this.operationSequence
    const context = this.options.projectContextForCacheDeletion
      ? await this.options.projectContextForCacheDeletion(request.projectId)
      : await this.cacheContext(request.projectId)
    const control = this.teamControl(context.teamKey)
    if (control.deletion) await control.deletion
    let finishDeletion!: () => void
    const deletion = new Promise<void>((resolve) => { finishDeletion = resolve })
    control.clearCutoff = Math.max(control.clearCutoff, clearOperationId)
    control.generation += 1
    control.deletion = deletion
    try {
      const affected = this.teamStates(context.localApprovalId, context.teamKey)
      for (const state of affected) state.cacheGeneration += 1
      const mutations = [...this.issueChains.values()]
      await Promise.allSettled([
        ...this.statePreparations.get(context.teamKey) ?? [],
        ...affected.flatMap((state) => state.refresh ? [state.refresh] : []),
        ...mutations
      ])
      await this.options.cache.clearBound(context.localApprovalId, context.projectId, context.teamKey)
      this.workflowStates.delete(context.teamKey)
      for (const state of this.teamStates(context.localApprovalId, context.teamKey)) {
        state.cacheGeneration += 1
        state.snapshot = undefined
        state.partialIssues = undefined
        state.incomplete = false
        this.emitDelta(state, [], true)
      }
    } finally {
      if (control.deletion === deletion) delete control.deletion
      finishDeletion()
    }
  }

  /** The team's states for a project, resolved through the same memo. Used by the host to report
   *  a mapping that names a state the team no longer has. */
  async workflowStatesFor(projectId: string): Promise<LinearWorkflowState[]> {
    return this.teamWorkflowStates(await this.options.contextForProject(projectId))
  }

  /** The team's workflow states, memoised briefly. Also the read behind `unknownStates` in the
   *  control view, so a stale mapping is reported instead of silently refusing moves. */
  async teamWorkflowStates(captured: LinearIssueServiceContext): Promise<LinearWorkflowState[]> {
    const cached = this.workflowStates.get(captured.teamKey)
    if (cached && this.now() - cached.at < STATES_CACHE_MS) return cached.states
    const states = await this.readWithEpoch(captured, () =>
      captured.client.listWorkflowStates(captured.teamKey))
    this.workflowStates.set(captured.teamKey, { at: this.now(), states })
    return states
  }

  private state(
    context: LinearIssueServiceContext,
    operationId: number,
    teamGeneration: number
  ): Promise<TeamState> {
    const work = this.prepareState(context, operationId, teamGeneration)
    let preparations = this.statePreparations.get(context.teamKey)
    if (!preparations) {
      preparations = new Set()
      this.statePreparations.set(context.teamKey, preparations)
    }
    preparations.add(work)
    void work.finally(() => {
      preparations!.delete(work)
      if (preparations!.size === 0) this.statePreparations.delete(context.teamKey)
    }).catch(() => undefined)
    return work
  }

  private async prepareState(
    context: LinearIssueServiceContext,
    operationId: number,
    teamGeneration: number
  ): Promise<TeamState> {
    this.assertTeamWriteAllowed(context.teamKey, operationId, teamGeneration)
    await this.options.cache.bind(
      context.localApprovalId, context.projectId, context.teamKey, context.userId
    )
    this.assertTeamWriteAllowed(context.teamKey, operationId, teamGeneration)
    const key = teamStateKey(context)
    const unboundKey = `unbound:${context.localApprovalId}\0${context.teamKey}`
    const unbound = this.teams.get(unboundKey)
    let state = this.teams.get(key)
    if (!state) {
      const cached = await this.options.cache.load(context.userId, context.teamKey)
      this.assertTeamWriteAllowed(context.teamKey, operationId, teamGeneration)
      state = {
        snapshot: cached.lastComplete,
        partialIssues: cached.lastAttempt?.partialIssues,
        incomplete: !!cached.lastAttempt,
        subscribers: new Map(),
        cacheGeneration: 0
      }
      this.teams.set(key, state)
    }
    if (unbound && unbound !== state) {
      for (const [projectId, subscribers] of unbound.subscribers) {
        let target = state.subscribers.get(projectId)
        if (!target) {
          target = new Set()
          state.subscribers.set(projectId, target)
        }
        for (const uiId of subscribers) target.add(uiId)
      }
      if (unbound.timer) {
        this.unschedule(unbound.timer)
        delete unbound.timer
      }
      this.teams.delete(unboundKey)
      this.ensureTimer(state)
    }
    this.migrateProjectState(context.projectId, key, state)
    this.projectKeys.set(context.projectId, key)
    return state
  }

  private async cacheContext(projectId: string): Promise<LinearIssueProjectContext> {
    if (this.options.projectContextForCache) return this.options.projectContextForCache(projectId)
    return this.options.contextForProject(projectId)
  }

  private async cachedState(context: LinearIssueProjectContext): Promise<{
    key: string
    state: TeamState
  }> {
    await this.waitForTeamDeletion(context.teamKey)
    const teamGeneration = this.teamControl(context.teamKey).generation
    const userId = await this.options.cache.boundUserId(
      context.localApprovalId, context.projectId, context.teamKey
    )
    if (!userId) {
      if (teamGeneration !== this.teamControl(context.teamKey).generation) {
        return this.cachedState(context)
      }
      const key = `unbound:${context.localApprovalId}\0${context.teamKey}`
      let state = this.teams.get(key)
      if (!state) {
        state = { incomplete: false, subscribers: new Map(), cacheGeneration: 0 }
        this.teams.set(key, state)
      }
      this.projectKeys.set(context.projectId, key)
      if (teamGeneration !== this.teamControl(context.teamKey).generation) {
        return this.cachedState(context)
      }
      return { key, state }
    }
    const key = `${userId}\0${context.teamKey}`
    let state = this.teams.get(key)
    if (!state) {
      const cached = await this.options.cache.load(userId, context.teamKey)
      if (teamGeneration !== this.teamControl(context.teamKey).generation) {
        return this.cachedState(context)
      }
      state = {
        snapshot: cached.lastComplete,
        partialIssues: cached.lastAttempt?.partialIssues,
        incomplete: !!cached.lastAttempt,
        subscribers: new Map(),
        cacheGeneration: 0
      }
      this.teams.set(key, state)
    }
    this.projectKeys.set(context.projectId, key)
    if (teamGeneration !== this.teamControl(context.teamKey).generation) {
      return this.cachedState(context)
    }
    return { key, state }
  }

  private async refreshTeam(
    captured: LinearIssueServiceContext,
    state: TeamState,
    forceFull: boolean,
    cacheGeneration: number,
    operationId: number,
    teamGeneration: number,
    refreshStartedAt: number
  ): Promise<void> {
    const full = forceFull || !state.snapshot ||
      this.now() - state.snapshot.lastFullReconciliationAt >= FULL_REFRESH_AGE
    const previous = state.snapshot
    const byId = new Map((full ? [] : previous?.issues ?? []).map((issue) => [issue.id, issue]))
    // The cursor is per-REFRESH state: it addresses a position inside one server-side result set
    // and is never persisted (see the cache's write-up).
    let after: string | undefined
    while (true) {
      if (!this.teamWriteAllowed(captured.teamKey, operationId, teamGeneration) ||
          cacheGeneration !== state.cacheGeneration ||
          epoch(captured) !== epoch(await this.options.contextForProject(captured.projectId))) return
      // The 2 s overlap is the same one the GitHub path uses: `updatedAt` is written by the server,
      // and a strictly-greater filter anchored at our own start instant would drop an issue whose
      // write landed in the same moment the previous refresh read.
      const updatedSince = !full && previous?.lastSuccessfulRefreshAt
        ? new Date(Math.max(0, previous.lastSuccessfulRefreshAt - 2_000)).toISOString()
        : undefined
      const result = await this.readWithEpoch(captured, () =>
        captured.client.listIssues(captured.teamKey, {
          first: PAGE_SIZE,
          ...(after ? { after } : {}),
          ...(updatedSince ? { updatedSince } : {})
        })).catch((error: unknown) =>
          error instanceof ConfigurationChangedError ? null : Promise.reject(error))
      if (!result) return
      for (const item of result.items) {
        const old = byId.get(item.id)
        if (!old || item.updatedAt >= old.updatedAt) byId.set(item.id, item)
      }
      if (byId.size > MAX_LINEAR_ISSUES) {
        await this.incomplete(
          captured, state, 'issue-limit', [...byId.values()].slice(0, MAX_LINEAR_ISSUES),
          cacheGeneration, operationId, teamGeneration
        )
        return
      }
      if (!result.endCursor) break
      after = result.endCursor
    }
    const issues = [...byId.values()]
    if (Buffer.byteLength(JSON.stringify(issues), 'utf-8') > MAX_CACHE_BYTES) {
      await this.incomplete(
        captured, state, 'byte-limit', issues, cacheGeneration, operationId, teamGeneration
      )
      return
    }
    if (!this.teamWriteAllowed(captured.teamKey, operationId, teamGeneration) ||
        cacheGeneration !== state.cacheGeneration ||
        epoch(captured) !== epoch(await this.options.contextForProject(captured.projectId))) return
    const snapshot: LinearCompleteSnapshot = {
      issues,
      lastSuccessfulRefreshAt: refreshStartedAt,
      lastFullReconciliationAt: full
        ? refreshStartedAt
        : previous?.lastFullReconciliationAt ?? refreshStartedAt
    }
    if (!this.teamWriteAllowed(captured.teamKey, operationId, teamGeneration)) return
    await this.options.cache.saveComplete(captured.userId, captured.teamKey, snapshot)
    if (!this.teamWriteAllowed(captured.teamKey, operationId, teamGeneration) ||
        cacheGeneration !== state.cacheGeneration) return
    const oldIds = new Map((previous?.issues ?? []).map((item) => [item.id, item.updatedAt]))
    const nextIds = new Set(issues.map((item) => item.id))
    const changed = [
      ...issues.filter((item) => oldIds.get(item.id) !== item.updatedAt).map((item) => item.id),
      ...(previous?.issues ?? []).filter((item) => !nextIds.has(item.id)).map((item) => item.id)
    ]
    state.snapshot = snapshot
    state.partialIssues = undefined
    state.incomplete = false
    // Capture the team's states alongside the issues. Memoised for STATES_CACHE_MS, so on the 60 s
    // poll this is one extra query a minute at most — and it is owed anyway, both for the move
    // path and for the mapping-hole report in the control view. A failure keeps the previous
    // answer: stale state types are far better than none, which would leave the board unable to
    // tell a completion from a cancellation.
    state.states = await this.teamWorkflowStates(captured).catch(() => state.states)
    this.emitDelta(state, changed, true)
  }

  private subscriberCount(state: TeamState): number {
    let count = 0
    for (const subscribers of state.subscribers.values()) count += subscribers.size
    return count
  }

  private ensureTimer(state: TeamState): void {
    if (state.timer || this.subscriberCount(state) === 0) return
    state.timer = this.schedule(() => this.poll(state), POLL_MS)
  }

  private async poll(state: TeamState): Promise<void> {
    for (const projectId of [...state.subscribers.keys()]) {
      try {
        // Deliberately BELOW the caller floor: the floor bounds callers we don't control, while
        // the poll is already paced by POLL_MS. Routing it through the floor would also break this
        // loop's fallback — a throttled call returns without throwing, which reads here as "this
        // project worked" and would stop us ever trying the next subscriber's context.
        await this.refreshWithinFloor({ projectId })
        return
      } catch {
        // Another approved project may still provide a valid context for the shared team.
      }
    }
  }

  private migrateProjectState(projectId: string, key: string, target: TeamState): void {
    const previousKey = this.projectKeys.get(projectId)
    if (!previousKey || previousKey === key) return
    const previous = this.teams.get(previousKey)
    const subscribers = previous?.subscribers.get(projectId)
    if (!previous || !subscribers) return
    let destination = target.subscribers.get(projectId)
    if (!destination) {
      destination = new Set()
      target.subscribers.set(projectId, destination)
    }
    for (const uiId of subscribers) destination.add(uiId)
    previous.subscribers.delete(projectId)
    if (this.subscriberCount(previous) === 0 && previous.timer) {
      this.unschedule(previous.timer)
      delete previous.timer
    }
    this.ensureTimer(target)
  }

  private teamControl(teamKey: string): TeamControl {
    let control = this.teamControls.get(teamKey)
    if (!control) {
      control = { generation: 0, clearCutoff: 0 }
      this.teamControls.set(teamKey, control)
    }
    return control
  }

  private teamWriteAllowed(
    teamKey: string,
    operationId: number,
    teamGeneration: number
  ): boolean {
    const control = this.teamControl(teamKey)
    return !control.deletion && operationId > control.clearCutoff &&
      teamGeneration === control.generation
  }

  private assertTeamWriteAllowed(
    teamKey: string,
    operationId: number,
    teamGeneration: number
  ): void {
    if (!this.teamWriteAllowed(teamKey, operationId, teamGeneration)) {
      throw new TeamClearedError()
    }
  }

  private async waitForTeamDeletion(teamKey: string): Promise<void> {
    while (this.teamControl(teamKey).deletion) {
      await this.teamControl(teamKey).deletion
    }
  }

  private teamStates(localApprovalId: string, teamKey: string): TeamState[] {
    const states: TeamState[] = []
    for (const [key, state] of this.teams) {
      if (key.endsWith(`\0${teamKey}`) || key === `unbound:${localApprovalId}\0${teamKey}`) {
        states.push(state)
      }
    }
    return states
  }

  private readWithEpoch<T>(
    captured: LinearIssueServiceContext,
    operation: () => Promise<T>
  ): Promise<T> {
    return this.options.coordinator.runRead(captured.userId, async () => {
      if (epoch(captured) !== epoch(await this.options.contextForProject(captured.projectId))) {
        throw new ConfigurationChangedError()
      }
      return operation()
    })
  }

  private emitDelta(state: TeamState, changedIssueIds: string[], includeEmpty = false): void {
    if (!includeEmpty && changedIssueIds.length === 0) return
    for (const [projectId, subscribers] of state.subscribers) {
      for (const uiId of subscribers) this.options.onDelta?.(uiId, projectId, changedIssueIds)
    }
  }

  private async incomplete(
    context: LinearIssueServiceContext,
    state: TeamState,
    reason: 'issue-limit' | 'byte-limit',
    issues: LinearIssue[],
    cacheGeneration: number,
    operationId: number,
    teamGeneration: number
  ): Promise<void> {
    if (!this.teamWriteAllowed(context.teamKey, operationId, teamGeneration) ||
        cacheGeneration !== state.cacheGeneration) return
    await this.options.cache.saveIncompleteAttempt(context.userId, context.teamKey, {
      reason,
      observedAt: this.now(),
      ...(!state.snapshot ? { partialIssues: issues } : {})
    })
    if (!this.teamWriteAllowed(context.teamKey, operationId, teamGeneration) ||
        cacheGeneration !== state.cacheGeneration) return
    if (!state.snapshot) state.partialIssues = issues
    state.incomplete = true
    this.emitDelta(state, [], true)
  }
}

class ConfigurationChangedError extends Error {}
class TeamClearedError extends Error {}
