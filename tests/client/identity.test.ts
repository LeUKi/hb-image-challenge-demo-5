import { describe, expect, it, vi } from 'vitest'
import { galleryGrant, galleryHeaders, PageIdentityCache } from '../../src/lib/identity'
import { PrivateImageCache } from '../../src/lib/private-images'

const identified = { identified: true as const, token: 'private-page-jwt', expiresAt: new Date(100_000).toISOString(), user: { id: '123', name: '玩家', username: 'test', level: null } }

describe('page identity stays in authenticated request headers', () => {
  it('shares concurrent requests and caches only until the identity is about to expire', async () => {
    const sdk = { identity: vi.fn(async () => identified) }
    let now = 0
    const cache = new PageIdentityCache(sdk, () => now)
    await Promise.all([cache.get(), cache.get(), cache.get()])
    expect(sdk.identity).toHaveBeenCalledTimes(1)
    now = 94_999
    await cache.get()
    expect(sdk.identity).toHaveBeenCalledTimes(1)
    now = 95_001
    await cache.get()
    expect(sdk.identity).toHaveBeenCalledTimes(2)
  })

  it('never caches a denied identity and validates the private gallery grant shape', async () => {
    const cache = new PageIdentityCache({ identity: async () => ({ identified: false, reason: 'denied' }) })
    await expect(cache.get()).rejects.toThrow('允许身份验证')
    expect(galleryGrant({ data: { galleryGrant: 'a'.repeat(64) } })).toBe('a'.repeat(64))
    expect(galleryGrant({ data: { galleryGrant: 'not-a-grant' } })).toBeNull()
    const headers = galleryHeaders('secret', 'a'.repeat(64))
    expect(headers.get('Authorization')).toBe('Bearer secret')
    expect(headers.get('X-Hb-Gallery-Grant')).toBe('a'.repeat(64))
  })

  it('revalidates the same account without invalidating the current workspace', async () => {
    let release: (value: typeof identified) => void = () => undefined
    const delayed = new Promise<typeof identified>(resolve => { release = resolve })
    const sdk = { identity: vi.fn().mockResolvedValueOnce(identified).mockReturnValueOnce(delayed) }
    const cache = new PageIdentityCache(sdk, () => 0)
    await cache.get()
    const version = cache.version
    const refreshing = cache.revalidate()
    expect(await cache.get()).toEqual(identified)
    expect(cache.subject()).toBe('123')
    release({ ...identified, token: 'fresh-token' })
    await refreshing
    expect((await cache.get()).token).toBe('fresh-token')
    expect(cache.version).toBe(version)
    expect(sdk.identity).toHaveBeenCalledTimes(2)
  })

  it('invalidates the previous actor only after a fresh trusted ID proves an account change', async () => {
    const next = { ...identified, user: { ...identified.user, id: '456' } }
    const sdk = { identity: vi.fn().mockResolvedValueOnce(identified).mockResolvedValueOnce(next) }
    const cache = new PageIdentityCache(sdk, () => 0)
    await cache.get()
    const version = cache.version
    expect((await cache.revalidate()).user.id).toBe('456')
    expect(cache.subject()).toBe('456')
    expect(cache.version).toBe(version + 1)
  })

  it('invalidates an in-flight identity when a same-name account changes', async () => {
    let release: (value: typeof identified) => void = () => undefined
    const delayed = new Promise<typeof identified>(resolve => { release = resolve })
    const next = { ...identified, user: { ...identified.user, id: '456' } }
    const sdk = { identity: vi.fn().mockReturnValueOnce(delayed).mockResolvedValue(next) }
    const cache = new PageIdentityCache(sdk, () => 0)
    const old = cache.get()
    cache.clear()
    expect((await cache.get()).user.id).toBe('456')
    release(identified)
    await expect(old).rejects.toThrow('参与身份正在重新核对')
    expect(cache.subject()).toBe('456')
    expect((await cache.get()).user.id).toBe('456')
    expect(sdk.identity).toHaveBeenCalledTimes(2)
  })

  it('fetches a private image once as a blob without putting credentials into the URL', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Blob(['image'], { type: 'image/png' })))
    const cache = new PrivateImageCache(async () => galleryHeaders('secret', 'a'.repeat(64)))
    try {
      const [first, second] = await Promise.all([cache.get('image-id'), cache.get('image-id')])
      expect(first).toBe(second)
      expect(first).toMatch(/^blob:/)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe('/api/images/image-id')
      expect((init?.headers as Headers).get('Authorization')).toBe('Bearer secret')
      expect(init?.credentials).toBe('omit')
    } finally { cache.dispose(); fetchMock.mockRestore() }
  })
})
