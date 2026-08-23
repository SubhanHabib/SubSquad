import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LinearIssueCache } from './cache'
import { LinearRequestCoordinator } from './request-coordinator'
import {
  FULL_REFRESH_MIN_INTERVAL_MS,
  LinearIssueService,
  REFRESH_MIN_INTERVAL_MS,
  type LinearIssueServiceContext,
  type LinearIssuesClientLike
} from './service'
import { normaliseProjectKanbanLinear } from './config'
import type { KanbanColumn } from '../../shared/types'
import type {
  LinearIssue,
  LinearIssuePageResult,
  LinearWorkflowState
} from '../../shared/linear-issues'

let userDataDir: string
let now = 1_000_000

const columns: KanbanColumn[] = [
  { id: 'todo', title: 'Todo', color: '#2563eb' },
  { id: 'doing', title: 'Doing', color: '#f59e0b' },
  { id: 'done', title: 'Done', color: '#16a34a' },
  { id: 'dropped', title: 'Dropped', color: '#ef4444' }
]

const STATES: LinearWorkflowState[] = [
  { id: 's-todo', name: 'Todo', type: 'unstarted', color: 'aaaaaa', position: 1 },
  { id: 's-doing', name: 'In Progress', type: 'started', color: 'bbbbbb', position: 2 },
  { id: 's-done', name: 'Done', type: 'completed', color: 'cccccc', position: 3 },
  { id: 's-dropped', name: 'Cancelled', type: 'canceled', color: 'dddddd', position: 4 }
]

const MAPPINGS = [
  { columnId: 'todo', stateName: 'Todo' },
  { columnId: 'doing', stateName: 'In Progress' },
  { columnId: 'done', stateName: 'Done' },
  { columnId: 'dropped', stateName: 'Cancelled' }
]

const issue = (id: string, stateName: string, updatedAt: string): LinearIssue => ({
  id,
  identifier: `ENG-${id}`,
  number: Number(id.replace(/\D/g, '')) || 1,
  title: `Issue ${id}`,
  description: '',
  url: `https://linear.app/acme/issue/ENG-${id}`,
  state: STATES.find((s) => s.name === stateName)!,
  labels: [],
  assignee: null,
  priority: 0,
  estimate: null,
  dueDate: null,
  cycleName: null,
  projectName: null,
  createdAt: '2026-08-01T10:00:00Z',
  updatedAt
})

function harness(options: { client?: Partial<LinearIssuesClientLike> } = {}) {
  const listIssues = vi.fn<(
    teamKey: string,
    options: { first: number; after?: string; updatedSince?: string }
  ) => Promise<LinearIssuePageResult>>(async () => ({ items: [] }))
  const getIssue = vi.fn(async (id: string) => issue(id, 'Todo', '2026-08-09T10:00:00Z'))
  const updateIssueState = vi.fn(async (id: string, stateId: string) =>
    ({ ...issue(id, 'Todo', '2026-08-10T10:00:00Z'), state: STATES.find((s) => s.id === stateId)! }))
  const listWorkflowStates = vi.fn(async () => STATES)
  const client: LinearIssuesClientLike = {
    listIssues, getIssue, updateIssueState, listWorkflowStates, ...options.client
  }
  const config = normaliseProjectKanbanLinear({ teamKey: 'ENG', columnMappings: MAPPINGS }, columns)
  if (!config.ok) throw new Error('fixture config invalid')
  let credentialGeneration = 0
  const context = (): LinearIssueServiceContext => ({
    localApprovalId: 'local-1',
    projectId: 'p1',
    teamKey: 'ENG',
    config: config.value,
    controlRevision: 1,
    columnColors: {},
    credentialGeneration,
    userId: 'u1',
    client
  })
  const contextForProject = vi.fn(async () => context())
  const service = new LinearIssueService({
    cache: new LinearIssueCache(userDataDir),
    coordinator: new LinearRequestCoordinator({ now: () => now, sleep: async () => undefined }),
    contextForProject,
    now: () => now,
    setInterval: () => 0,
    clearInterval: () => undefined
  })
  return {
    service,
    client,
    listIssues,
    getIssue,
    updateIssueState,
    listWorkflowStates,
    contextForProject,
    bumpCredential: () => { credentialGeneration += 1 }
  }
}

beforeEach(async () => {
  userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-linear-service-'))
  now = 1_000_000
})
afterEach(async () => {
  await fs.rm(userDataDir, { recursive: true, force: true })
})

describe('LinearIssueService refresh', () => {
  it('places issues by their workflow state and leaves unmapped states in Ungrouped', async () => {
    const h = harness()
    h.listIssues.mockResolvedValueOnce({
      items: [
        issue('1', 'Todo', '2026-08-09T10:00:00Z'),
        issue('2', 'In Progress', '2026-08-09T11:00:00Z'),
        // A state nobody mapped. Normal for triage/backlog — Ungrouped, and NOT a conflict.
        {
          ...issue('3', 'Todo', '2026-08-09T12:00:00Z'),
          state: { id: 's-tri', name: 'Triage', type: 'triage', color: 'eeeeee', position: 0 }
        }
      ]
    })
    await h.service.refresh({ projectId: 'p1' })
    const todo = await h.service.query({ projectId: 'p1', columnId: 'todo', pageSize: 50 })
    const ungrouped = await h.service.query({ projectId: 'p1', columnId: null, pageSize: 50 })
    expect(todo.items.map((i) => i.id)).toEqual(['1'])
    expect(ungrouped.items.map((i) => i.id)).toEqual(['3'])
    expect(ungrouped.counts).toMatchObject({ todo: 1, doing: 1, ungrouped: 1 })
  })

  it('carries each mapped column state type so the board can tell a completion from a cancel', async () => {
    const h = harness()
    await h.service.refresh({ projectId: 'p1' })
    const page = await h.service.query({ projectId: 'p1', columnId: null, pageSize: 50 })
    expect(page.columnStateTypes).toEqual({
      todo: 'unstarted', doing: 'started', done: 'completed', dropped: 'canceled'
    })
  })

  it('follows the relay cursor within one refresh and never persists it', async () => {
    const h = harness()
    h.listIssues
      .mockResolvedValueOnce({ items: [issue('1', 'Todo', '2026-08-09T10:00:00Z')], endCursor: 'c2' })
      .mockResolvedValueOnce({ items: [issue('2', 'Todo', '2026-08-09T11:00:00Z')] })
    await h.service.refresh({ projectId: 'p1' })
    expect(h.listIssues.mock.calls[1][1]).toMatchObject({ after: 'c2' })
    // The next refresh starts a fresh scan: a cursor addresses a position in one result set.
    now += REFRESH_MIN_INTERVAL_MS + 1
    h.listIssues.mockResolvedValueOnce({ items: [] })
    await h.service.refresh({ projectId: 'p1' })
    expect(h.listIssues.mock.calls[2][1].after).toBeUndefined()
  })

  it('asks incrementally with a 2 s overlap after the first full pass', async () => {
    const h = harness()
    const firstStart = now
    await h.service.refresh({ projectId: 'p1' })
    expect(h.listIssues.mock.calls[0][1].updatedSince).toBeUndefined()
    now += FULL_REFRESH_MIN_INTERVAL_MS + 1
    await h.service.refresh({ projectId: 'p1' })
    // `updatedAt` is written by the server, so a filter anchored exactly at our own start instant
    // would drop an issue whose write landed in that same moment.
    expect(h.listIssues.mock.calls[1][1].updatedSince)
      .toBe(new Date(firstStart - 2_000).toISOString())
  })

  it('throttles caller-driven refreshes and keeps the full floor separate', async () => {
    const h = harness()
    await h.service.refresh({ projectId: 'p1' })
    expect(h.listIssues).toHaveBeenCalledTimes(1)
    await h.service.refresh({ projectId: 'p1' })
    expect(h.listIssues).toHaveBeenCalledTimes(1)
    now += REFRESH_MIN_INTERVAL_MS + 1
    await h.service.refresh({ projectId: 'p1' })
    expect(h.listIssues).toHaveBeenCalledTimes(2)
    // An incremental pass does not satisfy a full reconciliation and never moves that floor, so a
    // full request is allowed through immediately even though an incremental just ran.
    await h.service.refresh({ projectId: 'p1', full: true })
    expect(h.listIssues).toHaveBeenCalledTimes(3)
    // ...and once one HAS run, the longer floor holds the next one back.
    now += REFRESH_MIN_INTERVAL_MS + 1
    await h.service.refresh({ projectId: 'p1', full: true })
    expect(h.listIssues).toHaveBeenCalledTimes(3)
    now += FULL_REFRESH_MIN_INTERVAL_MS + 1
    await h.service.refresh({ projectId: 'p1', full: true })
    expect(h.listIssues).toHaveBeenCalledTimes(4)
  })

  it('does not let a FAILED refresh hold the floor', async () => {
    // Otherwise the first network blip disables the board's own Retry button for 30 seconds.
    const h = harness()
    h.listIssues.mockRejectedValueOnce(new Error('offline'))
    await expect(h.service.refresh({ projectId: 'p1' })).rejects.toThrow('offline')
    await h.service.refresh({ projectId: 'p1' })
    expect(h.listIssues).toHaveBeenCalledTimes(2)
  })
})

describe('LinearIssueService moveIssue', () => {
  const seed = async (h: ReturnType<typeof harness>, state = 'Todo'): Promise<void> => {
    h.listIssues.mockResolvedValueOnce({ items: [issue('1', state, '2026-08-09T10:00:00Z')] })
    await h.service.refresh({ projectId: 'p1' })
  }

  it('is read only until a complete refresh has succeeded', async () => {
    const h = harness()
    h.listIssues.mockRejectedValueOnce(new Error('offline'))
    await expect(h.service.refresh({ projectId: 'p1' })).rejects.toThrow()
    expect(await h.service.moveIssue({
      projectId: 'p1', issueId: '1', toColumnId: 'done', expectedUpdatedAt: 'x'
    })).toEqual({ status: 'read-only' })
  })

  it('writes the destination state and confirms', async () => {
    const h = harness()
    await seed(h)
    const result = await h.service.moveIssue({
      projectId: 'p1', issueId: '1', toColumnId: 'done', expectedUpdatedAt: '2026-08-09T10:00:00Z'
    })
    expect(h.updateIssueState).toHaveBeenCalledWith('1', 's-done')
    expect(result.status).toBe('confirmed')
  })

  it('refuses a move onto Ungrouped', async () => {
    // Every Linear issue is always in exactly one state, so there is no write meaning "no state".
    const h = harness()
    await seed(h)
    expect(await h.service.moveIssue({
      projectId: 'p1', issueId: '1', toColumnId: null, expectedUpdatedAt: '2026-08-09T10:00:00Z'
    })).toEqual({ status: 'invalid-target' })
    expect(h.updateIssueState).not.toHaveBeenCalled()
  })

  it('refuses a destination whose mapped state no longer exists, without guessing', async () => {
    const h = harness({ client: { listWorkflowStates: vi.fn(async () => STATES.filter((s) => s.name !== 'Done')) } })
    await seed(h)
    expect(await h.service.moveIssue({
      projectId: 'p1', issueId: '1', toColumnId: 'done', expectedUpdatedAt: '2026-08-09T10:00:00Z'
    })).toEqual({ status: 'invalid-target' })
    expect(h.updateIssueState).not.toHaveBeenCalled()
  })

  it('refuses an issue that is not in the snapshot', async () => {
    const h = harness()
    await seed(h)
    expect(await h.service.moveIssue({
      projectId: 'p1', issueId: 'nope', toColumnId: 'done', expectedUpdatedAt: 'x'
    })).toEqual({ status: 'invalid-target' })
  })

  it('reports stale with the refreshed issue when the server moved on', async () => {
    const h = harness()
    await seed(h)
    h.getIssue.mockResolvedValueOnce(issue('1', 'In Progress', '2026-08-09T12:00:00Z'))
    const result = await h.service.moveIssue({
      projectId: 'p1', issueId: '1', toColumnId: 'done', expectedUpdatedAt: '2026-08-09T10:00:00Z'
    })
    expect(result).toMatchObject({ status: 'stale' })
    expect(h.updateIssueState).not.toHaveBeenCalled()
    // The refreshed issue is folded into the snapshot so the board stops showing the stale one.
    const doing = await h.service.query({ projectId: 'p1', columnId: 'doing', pageSize: 50 })
    expect(doing.items.map((i) => i.id)).toEqual(['1'])
  })

  it('does not write when the issue is already in the destination state', async () => {
    // A drag that lands where the card already sits would otherwise reorder it in Linear for no
    // reason the user asked for.
    const h = harness()
    await seed(h, 'Done')
    h.getIssue.mockResolvedValueOnce(issue('1', 'Done', '2026-08-09T10:00:00Z'))
    const result = await h.service.moveIssue({
      projectId: 'p1', issueId: '1', toColumnId: 'done', expectedUpdatedAt: '2026-08-09T10:00:00Z'
    })
    expect(h.getIssue).toHaveBeenCalled()
    expect(h.updateIssueState).not.toHaveBeenCalled()
    expect(result.status).toBe('confirmed')
  })

  it('abandons the write when the credential boundary moves mid-move', async () => {
    const h = harness()
    await seed(h)
    h.getIssue.mockImplementationOnce(async (id: string) => {
      h.bumpCredential()
      return issue(id, 'Todo', '2026-08-09T10:00:00Z')
    })
    const result = await h.service.moveIssue({
      projectId: 'p1', issueId: '1', toColumnId: 'done', expectedUpdatedAt: '2026-08-09T10:00:00Z'
    })
    expect(result).toEqual({ status: 'configuration-changed' })
    expect(h.updateIssueState).not.toHaveBeenCalled()
  })
})

describe('LinearIssueService clearCache', () => {
  it('drops the snapshot and its binding', async () => {
    const h = harness()
    h.listIssues.mockResolvedValueOnce({ items: [issue('1', 'Todo', '2026-08-09T10:00:00Z')] })
    await h.service.refresh({ projectId: 'p1' })
    expect((await h.service.query({ projectId: 'p1', columnId: 'todo', pageSize: 50 })).items)
      .toHaveLength(1)
    await h.service.clearCache({ projectId: 'p1' })
    const page = await h.service.query({ projectId: 'p1', columnId: 'todo', pageSize: 50 })
    expect(page.items).toEqual([])
    expect(page.readOnly).toBe(true)
  })
})
