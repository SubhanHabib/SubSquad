import { describe, expect, it } from 'vitest'
import {
  UNGROUPED_REFUSAL,
  linearMoveConfirmation,
  linearMoveIntent,
  type MovableLinearIssue
} from './linearIssueMove'

const TYPES = {
  todo: 'unstarted',
  doing: 'started',
  done: 'completed',
  dropped: 'canceled'
} as const

const live = (columnId: string | null): MovableLinearIssue =>
  ({ identifier: 'ENG-12', title: 'Ship it', done: false, columnId })
const finished = (columnId: string | null): MovableLinearIssue =>
  ({ identifier: 'ENG-12', title: 'Ship it', done: true, columnId })

describe('linearMoveIntent', () => {
  it('is a no-op when the card is dropped where it already sits', () => {
    expect(linearMoveIntent(live('todo'), 'todo', TYPES)).toEqual({ kind: 'noop' })
  })

  it('refuses Ungrouped with the reason', () => {
    expect(linearMoveIntent(live('todo'), null, TYPES))
      .toEqual({ kind: 'refused', reason: UNGROUPED_REFUSAL })
  })

  it('classifies ordinary, completing, cancelling and reopening moves', () => {
    expect(linearMoveIntent(live('todo'), 'doing', TYPES).kind).toBe('state-change')
    expect(linearMoveIntent(live('todo'), 'done', TYPES).kind).toBe('complete')
    expect(linearMoveIntent(live('todo'), 'dropped', TYPES).kind).toBe('cancel')
    expect(linearMoveIntent(finished('done'), 'doing', TYPES).kind).toBe('reopen')
    // Finished → finished is not a reopen: cancelling something already done is a cancel.
    expect(linearMoveIntent(finished('done'), 'dropped', TYPES).kind).toBe('cancel')
  })

  it('treats an unknown destination type as ordinary, which is the safe direction', () => {
    // Unknown types only occur before the first refresh has landed — when the board is read only
    // anyway. For a finished issue the fallback still resolves to `reopen`, which confirms.
    expect(linearMoveIntent(live('todo'), 'doing', undefined).kind).toBe('state-change')
    expect(linearMoveIntent(finished('done'), 'doing', undefined).kind).toBe('reopen')
  })
})

describe('linearMoveConfirmation', () => {
  it('does NOT ask before completing — the most common gesture on the board', () => {
    // Deliberately unlike the GitHub board, where the equivalent move closes an issue and notifies
    // every watcher. A dialog on the happy path is training to click through dialogs, which is
    // what would blunt the cancel confirmation below.
    expect(linearMoveConfirmation(live('doing'), 'done', TYPES)).toBeNull()
  })

  it('does not ask for an ordinary state change', () => {
    expect(linearMoveConfirmation(live('todo'), 'doing', TYPES)).toBeNull()
  })

  it('asks before cancelling', () => {
    const confirmation = linearMoveConfirmation(live('doing'), 'dropped', TYPES)
    expect(confirmation).toMatchObject({ confirmLabel: 'Cancel issue', danger: true })
    expect(confirmation?.message).toContain('ENG-12')
  })

  it('asks before reopening finished work', () => {
    const confirmation = linearMoveConfirmation(finished('done'), 'todo', TYPES)
    expect(confirmation).toMatchObject({ confirmLabel: 'Reopen issue', danger: true })
  })

  it('has nothing to confirm for a refusal or a no-op', () => {
    expect(linearMoveConfirmation(live('todo'), null, TYPES)).toBeNull()
    expect(linearMoveConfirmation(live('todo'), 'todo', TYPES)).toBeNull()
  })
})
