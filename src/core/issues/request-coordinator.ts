// Per-identity request discipline shared by every issue provider: at most 4 concurrent reads, one
// mutation at a time spaced 1 s apart, a rate-limit pause the whole identity waits behind, and a
// generation counter so a configuration change cancels everything in flight.
//
// Nothing here is GitHub-specific and nothing here may become so. It is keyed by the AUTHENTICATED
// USER because that is the scope both providers' budgets are actually metered in — GitHub's hourly
// request limit and Linear's complexity budget are both per-user, shared across every repository or
// team that user reaches. `noteOperationRateLimit` duck-types `{ code: 'rate-limited', retryAt }`,
// so a provider's own error class needs only those two fields to participate.
//
// Lifted out of `src/core/github/` when Linear arrived: two copies of this would drift, and its
// bugs would be silent and identical in both. `src/core/github/request-coordinator.ts` is now a
// re-export shim, so no GitHub call site or test changed.
export class IssueCoordinatorError extends Error {
  constructor(readonly code: 'configuration-changed') {
    super(code)
  }
}

type RateLimit = { kind: 'primary' | 'secondary'; retryAt: number }
type ReadJob = {
  generation: number
  run: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}
type IdentityState = {
  activeReads: number
  readQueue: ReadJob[]
  mutationTail: Promise<void>
  lastMutationAt: number
  generation: number
  retryAt: number
}

type CoordinatorOptions = {
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
}

function noteOperationRateLimit(state: IdentityState, error: unknown): void {
  if (!error || typeof error !== 'object') return
  const value = error as { code?: unknown; retryAt?: unknown }
  if (value.code === 'rate-limited' && typeof value.retryAt === 'number' &&
      Number.isFinite(value.retryAt)) {
    state.retryAt = Math.max(state.retryAt, value.retryAt)
  }
}

export class IssueRequestCoordinator {
  private readonly states = new Map<string, IdentityState>()
  private readonly now: () => number
  private readonly sleep: (milliseconds: number) => Promise<void>

  constructor(options: CoordinatorOptions = {}) {
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  }

  runRead<T>(identity: string, operation: () => Promise<T>): Promise<T> {
    const state = this.state(identity)
    return new Promise<T>((resolve, reject) => {
      state.readQueue.push({
        generation: state.generation,
        run: operation,
        resolve: resolve as (value: unknown) => void,
        reject
      })
      this.drainReads(identity, state)
    })
  }

  runMutation<T>(identity: string, operation: () => Promise<T>): Promise<T> {
    const state = this.state(identity)
    const generation = state.generation
    let resolveResult: (value: T) => void
    let rejectResult: (error: unknown) => void
    const result = new Promise<T>((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
    state.mutationTail = state.mutationTail.then(async () => {
      try {
        if (generation !== state.generation) throw new IssueCoordinatorError('configuration-changed')
        await this.waitForRate(state)
        const spacing = state.lastMutationAt + 1_000 - this.now()
        if (spacing > 0) await this.sleep(spacing)
        if (generation !== state.generation) throw new IssueCoordinatorError('configuration-changed')
        state.lastMutationAt = this.now()
        resolveResult(await operation())
      } catch (error) {
        noteOperationRateLimit(state, error)
        rejectResult(error)
      }
    })
    return result
  }

  noteRateLimit(identity: string, limit: RateLimit): void {
    const state = this.state(identity)
    if (Number.isFinite(limit.retryAt)) state.retryAt = Math.max(state.retryAt, limit.retryAt)
  }

  canStart(identity: string, at = this.now()): boolean {
    return at >= this.state(identity).retryAt
  }

  cancelIdentity(identity: string): void {
    const state = this.state(identity)
    state.generation += 1
    const error = new IssueCoordinatorError('configuration-changed')
    for (const job of state.readQueue.splice(0)) job.reject(error)
  }

  cancelAll(): void {
    for (const identity of this.states.keys()) this.cancelIdentity(identity)
  }

  private state(identity: string): IdentityState {
    let state = this.states.get(identity)
    if (!state) {
      state = {
        activeReads: 0,
        readQueue: [],
        mutationTail: Promise.resolve(),
        lastMutationAt: Number.NEGATIVE_INFINITY,
        generation: 0,
        retryAt: 0
      }
      this.states.set(identity, state)
    }
    return state
  }

  private drainReads(identity: string, state: IdentityState): void {
    while (state.activeReads < 4 && state.readQueue.length) {
      const job = state.readQueue.shift()!
      state.activeReads += 1
      void (async () => {
        try {
          if (job.generation !== state.generation) throw new IssueCoordinatorError('configuration-changed')
          await this.waitForRate(state)
          if (job.generation !== state.generation) throw new IssueCoordinatorError('configuration-changed')
          job.resolve(await job.run())
        } catch (error) {
          noteOperationRateLimit(state, error)
          job.reject(error)
        } finally {
          state.activeReads -= 1
          this.drainReads(identity, state)
        }
      })()
    }
  }

  private async waitForRate(state: IdentityState): Promise<void> {
    while (true) {
      const wait = state.retryAt - this.now()
      if (wait <= 0) return
      await this.sleep(wait)
    }
  }
}
