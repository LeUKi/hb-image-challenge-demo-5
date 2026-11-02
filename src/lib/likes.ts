import type { GalleryLikeBatch, GalleryLikeReceipt } from '../shared/contracts'

export const LIKE_SYNC_MS = 30_000
export const LIKE_BATCH_ITEM_LIMIT = 50
export const LIKE_BATCH_COUNT_LIMIT = 1_000
export const MAX_QUEUED_LIKE_ITEMS = 2_000
export const MAX_QUEUED_LIKES_PER_ITEM = 1_000_000

type LikeStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i
const validId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)
const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

export const likeStorageKey = (scope: string): string => `hb-image-challenge:likes:${scope}`

function readBatch(value: unknown): GalleryLikeBatch | undefined {
  if (!record(value) || !validId(value.id) || !Array.isArray(value.items) || !value.items.length || value.items.length > LIKE_BATCH_ITEM_LIMIT) return
  const items: GalleryLikeBatch['items'] = []
  const ids = new Set<string>()
  for (const item of value.items) {
    if (!record(item) || !validId(item.id) || !integer(item.count, LIKE_BATCH_COUNT_LIMIT) || !item.count || ids.has(item.id)) return
    items.push({ id: item.id, count: item.count })
    ids.add(item.id)
  }
  return { id: value.id, items }
}

/** A scoped outbox. It never sends requests and never postpones a due batch on another tap. */
export class LikeQueue {
  private readonly counts = new Map<string, number>()
  private frozen: GalleryLikeBatch | undefined
  private nextAllowedAt = 0
  private readonly key: string

  constructor(
    scope: string,
    private readonly storage: LikeStorage | null,
    private readonly now: () => number = Date.now,
    private readonly uuid: () => string = () => crypto.randomUUID(),
  ) {
    this.key = likeStorageKey(scope)
    this.restore()
  }

  add(id: string): boolean {
    const count = this.counts.get(id) ?? 0
    if (!validId(id) || count >= MAX_QUEUED_LIKES_PER_ITEM || (!count && this.counts.size >= MAX_QUEUED_LIKE_ITEMS)) return false
    if (!this.hasPending()) this.nextAllowedAt = Math.max(this.nextAllowedAt, this.now() + LIKE_SYNC_MS)
    this.counts.set(id, count + 1)
    this.persist()
    return true
  }

  pending(id: string): number { return this.counts.get(id) ?? 0 }
  hasPending(): boolean { return !!this.frozen || this.counts.size > 0 }
  unacknowledgedBatchId(): string | undefined { return this.frozen?.id }
  dueIn(): number { return this.hasPending() ? Math.max(0, this.nextAllowedAt - this.now()) : 0 }
  pendingSnapshot(): Record<string, number> { return Object.fromEntries(this.counts) }

  batch(): GalleryLikeBatch | undefined {
    if (!this.hasPending() || this.dueIn() > 0) return
    if (!this.frozen) {
      const id = this.uuid()
      if (!validId(id)) return
      this.frozen = {
        id,
        items: [...this.counts].slice(0, LIKE_BATCH_ITEM_LIMIT).map(([id, count]) => ({ id, count: Math.min(count, LIKE_BATCH_COUNT_LIMIT) })),
      }
    }
    // Persist the gate before handing the payload to a caller that may immediately send it.
    this.nextAllowedAt = this.now() + LIKE_SYNC_MS
    this.persist()
    return { id: this.frozen.id, items: this.frozen.items.map(item => ({ ...item })) }
  }

  ack(receipt: GalleryLikeReceipt): void {
    if (!this.frozen || receipt.id !== this.frozen.id || !['accepted', 'throttled'].includes(receipt.status) || !integer(receipt.retryAfterMs) || !Array.isArray(receipt.rejected) || !receipt.rejected.every(validId)) return
    this.nextAllowedAt = Math.max(this.nextAllowedAt, this.now() + receipt.retryAfterMs)
    if (receipt.status === 'accepted') {
      const rejected = new Set(receipt.rejected)
      for (const id of rejected) this.counts.delete(id)
      for (const item of this.frozen.items) {
        if (rejected.has(item.id)) continue
        const remaining = (this.counts.get(item.id) ?? 0) - item.count
        this.counts.delete(item.id)
        // Rotate large counts and taps made in flight behind untouched images.
        if (remaining > 0) this.counts.set(item.id, remaining)
      }
      this.frozen = undefined
    }
    this.persist()
  }

  failure(): void {
    if (!this.frozen) return
    this.nextAllowedAt = Math.max(this.nextAllowedAt, this.now() + LIKE_SYNC_MS)
    this.persist()
  }

  private persist(): void {
    try {
      this.storage?.setItem(this.key, JSON.stringify({ version: 1, pending: [...this.counts], frozen: this.frozen, nextAllowedAt: this.nextAllowedAt }))
    } catch { /* Restricted or full storage still leaves a working in-memory outbox. */ }
  }

  private restore(): void {
    try {
      const raw = this.storage?.getItem(this.key)
      if (!raw) return
      const value: unknown = JSON.parse(raw)
      if (!record(value) || value.version !== 1 || !Array.isArray(value.pending) || value.pending.length > MAX_QUEUED_LIKE_ITEMS || !integer(value.nextAllowedAt)) return
      const restored = new Map<string, number>()
      for (const item of value.pending) {
        if (!Array.isArray(item) || item.length !== 2 || !validId(item[0]) || !integer(item[1], MAX_QUEUED_LIKES_PER_ITEM) || !item[1] || restored.has(item[0])) return
        restored.set(item[0], item[1])
      }
      const frozen = value.frozen === undefined ? undefined : readBatch(value.frozen)
      if (value.frozen !== undefined && !frozen) return
      if (frozen?.items.some(item => (restored.get(item.id) ?? 0) < item.count)) return
      for (const [id, count] of restored) this.counts.set(id, count)
      this.frozen = frozen
      this.nextAllowedAt = value.nextAllowedAt
    } catch { /* Corrupt or unavailable browser storage must not block liking. */ }
  }
}
