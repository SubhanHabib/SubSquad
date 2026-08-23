import { memo, useState } from 'react'
import type { LinearIssueCardView } from '@shared/linear-issues'
import type { KanbanColumn } from '@shared/types'
import { updatedRelative } from '../../lib/relativeTime'

/** Linear's own priority scale, passed through unchanged: 0 none, 1 urgent … 4 low. */
const PRIORITY_LABEL = ['', 'Urgent', 'High', 'Medium', 'Low']

/** One Linear issue on the board — the `linear` source's leaf, the counterpart to
 *  `GitHubIssueCard` and `GitHubPullCard`.
 *
 *  Two differences from the GitHub card are Linear's model, not styling choices: an issue has
 *  exactly ONE assignee (rendered through the same avatar row so the column reads uniformly), and
 *  it has no mapping conflict to report, because it always sits in exactly one workflow state.
 *  That freed slot shows the state's own name instead, which is strictly more useful — it names
 *  the state a column is mapped to, including the ones no column claims. */
export const LinearIssueCard = memo(function LinearIssueCard({
  issue,
  columns,
  moving,
  readOnly,
  status,
  onOpen,
  onMove,
  onDragStart,
  onDragEnd
}: {
  issue: LinearIssueCardView
  columns: KanbanColumn[]
  moving: boolean
  readOnly: boolean
  status?: string
  onOpen: (issue: LinearIssueCardView) => void
  onMove: (issue: LinearIssueCardView, columnId: string | null) => void
  onDragStart: (issue: LinearIssueCardView) => void
  onDragEnd: () => void
}): React.JSX.Element {
  const [dragging, setDragging] = useState(false)
  const assignees = issue.assignee ? [issue.assignee] : []
  const done = issue.state.type === 'completed' || issue.state.type === 'canceled'
  return (
    <article
      className={`kanban-card kanban-card--linear${dragging ? ' kanban-card--dragging' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`Open Linear issue ${issue.identifier}: ${issue.title}`}
      draggable={!moving && !readOnly}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        setDragging(true)
        onDragStart(issue)
      }}
      onDragEnd={() => {
        setDragging(false)
        onDragEnd()
      }}
      onClick={() => onOpen(issue)}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        if ((event.target as HTMLElement).closest('select')) return
        event.preventDefault()
        onOpen(issue)
      }}
    >
      <div className="kanban-card__row">
        {/* The dot takes the workflow state's OWN colour: Linear users pick those, and a board
            that recoloured them would disagree with the app the issues live in. */}
        <span
          className={`linear-issue-state linear-issue-state--${done ? 'done' : 'open'}`}
          style={{ borderColor: issue.state.color }}
          aria-hidden="true"
        />
        <span className="kanban-card__title">{issue.title}</span>
        <span className="linear-issue-source" title="Linear issue">LIN</span>
      </div>
      <div className="linear-issue-card__number">{issue.identifier}</div>
      {issue.labels.length > 0 && (
        <div className="linear-issue-card__labels">
          {issue.labels.slice(0, 5).map((label) => (
            <span
              key={label.id}
              className="linear-issue-label"
              style={{ borderColor: label.color, color: label.color }}
            >
              {label.name}
            </span>
          ))}
          {issue.labels.length > 5 && (
            <span className="linear-issue-label">+{issue.labels.length - 5}</span>
          )}
        </div>
      )}
      <div className="linear-issue-card__footer">
        <span>{moving ? 'Syncing…' : updatedRelative(issue.updatedAt)}</span>
        {issue.priority > 0 && (
          <span className={`linear-issue-priority linear-issue-priority--${issue.priority}`}>
            {PRIORITY_LABEL[issue.priority] ?? ''}
          </span>
        )}
        {issue.estimate !== null && (
          <span className="linear-issue-estimate" title="Estimate">{issue.estimate}</span>
        )}
        <span className="linear-issue-statename" title="Workflow state">{issue.state.name}</span>
        {assignees.length > 0 && (
          <span className="kanban-card__avatars">
            {assignees.map((assignee) => {
              const avatar = issue.avatarDataUrls?.[assignee.id]
              return avatar ? (
                <img
                  key={assignee.id}
                  className="linear-issue-avatar"
                  src={avatar}
                  alt={assignee.name}
                />
              ) : (
                <span
                  key={assignee.id}
                  className="linear-issue-avatar linear-issue-avatar--initial"
                  title={assignee.name}
                >
                  {(assignee.name[0] ?? '?').toUpperCase()}
                </span>
              )
            })}
          </span>
        )}
        <label className="linear-issue-move" onClick={(event) => event.stopPropagation()}>
          <span className="sr-only">Move issue {issue.identifier}</span>
          <select
            aria-label={`Move issue ${issue.identifier}`}
            value={issue.columnId ?? ''}
            disabled={moving || readOnly}
            onChange={(event) => onMove(issue, event.target.value || null)}
          >
            <option value="">Ungrouped</option>
            {columns.map((column) => (
              <option key={column.id} value={column.id}>{column.title}</option>
            ))}
          </select>
        </label>
      </div>
      {status && <div className="linear-issue-card__status" role="status">{status}</div>}
    </article>
  )
})
