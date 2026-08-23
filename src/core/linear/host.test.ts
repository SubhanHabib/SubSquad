import { describe, expect, it, vi } from 'vitest'
import type { Project } from '../../shared/types'
import type { LinearControlState, LinearWorkflowState } from '../../shared/linear-issues'
import { LinearHostController, LinearHostError } from './host'

const state = (name: string, type: LinearWorkflowState['type']): LinearWorkflowState =>
  ({ id: `s-${name}`, name, type, color: 'aaaaaa', position: 1 })

const project = (teamKey?: string): Project => ({
  id: 'project-1',
  name: 'Test',
  color: '#8b5cf6',
  cwd: '/repo',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [],
  kanban: {
    columns: [
      { id: 'todo', title: 'Todo', color: '#2563eb' },
      { id: 'done', title: 'Done', color: '#16a34a' }
    ],
    assignments: [],
    linear: {
      ...(teamKey ? { teamKey } : {}),
      columnMappings: [
        { columnId: 'todo', stateName: 'Todo' },
        { columnId: 'done', stateName: 'Done' }
      ]
    }
  }
})

function fixture(options: {
  teamKey?: string
  approved?: boolean
  states?: LinearWorkflowState[] | null
} = {}) {
  let control: LinearControlState = {
    version: 1,
    revision: 0,
    approvals: options.approved === false || options.approved === undefined
      ? []
      : [{
          localApprovalId: 'local-1',
          projectId: 'project-1',
          teamKey: options.teamKey ?? 'ENG',
          enabled: true,
          approvedAt: 1
        }]
  }
  let key: string | null = 'lin_api_key'
  const secret = {
    availability: 'encrypted' as const,
    readForHost: vi.fn(async () => key),
    save: vi.fn(async (value: string) => { key = value }),
    clear: vi.fn(async () => { key = null })
  }
  const controls = {
    load: vi.fn(async () => structuredClone(control)),
    approve: vi.fn(async (input: {
      expectedRevision: number
      localApprovalId: string
      projectId: string
      teamKey: string
    }) => {
      control = {
        ...control,
        revision: control.revision + 1,
        approvals: [{
          localApprovalId: input.localApprovalId,
          projectId: input.projectId,
          teamKey: input.teamKey,
          enabled: true,
          approvedAt: 1
        }]
      }
      return structuredClone(control)
    }),
    revoke: vi.fn(async () => {
      control = { ...control, revision: control.revision + 1, approvals: [] }
      return structuredClone(control)
    }),
    isApproved: vi.fn((current: LinearControlState, input: {
      localApprovalId: string
      projectId: string
      teamKey: string
    }) => current.approvals.some((approval) =>
      approval.localApprovalId === input.localApprovalId &&
      approval.projectId === input.projectId &&
      approval.teamKey === input.teamKey))
  }
  const client = {
    listIssues: vi.fn(),
    getIssue: vi.fn(),
    updateIssueState: vi.fn(),
    listWorkflowStates: vi.fn(async () => options.states ?? []),
    listTeams: vi.fn(async () => [{ id: 't1', key: 'ENG', name: 'Engineering' }])
  }
  const controller = new LinearHostController({
    project: async () => ({ project: project(options.teamKey ?? 'ENG'), localApprovalId: 'local-1' }),
    controls,
    resolver: {
      resolve: async () => key ? { userId: 'u1', name: 'Ada', apiKey: key } : null,
      status: async () => ({
        authenticated: !!key,
        keyPresent: !!key,
        storage: 'encrypted' as const,
        ...(key ? { name: 'Ada' } : {})
      })
    },
    secret,
    validateKey: async (value: string) => value.startsWith('lin_') ? { userId: 'u1', name: 'Ada' } : null,
    client: () => client,
    workflowStatesForProject: options.states === null
      ? async () => null
      : async () => options.states ?? []
  })
  return { controller, controls, client, secret }
}

describe('LinearHostController', () => {
  it('reports a mapping that names a state the team no longer has', async () => {
    // The mapping is saved by NAME, so a renamed or deleted state must be surfaced — otherwise the
    // column silently refuses every move with no way for the user to see why.
    const { controller } = fixture({ approved: true, states: [state('Todo', 'unstarted')] })
    const view = await controller.status('project-1')
    expect(view.project?.approved).toBe(true)
    expect(view.project?.unknownStates).toEqual(['Done'])
  })

  it('reports no unknown states when every mapping resolves', async () => {
    const { controller } = fixture({
      approved: true,
      states: [state('Todo', 'unstarted'), state('Done', 'completed')]
    })
    expect((await controller.status('project-1')).project?.unknownStates).toBeUndefined()
  })

  it('never reports a mapping as stale because the states could not be read', async () => {
    // A failed read is not evidence. Reporting it as a broken mapping would put a warning on a
    // perfectly good board on every network hiccup.
    const { controller } = fixture({ approved: true, states: null })
    expect((await controller.status('project-1')).project?.unknownStates).toBeUndefined()
  })

  it('masks the auth block until the project is approved on this machine', async () => {
    const { controller } = fixture({ approved: false })
    const view = await controller.status('project-1')
    expect(view.project?.approved).toBe(false)
    expect(view.auth).toMatchObject({ authenticated: false, keyPresent: false })
  })

  it('refuses to approve a team other than the configured one', async () => {
    const { controller } = fixture({ teamKey: 'ENG', approved: false })
    await expect(controller.approve({
      projectId: 'project-1', teamKey: 'OPS', expectedRevision: 0
    })).rejects.toBeInstanceOf(LinearHostError)
  })

  it('requires a configured team before anything can be approved or read', async () => {
    const controller = new LinearHostController({
      project: async () => ({ project: project(undefined), localApprovalId: 'local-1' }),
      controls: {
        load: async () => ({ version: 1, revision: 0, approvals: [] }),
        approve: async () => ({ version: 1, revision: 1, approvals: [] }),
        revoke: async () => ({ version: 1, revision: 1, approvals: [] }),
        isApproved: () => false
      },
      resolver: {
        resolve: async () => ({ userId: 'u1', name: 'Ada', apiKey: 'lin_x' }),
        status: async () => ({ authenticated: true, keyPresent: true, storage: 'encrypted' })
      },
      secret: {
        availability: 'encrypted',
        readForHost: async () => 'lin_x',
        save: async () => undefined,
        clear: async () => undefined
      },
      validateKey: async () => ({ userId: 'u1', name: 'Ada' }),
      client: () => ({
        listIssues: vi.fn(),
        getIssue: vi.fn(),
        updateIssueState: vi.fn(),
        listWorkflowStates: vi.fn(async () => []),
        listTeams: vi.fn(async () => [])
      })
    })
    await expect(controller.projectContextForCache('project-1')).rejects.toMatchObject({
      code: 'team-not-configured'
    })
    // Status still answers — the settings screen has to be able to say what is missing.
    expect((await controller.status('project-1')).project?.approved).toBe(false)
  })

  it('refuses a context for a project this machine has not approved', async () => {
    const { controller } = fixture({ approved: false })
    await expect(controller.contextForProject('project-1')).rejects.toMatchObject({
      code: 'not-approved'
    })
  })

  it('refuses a context when no key resolves, without touching the client', async () => {
    const { controller, secret } = fixture({ approved: true })
    await controller.clearKey()
    await expect(controller.contextForProject('project-1')).rejects.toMatchObject({
      code: 'not-authenticated'
    })
    expect(secret.clear).toHaveBeenCalled()
  })

  it('refuses to save a key Linear will not validate', async () => {
    const { controller, secret } = fixture({ approved: true })
    await expect(controller.saveKey('nope')).rejects.toMatchObject({ code: 'invalid-key' })
    expect(secret.save).not.toHaveBeenCalled()
  })

  it('bumps the credential generation on a key change so captured work is cancelled', async () => {
    const boundary = vi.fn()
    const { controller } = fixture({ approved: true })
    // The generation rides the service context's epoch; the observable half here is the callback.
    ;(controller as unknown as { dependencies: { onCredentialBoundaryChange?: () => void } })
      .dependencies.onCredentialBoundaryChange = boundary
    await controller.saveKey('lin_new')
    expect(boundary).toHaveBeenCalled()
  })
})
