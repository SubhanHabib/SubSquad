import type { GitHubIssue } from '../../shared/github-issues'
import { IssueCacheError, IssueSnapshotCache } from '../issues/snapshot-cache'
import { parseGitHubRepository } from './config'

const DIRECTORY = 'github-issues-cache'
const BINDING_DIRECTORY = 'github-issues-bindings'
const DEFAULT_MAXIMUM = 64 * 1024 * 1024

export interface GitHubCompleteSnapshot {
  issues: GitHubIssue[]
  etags: Record<string, string>
  lastSuccessfulRefreshAt: number
  lastFullReconciliationAt: number
  /** Pull requests were dropped to stay inside the issue/byte bounds, so the pull lane is a
   *  subset. Issues are never dropped for a pull request — see the eviction order in
   *  `service.refreshRepository`. */
  pullsTruncated?: boolean
}

export interface GitHubIncompleteAttempt {
  reason: 'issue-limit' | 'byte-limit'
  observedAt: number
  partialIssues?: GitHubIssue[]
}

export interface GitHubCacheDocument {
  version: 1
  lastComplete?: GitHubCompleteSnapshot
  lastAttempt?: GitHubIncompleteAttempt
}

/** Historical name for the shared cache's error — the code union is identical, and this IS that
 *  class, so every existing `instanceof GitHubCacheError` call site keeps working. */
export const GitHubCacheError = IssueCacheError
export type GitHubCacheError = IssueCacheError

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function validPull(value: unknown): boolean {
  if (value === undefined) return true
  if (!value || typeof value !== 'object') return false
  const pull = value as NonNullable<GitHubIssue['pull']>
  return typeof pull.draft === 'boolean' &&
    (pull.mergedAt === null || typeof pull.mergedAt === 'string') &&
    (pull.head === undefined || typeof pull.head === 'string')
}

function validIssue(value: unknown): value is GitHubIssue {
  if (!value || typeof value !== 'object') return false
  const issue = value as GitHubIssue
  return validPull(issue.pull) && safeInteger(issue.id) && issue.id > 0 && safeInteger(issue.number) && issue.number > 0 &&
    typeof issue.title === 'string' && typeof issue.body === 'string' &&
    (issue.state === 'open' || issue.state === 'closed') &&
    typeof issue.htmlUrl === 'string' && typeof issue.apiUrl === 'string' &&
    Array.isArray(issue.labels) && Array.isArray(issue.assignees) &&
    typeof issue.createdAt === 'string' && typeof issue.updatedAt === 'string' &&
    typeof issue.locked === 'boolean'
}

function validComplete(value: unknown): value is GitHubCompleteSnapshot {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as GitHubCompleteSnapshot
  return Array.isArray(snapshot.issues) && snapshot.issues.length <= 10_000 &&
    snapshot.issues.every(validIssue) &&
    snapshot.etags !== null && typeof snapshot.etags === 'object' && !Array.isArray(snapshot.etags) &&
    Object.entries(snapshot.etags).every(([key, etag]) => key.length <= 2_048 && typeof etag === 'string' && etag.length <= 512) &&
    safeInteger(snapshot.lastSuccessfulRefreshAt) && safeInteger(snapshot.lastFullReconciliationAt) &&
    (snapshot.pullsTruncated === undefined || typeof snapshot.pullsTruncated === 'boolean')
}

function validAttempt(value: unknown): value is GitHubIncompleteAttempt {
  if (!value || typeof value !== 'object') return false
  const attempt = value as GitHubIncompleteAttempt
  return (attempt.reason === 'issue-limit' || attempt.reason === 'byte-limit') &&
    safeInteger(attempt.observedAt) &&
    (attempt.partialIssues === undefined ||
      (Array.isArray(attempt.partialIssues) && attempt.partialIssues.length <= 10_000 &&
        attempt.partialIssues.every(validIssue)))
}

function validDocument(value: unknown): value is GitHubCacheDocument {
  if (!value || typeof value !== 'object') return false
  const document = value as GitHubCacheDocument
  return document.version === 1 &&
    (document.lastComplete === undefined || validComplete(document.lastComplete)) &&
    (document.lastAttempt === undefined || validAttempt(document.lastAttempt))
}

export class GitHubIssueCache extends IssueSnapshotCache<GitHubCacheDocument> {
  constructor(
    userDataDir: string,
    options: { maximumBytes?: number } = {}
  ) {
    super(userDataDir, {
      directory: DIRECTORY,
      bindingDirectory: BINDING_DIRECTORY,
      parseSubject: parseGitHubRepository,
      validDocument,
      emptyDocument: () => ({ version: 1 }),
      maximumBytes: options.maximumBytes ?? DEFAULT_MAXIMUM
    })
  }

  async saveComplete(
    userId: string,
    repository: string,
    snapshot: GitHubCompleteSnapshot
  ): Promise<void> {
    if (!validComplete(snapshot)) throw new IssueCacheError('cache-too-large')
    await this.write(userId, repository, {
      version: 1,
      lastComplete: structuredClone(snapshot)
    })
  }

  async saveIncompleteAttempt(
    userId: string,
    repository: string,
    attempt: GitHubIncompleteAttempt
  ): Promise<void> {
    if (!validAttempt(attempt)) throw new IssueCacheError('cache-too-large')
    const current = await this.load(userId, repository)
    const metadata: GitHubIncompleteAttempt = {
      reason: attempt.reason,
      observedAt: attempt.observedAt,
      ...(!current.lastComplete && attempt.partialIssues
        ? { partialIssues: structuredClone(attempt.partialIssues) }
        : {})
    }
    let next: GitHubCacheDocument = {
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
    await this.write(userId, repository, next)
  }
}
