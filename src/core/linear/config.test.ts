import { describe, expect, it } from 'vitest'
import { normaliseProjectKanbanLinear, parseLinearTeamKey } from './config'
import type { KanbanColumn } from '../../shared/types'

const columns: KanbanColumn[] = [
  { id: 'c1', title: 'To Do', color: '#0a84ff' },
  { id: 'c2', title: 'In Progress', color: '#ff9f0a' },
  { id: 'c3', title: 'Done', color: '#32d74b' }
]

describe('parseLinearTeamKey', () => {
  it('upper-cases and accepts a short alphanumeric key', () => {
    expect(parseLinearTeamKey(' eng ')).toBe('ENG')
    expect(parseLinearTeamKey('OPS2')).toBe('OPS2')
  })

  it('refuses anything that is not a bounded token', () => {
    // The key is a cache subject and an approval key, so it must be a safe, bounded token.
    for (const value of ['', 'a b', 'eng/ops', '../etc', 'X'.repeat(17), 42, null, undefined]) {
      expect(parseLinearTeamKey(value)).toBeNull()
    }
  })
})

describe('normaliseProjectKanbanLinear', () => {
  it('canonicalises mappings into column order and hashes a stable revision', () => {
    const a = normaliseProjectKanbanLinear({
      teamKey: 'eng',
      columnMappings: [
        { columnId: 'c3', stateName: 'Done' },
        { columnId: 'c1', stateName: 'Todo' }
      ]
    }, columns)
    const b = normaliseProjectKanbanLinear({
      columnMappings: [
        { columnId: 'c1', stateName: 'Todo' },
        { columnId: 'c3', stateName: 'Done' }
      ],
      teamKey: 'ENG'
    }, columns)
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(a.value.columnMappings.map((m) => m.columnId)).toEqual(['c1', 'c3'])
    // Key order and input order must not change the revision — it is the epoch the service uses to
    // tell a real configuration change from a re-read.
    expect(a.value.revision).toBe(b.value.revision)
  })

  it('changes the revision when a mapping actually changes', () => {
    const a = normaliseProjectKanbanLinear({ columnMappings: [{ columnId: 'c1', stateName: 'Todo' }] }, columns)
    const b = normaliseProjectKanbanLinear({ columnMappings: [{ columnId: 'c1', stateName: 'Backlog' }] }, columns)
    expect(a.ok && b.ok && a.value.revision !== b.value.revision).toBe(true)
  })

  it('refuses a mapping to a column the board does not have', () => {
    expect(normaliseProjectKanbanLinear({
      columnMappings: [{ columnId: 'nope', stateName: 'Todo' }]
    }, columns)).toEqual({ ok: false, reason: 'unknown-column' })
  })

  it('refuses two mappings for one column', () => {
    expect(normaliseProjectKanbanLinear({
      columnMappings: [
        { columnId: 'c1', stateName: 'Todo' },
        { columnId: 'c1', stateName: 'Backlog' }
      ]
    }, columns)).toEqual({ ok: false, reason: 'duplicate-column' })
  })

  it('refuses two columns mapped to one state, case-insensitively', () => {
    // Both columns would be an equally valid home for every issue in that state, and the board
    // would silently place by mapping order.
    expect(normaliseProjectKanbanLinear({
      columnMappings: [
        { columnId: 'c1', stateName: 'In Progress' },
        { columnId: 'c2', stateName: 'in progress' }
      ]
    }, columns)).toEqual({ ok: false, reason: 'duplicate-state' })
  })

  it('refuses an empty or oversized state name', () => {
    expect(normaliseProjectKanbanLinear({
      columnMappings: [{ columnId: 'c1', stateName: '   ' }]
    }, columns)).toEqual({ ok: false, reason: 'empty-state' })
    expect(normaliseProjectKanbanLinear({
      columnMappings: [{ columnId: 'c1', stateName: 'x'.repeat(81) }]
    }, columns)).toEqual({ ok: false, reason: 'state-too-long' })
  })

  it('refuses an invalid team key and a malformed shape', () => {
    expect(normaliseProjectKanbanLinear({ teamKey: 'a b', columnMappings: [] }, columns))
      .toEqual({ ok: false, reason: 'invalid-team-key' })
    expect(normaliseProjectKanbanLinear({ columnMappings: 'no' }, columns))
      .toEqual({ ok: false, reason: 'invalid-shape' })
    expect(normaliseProjectKanbanLinear(null, columns))
      .toEqual({ ok: false, reason: 'invalid-shape' })
  })

  it('omits an absent team key rather than emitting undefined', () => {
    const result = normaliseProjectKanbanLinear({ columnMappings: [] }, columns)
    expect(result.ok && 'teamKey' in result.value).toBe(false)
  })
})
