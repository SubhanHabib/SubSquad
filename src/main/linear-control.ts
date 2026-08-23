import type { LinearSecretStore } from '../core/linear/credentials'
import type { LinearHostController } from '../core/linear/host'
import { IPC } from '../shared/ipc'
import { ElectronSecretStore, type SafeStorageLike } from './github-control'

const FILE_NAME = 'linear-api-key.json'

/**
 * The Linear API key on the desktop.
 *
 * Deliberately ~10 lines: `ElectronSecretStore` is already generic over its file name, and it
 * carries everything a credential file needs here — safeStorage ciphertext when a real OS keyring
 * is available, an owner-only 0600 file when it is not, the FIFO mutation chain, the unique-temp
 * atomic write and the stale-temp sweep that exists because an orphaned temp IS an orphaned
 * credential. Reimplementing any of that for Linear would be a second copy of exactly the code
 * whose bugs are silent.
 */
export class ElectronLinearSecretStore extends ElectronSecretStore implements LinearSecretStore {
  constructor(userDataDir: string, safeStorage: SafeStorageLike) {
    super(userDataDir, safeStorage, FILE_NAME)
  }
}

export class LinearControlAccessError extends Error {
  readonly code = 'E_FORBIDDEN'

  constructor() {
    super('Linear control is available only to the local main window')
  }
}

type IpcMainLike = {
  handle(channel: string, handler: (event: { sender: { id: number } }, ...args: any[]) => unknown): void
}

type Controller = Pick<LinearHostController,
  'status' | 'approve' | 'revoke' | 'saveKey' | 'clearKey' | 'teams' | 'states'>

/**
 * Control is main-window only, the same guard `registerElectronGitHubControl` applies and for the
 * same reason: these verbs save a credential and grant a project network access, so a webview or a
 * relay-backed renderer must never reach them.
 */
export function registerElectronLinearControl(
  ipc: IpcMainLike,
  mainWindowId: () => number | undefined,
  controller: Controller
): void {
  const local = <T extends unknown[]>(action: (...args: T) => unknown) =>
    (event: { sender: { id: number } }, ...args: T): unknown => {
      if (mainWindowId() !== event.sender.id) throw new LinearControlAccessError()
      return action(...args)
    }
  ipc.handle(IPC.linearControlStatus, local((projectId?: string) => controller.status(projectId)))
  ipc.handle(IPC.linearControlApprove, local((input) => controller.approve(input)))
  ipc.handle(IPC.linearControlRevoke, local((input) => controller.revoke(input)))
  ipc.handle(IPC.linearControlSaveKey, local((key: string) => controller.saveKey(key)))
  ipc.handle(IPC.linearControlClearKey, local(() => controller.clearKey()))
  ipc.handle(IPC.linearControlTeams, local(() => controller.teams()))
  ipc.handle(IPC.linearControlStates, local((teamKey: string) => controller.states(teamKey)))
}
