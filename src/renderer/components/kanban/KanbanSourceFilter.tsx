import type { ProjectKanban } from '@shared/types'
import { KANBAN_SOURCES, type KanbanSourceFilter as KanbanSourceFilterValue } from '../../lib/kanbanSources'

/** The filter's value: every source, or one of them. Named for its call sites, which read it as
 *  "which source is the board showing". */
export type KanbanSource = KanbanSourceFilterValue

export function KanbanSourceFilter({
  value,
  board,
  onChange
}: {
  value: KanbanSource
  /** Filtered against each source's own `configured` predicate — see below. */
  board: ProjectKanban
  onChange: (value: KanbanSource) => void
}): React.JSX.Element {
  // 'all' plus the registry, in declaration order — adding a source adds a button here.
  //
  // Only sources CONFIGURED for this board are offered. Every source used to share one gate
  // (`board.github` covers issues and pull requests alike, and sessions are universal), so the
  // question never arose; with a second tracker it does, and an unconfigured source's button
  // could only ever empty the board. The predicate is the registry's, not one re-spelled here.
  const options: { id: KanbanSource; label: string }[] = [
    { id: 'all', label: 'All' },
    ...KANBAN_SOURCES
      .filter((source) => source.configured(board))
      .map((source) => ({ id: source.id as KanbanSource, label: source.label }))
  ]
  return (
    <div className="kanban-source-filter" role="group" aria-label="Card source">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className={value === option.id ? 'kanban-source-filter__button is-active' : 'kanban-source-filter__button'}
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
