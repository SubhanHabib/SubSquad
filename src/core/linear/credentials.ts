import type { LinearAuthStatus, LinearSecretAvailability } from '../../shared/linear-issues'
import type { SecretStore } from '../secret-store'

export interface LinearSecretStore extends SecretStore {
  readonly availability: LinearSecretAvailability
}

export interface ValidatedLinearIdentity {
  userId: string
  name: string
}

export interface ResolvedLinearCredential extends ValidatedLinearIdentity {
  apiKey: string
}

type ResolverDependencies = {
  secret: LinearSecretStore
  validate(apiKey: string): Promise<ValidatedLinearIdentity | null>
  now?: () => number
}

/**
 * Same 30 s memo as `GitHubCredentialResolver`, and for the same measured reason: the service
 * re-checks its epoch before every read and around every write, each check calls `resolve()`, and
 * an uncached resolve spends a `viewer` query that does NOT pass through the request coordinator —
 * so it is neither rate-limited nor backed off. On Linear that matters more than on GitHub,
 * because the budget it would burn is a complexity budget shared with every other query.
 *
 * This resolver is much smaller than GitHub's for one reason only: there is no provider choice to
 * make. Linear ships no official CLI, so there is no `gh`-equivalent to prefer, no `auto` mode and
 * no provider union — a stored personal API key is the only credential this can ever hold.
 */
export const CREDENTIAL_CACHE_MS = 30_000

export class LinearCredentialResolver {
  private cache: { at: number; value: ResolvedLinearCredential | null } | null = null
  private readonly now: () => number

  constructor(private readonly dependencies: ResolverDependencies) {
    this.now = dependencies.now ?? Date.now
  }

  async resolve(): Promise<ResolvedLinearCredential | null> {
    const at = this.now()
    if (this.cache && at - this.cache.at < CREDENTIAL_CACHE_MS) return this.cache.value
    const value = await this.resolveUncached()
    // A null answer is cached too: "no key saved" is exactly the state that would otherwise spend
    // a round trip on every epoch check of every failing refresh.
    this.cache = { at, value }
    return value
  }

  /** Drop the memo the moment the credential boundary moves (key saved/cleared, project revoked)
   *  so the next resolve reflects the new reality instead of serving a revoked key until the TTL
   *  happens to lapse. */
  invalidate(): void {
    this.cache = null
  }

  async status(): Promise<LinearAuthStatus> {
    const stored = await this.dependencies.secret.readForHost()
    const identity = stored ? await this.dependencies.validate(stored) : null
    return {
      authenticated: identity !== null,
      keyPresent: stored !== null,
      storage: this.dependencies.secret.availability,
      ...(identity ? { name: identity.name } : {})
    }
  }

  private async resolveUncached(): Promise<ResolvedLinearCredential | null> {
    const apiKey = await this.dependencies.secret.readForHost()
    if (!apiKey) return null
    const identity = await this.dependencies.validate(apiKey)
    return identity ? { ...identity, apiKey } : null
  }
}
