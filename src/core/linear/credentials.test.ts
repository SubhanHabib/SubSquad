import { describe, expect, it, vi } from 'vitest'
import { CREDENTIAL_CACHE_MS, LinearCredentialResolver } from './credentials'

function fixture(options: { key?: string | null; valid?: boolean } = {}) {
  let key = options.key === undefined ? 'lin_api_key' : options.key
  let at = 1_000
  const secret = {
    availability: 'encrypted' as const,
    readForHost: vi.fn(async () => key),
    save: vi.fn(async (value: string) => { key = value }),
    clear: vi.fn(async () => { key = null })
  }
  const validate = vi.fn(async () =>
    options.valid === false ? null : { userId: 'u1', name: 'Ada' })
  const resolver = new LinearCredentialResolver({ secret, validate, now: () => at })
  return { resolver, secret, validate, advance: (ms: number) => { at += ms } }
}

describe('LinearCredentialResolver', () => {
  it('resolves the stored key to an identity', async () => {
    const { resolver } = fixture()
    expect(await resolver.resolve()).toEqual({ userId: 'u1', name: 'Ada', apiKey: 'lin_api_key' })
  })

  it('memoises for the cache window, including a NULL answer', async () => {
    // The service re-checks its epoch around every read and write; without the memo each check
    // would spend a `viewer` query that does not pass through the request coordinator, so it is
    // neither rate-limited nor backed off. "No key saved" is exactly the state that would burn it.
    const { resolver, secret, advance } = fixture({ key: null })
    expect(await resolver.resolve()).toBeNull()
    expect(await resolver.resolve()).toBeNull()
    expect(secret.readForHost).toHaveBeenCalledTimes(1)
    advance(CREDENTIAL_CACHE_MS + 1)
    expect(await resolver.resolve()).toBeNull()
    expect(secret.readForHost).toHaveBeenCalledTimes(2)
  })

  it('drops the memo the moment the credential boundary moves', async () => {
    const { resolver, secret } = fixture()
    await resolver.resolve()
    resolver.invalidate()
    await resolver.resolve()
    expect(secret.readForHost).toHaveBeenCalledTimes(2)
  })

  it('reports a saved-but-rejected key as present and not authenticated', async () => {
    // The two are different facts, and the settings copy says different things about them.
    const { resolver } = fixture({ valid: false })
    expect(await resolver.status()).toEqual({
      authenticated: false, keyPresent: true, storage: 'encrypted'
    })
  })

  it('reports the signed-in name when the key validates', async () => {
    const { resolver } = fixture()
    expect(await resolver.status()).toEqual({
      authenticated: true, keyPresent: true, storage: 'encrypted', name: 'Ada'
    })
  })

  it('never returns a credential for a key the API rejected', async () => {
    const { resolver } = fixture({ valid: false })
    expect(await resolver.resolve()).toBeNull()
  })
})
