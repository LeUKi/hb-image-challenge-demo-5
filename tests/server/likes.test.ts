import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleApiRequest } from '../../src/server/api'
import * as auth from '../../src/server/auth'
import type { AppEnv } from '../../src/server/env'
import type { GalleryLikeBatch, GalleryResponse } from '../../src/shared/contracts'
import { galleryGrant } from '../../src/server/store'
import { activity, environment, identity, params, sqliteD1 } from './helpers'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

function fixture() {
  const { db, sqlite } = sqliteD1()
  let viewer = { ...identity }, now = 1_000_000, user = 100
  const published = structuredClone(activity)
  const verify = vi.spyOn(auth, 'verifyIdentity').mockImplementation(async () => ({ ...viewer }))
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json(published)))
  const env = { ...environment, DB: db } as unknown as AppEnv
  function seed(options: { user?: string; hongbao?: string; score?: number | null; shared?: boolean; status?: 'ready' | 'processing' | 'failed'; saved?: boolean } = {}) {
    const id = crypto.randomUUID()
    sqlite.prepare(`INSERT INTO image_attempts
      (id,hongbao,user_id,idempotency_key,image_sha256,attempt_no,config_json,status,image_key,content_type,score,created_at,updated_at,gallery_shared)
      VALUES (?,?,?,?,?,1,?,?,?,?,?,?,?,?)`).run(
      id, options.hongbao ?? identity.hongbao, options.user ?? String(++user), crypto.randomUUID(), 'hash', JSON.stringify(params),
      options.status ?? 'ready', options.saved === false ? null : `private/${id}.png`, 'image/png',
      options.score === undefined ? 20 : options.score, user, user, options.shared === false ? 0 : 1,
    )
    return id
  }
  async function request(body?: unknown, path = '/api/gallery', grant?: string, headers: Record<string, string> = {}) {
    return (await handleApiRequest(new Request(`https://challenge.example.com${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer page-token', 'Content-Type': 'application/json', ...(grant ? { 'X-Hb-Gallery-Grant': grant } : {}), ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    }), env))!
  }
  const batch = (id: string, count: number): GalleryLikeBatch => ({ id: crypto.randomUUID(), items: [{ id, count }] })
  const counts = () => sqlite.prepare('SELECT image_id, likes FROM gallery_like_counts ORDER BY image_id').all()
  const gates = () => sqlite.prepare('SELECT * FROM gallery_like_gates ORDER BY hongbao,user_id').all()
  return {
    db, sqlite, env, published, verify, seed, request, batch, counts, gates,
    advance: (milliseconds = 30_000) => { now += milliseconds },
    viewer: (sub: string, hongbao = identity.hongbao) => { viewer = { ...identity, sub, hongbao }; published.activity.id = hongbao },
  }
}

describe('batched anonymous gallery likes', () => {
  it('returns zero counts on GET, accepts many clicks once, and refreshes older watched cards in the same POST', async () => {
    const f = fixture()
    const older = f.seed(), latest = f.seed()
    const first = await (await f.request(undefined, '/api/gallery?limit=1')).json() as GalleryResponse
    expect(first.items).toMatchObject([{ id: latest, likes: 0 }])
    expect(first.likeCounts).toEqual({ [latest]: 0 })
    const response = await f.request({ batch: f.batch(older, 300), watch: [older] }, '/api/gallery?limit=1')
    const gallery = await response.json() as GalleryResponse
    expect(response.status).toBe(200)
    expect(gallery.likeReceipt).toMatchObject({ status: 'accepted', retryAfterMs: 30_000, rejected: [] })
    expect(gallery.likeCounts).toEqual({ [older]: 300, [latest]: 0 })
    expect(gallery.items).toMatchObject([{ id: latest, likes: 0 }])
    expect(f.counts()).toEqual([{ image_id: older, likes: 300 }])
    expect(JSON.stringify(gallery)).not.toMatch(/user_id|operation_id|items_json|image_key/)
    expect(f.verify).toHaveBeenCalledWith('page-token', 'page', expect.any(Request), f.env)
    f.sqlite.close()
  })

  it('acknowledges identical replays forever without another increment or advancing the shared gate', async () => {
    const f = fixture(), id = f.seed()
    const old = f.batch(id, 7)
    await f.request({ batch: old })
    const gate = f.gates()
    expect((await (await f.request({ batch: old })).json() as GalleryResponse).likeReceipt?.status).toBe('accepted')
    expect(f.gates()).toEqual(gate)
    f.advance()
    const newer = f.batch(id, 5)
    await f.request({ batch: newer })
    f.advance(5_000)
    const replay = await (await f.request({ batch: old })).json() as GalleryResponse
    expect(replay.likeReceipt).toMatchObject({ id: old.id, status: 'accepted', retryAfterMs: 25_000 })
    expect(replay.likeCounts?.[id]).toBe(12)
    f.advance(25_000)
    await f.request({ batch: old })
    expect((await (await f.request({ batch: f.batch(id, 1) })).json() as GalleryResponse).likeReceipt?.status).toBe('accepted')
    expect(f.counts()).toEqual([{ image_id: id, likes: 13 }])
    f.sqlite.close()
  })

  it('canonicalizes order and UUID case but rejects reusing a batch ID for changed payloads', async () => {
    const f = fixture(), one = f.seed(), two = f.seed()
    const batch = { id: crypto.randomUUID(), items: [{ id: one, count: 2 }, { id: two, count: 3 }] }
    await f.request({ batch })
    const equivalent = { id: batch.id.toUpperCase(), items: [...batch.items].reverse().map(item => ({ ...item, id: item.id.toUpperCase() })) }
    expect((await f.request({ batch: equivalent })).status).toBe(200)
    const conflicting = await f.request({ batch: { ...batch, items: [{ id: one, count: 9 }] } })
    expect(conflicting.status).toBe(409)
    expect(await conflicting.json()).toMatchObject({ code: 'like_batch_conflict' })
    expect(f.counts()).toEqual([{ image_id: one, likes: 2 }, { image_id: two, likes: 3 }].sort((a, b) => a.image_id.localeCompare(b.image_id)))
    f.sqlite.close()
  })

  it('throttles new batches for 30 seconds while continuing gallery reads, then accepts the unchanged batch', async () => {
    const f = fixture(), id = f.seed()
    await f.request({ batch: f.batch(id, 3) })
    f.advance(4_000)
    const pending = f.batch(id, 8)
    const response = await f.request({ batch: pending, watch: [id] })
    const throttled = await response.json() as GalleryResponse
    expect(response.status).toBe(200)
    expect(throttled.likeReceipt).toEqual({ id: pending.id, status: 'throttled', retryAfterMs: 26_000, rejected: [] })
    expect(throttled.items).toMatchObject([{ id, likes: 3 }])
    expect(f.sqlite.prepare('SELECT COUNT(*) AS count FROM gallery_like_batches').get()).toMatchObject({ count: 1 })
    f.advance(26_000)
    expect((await (await f.request({ batch: pending })).json() as GalleryResponse).likeCounts?.[id]).toBe(11)
    f.sqlite.close()
  })

  it('binds gates and idempotency to the verified numeric player and activity', async () => {
    const f = fixture(), id = f.seed(), batch = f.batch(id, 4)
    await f.request({ batch })
    f.viewer('43')
    expect((await (await f.request({ batch })).json() as GalleryResponse).likeReceipt?.status).toBe('accepted')
    expect(f.counts()).toEqual([{ image_id: id, likes: 8 }])
    f.viewer('42', '87654321-1234-4234-8234-123456789012')
    const other = f.seed({ hongbao: '87654321-1234-4234-8234-123456789012' })
    expect((await (await f.request({ batch: { ...batch, items: [{ id: other, count: 6 }] } })).json() as GalleryResponse).likeReceipt?.status).toBe('accepted')
    expect(f.gates()).toHaveLength(3)
    expect((await f.request({ batch, sub: '10000' })).status).toBe(400)
    f.sqlite.close()
  })

  it('uniformly rejects hidden, nonexistent, unready and foreign targets without count leakage', async () => {
    const f = fixture(), visible = f.seed(), own = f.seed({ user: identity.sub, shared: false, score: 90 })
    const privateId = f.seed({ shared: false }), success = f.seed({ score: 90 })
    const processing = f.seed({ status: 'processing' }), failed = f.seed({ status: 'failed', score: null })
    const foreign = f.seed({ hongbao: 'other-hongbao' }), missing = crypto.randomUUID()
    const rejected = [privateId, success, processing, failed, foreign, missing]
    const batch = { id: crypto.randomUUID(), items: [visible, own, ...rejected].map(id => ({ id, count: 2 })) }
    const gallery = await (await f.request({ batch, watch: [visible, own, ...rejected] })).json() as GalleryResponse
    expect(gallery.likeReceipt?.rejected.sort()).toEqual(rejected.sort())
    expect(gallery.likeCounts).toEqual({ [visible]: 2, [own]: 2 })
    expect(f.counts()).toHaveLength(2)
    f.published.activity.status = 'ended'
    f.advance()
    const replay = await (await f.request({ batch })).json() as GalleryResponse
    expect(replay.likeReceipt?.rejected.sort()).toEqual(rejected.sort())
    expect(replay.likeCounts?.[success]).toBe(0)
    const unlocked = await (await f.request({ batch: f.batch(success, 3) })).json() as GalleryResponse
    expect(unlocked.likeCounts?.[success]).toBe(3)
    expect(unlocked.likeCounts).not.toHaveProperty(privateId)
    f.sqlite.close()
  })

  it('permits opted-in success likes with a bound claim grant and private ready targets for the owner', async () => {
    const f = fixture(), success = f.seed({ score: 90 }), privateId = f.seed({ shared: false }), processing = f.seed({ status: 'processing' })
    const grant = await galleryGrant(f.db, identity.hongbao, identity.sub)
    const granted = await (await f.request({ batch: f.batch(success, 1) }, '/api/gallery', grant)).json() as GalleryResponse
    expect(granted.likeReceipt?.rejected).toEqual([])
    expect(granted.likeCounts?.[success]).toBe(1)
    f.viewer(environment.OWNER_ID)
    const owned = await (await f.request({ batch: { id: crypto.randomUUID(), items: [{ id: privateId, count: 5 }, { id: processing, count: 5 }] }, watch: [processing] })).json() as GalleryResponse
    expect(owned.likeReceipt?.rejected).toEqual([processing])
    expect(owned.likeCounts?.[privateId]).toBe(5)
    expect(owned.likeCounts).not.toHaveProperty(processing)
    f.sqlite.close()
  })

  it('recovers a lost acknowledgement by readonly receipt lookup without writing or advancing the gate', async () => {
    const f = fixture(), id = f.seed(), hidden = f.seed({ shared: false })
    const batch = { id: crypto.randomUUID(), items: [{ id, count: 6 }, { id: hidden, count: 8 }] }
    await f.request({ batch })
    const gate = f.gates(), counts = f.counts()
    f.advance(2_000)
    const lookup = await (await f.request({ receiptFor: batch.id, watch: [id] })).json() as GalleryResponse
    expect(lookup.likeReceipt).toEqual({ id: batch.id, status: 'accepted', retryAfterMs: 28_000, rejected: [hidden] })
    expect(lookup.likeCounts?.[id]).toBe(6)
    expect(f.gates()).toEqual(gate)
    expect(f.counts()).toEqual(counts)
    expect(await (await f.request({ receiptFor: crypto.randomUUID() })).json()).not.toHaveProperty('likeReceipt')
    f.viewer('43')
    expect(await (await f.request({ receiptFor: batch.id })).json()).not.toHaveProperty('likeReceipt')
    f.sqlite.close()
  })

  it('rolls back the ledger, counts and gate together when a later transaction statement fails', async () => {
    const f = fixture(), id = f.seed(), batch = f.batch(id, 7)
    f.sqlite.exec("CREATE TRIGGER fail_like BEFORE INSERT ON gallery_like_counts BEGIN SELECT RAISE(ABORT, 'test failure'); END")
    expect((await f.request({ batch })).status).toBe(503)
    expect(f.counts()).toEqual([])
    expect(f.gates()).toEqual([])
    expect(f.sqlite.prepare('SELECT COUNT(*) AS count FROM gallery_like_batches').get()).toMatchObject({ count: 0 })
    f.sqlite.exec('DROP TRIGGER fail_like')
    expect((await (await f.request({ batch })).json() as GalleryResponse).likeCounts?.[id]).toBe(7)
    f.sqlite.close()
  })

  it('accepts the bounded 50-target batch and 200 watched UUIDs without exceeding D1 parameter limits', async () => {
    const f = fixture(), ids = Array.from({ length: 200 }, () => f.seed())
    const batch = { id: crypto.randomUUID(), items: ids.slice(0, 50).map(id => ({ id, count: 1000 })) }
    const response = await f.request({ batch, watch: ids }, '/api/gallery?limit=60')
    const gallery = await response.json() as GalleryResponse
    expect(response.status).toBe(200)
    expect(gallery.likeReceipt).toMatchObject({ status: 'accepted', rejected: [] })
    expect(Object.keys(gallery.likeCounts!)).toHaveLength(200)
    expect(ids.slice(0, 50).every(id => gallery.likeCounts?.[id] === 1000)).toBe(true)
    expect(f.counts()).toHaveLength(50)
    f.sqlite.close()
  })

  it('serializes concurrent database transactions so two tabs cannot both bypass the player gate', async () => {
    const f = fixture(), id = f.seed()
    const execute = f.db.batch.bind(f.db)
    let tail = Promise.resolve()
    vi.spyOn(f.db, 'batch').mockImplementation(statements => {
      const next = tail.then(() => execute(statements))
      tail = next.then(() => undefined, () => undefined)
      return next
    })
    const results = await Promise.all([f.request({ batch: f.batch(id, 2) }), f.request({ batch: f.batch(id, 9) })])
    const receipts = await Promise.all(results.map(async response => (await response.json() as GalleryResponse).likeReceipt))
    expect(receipts.map(receipt => receipt?.status).sort()).toEqual(['accepted', 'throttled'])
    expect([2, 9]).toContain(f.counts()[0].likes)
    f.advance()
    const duplicate = f.batch(id, 5)
    const before = f.counts()[0].likes as number
    const retries = await Promise.all([f.request({ batch: duplicate }), f.request({ batch: duplicate })])
    expect(retries.map(response => response.status)).toEqual([200, 200])
    expect(f.counts()[0].likes).toBe(before + 5)
    f.sqlite.close()
  })

  it.each([
    ['non-object JSON', []], ['null JSON', null], ['unknown actor field', { sub: '10000' }],
    ['invalid batch id', { batch: { id: 'invalid', items: [{ id: crypto.randomUUID(), count: 1 }] } }],
    ['empty batch', { batch: { id: crypto.randomUUID(), items: [] } }],
    ['non-numeric count', { batch: { id: crypto.randomUUID(), items: [{ id: crypto.randomUUID(), count: '1' }] } }],
    ['zero count', { batch: { id: crypto.randomUUID(), items: [{ id: crypto.randomUUID(), count: 0 }] } }],
    ['oversized count', { batch: { id: crypto.randomUUID(), items: [{ id: crypto.randomUUID(), count: 1001 }] } }],
    ['fractional count', { batch: { id: crypto.randomUUID(), items: [{ id: crypto.randomUUID(), count: 1.5 }] } }],
    ['too many batch items', { batch: { id: crypto.randomUUID(), items: Array.from({ length: 51 }, () => ({ id: crypto.randomUUID(), count: 1 })) } }],
    ['too many watch IDs', { watch: Array.from({ length: 201 }, () => crypto.randomUUID()) }],
    ['invalid watch ID', { watch: ['not-an-id'] }], ['invalid receipt ID', { receiptFor: 'invalid' }],
    ['invalid JSON', '{'],
  ])('rejects %s before any writes', async (_label, body) => {
    const f = fixture()
    expect((await f.request(body)).status).toBe(400)
    expect(f.gates()).toEqual([])
    expect(f.counts()).toEqual([])
    f.sqlite.close()
  })

  it('rejects duplicate UUIDs including case variants and validates pagination before writing', async () => {
    const f = fixture(), id = f.seed()
    expect((await f.request({ batch: { id: crypto.randomUUID(), items: [{ id, count: 1 }, { id: id.toUpperCase(), count: 1 }] } })).status).toBe(400)
    expect((await f.request({ watch: [id, id.toUpperCase()] })).status).toBe(400)
    const batch = f.batch(id, 1)
    expect((await f.request({ batch }, '/api/gallery?limit=61')).status).toBe(400)
    expect((await f.request({ batch }, '/api/gallery?cursor=bad')).status).toBe(400)
    expect(f.counts()).toEqual([])
    expect(f.gates()).toEqual([])
    f.sqlite.close()
  })

  it('bounds bytes even when Content-Length is absent or understated', async () => {
    const f = fixture(), oversized = ' '.repeat(32 * 1024) + '{}'
    expect((await f.request(oversized)).status).toBe(413)
    expect((await f.request(oversized, '/api/gallery', undefined, { 'Content-Length': '2' })).status).toBe(413)
    expect((await f.request('{}', '/api/gallery', undefined, { 'Content-Length': String(32 * 1024 + 1) })).status).toBe(413)
    expect(f.gates()).toEqual([])
    f.sqlite.close()
  })
})
