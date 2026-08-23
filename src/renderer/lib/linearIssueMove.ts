// What a board move actually DOES to a Linear issue — decided in one pure place so the drop
// handler, the card's Move selector and the summary modal cannot disagree about it.
//
// The GitHub module this mirrors confirms every state change, because on GitHub a column move can
// close or reopen an issue and both notify every watcher. Linear is a different product and the
// rules here are deliberately NOT a copy:
//
//   * Moving into a `completed` state is SILENT. It is the single most common gesture on a board,
//     it is undone by dragging the card back, and nobody is emailed. A dialog on the happy path is
//     not a safety feature — it is training to click through dialogs, which is what would blunt
//     the cancel confirmation below, the one that actually matters.
//   * Moving into a `canceled` state CONFIRMS. Cancelling says the work will not be done; it drops
//     out of cycle scope and reads to the rest of the team as a decision, not a status.
//   * Moving OUT of a finished state (completed or canceled) CONFIRMS. Reopening resurrects work
//     the team believes is settled, and it rewrites the issue's history in cycle reports.
//   * Ungrouped is REFUSED, not confirmed. Every Linear issue is in exactly one workflow state at
//     all times, so there is no write that means "no state" — the honest answer is that the
//     gesture is impossible, with the reason the user needs to fix it.

import type { LinearWorkflowState } from '@shared/linear-issues'

/** Same shape as `GitHubMoveConfirmation`, declared per provider rather than shared: the two
 *  answer the question independently and deliberately differ on what warrants a dialog. */
export interface LinearMoveConfirmation {
  message: string
  confirmLabel: string
  danger: boolean
}

export type LinearMoveIntentKind =
  | 'noop'
  | 'state-change'
  | 'complete'
  | 'cancel'
  | 'reopen'
  | 'refused'

export interface LinearMoveIntent {
  kind: LinearMoveIntentKind
  /** Set only for `refused`: what to tell the user instead of performing the move. */
  reason?: string
}

export interface MovableLinearIssue {
  identifier: string
  title: string
  /** The issue's CURRENT state is finished (completed or canceled). */
  done: boolean
  columnId: string | null
}

export const UNGROUPED_REFUSAL =
  'Every Linear issue has a workflow state — map a column to move it there.'

type StateType = LinearWorkflowState['type']

function destinationType(
  toColumnId: string | null,
  columnStateTypes: Record<string, StateType> | undefined
): StateType | undefined {
  return toColumnId === null ? undefined : columnStateTypes?.[toColumnId]
}

export function linearMoveIntent(
  issue: MovableLinearIssue,
  toColumnId: string | null,
  columnStateTypes?: Record<string, StateType>
): LinearMoveIntent {
  if (issue.columnId === toColumnId) return { kind: 'noop' }
  if (toColumnId === null) return { kind: 'refused', reason: UNGROUPED_REFUSAL }
  const type = destinationType(toColumnId, columnStateTypes)
  if (issue.done) {
    // Leaving a finished state. An unknown destination type is treated as ordinary here, which is
    // the SAFE direction: it still resolves to `reopen`, which confirms.
    return type === 'completed' || type === 'canceled'
      ? { kind: type === 'canceled' ? 'cancel' : 'complete' }
      : { kind: 'reopen' }
  }
  if (type === 'canceled') return { kind: 'cancel' }
  if (type === 'completed') return { kind: 'complete' }
  return { kind: 'state-change' }
}

/** The dialog to show before the move, or null when the move needs none. */
export function linearMoveConfirmation(
  issue: MovableLinearIssue,
  toColumnId: string | null,
  columnStateTypes?: Record<string, StateType>
): LinearMoveConfirmation | null {
  const { kind } = linearMoveIntent(issue, toColumnId, columnStateTypes)
  const name = `${issue.identifier} ${issue.title}`
  if (kind === 'cancel') {
    return {
      message: `Cancel ${name} in Linear? It leaves the cycle as work that will not be done.`,
      confirmLabel: 'Cancel issue',
      danger: true
    }
  }
  if (kind === 'reopen') {
    return {
      message: `Reopen ${name} in Linear? It is currently finished, and reopening changes the team's cycle history.`,
      confirmLabel: 'Reopen issue',
      danger: true
    }
  }
  return null
}
