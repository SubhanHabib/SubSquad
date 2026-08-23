import type { Project } from '../../shared/types'
import type { CorePlatform } from '../platform'
import type { LinearSecretStore } from './credentials'
import { LinearCredentialResolver } from './credentials'
import { LinearControlStore } from './control-store'
import { LinearIssuesClient } from './client'
import { LinearIssueCache } from './cache'
import { LinearRequestCoordinator } from './request-coordinator'
import { LinearHostController } from './host'
import { LinearIssueService } from './service'
import { registerLinearIssueHandlers } from './handlers'
import { IPC } from '../../shared/ipc'

type Dependencies = {
  platform: CorePlatform
  userDataDir: string
  project(projectId: string): Promise<{ project: Project; localApprovalId: string } | null>
  secret: LinearSecretStore
}

export function registerLinearIntegration(dependencies: Dependencies): {
  controller: LinearHostController
  service: LinearIssueService
} {
  const validateKey = async (apiKey: string) => {
    try {
      return await new LinearIssuesClient({ apiKey }).getAuthenticatedUser()
    } catch {
      return null
    }
  }
  const controls = new LinearControlStore(dependencies.userDataDir)
  const coordinator = new LinearRequestCoordinator()
  const resolver = new LinearCredentialResolver({
    secret: dependencies.secret,
    validate: validateKey
  })
  // The controller and the service each need the other: the service asks the controller for a
  // context, and the controller asks the service for the memoised workflow states behind
  // `unknownStates`. The service is assigned immediately below, and nothing can call into this
  // closure before then — every path to it starts at an IPC handler.
  let service: LinearIssueService | undefined
  const controller = new LinearHostController({
    project: dependencies.project,
    controls,
    resolver,
    secret: dependencies.secret,
    validateKey,
    client: (apiKey) => new LinearIssuesClient({ apiKey }),
    workflowStatesForProject: async (projectId) => {
      if (!service) return null
      try {
        return await service.workflowStatesFor(projectId)
      } catch {
        return null
      }
    },
    // Both halves of a credential boundary move: stop work that captured the old credential, and
    // drop the resolver's memo so the next resolve reflects the change immediately instead of
    // serving a revoked key until its TTL happens to lapse.
    onCredentialBoundaryChange: () => {
      coordinator.cancelAll()
      resolver.invalidate()
    }
  })
  service = new LinearIssueService({
    cache: new LinearIssueCache(dependencies.userDataDir),
    coordinator,
    contextForProject: (projectId) => controller.contextForProject(projectId),
    projectContextForCache: (projectId) => controller.projectContextForCache(projectId),
    projectContextForCacheDeletion: (projectId) =>
      controller.projectContextForCacheDeletion(projectId),
    onDelta: (uiId, projectId, changedIssueIds) =>
      dependencies.platform.sendTo(uiId, IPC.linearIssuesChanged(projectId), changedIssueIds)
  })
  registerLinearIssueHandlers(dependencies.platform, service)

  return { controller, service }
}
