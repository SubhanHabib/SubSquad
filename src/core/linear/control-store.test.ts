import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LinearControlStore } from './control-store'

let userDataDir: string

beforeEach(async () => {
  userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-linear-control-'))
})
afterEach(async () => {
  await fs.rm(userDataDir, { recursive: true, force: true })
})

describe('LinearControlStore', () => {
  it('persists an approval keyed on the team, at mode 0600', async () => {
    const store = new LinearControlStore(userDataDir)
    const state = await store.approve({
      expectedRevision: 0,
      localApprovalId: 'local-a',
      projectId: 'project-a',
      teamKey: 'ENG'
    })
    expect(state).toMatchObject({
      version: 1,
      revision: 1,
      approvals: [{ localApprovalId: 'local-a', projectId: 'project-a', teamKey: 'ENG', enabled: true }]
    })
    const stat = await fs.stat(path.join(userDataDir, 'linear-issues-control.json'))
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('scopes approval to the exact (machine, project, team) triple', async () => {
    const store = new LinearControlStore(userDataDir)
    const state = await store.approve({
      expectedRevision: 0, localApprovalId: 'local-a', projectId: 'p1', teamKey: 'ENG'
    })
    expect(store.isApproved(state, { localApprovalId: 'local-a', projectId: 'p1', teamKey: 'ENG' })).toBe(true)
    // Switching the project to another team must require approving that team.
    expect(store.isApproved(state, { localApprovalId: 'local-a', projectId: 'p1', teamKey: 'OPS' })).toBe(false)
    expect(store.isApproved(state, { localApprovalId: 'local-b', projectId: 'p1', teamKey: 'ENG' })).toBe(false)
    expect(store.isApproved(state, { localApprovalId: 'local-a', projectId: 'p2', teamKey: 'ENG' })).toBe(false)
  })

  it('refuses a mutation that names the wrong revision', async () => {
    const store = new LinearControlStore(userDataDir)
    await store.approve({ expectedRevision: 0, localApprovalId: 'l', projectId: 'p', teamKey: 'ENG' })
    await expect(store.approve({
      expectedRevision: 0, localApprovalId: 'l', projectId: 'p', teamKey: 'ENG'
    })).rejects.toMatchObject({ code: 'revision-conflict' })
  })

  it('refuses an approval whose team key is not canonical', async () => {
    const store = new LinearControlStore(userDataDir)
    await expect(store.approve({
      expectedRevision: 0, localApprovalId: 'l', projectId: 'p', teamKey: 'eng'
    })).rejects.toMatchObject({ code: 'invalid-control-input' })
  })

  it('revokes every approval this machine holds for the project', async () => {
    const store = new LinearControlStore(userDataDir)
    await store.approve({ expectedRevision: 0, localApprovalId: 'l', projectId: 'p', teamKey: 'ENG' })
    const state = await store.revoke({ expectedRevision: 1, localApprovalId: 'l' })
    expect(state.approvals).toEqual([])
  })

  it('reads an unreadable or untrusted file as nothing configured', async () => {
    await fs.writeFile(path.join(userDataDir, 'linear-issues-control.json'), '{ not json')
    const store = new LinearControlStore(userDataDir)
    expect(await store.load()).toEqual({ version: 1, revision: 0, approvals: [] })
  })
})
