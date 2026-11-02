import { describe, expect, it } from 'vitest'
import { LIKE_BATCH_COUNT_LIMIT, LIKE_BATCH_ITEM_LIMIT, LIKE_SYNC_MS, LikeQueue, MAX_QUEUED_LIKE_ITEMS, MAX_QUEUED_LIKES_PER_ITEM, likeStorageKey } from '../../src/lib/likes'
import type { GalleryLikeBatch, GalleryLikeReceipt } from '../../src/shared/contracts'

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const accepted = (batch: GalleryLikeBatch, rejected: string[] = []): GalleryLikeReceipt => ({ id: batch.id, status: 'accepted', retryAfterMs: 0, rejected })
const memory = () => {
  const values = new Map<string, string>()
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
}
const fixture = (scope = 'hongbao:123', storage = memory()) => {
  let time = 1_000, nextId = 10_000
  const now = () => time
  const uuid = () => id(++nextId)
  return { storage, now, uuid, advance: (ms = LIKE_SYNC_MS) => { time += ms }, queue: new LikeQueue(scope, storage, now, uuid) }
}

describe('durable optimistic likes outbox', () => {
  it('combines 300 taps and waits the full interval before returning one batch', () => {
    const { queue, advance } = fixture()
    for (let n = 0; n < 300; n++) expect(queue.add(id(1))).toBe(true)
    expect(queue.pending(id(1))).toBe(300)
    expect(queue.dueIn()).toBe(LIKE_SYNC_MS)
    expect(queue.batch()).toBeUndefined()
    advance(LIKE_SYNC_MS - 1)
    expect(queue.batch()).toBeUndefined()
    advance(1)
    expect(queue.batch()?.items).toEqual([{ id: id(1), count: 300 }])
    expect(queue.batch()).toBeUndefined()
    expect(queue.dueIn()).toBe(LIKE_SYNC_MS)
  })

  it('never delays a fixed sync time while taps keep arriving', () => {
    const { queue, advance } = fixture()
    queue.add(id(1))
    for (let n = 0; n < 30; n++) { advance(1_000); queue.add(id(1)) }
    expect(queue.dueIn()).toBe(0)
    const batch = queue.batch()!
    expect(batch.items).toEqual([{ id: id(1), count: 31 }])
    queue.add(id(2))
    advance(29_000)
    queue.add(id(2))
    expect(queue.batch()).toBeUndefined()
    advance(1_000)
    expect(queue.batch()).toEqual(batch)
  })

  it('clears only acknowledged counts and preserves taps made while a request was in flight', () => {
    const { queue, advance } = fixture()
    queue.add(id(1)); queue.add(id(1)); advance()
    const batch = queue.batch()!
    queue.add(id(1)); queue.add(id(2))
    expect(queue.pending(id(1))).toBe(3)
    queue.ack(accepted(batch))
    expect(queue.pendingSnapshot()).toEqual({ [id(2)]: 1, [id(1)]: 1 })
    expect(queue.batch()).toBeUndefined()
    advance()
    expect(queue.batch()?.items).toEqual([{ id: id(2), count: 1 }, { id: id(1), count: 1 }])
  })

  it('replays exactly the frozen batch ID after a lost response, failure, and reload', () => {
    const { queue, storage, now, uuid, advance } = fixture()
    expect(queue.unacknowledgedBatchId()).toBeUndefined()
    queue.add(id(1)); advance()
    const batch = queue.batch()!
    expect(queue.unacknowledgedBatchId()).toBe(batch.id)
    queue.add(id(2))
    advance(4_000); queue.failure()
    const reloaded = new LikeQueue('hongbao:123', storage, now, uuid)
    expect(reloaded.unacknowledgedBatchId()).toBe(batch.id)
    expect(reloaded.pendingSnapshot()).toEqual({ [id(1)]: 1, [id(2)]: 1 })
    expect(reloaded.dueIn()).toBe(LIKE_SYNC_MS)
    expect(reloaded.batch()).toBeUndefined()
    advance()
    expect(reloaded.batch()).toEqual(batch)
    reloaded.ack(accepted(batch))
    expect(reloaded.unacknowledgedBatchId()).toBeUndefined()
    expect(reloaded.pendingSnapshot()).toEqual({ [id(2)]: 1 })
  })

  it('persists a server throttle through reload without changing the retry payload', () => {
    const { queue, storage, now, uuid, advance } = fixture()
    queue.add(id(1)); advance()
    const batch = queue.batch()!
    queue.ack({ id: batch.id, status: 'throttled', retryAfterMs: 90_000, rejected: [] })
    const reloaded = new LikeQueue('hongbao:123', storage, now, uuid)
    expect(reloaded.dueIn()).toBe(90_000)
    advance(89_999)
    expect(reloaded.batch()).toBeUndefined()
    advance(1)
    expect(reloaded.batch()).toEqual(batch)
    expect(reloaded.pending(id(1))).toBe(1)
  })

  it('keeps different actors and hongbao isolated in the same browser storage', () => {
    const { queue, storage, now, uuid } = fixture()
    queue.add(id(1))
    expect(new LikeQueue('hongbao:456', storage, now, uuid).hasPending()).toBe(false)
    expect(new LikeQueue('other-hongbao:123', storage, now, uuid).hasPending()).toBe(false)
    expect(new LikeQueue('hongbao:123', storage, now, uuid).pending(id(1))).toBe(1)
  })

  it('rejects corrupt persisted values and stays usable when storage throws', () => {
    for (const raw of ['not JSON', 'null', JSON.stringify({ version: 1, pending: [[id(1), -1]], nextAllowedAt: 0 }), JSON.stringify({ version: 1, pending: [[id(1), 1]], frozen: { id: 'bad', items: [] }, nextAllowedAt: 0 }), JSON.stringify({ version: 1, pending: [[id(1), 1]], nextAllowedAt: Number.MAX_VALUE })]) {
      const storage = memory()
      storage.setItem(likeStorageKey('scope'), raw)
      const queue = new LikeQueue('scope', storage)
      expect(queue.hasPending()).toBe(false)
      expect(queue.add(id(2))).toBe(true)
      expect(queue.pending(id(2))).toBe(1)
    }
    const unavailable = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('full') }, removeItem: () => { throw new Error('blocked') } }
    const queue = new LikeQueue('scope', unavailable, () => 0, () => id(100))
    expect(queue.add(id(1))).toBe(true)
    expect(queue.pending(id(1))).toBe(1)
    expect(new LikeQueue('scope', null).add(id(1))).toBe(true)
  })

  it('bounds each payload and rotates overflow so a popular image cannot starve other images', () => {
    const { queue, advance } = fixture()
    for (let n = 0; n < LIKE_BATCH_COUNT_LIMIT + 3; n++) queue.add(id(1))
    for (let n = 2; n <= LIKE_BATCH_ITEM_LIMIT + 1; n++) queue.add(id(n))
    advance()
    const first = queue.batch()!
    expect(first.items).toHaveLength(LIKE_BATCH_ITEM_LIMIT)
    expect(first.items[0]).toEqual({ id: id(1), count: LIKE_BATCH_COUNT_LIMIT })
    queue.ack(accepted(first))
    advance()
    expect(queue.batch()?.items).toEqual([{ id: id(LIKE_BATCH_ITEM_LIMIT + 1), count: 1 }, { id: id(1), count: 3 }])
  })

  it('declines new items at capacity without dropping queued likes and still accepts existing images', () => {
    const { queue } = fixture()
    for (let n = 1; n <= MAX_QUEUED_LIKE_ITEMS; n++) expect(queue.add(id(n))).toBe(true)
    expect(queue.add(id(MAX_QUEUED_LIKE_ITEMS + 1))).toBe(false)
    expect(queue.add(id(1))).toBe(true)
    expect(queue.pending(id(1))).toBe(2)
    expect(Object.keys(queue.pendingSnapshot())).toHaveLength(MAX_QUEUED_LIKE_ITEMS)
    expect(queue.add('invalid')).toBe(false)
  })

  it('validates restored integer counts and declines overflow on an existing item', () => {
    const storage = memory()
    storage.setItem(likeStorageKey('scope'), JSON.stringify({ version: 1, pending: [[id(1), MAX_QUEUED_LIKES_PER_ITEM]], nextAllowedAt: 0 }))
    const queue = new LikeQueue('scope', storage)
    expect(queue.add(id(1))).toBe(false)
    expect(queue.pending(id(1))).toBe(MAX_QUEUED_LIKES_PER_ITEM)
    storage.setItem(likeStorageKey('scope'), JSON.stringify({ version: 1, pending: [[id(1), 1.5]], nextAllowedAt: 0 }))
    expect(new LikeQueue('scope', storage).hasPending()).toBe(false)
  })

  it('discards all pending taps on rejected images, including taps made in flight', () => {
    const { queue, advance } = fixture()
    queue.add(id(1)); queue.add(id(2)); advance()
    const batch = queue.batch()!
    queue.add(id(1)); queue.add(id(2))
    queue.ack(accepted(batch, [id(1)]))
    expect(queue.pendingSnapshot()).toEqual({ [id(2)]: 1 })
  })

  it('ignores stale, duplicate, and malformed receipts without losing later taps', () => {
    const { queue, advance } = fixture()
    queue.add(id(1)); advance()
    const first = queue.batch()!
    queue.ack({ ...accepted(first), id: id(999) })
    expect(queue.pending(id(1))).toBe(1)
    queue.ack(accepted(first))
    queue.add(id(1)); advance()
    const second = queue.batch()!
    queue.ack(accepted(first, [id(1)]))
    queue.ack({ ...accepted(second), retryAfterMs: -1 })
    expect(queue.pending(id(1))).toBe(1)
    queue.ack(accepted(second))
    queue.ack(accepted(second))
    expect(queue.hasPending()).toBe(false)
  })

  it('does not let a caller mutate the persisted retry payload', () => {
    const { queue, advance } = fixture()
    queue.add(id(1)); advance()
    const batch = queue.batch()!
    batch.items[0].count = 999
    advance()
    expect(queue.batch()?.items).toEqual([{ id: id(1), count: 1 }])
  })
})
