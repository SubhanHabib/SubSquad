import type { LinearIssue } from '../../shared/linear-issues'
import { IssueCacheError, IssueSnapshotCache } from '../issues/snapshot-cache'
import { parseLinearTeamKey } from './config'

const DIRECTORY = 'linear-issues-cache'
const BINDING_DIRECTORY = 'linear-issues-bindings'
const DEFAULT_MAXIMUM = 64 * 1024 * 1024
export const MAX_LINEAR_ISSUES = 10_000

export interface LinearCompleteSnapshot {
  issues: LinearIssue[]
  lastSuccessfulRefreshAt: number
  lastFullReconciliationAt: number
}

export interface LinearIncompleteAttempt {
  reason: 'issue-limit' | 'byte-limit'
  observedAt: number
  partialIssues?: LinearIssue[]
}

export interface LinearCacheDocument {
  version: 1
  lastComplete?: LinearCompleteSnapshot
  lastAttempt?: LinearIncompleteAttempt
}

export const LinearCacheError = IssueCacheError
export type LinearCacheError = IssueCacheError

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function nonEmptyString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function validIssue(value: unknown): value is LinearIssue {
  if (!value || typeof value !== 'object') return false
  const issue = value as LinearIssue
  // Identity is an opaque STRING here, where GitHub's validator asserts `number > 0`. A Linear id
  // is a UUID and its `number` is per-team, so `number` is display data and only `id` may be
  // trusted as an address.
  return nonEmptyString(issue.id, 128) && nonEmptyString(issue.identifier, 64) &&
    safeInteger(issue.number) &&
    typeof issue.title === 'string' && typeof issue.description === 'string' &&
    typeof issue.url === 'string' &&
    !!issue.state && typeof issue.state === 'object' &&
    nonEmptyString(issue.state.id, 128) && nonEmptyString(issue.state.name, 200) &&
    typeof issue.state.type === 'string' &&
    Array.isArray(issue.labels) &&
    (issue.assignee === null || (typeof issue.assignee === 'object' && !!issue.assignee)) &&
    typeof issue.priority === 'number' &&
    (issue.estimate === null || typeof issue.estimate === 'number') &&
    (issue.dueDate === null || typeof issue.dueDate === 'string') &&
    (issue.cycleName === null || typeof issue.cycleName === 'string') &&
    (issue.projectName === null || typeof issue.projectName === 'string') &&
    typeof issue.createdAt === 'string' && typeof issue.updatedAt === 'string'
}

function validComplete(value: unknown): value is LinearCompleteSnapshot {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as LinearCompleteSnapshot
  return Array.isArray(snapshot.issues) && snapshot.issues.length <= MAX_LINEAR_ISSUES &&
    snapshot.issues.every(validIssue) &&
    safeInteger(snapshot.lastSuccessfulRefreshAt) && safeInteger(snapshot.lastFullReconciliationAt)
}

function validAttempt(value: unknown): value is LinearIncompleteAttempt {
  if (!value || typeof value !== 'object') return false
  const attempt = value as LinearIncompleteAttempt
  return (attempt.reason === 'issue-limit' || attempt.reason === 'byte-limit') &&
    safeInteger(attempt.observedAt) &&
    (attempt.partialIssues === undefined ||
      (Array.isArray(attempt.partialIssues) && attempt.partialIssues.length <= MAX_LINEAR_ISSUES &&
        attempt.partialIssues.every(validIssue)))
}

function validDocument(value: unknown): value is LinearCacheDocument {
  if (!value || typeof value !== 'object') return false
  const document = value as LinearCacheDocument
  return document.version === 1 &&
    (document.lastComplete === undefined || validComplete(document.lastComplete)) &&
    (document.lastAttempt === undefined || validAttempt(document.lastAttempt))
}

/**
 * The per-identity snapshot cache, subject = the team key.
 *
 * TWO DIFFERENCES from `GitHubIssueCache`, both consequences of the API rather than choices:
 *
 * 1. **No `etags`.** Linear's GraphQL endpoint offers no conditional requests, so there is no
 *    "not modified" short-circuit to persist. Its replacement is the `lastSuccessfulRefreshAt`
 *    watermark, which the service feeds to `updatedAt: { gt: … }` — the same job GitHub's `since`
 *    does, and the field is already here.
 * 2. **No persisted relay cursor**, though the plan called for one. A cursor addresses a POSITION
 *    inside one server-side result set; resuming a later refresh from a cursor minted against an
 *    earlier one would silently skip or repeat issues, and Linear does not promise a cursor
 *    outlives its query. Cursors are therefore per-refresh state held in memory by
 *    `refreshTeam`, exactly as GitHub holds its page counter. Nothing is lost: an interrupted
 *    refresh restarts, which is what the GitHub path does too.
 */
export class LinearIssueCache extends IssueSnapshotCache<LinearCacheDocument> {
  constructor(userDataDir: string, options: { maximumBytes?: number } = {}) {
    super(userDataDir, {
      directory: DIRECTORY,
      bindingDirectory: BINDING_DIRECTORY,
      parseSubject: parseLinearTeamKey,
      validDocument,
      emptyDocument: () => ({ version: 1 }),
      maximumBytes: options.maximumBytes ?? DEFAULT_MAXIMUM
    })
  }

  async saveComplete(
    userId: string,
    teamKey: string,
    snapshot: LinearCompleteSnapshot
  ): Promise<void> {
    if (!validComplete(snapshot)) throw new IssueCacheError('cache-too-large')
    await this.write(userId, teamKey, { version: 1, lastComplete: structuredClone(snapshot) })
  }

  async saveIncompleteAttempt(
    userId: string,
    teamKey: string,
    attempt: LinearIncompleteAttempt
  ): Promise<void> {
    if (!validAttempt(attempt)) throw new IssueCacheError('cache-too-large')
    const current = await this.load(userId, teamKey)
    const metadata: LinearIncompleteAttempt = {
      reason: attempt.reason,
      observedAt: attempt.observedAt,
      // A partial set is only worth keeping when there is no complete snapshot to fall back on —
      // otherwise it would displace good data with worse data.
      ...(!current.lastComplete && attempt.partialIssues
        ? { partialIssues: structuredClone(attempt.partialIssues) }
        : {})
    }
    let next: LinearCacheDocument = {
      version: 1,
      ...(current.lastComplete ? { lastComplete: current.lastComplete } : {}),
      lastAttempt: metadata
    }
    if (Buffer.byteLength(JSON.stringify(next), 'utf-8') > this.maximum && metadata.partialIssues) {
      next = {
        version: 1,
        lastAttempt: { reason: metadata.reason, observedAt: metadata.observedAt }
      }
    }
    await this.write(userId, teamKey, next)
  }
}
