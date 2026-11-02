import type { Hb, HbIdentityResult } from '../types/hb-sdk'

type Identified = Extract<HbIdentityResult, { identified: true }>

/** Tokens stay in this page's memory. Uploads always obtain a fresh nonce-bound token. */
export class PageIdentityCache {
  readonly cacheKey = crypto.randomUUID()
  private cached: Identified | null = null
  private expiresAt = 0
  private pending: Promise<Identified> | null = null
  private revision = 0

  constructor(private sdk: Pick<Hb, 'identity'>, private now: () => number = Date.now, readonly scope = '') {}

  remember(identity: Identified): void {
    if (this.cached && this.cached.user.id !== identity.user.id) this.clear()
    this.cached = identity
    this.expiresAt = Date.parse(identity.expiresAt)
  }

  get version(): number { return this.revision }
  subject(): string | null { return this.cached?.user.id ?? null }
  clear(): void { this.cached = null; this.expiresAt = 0; this.pending = null; this.revision += 1 }

  async get(): Promise<Identified> {
    if (this.cached && this.expiresAt > this.now() + 5_000) return this.cached
    return this.revalidate()
  }

  /** Keep the current actor usable until a fresh trusted identity proves a change. */
  async revalidate(): Promise<Identified> {
    if (this.pending) return this.pending
    const revision = this.revision
    this.pending = this.sdk.identity().then(identity => {
      if (this.revision !== revision) throw new Error('参与身份正在重新核对，请稍后继续')
      if (!identity.identified) throw new Error(identity.message || '允许身份验证后，才能查看本轮作品')
      this.remember(identity)
      return identity
    }).finally(() => { if (this.revision === revision) this.pending = null })
    return this.pending
  }
}

export function galleryGrant(view: { data: unknown } | null | undefined): string | null {
  const data = view?.data
  if (!data || typeof data !== 'object' || !('galleryGrant' in data)) return null
  return typeof data.galleryGrant === 'string' && /^[a-f0-9]{64}$/.test(data.galleryGrant) ? data.galleryGrant : null
}

export function galleryHeaders(token: string, grant: string | null): Headers {
  const headers = new Headers({ Authorization: `Bearer ${token}` })
  if (grant) headers.set('X-Hb-Gallery-Grant', grant)
  return headers
}
