import type { LinearControlState, LinearProjectApproval } from '../../shared/linear-issues'
import { RevisionedJsonStore, RevisionedStoreError } from '../issues/revisioned-store'
import { parseLinearTeamKey } from './config'

const FILE_NAME = 'linear-issues-control.json'
const EMPTY_STATE: LinearControlState = {
  version: 1,
  revision: 0,
  approvals: []
}

export const LinearControlError = RevisionedStoreError
export type LinearControlError = RevisionedStoreError

type ApprovalInput = {
  expectedRevision: number
  localApprovalId: string
  projectId: string
  teamKey: string
}

function validString(value: unknown, max = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function validApproval(value: unknown): value is LinearProjectApproval {
  if (!value || typeof value !== 'object') return false
  const approval = value as LinearProjectApproval
  return validString(approval.localApprovalId, 128) &&
    validString(approval.projectId, 256) &&
    parseLinearTeamKey(approval.teamKey) === approval.teamKey &&
    approval.enabled === true &&
    Number.isSafeInteger(approval.approvedAt) && approval.approvedAt > 0
}

function validState(value: unknown): value is LinearControlState {
  if (!value || typeof value !== 'object') return false
  const state = value as LinearControlState
  return state.version === 1 &&
    Number.isSafeInteger(state.revision) && state.revision >= 0 &&
    Array.isArray(state.approvals) && state.approvals.every(validApproval)
}

/**
 * Which projects on THIS machine may reach Linear. The revision discipline and the atomic write
 * live in `RevisionedJsonStore`; the verbs and the on-disk shape stay here.
 *
 * The approval subject is the TEAM KEY, where GitHub's is the repository — the same rule
 * ("approval is per project, per machine, per subject") applied to the thing Linear scopes a board
 * to. There is deliberately no `selectProvider`: with a single credential kind there is nothing to
 * select, and an unused verb on a security-relevant store is a liability.
 */
export class LinearControlStore extends RevisionedJsonStore<LinearControlState> {
  constructor(userDataDir: string) {
    super(userDataDir, FILE_NAME, EMPTY_STATE, validState)
  }

  approve(input: ApprovalInput): Promise<LinearControlState> {
    return this.mutate(input.expectedRevision, (state) => {
      if (!validString(input.localApprovalId, 128) ||
          !validString(input.projectId, 256) ||
          parseLinearTeamKey(input.teamKey) !== input.teamKey) {
        throw new RevisionedStoreError('invalid-control-input')
      }
      const approval: LinearProjectApproval = {
        localApprovalId: input.localApprovalId,
        projectId: input.projectId,
        teamKey: input.teamKey,
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

  revoke(input: { expectedRevision: number; localApprovalId: string }): Promise<LinearControlState> {
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

  isApproved(
    state: LinearControlState,
    input: { localApprovalId: string; projectId: string; teamKey: string }
  ): boolean {
    return state.approvals.some((approval) => approval.enabled &&
      approval.localApprovalId === input.localApprovalId &&
      approval.projectId === input.projectId &&
      approval.teamKey === input.teamKey)
  }
}
