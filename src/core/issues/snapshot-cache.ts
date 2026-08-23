import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { renameAtomic, tempNameFor } from '../fs-atomic'

/**
 * The private, per-identity on-disk cache every issue provider keeps: one document per
 * `(authenticated user, subject)` — a GitHub `owner/repo`, a Linear `<orgId>/<teamId>` — plus a
 * binding record mapping an approved project to the identities that have cached under it, so a
 * revoke can reach every one of them.
 *
 * Lifted out of `src/core/github/cache.ts` when Linear arrived. Only the MACHINERY moved — the
 * document shape, its validators and the save verbs stay with each provider, because those are
 * provider-shaped. What is shared is everything a second copy would get subtly wrong: the
 * one-handle read that closes a stat/read race, the unique-temp atomic publish, and the binding
 * record's legacy migration.
 */
export class IssueCacheError extends Error {
  constructor(readonly code: 'cache-too-large' | 'invalid-cache-key') {
    super(code)
  }
}

export interface IssueCacheConfig<Document> {
  /** Directory under the data dir holding the `<digest>.json` documents. */
  directory: string
  /** Directory under the data dir holding the project→identities binding records. */
  bindingDirectory: string
  /** Canonical form of a subject, or null when it is not a valid subject at all. */
  parseSubject(value: unknown): string | null
  validDocument(value: unknown): value is Document
  /** What `load` answers with when there is nothing readable. */
  emptyDocument(): Document
  maximumBytes: number
}

export abstract class IssueSnapshotCache<Document> {
  protected readonly maximum: number

  constructor(
    private readonly userDataDir: string,
    private readonly config: IssueCacheConfig<Document>
  ) {
    this.maximum = config.maximumBytes
  }

  async load(userId: string, subject: string): Promise<Document> {
    const file = this.file(userId, subject)
    // Measure and read through ONE open handle. Doing it as stat(path) + readFile(path) leaves a
    // window between the size check and the read, and this cache races itself: `write` publishes
    // by renaming a fresh file over this path, so a save landing mid-load would hand us a file the
    // size guard never saw. A handle is bound to the inode it opened, so the bytes we read are the
    // bytes we measured.
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined
    try {
      handle = await fs.open(file, 'r')
      const stat = await handle.stat()
      if (stat.size > this.maximum) return this.config.emptyDocument()
      const parsed: unknown = JSON.parse(await handle.readFile('utf-8'))
      return this.config.validDocument(parsed)
        ? structuredClone(parsed)
        : this.config.emptyDocument()
    } catch {
      return this.config.emptyDocument()
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  async clear(userId: string, subject: string): Promise<void> {
    await fs.rm(this.file(userId, subject), { force: true })
  }

  async bind(
    localApprovalId: string,
    projectId: string,
    subject: string,
    userId: string
  ): Promise<void> {
    if (!userId || userId.length > 256) throw new IssueCacheError('invalid-cache-key')
    const file = this.bindingFile(localApprovalId, projectId, subject)
    const existing = await this.readBinding(file)
    const userIds = [...new Set([...(existing?.userIds ?? []), userId])]
    await this.writePrivate(file, JSON.stringify({
      version: 1,
      activeUserId: userId,
      userIds
    }))
  }

  async boundUserId(
    localApprovalId: string,
    projectId: string,
    subject: string
  ): Promise<string | null> {
    const binding = await this.readBinding(this.bindingFile(localApprovalId, projectId, subject))
    return binding?.activeUserId ?? null
  }

  async clearBound(localApprovalId: string, projectId: string, subject: string): Promise<void> {
    const binding = this.bindingFile(localApprovalId, projectId, subject)
    const value = await this.readBinding(binding)
    for (const userId of value?.userIds ?? []) await this.clear(userId, subject)
    await fs.rm(binding, { force: true })
  }

  /** Publish a document, refusing one that would exceed the byte cap. */
  protected async write(userId: string, subject: string, document: Document): Promise<void> {
    const content = JSON.stringify(document)
    if (Buffer.byteLength(content, 'utf-8') > this.maximum) {
      throw new IssueCacheError('cache-too-large')
    }
    await this.writePrivate(this.file(userId, subject), content)
  }

  private file(userId: string, subject: string): string {
    if (!userId || userId.length > 256 || this.config.parseSubject(subject) !== subject) {
      throw new IssueCacheError('invalid-cache-key')
    }
    const digest = createHash('sha256').update(`${userId}\0${subject}`).digest('hex')
    return path.join(this.userDataDir, this.config.directory, `${digest}.json`)
  }

  private bindingFile(localApprovalId: string, projectId: string, subject: string): string {
    if (!localApprovalId || localApprovalId.length > 256 || !projectId || projectId.length > 256 ||
        this.config.parseSubject(subject) !== subject) {
      throw new IssueCacheError('invalid-cache-key')
    }
    const digest = createHash('sha256')
      .update(`${localApprovalId}\0${projectId}\0${subject}`)
      .digest('hex')
    return path.join(this.userDataDir, this.config.bindingDirectory, `${digest}.json`)
  }

  private async readBinding(file: string): Promise<{
    activeUserId: string
    userIds: string[]
  } | null> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf-8'))
      if (!parsed || typeof parsed !== 'object') return null
      const value = parsed as {
        version?: unknown
        userId?: unknown
        activeUserId?: unknown
        userIds?: unknown
      }
      if (value.version !== 1) return null
      const legacy = typeof value.userId === 'string' ? value.userId : undefined
      const activeUserId = typeof value.activeUserId === 'string' ? value.activeUserId : legacy
      const candidates = Array.isArray(value.userIds) ? value.userIds : legacy ? [legacy] : []
      if (!activeUserId || activeUserId.length > 256 ||
          candidates.some((userId) => typeof userId !== 'string' || !userId || userId.length > 256)) {
        return null
      }
      const userIds = [...new Set(candidates as string[])]
      if (!userIds.includes(activeUserId)) userIds.push(activeUserId)
      return { activeUserId, userIds }
    } catch {
      return null
    }
  }

  private async writePrivate(file: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true })
    // The temp name must be unique per call because two writers reach the same `<digest>.json` from
    // different serialization domains: a provider's service serializes mutations per issue
    // (mutationChain) but single-flights refreshes per subject, so a mutation's save and a
    // refresh's save for one (userId, subject) are ordered by nothing at all. Binding writes are
    // looser still — `prepareState` runs under `statePreparations`, a Set that admits several at
    // once, and they share a binding file. tempNameFor + renameAtomic (core/fs-atomic.ts) carry
    // both halves of the fix: a collision-proof name, and the bounded retry for Windows sharing
    // violations — see fs-atomic.ts for the account this file's original write-up became.
    const temporary = tempNameFor(file)
    try {
      await fs.writeFile(temporary, content, { encoding: 'utf-8', mode: 0o600 })
      await fs.chmod(temporary, 0o600)
      await renameAtomic(temporary, file)
    } catch (error) {
      // A unique name never self-heals the way the fixed one did (the next write just reused it),
      // so a failed write has to remove its own temp — the more so as the mutation saves in a
      // provider's service swallow this error whole, leaving nobody to notice the litter. The error
      // still propagates. There is deliberately no sweep of orphans from dead processes as the
      // token stores do: these are issue snapshots and binding records, not a credential that
      // nothing will ever overwrite.
      await fs.rm(temporary, { force: true }).catch(() => {})
      throw error
    }
    await fs.chmod(file, 0o600)
  }
}
