import type { Project } from '../../shared/types'
import type {
  LinearAuthStatus,
  LinearControlState,
  LinearControlView,
  LinearTeamSummary,
  LinearWorkflowState
} from '../../shared/linear-issues'
import { foldStateName, normaliseProjectKanbanLinear, parseLinearTeamKey } from './config'
import type { LinearSecretStore, ResolvedLinearCredential } from './credentials'
import type {
  LinearIssueProjectContext,
  LinearIssueServiceContext,
  LinearIssuesClientLike
} from './service'

export class LinearHostError extends Error {
  constructor(readonly code:
    | 'project-not-found'
    | 'invalid-configuration'
    | 'team-not-configured'
    | 'team-mismatch'
    | 'not-approved'
    | 'not-authenticated'
    | 'invalid-key'
    | 'configuration-changed') {
    super(code)
  }
}

type ProjectRecord = { project: Project; localApprovalId: string }

type ControlStoreLike = {
  load(): Promise<LinearControlState>
  approve(input: {
    expectedRevision: number
    localApprovalId: string
    projectId: string
    teamKey: string
  }): Promise<LinearControlState>
  revoke(input: { expectedRevision: number; localApprovalId: string }): Promise<LinearControlState>
  isApproved(state: LinearControlState, input: {
    localApprovalId: string
    projectId: string
    teamKey: string
  }): boolean
}

type CredentialResolverLike = {
  resolve(): Promise<ResolvedLinearCredential | null>
  status(): Promise<LinearAuthStatus>
}

type HostDependencies = {
  project(projectId: string): Promise<ProjectRecord | null>
  controls: ControlStoreLike
  resolver: CredentialResolverLike
  secret: LinearSecretStore
  validateKey(apiKey: string): Promise<{ userId: string; name: string } | null>
  client(apiKey: string): LinearIssuesClientLike & {
    listTeams(): Promise<LinearTeamSummary[]>
  }
  /** The team's states, routed through the service's memo so the Settings page does not spend a
   *  query per status poll. Returns null when they cannot be read — an unreadable answer must not
   *  be reported as "your mapping is broken". */
  workflowStatesForProject?(projectId: string): Promise<LinearWorkflowState[] | null>
  onCredentialBoundaryChange?(): void
}

type ResolvedProject = ProjectRecord & {
  teamKey: string
  config: LinearIssueServiceContext['config']
}

/**
 * The trust boundary: which project may reach Linear, with which credential, for which team.
 *
 * Mirrors `GitHubHostController` with one structural simplification — there is no
 * `detectRepository` equivalent. Nothing in a git checkout names a Linear team, so the team is
 * whatever the project's configuration says and nothing else; a project with no configured team is
 * `team-not-configured` rather than falling back to something guessed from the working directory.
 */
export class LinearHostController {
  private credentialGeneration = 0

  constructor(private readonly dependencies: HostDependencies) {}

  async status(projectId?: string): Promise<LinearControlView> {
    const state = await this.dependencies.controls.load()
    if (!projectId) {
      return {
        control: { revision: state.revision },
        auth: await this.dependencies.resolver.status()
      }
    }

    const record = await this.dependencies.project(projectId)
    if (!record) throw new LinearHostError('project-not-found')
    const board = record.project.kanban
    const config = board?.linear
      ? normaliseProjectKanbanLinear(board.linear, board.columns)
      : null
    const teamKey = config?.ok ? config.value.teamKey : undefined
    const approved = !!teamKey && this.dependencies.controls.isApproved(state, {
      localApprovalId: record.localApprovalId,
      projectId,
      teamKey
    })
    const auth = approved
      ? await this.dependencies.resolver.status()
      : {
          authenticated: false,
          keyPresent: false,
          storage: this.dependencies.secret.availability
        }
    const unknownStates = approved && config?.ok
      ? await this.unknownStates(projectId, config.value.columnMappings.map((item) => item.stateName))
      : []
    return {
      control: { revision: state.revision },
      auth,
      project: {
        projectId,
        ...(teamKey ? { teamKey } : {}),
        approved,
        ...(unknownStates.length ? { unknownStates } : {})
      }
    }
  }

  async approve(input: {
    projectId: string
    teamKey: string
    expectedRevision: number
  }): Promise<LinearControlView> {
    const project = await this.resolveProject(input.projectId)
    if (parseLinearTeamKey(input.teamKey) !== project.teamKey) {
      throw new LinearHostError('team-mismatch')
    }
    await this.dependencies.controls.approve({
      ...input,
      localApprovalId: project.localApprovalId,
      teamKey: project.teamKey
    })
    return this.status(input.projectId)
  }

  async revoke(input: { projectId: string; expectedRevision: number }): Promise<LinearControlView> {
    const record = await this.dependencies.project(input.projectId)
    if (!record) throw new LinearHostError('project-not-found')
    await this.dependencies.controls.revoke({
      expectedRevision: input.expectedRevision,
      localApprovalId: record.localApprovalId
    })
    this.dependencies.onCredentialBoundaryChange?.()
    return this.status(input.projectId)
  }

  async saveKey(apiKey: string): Promise<LinearControlView> {
    const identity = await this.dependencies.validateKey(apiKey)
    if (!identity) throw new LinearHostError('invalid-key')
    await this.dependencies.secret.save(apiKey)
    this.credentialGeneration += 1
    this.dependencies.onCredentialBoundaryChange?.()
    return this.status()
  }

  async clearKey(): Promise<LinearControlView> {
    await this.dependencies.secret.clear()
    this.credentialGeneration += 1
    this.dependencies.onCredentialBoundaryChange?.()
    return this.status()
  }

  /** The workspace's teams, for the picker that replaces GitHub's git-origin detection. Requires
   *  only a valid key — a team list is not project-scoped, and the user needs it BEFORE there is
   *  anything to approve. */
  async teams(): Promise<LinearTeamSummary[]> {
    const credential = await this.dependencies.resolver.resolve()
    if (!credential) throw new LinearHostError('not-authenticated')
    return this.dependencies.client(credential.apiKey).listTeams()
  }

  /** A team's workflow states, for the column→state mapping UI. Same reasoning as `teams`: the
   *  mapping is built before approval exists. */
  async states(teamKey: string): Promise<LinearWorkflowState[]> {
    const key = parseLinearTeamKey(teamKey)
    if (!key) throw new LinearHostError('invalid-configuration')
    const credential = await this.dependencies.resolver.resolve()
    if (!credential) throw new LinearHostError('not-authenticated')
    return this.dependencies.client(credential.apiKey).listWorkflowStates(key)
  }

  async contextForProject(projectId: string): Promise<LinearIssueServiceContext> {
    const project = await this.projectContextForCache(projectId)
    const state = await this.dependencies.controls.load()
    if (state.revision !== project.controlRevision) {
      throw new LinearHostError('configuration-changed')
    }
    const credential = await this.dependencies.resolver.resolve()
    if (!credential) throw new LinearHostError('not-authenticated')
    return {
      ...project,
      credentialGeneration: this.credentialGeneration,
      userId: credential.userId,
      client: this.dependencies.client(credential.apiKey)
    }
  }

  async projectContextForCache(projectId: string): Promise<LinearIssueProjectContext> {
    const project = await this.resolveProject(projectId)
    const state = await this.dependencies.controls.load()
    if (!this.dependencies.controls.isApproved(state, {
      localApprovalId: project.localApprovalId,
      projectId,
      teamKey: project.teamKey
    })) throw new LinearHostError('not-approved')
    return this.cacheProjectContext(project, state.revision)
  }

  async projectContextForCacheDeletion(projectId: string): Promise<LinearIssueProjectContext> {
    const project = await this.resolveProject(projectId)
    const state = await this.dependencies.controls.load()
    return this.cacheProjectContext(project, state.revision)
  }

  private async unknownStates(projectId: string, mapped: string[]): Promise<string[]> {
    if (!this.dependencies.workflowStatesForProject || mapped.length === 0) return []
    const states = await this.dependencies.workflowStatesForProject(projectId).catch(() => null)
    // null = we could not read them. A failed read is not evidence that a mapping is stale, and
    // reporting it as one would put a red "unknown state" warning on a perfectly good board every
    // time the network hiccups.
    if (!states) return []
    const known = new Set(states.map((state) => foldStateName(state.name)))
    return mapped.filter((name) => !known.has(foldStateName(name)))
  }

  private cacheProjectContext(
    project: ResolvedProject,
    controlRevision: number
  ): LinearIssueProjectContext {
    return {
      localApprovalId: project.localApprovalId,
      projectId: project.project.id,
      teamKey: project.teamKey,
      config: project.config,
      controlRevision,
      columnColors: Object.fromEntries(
        (project.project.kanban?.columns ?? []).map((column) => [column.id, column.color])
      )
    }
  }

  private async resolveProject(projectId: string): Promise<ResolvedProject> {
    const record = await this.dependencies.project(projectId)
    if (!record) throw new LinearHostError('project-not-found')
    const board = record.project.kanban
    if (!board?.linear) throw new LinearHostError('invalid-configuration')
    const config = normaliseProjectKanbanLinear(board.linear, board.columns)
    if (!config.ok) throw new LinearHostError('invalid-configuration')
    if (!config.value.teamKey) throw new LinearHostError('team-not-configured')
    return { ...record, teamKey: config.value.teamKey, config: config.value }
  }
}
