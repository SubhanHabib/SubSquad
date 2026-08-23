import { useEffect, useMemo, useState } from 'react'
import type {
  LinearControlView,
  LinearTeamSummary,
  LinearWorkflowState,
  ProjectKanbanLinear
} from '@shared/linear-issues'
import { useProjects } from '../../../state/projects'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { ConfirmDialog } from '../../ConfirmDialog'
import { Button } from '@renderer/ui/Button'
import { Input } from '@renderer/ui/Input'
import { Select } from '@renderer/ui/Select'
import { Switch } from '@renderer/ui/Switch'

const ROWS = {
  enable: {
    title: 'Linear Issues',
    description: 'Show a Linear team’s issues on this project Kanban board.',
    keywords: ['linear', 'issues', 'kanban', 'sync', 'team']
  },
  authentication: {
    title: 'Authentication',
    keywords: ['linear', 'api key', 'personal api key', 'authentication']
  },
  team: {
    title: 'Team',
    keywords: ['linear', 'team', 'workspace', 'approve']
  },
  mapping: {
    title: 'Column states',
    keywords: ['linear', 'workflow', 'state', 'columns', 'mapping']
  },
  data: {
    title: 'Sync and local data',
    keywords: ['linear', 'refresh', 'cache', 'revoke']
  }
}
const ENTRIES = Object.values(ROWS)

type Confirmation = 'cache' | 'revoke' | null

function messageFor(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code: unknown }).code)
    : error instanceof Error ? error.message : ''
  if (code.includes('revision-conflict')) return 'Settings changed elsewhere. The latest state has been loaded.'
  if (code.includes('invalid-key')) return 'Linear could not validate that API key.'
  if (code.includes('not-authenticated')) return 'Save a valid Linear API key first.'
  if (code.includes('not-approved')) return 'Approve this team on this machine first.'
  if (code.includes('team-not-configured')) return 'Choose a Linear team first.'
  return 'The Linear action could not be completed. Please try again.'
}

export function LinearIssuesSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const projectId = useProjects((state) => state.activeProjectId)
  const project = useProjects((state) => state.projects.find((item) => item.id === state.activeProjectId))
  const setProjectKanban = useProjects((state) => state.setProjectKanban)
  const board = project?.kanban
  const linearConfig = board?.linear
  const [view, setView] = useState<LinearControlView | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [teams, setTeams] = useState<LinearTeamSummary[] | null>(null)
  const [states, setStates] = useState<LinearWorkflowState[] | null>(null)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [confirmation, setConfirmation] = useState<Confirmation>(null)

  const refreshStatus = async (): Promise<void> => {
    if (!projectId) return
    setView(await window.nodeTerminal.linearControl.status(projectId))
  }

  useEffect(() => {
    if (!isActive || !projectId || project?.remote) return
    let live = true
    void (async () => {
      try {
        const next = await window.nodeTerminal.linearControl.status(projectId)
        if (live) setView(next)
      } catch (error) {
        if (live) setNotice(messageFor(error))
      }
    })()
    return () => { live = false }
  }, [isActive, projectId, project?.remote])

  // Teams and states are read on demand rather than with the status poll: each is a real query
  // against the workspace's complexity budget, and neither changes while the user reads the page.
  const authenticated = !!view?.auth.authenticated || !!view?.auth.keyPresent
  useEffect(() => {
    if (!isActive || !authenticated) return
    let live = true
    void (async () => {
      try {
        const list = await window.nodeTerminal.linearControl.teams()
        if (live) setTeams(list)
      } catch {
        // A failed team read is not a configuration error — the picker simply stays a text field.
        if (live) setTeams(null)
      }
    })()
    return () => { live = false }
  }, [isActive, authenticated])

  const teamKey = linearConfig?.teamKey
  useEffect(() => {
    if (!isActive || !authenticated || !teamKey) {
      setStates(null)
      return
    }
    let live = true
    void (async () => {
      try {
        const list = await window.nodeTerminal.linearControl.states(teamKey)
        if (live) setStates(list)
      } catch {
        if (live) setStates(null)
      }
    })()
    return () => { live = false }
  }, [isActive, authenticated, teamKey])

  const updateConfig = (next: ProjectKanbanLinear | undefined): void => {
    if (!board || !projectId) return
    const updated = { ...board }
    if (next) updated.linear = next
    else delete updated.linear
    setProjectKanban(projectId, updated)
    setNotice('')
  }

  const run = async (name: string, action: () => Promise<void>, success: string): Promise<void> => {
    setBusy(name)
    setNotice('')
    try {
      await action()
      await refreshStatus()
      setNotice(success)
    } catch (error) {
      setNotice(messageFor(error))
      try { await refreshStatus() } catch { /* keep the actionable error */ }
    } finally {
      setBusy('')
    }
  }

  const mappings = useMemo(
    () => new Map(linearConfig?.columnMappings.map((item) => [item.columnId, item.stateName]) ?? []),
    [linearConfig?.columnMappings]
  )

  if (!projectId || !project) {
    return (
      <SettingsSection id="linear-issues" title="Linear Issues" isActive={isActive} searchEntries={ENTRIES}>
        <p className="text-sm text-muted">Open a project to configure Linear Issues.</p>
      </SettingsSection>
    )
  }

  if (project.remote) {
    return (
      <SettingsSection id="linear-issues" title="Linear Issues" isActive={isActive} searchEntries={ENTRIES}>
        <p className="text-sm text-muted">Configure Linear Issues on the computer hosting this project.</p>
      </SettingsSection>
    )
  }

  if (!board) {
    return (
      <SettingsSection id="linear-issues" title="Linear Issues" isActive={isActive} searchEntries={ENTRIES}>
        <p className="text-sm text-muted">Create this project’s Kanban board before enabling Linear Issues.</p>
      </SettingsSection>
    )
  }

  const enabled = !!linearConfig
  const approved = enabled && !!view?.project?.approved
  const unknownStates = view?.project?.unknownStates ?? []
  const ready = approved && !!view?.auth.authenticated && mappings.size > 0

  return (
    <SettingsSection id="linear-issues" title="Linear Issues" isActive={isActive} searchEntries={ENTRIES}>
      <div className="space-y-5">
        <SearchableRow {...ROWS.enable}>
          <FieldRow
            label="Show Linear issues on this board"
            description="Issues appear beside session cards. A column maps to a workflow state, so moving a card changes the issue’s state in Linear."
            control={
              <Switch
                checked={enabled}
                onChange={(next) => updateConfig(next ? { columnMappings: [] } : undefined)}
              />
            }
          />
        </SearchableRow>

        {enabled && linearConfig && (
          <>
            <SearchableRow {...ROWS.authentication}>
              <div className="space-y-3">
                <p className="text-[13px] text-muted">
                  {view?.auth.authenticated
                    ? `✓ Signed in${view.auth.name ? ` as ${view.auth.name}` : ''}.`
                    : view?.auth.keyPresent
                      ? 'A key is saved but Linear did not accept it. Paste a current one.'
                      : 'Create a personal API key in Linear under Settings → Security & access → Personal API keys.'}
                </p>
                <FieldRow
                  label="Personal API key"
                  description="Linear has no CLI to borrow a session from, so a personal API key is the only way in. The key is write only in this screen."
                  note={view?.auth.storage === 'restricted-file'
                    ? 'Encrypted key storage is unavailable. The key is protected in a mode 0600 local file.'
                    : undefined}
                  htmlFor="linear-api-key"
                  control={
                    <div className="flex items-center gap-2">
                      <Input
                        id="linear-api-key"
                        type="password"
                        autoComplete="off"
                        className="w-56"
                        value={apiKey}
                        placeholder={view?.auth.keyPresent ? 'Key saved' : 'lin_api_…'}
                        onChange={(event) => setApiKey(event.target.value)}
                      />
                      <Button
                        disabled={!apiKey || busy !== ''}
                        onClick={() => void run('key', async () => {
                          await window.nodeTerminal.linearControl.saveKey(apiKey)
                          setApiKey('')
                        }, 'API key saved securely.')}
                      >
                        Save key
                      </Button>
                      {view?.auth.keyPresent && (
                        <Button
                          disabled={busy !== ''}
                          onClick={() => void run('clear-key', async () => {
                            await window.nodeTerminal.linearControl.clearKey()
                            setApiKey('')
                          }, 'Saved key cleared.')}
                        >
                          Clear
                        </Button>
                      )}
                    </div>
                  }
                />
              </div>
            </SearchableRow>

            <SearchableRow {...ROWS.team}>
              <div className="space-y-3">
                <FieldRow
                  label="Team"
                  description="Nothing in a git checkout names a Linear team, so it is chosen here rather than detected."
                  htmlFor="linear-team"
                  control={teams && teams.length > 0
                    ? (
                      <Select
                        id="linear-team"
                        value={linearConfig.teamKey ?? ''}
                        disabled={busy !== ''}
                        onChange={(event) => {
                          const key = event.target.value
                          // Changing the team invalidates every state mapping: state names belong
                          // to a team, so keeping them would silently point at nothing.
                          updateConfig({
                            ...(key ? { teamKey: key } : {}),
                            columnMappings: key === linearConfig.teamKey
                              ? linearConfig.columnMappings
                              : []
                          })
                          void refreshStatus()
                        }}
                      >
                        <option value="">Choose a team…</option>
                        {teams.map((team) => (
                          <option key={team.id} value={team.key}>{team.name} ({team.key})</option>
                        ))}
                      </Select>
                    )
                    : (
                      <Input
                        id="linear-team"
                        className="w-56"
                        value={linearConfig.teamKey ?? ''}
                        placeholder="ENG"
                        onChange={(event) => updateConfig({
                          ...linearConfig,
                          teamKey: event.target.value.trim().toUpperCase()
                        })}
                      />
                    )}
                />
                <div className="flex items-center gap-2 text-[13px]">
                  <span className={`size-2 rounded-full ${ready ? 'bg-green-500' : 'bg-amber-500'}`} />
                  <span className="text-muted">
                    {ready
                      ? `Ready as ${view?.auth.name ?? 'Linear user'}`
                      : approved
                        ? 'Team approved. Map at least one column to a workflow state.'
                        : 'Approval is required before nodeterm reads this team.'}
                  </span>
                  {!approved && linearConfig.teamKey && (
                    <Button
                      variant="primary"
                      disabled={busy !== ''}
                      onClick={() => void run('approve', async () => {
                        const status = await window.nodeTerminal.linearControl.status(projectId)
                        await window.nodeTerminal.linearControl.approve({
                          projectId,
                          teamKey: linearConfig.teamKey!,
                          expectedRevision: status.control.revision
                        })
                      }, 'Team approved on this machine.')}
                    >
                      Approve this machine
                    </Button>
                  )}
                </div>
              </div>
            </SearchableRow>

            <SearchableRow {...ROWS.mapping}>
              <div className="space-y-4">
                <div>
                  <h3 className="text-sm font-medium text-text">Column states</h3>
                  <p className="mt-1 text-[13px] leading-relaxed text-muted">
                    Each column maps to one workflow state. Issues in an unmapped state — triage and
                    backlog, typically — collect in Ungrouped, which is not a drop target: every
                    Linear issue is always in some state.
                  </p>
                </div>
                {unknownStates.length > 0 && (
                  <p className="text-[13px] text-amber-500">
                    {unknownStates.length === 1
                      ? `The state “${unknownStates[0]}” no longer exists on this team. Cards cannot move into its column until it is remapped.`
                      : `These states no longer exist on this team: ${unknownStates.join(', ')}. Their columns cannot receive cards until they are remapped.`}
                  </p>
                )}
                {board.columns.map((column) => (
                  <FieldRow
                    key={column.id}
                    label={column.title}
                    htmlFor={`linear-state-${column.id}`}
                    control={states
                      ? (
                        <Select
                          id={`linear-state-${column.id}`}
                          value={mappings.get(column.id) ?? ''}
                          disabled={busy !== ''}
                          onChange={(event) => {
                            const stateName = event.target.value
                            const next = linearConfig.columnMappings
                              .filter((item) => item.columnId !== column.id)
                            if (stateName) next.push({ columnId: column.id, stateName })
                            updateConfig({
                              ...linearConfig,
                              columnMappings: board.columns.flatMap((item) =>
                                next.filter((mapping) => mapping.columnId === item.id))
                            })
                          }}
                        >
                          <option value="">Not mapped</option>
                          {states.map((state) => (
                            <option key={state.id} value={state.name}>
                              {state.name} · {state.type}
                            </option>
                          ))}
                        </Select>
                      )
                      : (
                        <Input
                          id={`linear-state-${column.id}`}
                          className="w-56"
                          value={mappings.get(column.id) ?? ''}
                          maxLength={80}
                          placeholder={column.title}
                          onChange={(event) => {
                            const stateName = event.target.value
                            const next = linearConfig.columnMappings
                              .filter((item) => item.columnId !== column.id)
                            if (stateName) next.push({ columnId: column.id, stateName })
                            updateConfig({
                              ...linearConfig,
                              columnMappings: board.columns.flatMap((item) =>
                                next.filter((mapping) => mapping.columnId === item.id))
                            })
                          }}
                        />
                      )}
                  />
                ))}
                {/* The mapping is saved by state NAME, and that is visible in the committed project
                    file — so it is worth saying why here rather than only in the code. */}
                <p className="text-[13px] text-muted">
                  Mappings are stored by state name in this project’s <code>.nodeterm/project.json</code>,
                  so they are readable in a diff and shared with everyone who clones the repo. The API
                  key and this machine’s approval stay local.
                </p>
              </div>
            </SearchableRow>

            <SearchableRow {...ROWS.data}>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  disabled={busy !== '' || !approved}
                  onClick={() => void run('refresh', async () => {
                    await window.nodeTerminal.linearIssues.refresh(projectId, true)
                  }, 'Full refresh requested.')}
                >
                  Refresh now
                </Button>
                <Button disabled={busy !== ''} onClick={() => setConfirmation('cache')}>
                  Clear local cache
                </Button>
                {approved && (
                  <Button disabled={busy !== ''} onClick={() => setConfirmation('revoke')}>
                    Revoke this machine
                  </Button>
                )}
              </div>
            </SearchableRow>
          </>
        )}

        {notice && <p className="text-[13px] text-muted">{notice}</p>}
      </div>

      {confirmation === 'cache' && (
        <ConfirmDialog
          message="Delete this project’s cached Linear issues on this computer? They are fetched again on the next refresh."
          confirmLabel="Clear cache"
          onCancel={() => setConfirmation(null)}
          onConfirm={() => {
            setConfirmation(null)
            void run('cache', async () => {
              await window.nodeTerminal.linearIssues.clearCache(projectId)
            }, 'Local cache cleared.')
          }}
        />
      )}
      {confirmation === 'revoke' && (
        <ConfirmDialog
          message="Stop this computer from reaching Linear for this project? Cached issues are deleted and the board stops loading them."
          confirmLabel="Revoke"
          danger
          onCancel={() => setConfirmation(null)}
          onConfirm={() => {
            setConfirmation(null)
            void run('revoke', async () => {
              const status = await window.nodeTerminal.linearControl.status(projectId)
              await window.nodeTerminal.linearControl.revoke({
                projectId,
                expectedRevision: status.control.revision
              })
            }, 'This machine can no longer reach Linear for this project.')
          }}
        />
      )}
    </SettingsSection>
  )
}
