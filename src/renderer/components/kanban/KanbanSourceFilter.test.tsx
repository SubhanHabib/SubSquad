// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { ProjectKanban } from '@shared/types'
import { KanbanSourceFilter } from './KanbanSourceFilter'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const board = (over: Partial<ProjectKanban> = {}): ProjectKanban =>
  ({ columns: [], assignments: [], ...over }) as ProjectKanban

function labels(host: HTMLElement): (string | null)[] {
  return [...host.querySelectorAll('button')].map((button) => button.textContent)
}

describe('KanbanSourceFilter', () => {
  it('offers All, Issues, Pull requests, and Sessions without changing board data', () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    const onChange = vi.fn()
    act(() => root.render(
      <KanbanSourceFilter value="all" board={board({ github: { columnMappings: [] } })} onChange={onChange} />
    ))
    expect(labels(host)).toEqual(['All', 'Issues', 'Pull requests', 'Sessions'])
    act(() => host.querySelectorAll('button')[1].click())
    expect(onChange).toHaveBeenCalledWith('github')
    act(() => root.unmount())
  })

  it('offers Linear once the board has a Linear config', () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    act(() => root.render(
      <KanbanSourceFilter
        value="all"
        board={board({ github: { columnMappings: [] }, linear: { columnMappings: [] } })}
        onChange={vi.fn()}
      />
    ))
    expect(labels(host)).toEqual(['All', 'Issues', 'Pull requests', 'Linear', 'Sessions'])
    act(() => root.unmount())
  })

  it('offers only the trackers a board actually has', () => {
    // A button for an unconfigured source could only ever empty the board, so the registry's own
    // `configured` predicate — not a condition re-spelled in the component — decides what shows.
    const host = document.createElement('div')
    const root = createRoot(host)
    act(() => root.render(
      <KanbanSourceFilter value="all" board={board({ linear: { columnMappings: [] } })} onChange={vi.fn()} />
    ))
    expect(labels(host)).toEqual(['All', 'Linear', 'Sessions'])
    act(() => root.render(
      <KanbanSourceFilter value="all" board={board()} onChange={vi.fn()} />
    ))
    expect(labels(host)).toEqual(['All', 'Sessions'])
    act(() => root.unmount())
  })
})
