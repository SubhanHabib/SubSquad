import type {
  GitHubAuthProvider,
  GitHubControlState,
  GitHubProjectApproval
} from '../../shared/github-issues'
import { RevisionedJsonStore, RevisionedStoreError } from '../issues/revisioned-store'
import { parseGitHubRepository } from './config'

const FILE_NAME = 'github-issues-control.json'
const EMPTY_STATE: GitHubControlState = {
  version: 1,
  revision: 0,
  authProvider: 'auto',
  approvals: []
}

/** Historical name for the shared store's error — the code union is identical, and every existing
 *  `instanceof GitHubControlError` call site keeps working because this IS that class. */
export const GitHubControlError = RevisionedStoreError
export type GitHubControlError = RevisionedStoreError

type ApprovalInput = {
  expectedRevision: number
  localApprovalId: string
  projectId: string
  repository: string
}

function validString(value: unknown, max = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function validApproval(value: unknown): value is GitHubProjectApproval {
  if (!value || typeof value !== 'object') return false
  const approval = value as GitHubProjectApproval
  return validString(approval.localApprovalId, 128) &&
    validString(approval.projectId, 256) &&
    parseGitHubRepository(approval.repository) === approval.repository &&
    approval.enabled === true &&
    Number.isSafeInteger(approval.approvedAt) && approval.approvedAt > 0
}

function validState(value: unknown): value is GitHubControlState {
  if (!value || typeof value !== 'object') return false
  const state = value as GitHubControlState
  return state.version === 1 &&
    Number.isSafeInteger(state.revision) && state.revision >= 0 &&
    (state.authProvider === 'auto' || state.authProvider === 'gh' || state.authProvider === 'token') &&
    Array.isArray(state.approvals) && state.approvals.every(validApproval)
}

/** Which projects on THIS machine may reach GitHub, and with which auth provider. The revision
 *  discipline and the atomic write live in `RevisionedJsonStore`; the verbs and the on-disk shape
 *  stay here, since the file already exists on users' disks with these exact field names. */
export class GitHubControlStore extends RevisionedJsonStore<GitHubControlState> {
  constructor(userDataDir: string) {
    super(userDataDir, FILE_NAME, EMPTY_STATE, validState)
  }

  approve(input: ApprovalInput): Promise<GitHubControlState> {
    return this.mutate(input.expectedRevision, (state) => {
      if (!validString(input.localApprovalId, 128) ||
          !validString(input.projectId, 256) ||
          parseGitHubRepository(input.repository) !== input.repository) {
        throw new RevisionedStoreError('invalid-control-input')
      }
      const approval: GitHubProjectApproval = {
        localApprovalId: input.localApprovalId,
        projectId: input.projectId,
        repository: input.repository,
        enabled: true,
        approvedAt: Date.now()
      }
      return {
        ...state,
        approvals: [
          ...state.approvals.filter((item) => item.localApprovalId !== input.localApprovalId),
          approval
        ]
      }
    })
  }

  revoke(input: { expectedRevision: number; localApprovalId: string }): Promise<GitHubControlState> {
    return this.mutate(input.expectedRevision, (state) => {
      if (!validString(input.localApprovalId, 128)) {
        throw new RevisionedStoreError('invalid-control-input')
      }
      return {
        ...state,
        approvals: state.approvals.filter((item) => item.localApprovalId !== input.localApprovalId)
      }
    })
  }

  selectProvider(input: {
    expectedRevision: number
    provider: GitHubAuthProvider
  }): Promise<GitHubControlState> {
    return this.mutate(input.expectedRevision, (state) => {
      if (input.provider !== 'auto' && input.provider !== 'gh' && input.provider !== 'token') {
        throw new RevisionedStoreError('invalid-control-input')
      }
      return { ...state, authProvider: input.provider }
    })
  }

  isApproved(
    state: GitHubControlState,
    input: { localApprovalId: string; projectId: string; repository: string }
  ): boolean {
    return state.approvals.some((approval) => approval.enabled &&
      approval.localApprovalId === input.localApprovalId &&
      approval.projectId === input.projectId &&
      approval.repository === input.repository)
  }
}
