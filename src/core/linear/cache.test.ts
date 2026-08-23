import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LinearIssueCache, type LinearCompleteSnapshot } from './cache'
import type { LinearIssue } from '../../shared/linear-issues'

let userDataDir: string

const issue = (n: number): LinearIssue => ({
  id: `id-${n}`,
  identifier: `ENG-${n}`,
  number: n,
  title: `Issue ${n}`,
  description: '',
  url: `https://linear.app/acme/issue/ENG-${n}`,
  state: { id: 's1', name: 'Todo', type: 'unstarted', color: 'aaaaaa', position: 1 },
  labels: [],
  assignee: null,
  priority: 0,
  estimate: null,
  dueDate: null,
  cycleName: null,
  projectName: null,
  createdAt: '2026-08-01T10:00:00Z',
  updatedAt: '2026-08-09T10:00:00Z'
})

const snapshot = (issues: LinearIssue[]): LinearCompleteSnapshot => ({
  issues,
  lastSuccessfulRefreshAt: 1_000,
  lastFullReconciliationAt: 1_000
})

beforeEach(async () => {
  userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'linear-cache-'))
})
afterEach(async () => {
  await fs.rm(userDataDir, { recursive: true, force: true })
})

describe('LinearIssueCache', () => {
  it('round-trips a complete snapshot per (user, team)', async () => {
    const cache = new LinearIssueCache(userDataDir)
    await cache.saveComplete('u1', 'ENG', snapshot([issue(1)]))
    expect((await cache.load('u1', 'ENG')).lastComplete?.issues).toHaveLength(1)
    // A different identity reading the same team sees nothing: the document is keyed by both.
    expect((await cache.load('u2', 'ENG')).lastComplete).toBeUndefined()
    expect((await cache.load('u1', 'OPS')).lastComplete).toBeUndefined()
  })

  it('refuses a team key that is not already canonical', async () => {
    // The cache path is derived from the subject, so it demands the canonical form rather than
    // normalising here — a lower-cased key would otherwise address a second, parallel document.
    const cache = new LinearIssueCache(userDataDir)
    await expect(cache.load('u1', 'eng')).rejects.toMatchObject({ code: 'invalid-cache-key' })
    await expect(cache.saveComplete('u1', 'not a key', snapshot([]))).rejects.toMatchObject({
      code: 'invalid-cache-key'
    })
  })

  it('never lets an incomplete attempt replace the last complete snapshot', async () => {
    const cache = new LinearIssueCache(userDataDir)
    await cache.saveComplete('u1', 'ENG', snapshot([issue(1), issue(2)]))
    await cache.saveIncompleteAttempt('u1', 'ENG', {
      reason: 'issue-limit',
      observedAt: 2_000,
      partialIssues: [issue(9)]
    })
    const document = await cache.load('u1', 'ENG')
    expect(document.lastComplete?.issues.map((i) => i.id)).toEqual(['id-1', 'id-2'])
    // With good data on disk the partial set is dropped entirely rather than kept beside it.
    expect(document.lastAttempt?.partialIssues).toBeUndefined()
    expect(document.lastAttempt?.reason).toBe('issue-limit')
  })

  it('keeps a partial set only when there is no complete snapshot to fall back on', async () => {
    const cache = new LinearIssueCache(userDataDir)
    await cache.saveIncompleteAttempt('u1', 'ENG', {
      reason: 'byte-limit',
      observedAt: 2_000,
      partialIssues: [issue(9)]
    })
    expect((await cache.load('u1', 'ENG')).lastAttempt?.partialIssues).toHaveLength(1)
  })

  it('drops the partial set rather than exceeding the byte cap', async () => {
    const cache = new LinearIssueCache(userDataDir, { maximumBytes: 900 })
    await cache.saveIncompleteAttempt('u1', 'ENG', {
      reason: 'byte-limit',
      observedAt: 2_000,
      partialIssues: [issue(1), issue(2), issue(3)]
    })
    const document = await cache.load('u1', 'ENG')
    expect(document.lastAttempt).toEqual({ reason: 'byte-limit', observedAt: 2_000 })
  })

  it('refuses a complete snapshot that would exceed the cap', async () => {
    const cache = new LinearIssueCache(userDataDir, { maximumBytes: 200 })
    await expect(cache.saveComplete('u1', 'ENG', snapshot([issue(1), issue(2)])))
      .rejects.toMatchObject({ code: 'cache-too-large' })
  })

  it('reads a document written for an unknown shape as empty', async () => {
    const cache = new LinearIssueCache(userDataDir)
    await cache.saveComplete('u1', 'ENG', snapshot([issue(1)]))
    const files = await fs.readdir(path.join(userDataDir, 'linear-issues-cache'))
    await fs.writeFile(
      path.join(userDataDir, 'linear-issues-cache', files[0]),
      JSON.stringify({ version: 2, lastComplete: { issues: 'nope' } })
    )
    expect(await cache.load('u1', 'ENG')).toEqual({ version: 1 })
  })

  it('clears every identity bound to a project', async () => {
    const cache = new LinearIssueCache(userDataDir)
    await cache.bind('local-1', 'p1', 'ENG', 'u1')
    await cache.saveComplete('u1', 'ENG', snapshot([issue(1)]))
    expect(await cache.boundUserId('local-1', 'p1', 'ENG')).toBe('u1')
    await cache.clearBound('local-1', 'p1', 'ENG')
    expect(await cache.boundUserId('local-1', 'p1', 'ENG')).toBeNull()
    expect((await cache.load('u1', 'ENG')).lastComplete).toBeUndefined()
  })
})
