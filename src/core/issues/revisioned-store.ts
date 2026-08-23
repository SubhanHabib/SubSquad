import { promises as fs } from 'node:fs'
import path from 'node:path'
import { renameAtomic, tempNameFor } from '../fs-atomic'

/**
 * A small owner-only JSON document with optimistic concurrency: every mutation names the revision
 * it believes it is editing, mutations run FIFO within an instance, and each write publishes
 * atomically through a unique temp.
 *
 * Lifted out of `src/core/github/control-store.ts` when Linear arrived. Deliberately only the
 * MACHINERY moved — the verbs (`approve` / `revoke` / `selectProvider`), the validators and the
 * on-disk field names stay with each provider's own store, because those are provider-shaped and
 * because GitHub's file already exists on users' disks and must keep its exact format. What is
 * shared is the part where a second copy's bugs would be silent and identical in both: the
 * revision check, the queue that orders it, and the atomic publish.
 */
export class RevisionedStoreError extends Error {
  constructor(readonly code: 'revision-conflict' | 'invalid-control-input') {
    super(code)
  }
}

export interface RevisionedDocument {
  version: 1
  revision: number
}

export abstract class RevisionedJsonStore<State extends RevisionedDocument> {
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly userDataDir: string,
    private readonly fileName: string,
    private readonly emptyState: State,
    private readonly validState: (value: unknown) => value is State
  ) {}

  protected get filePath(): string {
    return path.join(this.userDataDir, this.fileName)
  }

  /** The stored document, or a fresh empty one. A file we cannot read or cannot trust is not a
   *  reason to fail — it reads as "nothing has been configured", which is recoverable. */
  async load(): Promise<State> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.filePath, 'utf-8'))
      return this.validState(parsed) ? structuredClone(parsed) : structuredClone(this.emptyState)
    } catch {
      return structuredClone(this.emptyState)
    }
  }

  /**
   * Apply `change` iff the document is still at `expectedRevision`, then bump it.
   *
   * The queue is what makes the check meaningful: without it two callers could both read revision
   * 4, both pass, and the second would silently discard the first's write.
   */
  protected mutate(
    expectedRevision: number,
    change: (state: State) => State
  ): Promise<State> {
    let resolveResult: (state: State) => void
    let rejectResult: (error: unknown) => void
    const result = new Promise<State>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        const current = await this.load()
        if (!Number.isSafeInteger(expectedRevision) || current.revision !== expectedRevision) {
          throw new RevisionedStoreError('revision-conflict')
        }
        const next = { ...change(current), revision: current.revision + 1 }
        await this.write(next)
        resolveResult(structuredClone(next))
      } catch (error) {
        rejectResult(error)
      }
    })
    return result
  }

  private async write(state: State): Promise<void> {
    await fs.mkdir(this.userDataDir, { recursive: true })
    // Unique temp + retrying rename (core/fs-atomic.ts). mutate()'s writeQueue serializes writes
    // WITHIN this instance, but a second instance on the same data dir (Server Edition --data-dir)
    // shares nothing with it — the fixed `<file>.tmp` name this used to carry let two such writers
    // publish each other's half-written bytes. The unique name never self-heals, so a failed write
    // removes its own temp before rethrowing.
    const temporary = tempNameFor(this.filePath)
    try {
      await fs.writeFile(temporary, JSON.stringify(state), { encoding: 'utf-8', mode: 0o600 })
      await fs.chmod(temporary, 0o600)
      await renameAtomic(temporary, this.filePath)
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {})
      throw error
    }
    await fs.chmod(this.filePath, 0o600)
  }
}
