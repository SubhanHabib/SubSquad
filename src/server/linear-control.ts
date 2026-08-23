import type { CorePlatform } from '../core/platform'
import type { LinearSecretStore } from '../core/linear/credentials'
import type { LinearHostController } from '../core/linear/host'
import { IPC } from '../shared/ipc'
import { ServerSecretStore } from './github-control'

const FILE_NAME = 'linear-api-key.json'

/** Server Edition has no OS keyring, so the key lands in the same owner-only atomic file the
 *  GitHub token uses — `ServerSecretStore` is already generic over the file name. */
export class ServerLinearSecretStore extends ServerSecretStore implements LinearSecretStore {
  constructor(userDataDir: string) {
    super(userDataDir, FILE_NAME)
  }
}

type Controller = Pick<LinearHostController,
  'status' | 'approve' | 'revoke' | 'saveKey' | 'clearKey' | 'teams' | 'states'>

export function registerServerLinearControl(
  platform: CorePlatform,
  controller: Controller
): void {
  platform.handle(IPC.linearControlStatus, (projectId?: string) => controller.status(projectId))
  platform.handle(IPC.linearControlApprove, (input) => controller.approve(input))
  platform.handle(IPC.linearControlRevoke, (input) => controller.revoke(input))
  platform.handle(IPC.linearControlSaveKey, (key: string) => controller.saveKey(key))
  platform.handle(IPC.linearControlClearKey, () => controller.clearKey())
  platform.handle(IPC.linearControlTeams, () => controller.teams())
  platform.handle(IPC.linearControlStates, (teamKey: string) => controller.states(teamKey))
}
