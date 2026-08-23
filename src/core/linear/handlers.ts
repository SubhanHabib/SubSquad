import type { CorePlatform } from '../platform'
import { IPC } from '../../shared/ipc'
import type {
  LinearIssuePage,
  LinearIssueQuery,
  LinearMutationResult
} from '../../shared/linear-issues'

export interface LinearIssueHandlerService {
  subscribe(uiId: number, request: { projectId: string }): Promise<LinearIssuePage>
  unsubscribe(uiId: number, projectId: string): void
  query(request: LinearIssueQuery): Promise<LinearIssuePage>
  refresh(request: { projectId: string; full?: boolean }): Promise<void>
  moveIssue(request: {
    projectId: string
    issueId: string
    toColumnId: string | null
    expectedUpdatedAt: string
  }): Promise<LinearMutationResult>
  clearCache(request: { projectId: string }): Promise<void>
}

export function registerLinearIssueHandlers(
  platform: CorePlatform,
  service: LinearIssueHandlerService
): void {
  platform.handleWithSender(IPC.linearIssuesSubscribe, (uiId, request: { projectId: string }) =>
    service.subscribe(uiId, request))
  platform.onWithSender(IPC.linearIssuesUnsubscribe, (uiId, projectId: string) =>
    service.unsubscribe(uiId, projectId))
  platform.handle(IPC.linearIssuesQuery, (request: LinearIssueQuery) => service.query(request))
  platform.handle(IPC.linearIssuesRefresh, (projectId: string, full?: boolean) =>
    service.refresh({ projectId, full }))
  platform.handle(IPC.linearIssuesMove, (request) => service.moveIssue(request))
  platform.handle(IPC.linearIssuesClearCache, (projectId: string) =>
    service.clearCache({ projectId }))
}
