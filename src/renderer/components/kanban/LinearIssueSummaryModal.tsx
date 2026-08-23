import { useEffect, useRef } from 'react'
import type { LinearIssueCardView } from '@shared/linear-issues'
import type { KanbanColumn } from '@shared/types'
import { useSession } from '../../session/session'
import { Button } from '@renderer/ui/Button'
import { Select } from '@renderer/ui/Select'

/** Read-only detail view for one Linear issue — the counterpart to `GitHubIssueSummaryModal`.
 *  Editing titles, bodies and comments is deliberately not here; "Open in Linear" is the escape
 *  hatch, exactly as "Open on GitHub" is for the other provider. */
export function LinearIssueSummaryModal({
  issue,
  columns,
  moving,
  readOnly,
  status,
  onMove,
  onClose
}: {
  issue: LinearIssueCardView
  columns: KanbanColumn[]
  moving: boolean
  readOnly: boolean
  status?: string
  onMove: (columnId: string | null) => void
  onClose: () => void
}): React.JSX.Element {
  const { api } = useSession()
  const close = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLElement>(null)
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null)
  useEffect(() => {
    close.current?.focus()
    return () => opener.current?.focus()
  }, [])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key === 'Tab' && dialog.current) {
        const focusable = [...dialog.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
        )]
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  return (
    <div className="kanban-modal-scrim" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialog}
        className="linear-issue-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="linear-issue-modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="linear-issue-modal__header">
          <div>
            <div className="linear-issue-modal__eyebrow">Linear issue {issue.identifier}</div>
            <h2 id="linear-issue-modal-title">{issue.title}</h2>
          </div>
          <button ref={close} className="linear-issue-modal__close" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="linear-issue-modal__actions">
          <label>
            <span>Move to</span>
            <Select
              aria-label={`Move issue ${issue.identifier}`}
              value={issue.columnId ?? ''}
              disabled={moving || readOnly}
              onChange={(event) => onMove(event.target.value || null)}
            >
              {/* Ungrouped is offered so the current position of an unmapped state is
                  representable, but selecting it is refused with a reason — every Linear issue
                  always has a state, so "no column" is not a destination. */}
              <option value="">Ungrouped</option>
              {columns.map((column) => <option key={column.id} value={column.id}>{column.title}</option>)}
            </Select>
          </label>
          <Button onClick={() => void api.shell.openExternal(issue.url)}>Open in Linear</Button>
        </div>
        <div className="linear-issue-modal__meta">
          <span title="Workflow state">{issue.state.name}</span>
          {issue.cycleName && <span title="Cycle">{issue.cycleName}</span>}
          {issue.projectName && <span title="Project">{issue.projectName}</span>}
          {issue.dueDate && <span title="Due date">Due {issue.dueDate}</span>}
        </div>
        {status && <p className="linear-issue-modal__warning" role="status">{status}</p>}
        <div className="linear-issue-modal__body">
          {issue.description.trim() || 'No description provided.'}
        </div>
      </section>
    </div>
  )
}
