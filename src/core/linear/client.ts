import type {
  LinearIssue,
  LinearIssueLabel,
  LinearIssuePageResult,
  LinearIssueUser,
  LinearTeamSummary,
  LinearWorkflowState
} from '../../shared/linear-issues'
import { parseLinearTeamKey } from './config'

const API_URL = 'https://api.linear.app/graphql'
const DEFAULT_MAX_RESPONSE = 8 * 1024 * 1024
const MAX_PAGE_SIZE = 100

/**
 * The error union is IDENTICAL to `GitHubClientError`'s, and that is load-bearing rather than
 * cosmetic: `IssueRequestCoordinator.noteOperationRateLimit` duck-types `{ code: 'rate-limited',
 * retryAt }`, so sharing the vocabulary is what lets the coordinator's backoff work for Linear
 * with no changes at all.
 */
export class LinearClientError extends Error {
  constructor(
    readonly code: 'invalid-request' | 'malformed-response' | 'response-too-large' |
      'request-failed' | 'rate-limited' | 'insufficient-permission',
    readonly status?: number,
    readonly retryAt?: number
  ) {
    super(code)
  }
}

/**
 * Reset headers, in the order we trust them.
 *
 * Linear's public documentation and its actual responses have not agreed on these names across
 * versions, and the one thing that must never happen is a WRONG value being trusted: a reset stamp
 * parsed out of the wrong header pauses the whole identity for however long that number implies.
 * So this is a ladder of candidates, every value is sanity-checked against a bounded future window
 * by `resolveRetryAt`, and anything that fails those checks falls through to plain exponential
 * backoff — which is always safe, merely slower. Adding a name here is cheap; trusting an
 * unbounded one is not.
 */
export const RATE_LIMIT_RESET_HEADERS = [
  'x-ratelimit-requests-reset',
  'x-ratelimit-reset',
  'x-ratelimit-complexity-reset'
] as const

/** Longest pause a header is allowed to ask for. Beyond this we assume we misread the units. */
const MAX_RETRY_WINDOW_MS = 60 * 60_000

/**
 * Turn whatever the response said into an absolute instant, or null when nothing was credible.
 *
 * Two unit ambiguities are handled explicitly because both appear in the wild: `Retry-After` is
 * either delta-seconds or an HTTP date, and a reset stamp is either unix seconds or unix
 * milliseconds. Magnitude disambiguates the latter (a seconds-epoch value is ~1.7e9; a
 * milliseconds one is ~1.7e12), and the bounded window catches the case where it does not.
 */
export function resolveRetryAt(
  headers: { get(name: string): string | null },
  now: number
): number | null {
  const retryAfter = headers.get('retry-after')
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds > 0) {
      const at = now + seconds * 1_000
      if (at - now <= MAX_RETRY_WINDOW_MS) return at
    } else {
      const date = Date.parse(retryAfter)
      if (Number.isFinite(date) && date > now && date - now <= MAX_RETRY_WINDOW_MS) return date
    }
  }
  for (const name of RATE_LIMIT_RESET_HEADERS) {
    const raw = headers.get(name)
    if (!raw) continue
    const value = Number(raw)
    if (!Number.isFinite(value) || value <= 0) continue
    // > 1e12 is unambiguously milliseconds-since-epoch; anything smaller is read as seconds.
    const at = value > 1e12 ? value : value * 1_000
    if (at > now && at - now <= MAX_RETRY_WINDOW_MS) return at
  }
  return null
}

type ClientOptions = {
  apiKey: string
  fetch?: typeof fetch
  maxResponseBytes?: number
  timeoutMs?: number
  now?: () => number
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function string(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum
}

function isoDate(value: unknown): value is string {
  return string(value, 64) && !Number.isNaN(Date.parse(value))
}

function hexColour(value: unknown): string {
  // Linear sends "#4cb782"; the board renders six bare hex digits like GitHub's labels do.
  if (typeof value !== 'string') return '8b5cf6'
  const match = value.trim().replace(/^#/, '')
  return /^[0-9a-fA-F]{6}$/.test(match) ? match.toLowerCase() : '8b5cf6'
}

const STATE_TYPES = new Set([
  'triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled'
])

export function workflowStateFrom(value: unknown): LinearWorkflowState | null {
  const item = object(value)
  if (!item || !string(item.id, 128) || !item.id || !string(item.name, 200) || !item.name ||
      typeof item.type !== 'string' || !STATE_TYPES.has(item.type)) return null
  const position = Number(item.position)
  return {
    id: item.id,
    name: item.name,
    type: item.type as LinearWorkflowState['type'],
    color: hexColour(item.color),
    position: Number.isFinite(position) ? position : 0
  }
}

function labelFrom(value: unknown): LinearIssueLabel | null {
  const item = object(value)
  if (!item || !string(item.id, 128) || !item.id || !string(item.name, 200) || !item.name) return null
  return { id: item.id, name: item.name, color: hexColour(item.color) }
}

function userFrom(value: unknown): LinearIssueUser | null {
  const item = object(value)
  if (!item || !string(item.id, 128) || !item.id || !string(item.name, 200)) return null
  let avatarUrl: string | undefined
  if (string(item.avatarUrl, 2_048) && item.avatarUrl) {
    try {
      const url = new URL(item.avatarUrl)
      if (url.protocol === 'https:') avatarUrl = url.toString()
    } catch {
      avatarUrl = undefined
    }
  }
  return { id: item.id, name: item.name, ...(avatarUrl ? { avatarUrl } : {}) }
}

function nodesOf(value: unknown): unknown[] | null {
  const container = object(value)
  if (!container) return null
  return Array.isArray(container.nodes) ? container.nodes : null
}

export function issueFrom(value: unknown): LinearIssue | null {
  const item = object(value)
  if (!item || !string(item.id, 128) || !item.id ||
      !string(item.identifier, 64) || !item.identifier ||
      !string(item.title, 1_024) ||
      !(item.description === null || item.description === undefined ||
        string(item.description, 1_000_000)) ||
      !string(item.url, 2_048) ||
      !isoDate(item.createdAt) || !isoDate(item.updatedAt)) return null
  const number = Number(item.number)
  if (!Number.isSafeInteger(number) || number < 0) return null
  const state = workflowStateFrom(item.state)
  if (!state) return null
  const labelNodes = nodesOf(item.labels) ?? []
  if (labelNodes.length > 100) return null
  const labels = labelNodes.map(labelFrom)
  if (labels.some((label) => !label)) return null
  const assignee = item.assignee === null || item.assignee === undefined
    ? null
    : userFrom(item.assignee)
  if (item.assignee && !assignee) return null
  let url: URL
  try {
    url = new URL(item.url)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  const priority = Number(item.priority)
  const estimate = item.estimate === null || item.estimate === undefined
    ? null
    : Number(item.estimate)
  if (estimate !== null && !Number.isFinite(estimate)) return null
  const cycle = object(item.cycle)
  const project = object(item.project)
  return {
    id: item.id,
    identifier: item.identifier,
    number,
    title: item.title,
    description: item.description ?? '',
    url: url.toString(),
    state,
    labels: labels as LinearIssueLabel[],
    assignee,
    priority: Number.isFinite(priority) && priority >= 0 && priority <= 4 ? priority : 0,
    estimate,
    dueDate: string(item.dueDate, 32) ? item.dueDate : null,
    cycleName: cycle && string(cycle.name, 200) && cycle.name
      ? cycle.name
      : cycle && Number.isFinite(Number(cycle.number))
        ? `Cycle ${Number(cycle.number)}`
        : null,
    projectName: project && string(project.name, 200) ? project.name : null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  }
}

const ISSUE_FIELDS = `
  id
  identifier
  number
  title
  description
  url
  priority
  estimate
  dueDate
  createdAt
  updatedAt
  state { id name type color position }
  labels(first: 20) { nodes { id name color } }
  assignee { id name avatarUrl }
  cycle { number name }
  project { name }
`

export class LinearIssuesClient {
  private readonly fetcher: typeof fetch
  private readonly maximum: number
  private readonly timeoutMs: number
  private readonly now: () => number
  private backoffMs = 1_000

  constructor(private readonly options: ClientOptions) {
    this.fetcher = options.fetch ?? fetch
    this.maximum = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE
    this.timeoutMs = options.timeoutMs ?? 15_000
    this.now = options.now ?? Date.now
  }

  async getAuthenticatedUser(): Promise<{ userId: string; name: string }> {
    const data = await this.post('query { viewer { id name } }', {})
    const viewer = object(object(data)?.viewer)
    if (!viewer || !string(viewer.id, 128) || !viewer.id || !string(viewer.name, 200)) {
      throw new LinearClientError('malformed-response')
    }
    return { userId: viewer.id, name: viewer.name }
  }

  async listTeams(): Promise<LinearTeamSummary[]> {
    const data = await this.post(
      'query { teams(first: 250) { nodes { id key name } } }', {}
    )
    const nodes = nodesOf(object(data)?.teams)
    if (!nodes) throw new LinearClientError('malformed-response')
    const teams = nodes.map((candidate): LinearTeamSummary | null => {
      const item = object(candidate)
      if (!item || !string(item.id, 128) || !item.id || !string(item.name, 200)) return null
      const key = parseLinearTeamKey(item.key)
      return key ? { id: item.id, key, name: item.name } : null
    })
    if (teams.some((team) => !team)) throw new LinearClientError('malformed-response')
    return teams as LinearTeamSummary[]
  }

  async listWorkflowStates(teamKey: string): Promise<LinearWorkflowState[]> {
    const key = parseLinearTeamKey(teamKey)
    if (!key) throw new LinearClientError('invalid-request')
    const data = await this.post(
      `query($key: String!) {
         teams(filter: { key: { eq: $key } }, first: 1) {
           nodes { states(first: 100) { nodes { id name type color position } } }
         }
       }`,
      { key }
    )
    const teams = nodesOf(object(data)?.teams)
    if (!teams) throw new LinearClientError('malformed-response')
    // A key that matches no team is an ANSWER, not a malformed reply: the team was renamed or the
    // key belongs to a workspace this credential cannot see. The host turns the empty list into a
    // `team-not-found`, which is a fixable configuration error rather than a transport failure.
    if (teams.length === 0) return []
    const nodes = nodesOf(object(teams[0])?.states)
    if (!nodes) throw new LinearClientError('malformed-response')
    const states = nodes.map(workflowStateFrom)
    if (states.some((state) => !state)) throw new LinearClientError('malformed-response')
    return (states as LinearWorkflowState[]).sort((a, b) => a.position - b.position)
  }

  async listIssues(teamKey: string, options: {
    first: number
    after?: string
    updatedSince?: string
  }): Promise<LinearIssuePageResult> {
    const key = parseLinearTeamKey(teamKey)
    if (!key) throw new LinearClientError('invalid-request')
    if (!Number.isSafeInteger(options.first) || options.first < 1 || options.first > MAX_PAGE_SIZE) {
      throw new LinearClientError('invalid-request')
    }
    if (options.after !== undefined && !string(options.after, 4_096)) {
      throw new LinearClientError('invalid-request')
    }
    if (options.updatedSince !== undefined && !isoDate(options.updatedSince)) {
      throw new LinearClientError('invalid-request')
    }
    const data = await this.post(
      `query($key: String!, $first: Int!, $after: String, $since: DateTimeOrDuration) {
         issues(
           filter: { team: { key: { eq: $key } }, updatedAt: { gt: $since } }
           orderBy: updatedAt
           first: $first
           after: $after
         ) {
           nodes { ${ISSUE_FIELDS} }
           pageInfo { hasNextPage endCursor }
         }
       }`,
      {
        key,
        first: options.first,
        ...(options.after ? { after: options.after } : {}),
        ...(options.updatedSince ? { since: options.updatedSince } : {})
      }
    )
    const container = object(object(data)?.issues)
    const nodes = nodesOf(container)
    if (!container || !nodes) throw new LinearClientError('malformed-response')
    const items = nodes.map(issueFrom)
    if (items.some((item) => !item)) throw new LinearClientError('malformed-response')
    const pageInfo = object(container.pageInfo)
    const endCursor = pageInfo && pageInfo.hasNextPage === true && string(pageInfo.endCursor, 4_096)
      ? pageInfo.endCursor
      : undefined
    return { items: items as LinearIssue[], ...(endCursor ? { endCursor } : {}) }
  }

  async getIssue(issueId: string): Promise<LinearIssue> {
    if (!string(issueId, 128) || !issueId) throw new LinearClientError('invalid-request')
    const data = await this.post(
      `query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
      { id: issueId }
    )
    const issue = issueFrom(object(data)?.issue)
    if (!issue) throw new LinearClientError('malformed-response')
    return issue
  }

  async updateIssueState(issueId: string, stateId: string): Promise<LinearIssue> {
    if (!string(issueId, 128) || !issueId || !string(stateId, 128) || !stateId) {
      throw new LinearClientError('invalid-request')
    }
    const data = await this.post(
      `mutation($id: String!, $stateId: String!) {
         issueUpdate(id: $id, input: { stateId: $stateId }) {
           success
           issue { ${ISSUE_FIELDS} }
         }
       }`,
      { id: issueId, stateId }
    )
    const payload = object(object(data)?.issueUpdate)
    if (!payload || payload.success !== true) throw new LinearClientError('request-failed')
    const issue = issueFrom(payload.issue)
    if (!issue) throw new LinearClientError('malformed-response')
    return issue
  }

  private async post(query: string, variables: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response
    try {
      response = await this.fetcher(API_URL, {
        method: 'POST',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          // NO `Bearer` prefix. A personal API key is sent raw; the Bearer form is for OAuth
          // access tokens, and Linear answers a prefixed key with an authentication error that
          // reads exactly like a revoked key.
          authorization: this.options.apiKey
        },
        body: JSON.stringify({ query, variables })
      })
    } catch {
      throw new LinearClientError('request-failed')
    } finally {
      clearTimeout(timer)
    }

    if (response.status === 429) throw this.rateLimited(response)
    if (response.status === 401 || response.status === 403) {
      throw new LinearClientError('insufficient-permission', response.status)
    }
    if (!response.ok) throw new LinearClientError('request-failed', response.status)

    const body = object(await this.json(response))
    if (!body) throw new LinearClientError('malformed-response')
    // GraphQL answers a FAILED request with HTTP 200 and a non-empty `errors[]`. A `response.ok`
    // check alone therefore reports every authentication failure, rate limit and validation error
    // as a success whose `data` is null — and the decoders below would call that
    // 'malformed-response', hiding a revoked key behind a parser bug. This branch is the whole
    // reason the client cannot be a thin fetch wrapper.
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      throw this.fromGraphQlErrors(body.errors, response)
    }
    if (body.data === null || body.data === undefined) throw new LinearClientError('malformed-response')
    return body.data
  }

  private fromGraphQlErrors(errors: unknown[], response: Response): LinearClientError {
    const codes = new Set<string>()
    for (const candidate of errors.slice(0, 20)) {
      const error = object(candidate)
      const extensions = object(error?.extensions)
      for (const value of [extensions?.code, extensions?.type, error?.message]) {
        if (typeof value === 'string') codes.add(value.toUpperCase())
      }
    }
    const has = (needle: string): boolean =>
      [...codes].some((code) => code.includes(needle))
    if (has('RATELIMIT') || has('RATE LIMIT')) return this.rateLimited(response)
    if (has('AUTHENTICATION') || has('FORBIDDEN') || has('UNAUTHORIZED')) {
      return new LinearClientError('insufficient-permission', response.status)
    }
    return new LinearClientError('request-failed', response.status)
  }

  private rateLimited(response: Response): LinearClientError {
    const now = this.now()
    const fromHeaders = resolveRetryAt(response.headers, now)
    if (fromHeaders === null) {
      // No credible header: back off exponentially, exactly as the GitHub client does for a
      // secondary limit with no Retry-After.
      const retryAt = now + this.backoffMs
      this.backoffMs = Math.min(this.backoffMs * 2, 60_000)
      return new LinearClientError('rate-limited', response.status, retryAt)
    }
    return new LinearClientError('rate-limited', response.status, fromHeaders)
  }

  private async json(response: Response): Promise<unknown> {
    const length = Number(response.headers.get('content-length'))
    if (Number.isFinite(length) && length > this.maximum) {
      throw new LinearClientError('response-too-large')
    }
    if (!response.body) throw new LinearClientError('malformed-response')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > this.maximum) {
        await reader.cancel()
        throw new LinearClientError('response-too-large')
      }
      chunks.push(next.value)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown
    } catch {
      throw new LinearClientError('malformed-response')
    }
  }
}
