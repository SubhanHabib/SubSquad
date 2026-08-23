import { createHash } from 'node:crypto'
import type { KanbanColumn } from '../../shared/types'
import type {
  LinearConfigResult,
  NormalisedProjectKanbanLinear
} from '../../shared/linear-issues'

/** Linear team keys are short uppercase tokens ("ENG", "OPS2"). The cap is deliberately looser
 *  than Linear's own UI so a workspace with an unusual key is not locked out; what matters is that
 *  the value is a bounded, path-safe token, because it is the cache subject and an approval key. */
const TEAM_KEY = /^[A-Z0-9]{1,16}$/

export function parseLinearTeamKey(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const value = input.trim().toUpperCase()
  return TEAM_KEY.test(value) ? value : null
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/**
 * Validate and canonicalise a project's Linear board configuration.
 *
 * Mirrors `normaliseProjectKanbanGitHub`: the same duplicate-column / unknown-column / empty /
 * too-long checks, mappings sorted into column order, and a sha256 `revision` over the canonical
 * object so the service can tell a real configuration change from a re-read.
 *
 * TWO DELIBERATE DIFFERENCES from the GitHub normaliser:
 *
 * 1. **The state is stored by NAME, never by id.** `.nodeterm/project.json` is committed and
 *    reviewed by humans, and a UUID is unreadable in a diff. Linear state ids are also not stable
 *    across a delete-and-recreate of a state that keeps its name, while the name survives. Names
 *    are resolved to ids at runtime against the team's own states, exactly as GitHub matches label
 *    names case-insensitively — and a name that no longer resolves is surfaced as `unknownStates`
 *    in the control view rather than silently refusing every move into that column.
 * 2. **There is no completion column.** A Linear state carries its own `type`, so completion is a
 *    property of the destination rather than a separate column the user has to nominate.
 */
export function normaliseProjectKanbanLinear(
  input: unknown,
  columns: readonly KanbanColumn[]
): LinearConfigResult {
  const value = record(input)
  if (!value || !Array.isArray(value.columnMappings)) {
    return { ok: false, reason: 'invalid-shape' }
  }

  let teamKey: string | undefined
  if (value.teamKey !== undefined) {
    teamKey = parseLinearTeamKey(value.teamKey) ?? undefined
    if (!teamKey) return { ok: false, reason: 'invalid-team-key' }
  }

  const columnIds = new Set(columns.map((column) => column.id))
  const seenColumns = new Set<string>()
  const seenStates = new Set<string>()
  const mappings: Array<{ columnId: string; stateName: string }> = []
  for (const candidate of value.columnMappings) {
    const mapping = record(candidate)
    if (!mapping || typeof mapping.columnId !== 'string' || typeof mapping.stateName !== 'string') {
      return { ok: false, reason: 'invalid-shape' }
    }
    const columnId = mapping.columnId.trim()
    const stateName = mapping.stateName.trim().normalize('NFKC')
    if (!columnIds.has(columnId)) return { ok: false, reason: 'unknown-column' }
    if (seenColumns.has(columnId)) return { ok: false, reason: 'duplicate-column' }
    if (!stateName) return { ok: false, reason: 'empty-state' }
    if (stateName.length > 80) return { ok: false, reason: 'state-too-long' }
    const folded = stateName.toLocaleLowerCase('en-US')
    // Two columns mapped to ONE state would make the placement ambiguous in the read direction:
    // every issue in that state would have two equally valid homes, and the board would pick by
    // mapping order. Refused for the same reason GitHub refuses a duplicate label.
    if (seenStates.has(folded)) return { ok: false, reason: 'duplicate-state' }
    seenColumns.add(columnId)
    seenStates.add(folded)
    mappings.push({ columnId, stateName })
  }

  const order = new Map(columns.map((column, index) => [column.id, index]))
  mappings.sort((a, b) => order.get(a.columnId)! - order.get(b.columnId)!)
  const canonical = {
    ...(teamKey ? { teamKey } : {}),
    columnMappings: mappings
  }
  const normalised: NormalisedProjectKanbanLinear = {
    ...canonical,
    revision: createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
  }
  return { ok: true, value: normalised }
}

/** Case-insensitive, width-insensitive fold used everywhere a state name is compared. */
export function foldStateName(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US')
}
