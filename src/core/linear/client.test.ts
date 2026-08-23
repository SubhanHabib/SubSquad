import { describe, expect, it } from 'vitest'
import { LinearClientError, LinearIssuesClient, resolveRetryAt } from './client'

const NOW = Date.parse('2026-08-23T12:00:00Z')

const issue = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: '11111111-2222-4333-8444-555555555555',
  identifier: 'ENG-12',
  number: 12,
  title: 'Ship the thing',
  description: 'Body',
  url: 'https://linear.app/acme/issue/ENG-12',
  priority: 2,
  estimate: 3,
  dueDate: '2026-09-01',
  createdAt: '2026-08-01T10:00:00Z',
  updatedAt: '2026-08-09T10:00:00Z',
  state: { id: 'state-1', name: 'In Progress', type: 'started', color: '#4cb782', position: 2 },
  labels: { nodes: [{ id: 'l1', name: 'bug', color: '#d73a4a' }] },
  assignee: { id: 'u1', name: 'Ada', avatarUrl: 'https://example.com/a.png' },
  cycle: { number: 4, name: 'Cycle 4' },
  project: { name: 'Platform' },
  ...over
})

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...init.headers },
    ...init
  })
}

const client = (fetcher: typeof fetch): LinearIssuesClient =>
  new LinearIssuesClient({ apiKey: 'lin_api_secret', fetch: fetcher, now: () => NOW })

describe('LinearIssuesClient', () => {
  it('sends the API key with NO Bearer prefix', async () => {
    const calls: RequestInit[] = []
    const c = client(async (_url, init) => {
      calls.push(init ?? {})
      return response({ data: { viewer: { id: 'u1', name: 'Ada' } } })
    })
    await c.getAuthenticatedUser()
    // A personal API key is sent raw. Prefixing it with `Bearer ` (the OAuth form) earns an
    // authentication error that reads exactly like a revoked key.
    expect(new Headers(calls[0].headers).get('authorization')).toBe('lin_api_secret')
  })

  it('treats HTTP 200 carrying a non-empty errors[] as a failure, not a success', async () => {
    // The whole reason this client cannot be a thin fetch wrapper: `response.ok` is TRUE here.
    const c = client(async () => response({
      data: null,
      errors: [{ message: 'Something went wrong', extensions: { code: 'INTERNAL_SERVER_ERROR' } }]
    }))
    await expect(c.getAuthenticatedUser()).rejects.toMatchObject({ code: 'request-failed' })
  })

  it('maps an authentication error in a 200 body to insufficient-permission', async () => {
    const c = client(async () => response({
      data: null,
      errors: [{ message: 'no', extensions: { code: 'AUTHENTICATION_ERROR' } }]
    }))
    await expect(c.listTeams()).rejects.toMatchObject({ code: 'insufficient-permission' })
  })

  it('maps a RATELIMITED error to rate-limited with a parsed retryAt', async () => {
    const reset = Math.floor((NOW + 30_000) / 1_000)
    const c = client(async () => response(
      { data: null, errors: [{ message: 'slow down', extensions: { code: 'RATELIMITED' } }] },
      { headers: { 'x-ratelimit-requests-reset': String(reset) } }
    ))
    const error = await c.listTeams().catch((e: unknown) => e) as LinearClientError
    expect(error.code).toBe('rate-limited')
    expect(error.retryAt).toBe(reset * 1_000)
  })

  it('backs off exponentially when a 429 carries no credible reset header', async () => {
    const c = client(async () => new Response('{}', { status: 429 }))
    const first = await c.listTeams().catch((e: unknown) => e) as LinearClientError
    const second = await c.listTeams().catch((e: unknown) => e) as LinearClientError
    expect(first.code).toBe('rate-limited')
    expect(first.retryAt).toBe(NOW + 1_000)
    expect(second.retryAt).toBe(NOW + 2_000)
  })

  it('refuses a response larger than the cap', async () => {
    const c = new LinearIssuesClient({
      apiKey: 'k',
      maxResponseBytes: 32,
      fetch: async () => response({ data: { viewer: { id: 'u1', name: 'x'.repeat(200) } } })
    })
    await expect(c.getAuthenticatedUser()).rejects.toMatchObject({ code: 'response-too-large' })
  })

  it('decodes an issue, folding Linear-native fields and the single assignee', async () => {
    const c = client(async () => response({
      data: { issues: { nodes: [issue()], pageInfo: { hasNextPage: false, endCursor: null } } }
    }))
    const page = await c.listIssues('ENG', { first: 50 })
    expect(page.items[0]).toMatchObject({
      id: '11111111-2222-4333-8444-555555555555',
      identifier: 'ENG-12',
      priority: 2,
      estimate: 3,
      dueDate: '2026-09-01',
      cycleName: 'Cycle 4',
      projectName: 'Platform',
      assignee: { id: 'u1', name: 'Ada' }
    })
    // Colours arrive as "#4cb782" and are normalised to the six bare hex digits the board renders.
    expect(page.items[0].state.color).toBe('4cb782')
    expect(page.items[0].labels[0].color).toBe('d73a4a')
    expect(page.endCursor).toBeUndefined()
  })

  it('carries the relay cursor only while another page exists', async () => {
    const c = client(async () => response({
      data: { issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'cur-2' } } }
    }))
    expect((await c.listIssues('ENG', { first: 50 })).endCursor).toBe('cur-2')
  })

  it('answers an unmatched team key with an empty state list, not a malformed response', async () => {
    // A key that matches nothing is an ANSWER (renamed team, wrong workspace) the host turns into
    // a fixable configuration error — never a transport failure.
    const c = client(async () => response({ data: { teams: { nodes: [] } } }))
    expect(await c.listWorkflowStates('ENG')).toEqual([])
  })

  it('refuses a mutation the API reported as unsuccessful', async () => {
    const c = client(async () => response({ data: { issueUpdate: { success: false, issue: null } } }))
    await expect(c.updateIssueState('id-1', 'state-2')).rejects.toMatchObject({ code: 'request-failed' })
  })

  it('rejects an invalid team key before spending a request', async () => {
    let called = false
    const c = client(async () => { called = true; return response({ data: {} }) })
    await expect(c.listIssues('not a key', { first: 10 })).rejects.toMatchObject({
      code: 'invalid-request'
    })
    expect(called).toBe(false)
  })
})

describe('resolveRetryAt', () => {
  const headers = (values: Record<string, string>) => new Headers(values)

  it('prefers Retry-After in delta-seconds', () => {
    expect(resolveRetryAt(headers({ 'retry-after': '20' }), NOW)).toBe(NOW + 20_000)
  })

  it('accepts an HTTP-date Retry-After', () => {
    const at = new Date(NOW + 45_000).toUTCString()
    expect(resolveRetryAt(headers({ 'retry-after': at }), NOW)).toBe(Date.parse(at))
  })

  it('reads a reset stamp as seconds or milliseconds by magnitude', () => {
    expect(resolveRetryAt(headers({ 'x-ratelimit-requests-reset': String((NOW + 10_000) / 1_000) }), NOW))
      .toBe(NOW + 10_000)
    expect(resolveRetryAt(headers({ 'x-ratelimit-requests-reset': String(NOW + 10_000) }), NOW))
      .toBe(NOW + 10_000)
  })

  it('falls through the ladder to a later candidate name', () => {
    expect(resolveRetryAt(headers({ 'x-ratelimit-complexity-reset': String(NOW + 5_000) }), NOW))
      .toBe(NOW + 5_000)
  })

  it('rejects a value outside the bounded window rather than trusting it', () => {
    // The names are not fully pinned across Linear's own docs, so a misread unit must degrade to
    // "no credible header" (and thence to backoff) instead of pausing the identity for a day.
    expect(resolveRetryAt(headers({ 'x-ratelimit-requests-reset': String(NOW + 86_400_000) }), NOW))
      .toBeNull()
    expect(resolveRetryAt(headers({ 'retry-after': '-5' }), NOW)).toBeNull()
    expect(resolveRetryAt(headers({}), NOW)).toBeNull()
  })
})
