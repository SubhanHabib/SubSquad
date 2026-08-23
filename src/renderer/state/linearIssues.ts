// The board's Linear pages, ref-counted per project — a straight sibling of
// `state/githubIssues.ts`, deliberately kept as a separate store rather than a generic one.
//
// The two providers disagree about identity (`moving` and `issueStatus` are keyed by an int issue
// NUMBER for GitHub and by a UUID string here), and a shared store would have to be generic over
// that key on every line while both providers' pages, cursors and status wording stayed distinct.
// The board meets them a level above instead, at the `kanbanSources` registry, which places each
// source's own card component rather than unifying their data.
import { create } from 'zustand'
import type {
  LinearIssuePage,
  LinearIssuesApi,
  LinearMutationResult
} from '@shared/linear-issues'

export interface LinearProjectPages {
  pages: Record<string, LinearIssuePage>
  columns: string[]
  moving: Record<string, true>
  loading: boolean
  error?: string
  labelFilter: string[]
  issueStatus: Record<string, string>
  generation: number
  loadGeneration: number
}

interface LinearIssuesState {
  projects: Record<string, LinearProjectPages>
  connect(api: LinearIssuesApi, projectId: string, columns: string[], labelFilter?: string[]): Promise<() => void>
  reload(api: LinearIssuesApi, projectId: string): Promise<void>
  loadMore(api: LinearIssuesApi, projectId: string, columnId: string | null): Promise<void>
  move(
    api: LinearIssuesApi,
    projectId: string,
    issueId: string,
    toColumnId: string | null,
    expectedUpdatedAt: string
  ): Promise<LinearMutationResult>
}

const keyFor = (columnId: string | null): string => columnId ?? 'ungrouped'
let nextConnectionGeneration = 0

type HostSubscription = {
  api: LinearIssuesApi
  refs: number
  subscribed: boolean
  pending?: Promise<void>
}

const hostSubscriptions = new WeakMap<LinearIssuesApi, Map<string, HostSubscription>>()

function subscriptionsFor(api: LinearIssuesApi): Map<string, HostSubscription> {
  let subscriptions = hostSubscriptions.get(api)
  if (!subscriptions) {
    subscriptions = new Map()
    hostSubscriptions.set(api, subscriptions)
  }
  return subscriptions
}

async function acquireHostSubscription(api: LinearIssuesApi, projectId: string): Promise<() => void> {
  const subscriptions = subscriptionsFor(api)
  let record = subscriptions.get(projectId)
  if (!record) {
    record = { api, refs: 0, subscribed: false }
    subscriptions.set(projectId, record)
  }
  record.refs += 1
  try {
    if (!record.subscribed) {
      if (!record.pending) {
        const current = record
        current.pending = current.api.subscribe(projectId).then(() => {
          current.subscribed = true
        }).finally(() => {
          delete current.pending
        })
      }
      await record.pending
    }
  } catch (error) {
    record.refs -= 1
    if (record.refs === 0 && subscriptions.get(projectId) === record) {
      subscriptions.delete(projectId)
    }
    throw error
  }
  let released = false
  return () => {
    if (released) return
    released = true
    record!.refs -= 1
    if (record!.refs !== 0 || subscriptions.get(projectId) !== record) return
    subscriptions.delete(projectId)
    if (record!.subscribed) void record!.api.unsubscribe(projectId)
  }
}

export const useLinearIssues = create<LinearIssuesState>((set, get) => ({
  projects: {},

  async connect(api, projectId, columns, labelFilter = []) {
    const generation = ++nextConnectionGeneration
    const ownsConnection = (): boolean =>
      get().projects[projectId]?.generation === generation
    set((state) => ({
      projects: {
        ...state.projects,
        [projectId]: {
          pages: {}, columns, moving: {}, loading: true, labelFilter, issueStatus: {},
          generation, loadGeneration: 0
        }
      }
    }))
    let live = true
    let releaseHost: (() => void) | undefined
    const changed = api.onChanged(projectId, () => {
      if (live && ownsConnection()) void get().reload(api, projectId)
    })
    const teardown = (): void => {
      if (!live) return
      live = false
      changed()
      releaseHost?.()
      if (!ownsConnection()) return
      set((state) => {
        if (state.projects[projectId]?.generation !== generation) return state
        const projects = { ...state.projects }
        delete projects[projectId]
        return { projects }
      })
    }
    try {
      releaseHost = await acquireHostSubscription(api, projectId)
      if (!ownsConnection()) {
        live = false
        changed()
        releaseHost()
        return () => undefined
      }
      const loadGeneration = get().projects[projectId]?.loadGeneration ?? 0
      const columnPages = await Promise.all([null, ...columns].map(async (columnId) => [
        keyFor(columnId),
        await api.query({ projectId, columnId, pageSize: 50, labelFilter })
      ] as const))
      set((state) => state.projects[projectId]?.generation === generation &&
        state.projects[projectId]?.loadGeneration === loadGeneration ? ({
        projects: {
          ...state.projects,
          [projectId]: {
            pages: Object.fromEntries(columnPages),
            columns,
            moving: state.projects[projectId]?.moving ?? {},
            issueStatus: state.projects[projectId]?.issueStatus ?? {},
            loading: false,
            labelFilter,
            generation,
            loadGeneration
          }
        }
      }) : state)
    } catch (error) {
      set((state) => state.projects[projectId]?.generation === generation ? ({
        projects: {
          ...state.projects,
          [projectId]: {
            pages: {}, columns, moving: {}, loading: false, labelFilter, issueStatus: {},
            error: error instanceof Error ? error.message : 'Linear issues are unavailable',
            generation,
            loadGeneration: state.projects[projectId]?.loadGeneration ?? 0
          }
        }
      }) : state)
    }
    if (!ownsConnection()) {
      live = false
      changed()
      releaseHost?.()
      return () => undefined
    }
    return teardown
  },

  async reload(api, projectId) {
    const current = get().projects[projectId]
    if (!current) return
    const generation = current.generation
    const loadGeneration = current.loadGeneration + 1
    set((state) => {
      const existing = state.projects[projectId]
      return existing?.generation === generation ? {
        projects: {
          ...state.projects,
          [projectId]: { ...existing, loadGeneration }
        }
      } : state
    })
    try {
      const pages = await Promise.all([null, ...current.columns].map(async (columnId) => [
        keyFor(columnId),
        await api.query({ projectId, columnId, pageSize: 50, labelFilter: current.labelFilter })
      ] as const))
      set((state) => {
        const existing = state.projects[projectId]
        if (existing?.generation !== generation || existing.loadGeneration !== loadGeneration) return state
        return existing ? {
          projects: {
            ...state.projects,
            [projectId]: { ...existing, pages: Object.fromEntries(pages), loading: false, error: undefined }
          }
        } : state
      })
    } catch (error) {
      set((state) => {
        const existing = state.projects[projectId]
        if (existing?.generation !== generation || existing.loadGeneration !== loadGeneration) return state
        return existing ? {
          projects: {
            ...state.projects,
            [projectId]: {
              ...existing,
              loading: false,
              error: error instanceof Error ? error.message : 'Linear issues are unavailable'
            }
          }
        } : state
      })
    }
  },

  async loadMore(api, projectId, columnId) {
    const project = get().projects[projectId]
    const current = project?.pages[keyFor(columnId)]
    if (!project || !current?.nextCursor) return
    const generation = project.generation
    const loadGeneration = project.loadGeneration
    const next = await api.query({
      projectId,
      columnId,
      pageSize: 50,
      cursor: current.nextCursor,
      labelFilter: project.labelFilter
    })
    set((state) => {
      const existing = state.projects[projectId]
      if (!existing || existing.generation !== generation ||
          existing.loadGeneration !== loadGeneration) return state
      return {
        projects: {
          ...state.projects,
          [projectId]: {
            ...existing,
            pages: {
              ...existing.pages,
              [keyFor(columnId)]: { ...next, items: [...current.items, ...next.items] }
            }
          }
        }
      }
    })
  },

  async move(api, projectId, issueId, toColumnId, expectedUpdatedAt) {
    const generation = get().projects[projectId]?.generation
    set((state) => {
      const project = state.projects[projectId]
      if (!project || project.generation !== generation) return state
      return {
        projects: {
          ...state.projects,
          [projectId]: { ...project, moving: { ...project.moving, [issueId]: true } }
        }
      }
    })
    try {
      const result = await api.moveIssue({ projectId, issueId, toColumnId, expectedUpdatedAt })
      const status = result.status === 'confirmed'
        ? 'Synced with Linear.'
        : result.status === 'refresh-pending'
          ? 'Updated in Linear. Local refresh is pending.'
          : result.status === 'stale'
            ? 'Changed in Linear. Review the latest issue and retry.'
            : result.status === 'read-only'
              ? 'This team is read only until a complete refresh succeeds.'
              : result.status === 'invalid-target'
                ? 'This issue or destination state is no longer available.'
                : result.status === 'configuration-changed'
                  ? 'Linear settings changed. Refresh and retry.'
                  : result.message
      set((state) => {
        const project = state.projects[projectId]
        if (!project || project.generation !== generation) return state
        const pages = result.status === 'stale'
          ? Object.fromEntries(Object.entries(project.pages).map(([key, page]) => [key, {
            ...page,
            items: page.items.map((item) => item.id === issueId
              ? { ...item, ...result.issue }
              : item)
          }]))
          : project.pages
        return { projects: { ...state.projects, [projectId]: {
          ...project, pages, issueStatus: { ...project.issueStatus, [issueId]: status }
        } } }
      })
      if (result.status === 'confirmed' || result.status === 'refresh-pending' || result.status === 'stale') {
        await get().reload(api, projectId)
      }
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Linear sync failed'
      set((state) => {
        const project = state.projects[projectId]
        return project?.generation === generation ? { projects: { ...state.projects, [projectId]: {
          ...project, issueStatus: { ...project.issueStatus, [issueId]: `Sync failed. ${message}` }
        } } } : state
      })
      return { status: 'failed', message }
    } finally {
      set((state) => {
        const project = state.projects[projectId]
        if (!project || project.generation !== generation) return state
        const moving = { ...project.moving }
        delete moving[issueId]
        return { projects: { ...state.projects, [projectId]: { ...project, moving } } }
      })
    }
  }
}))
