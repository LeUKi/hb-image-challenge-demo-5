import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleApiRequest } from '../../src/server/api'
import * as auth from '../../src/server/auth'
import type { AppEnv } from '../../src/server/env'
import type { GalleryResponse } from '../../src/shared/contracts'
import { activity, environment, identity, params, png, sqliteD1 } from './helpers'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

function fixture() {
  const { db, sqlite } = sqliteD1()
  let viewer = { ...identity }
  const published = structuredClone(activity)
  vi.spyOn(auth, 'verifyIdentity').mockImplementation(async () => viewer)
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json(published)))
  const get = vi.fn().mockImplementation(async () => ({ body: png() }))
  const env = { ...environment, DB: db, IMAGES: { get } } as unknown as AppEnv
  let created = 1000
  function seed(options: { user?: string; hongbao?: string; score?: number | null; shared?: boolean; saved?: boolean; status?: 'ready' | 'processing' | 'failed'; attempt?: number; createdAt?: number; config?: Record<string, unknown>; nsfwScore?: number | null } = {}) {
    const id = crypto.randomUUID()
    const now = options.createdAt ?? ++created
    sqlite.prepare(`INSERT INTO image_attempts
      (id,hongbao,user_id,idempotency_key,image_sha256,attempt_no,config_json,status,image_key,content_type,score,nsfw_score,image_width,image_height,created_at,updated_at,gallery_shared)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, options.hongbao ?? identity.hongbao, options.user ?? '99', crypto.randomUUID(), 'private-hash', options.attempt ?? 1,
      JSON.stringify(options.config ?? params), options.status ?? 'ready', options.saved === false ? null : `private/${id}.png`, 'image/png',
      options.score === undefined ? 20 : options.score, options.nsfwScore === undefined ? 8 : options.nsfwScore, 400, 600, now, now, options.shared === false ? 0 : 1,
    )
    return id
  }
  async function request(path = '/api/gallery', grant?: string, extraHeaders: Record<string, string> = {}) {
    return (await handleApiRequest(new Request(`https://challenge.example.com${path}`, {
      headers: { Authorization: 'Bearer test-page', ...extraHeaders, ...(grant ? { 'X-Hb-Gallery-Grant': grant } : {}) },
    }), env))!
  }
  return { sqlite, db, published, get, seed, request, viewer: (sub: string, hongbao = identity.hongbao) => { viewer = { ...identity, sub, hongbao } } }
}

describe('anonymous scoped gallery', () => {
  it('shows own uploads and other opted-in misses before claiming, including above-range misses, but never failures', async () => {
    const f = fixture()
    const own = f.seed({ user: '42', score: 90, shared: false })
    const below = f.seed({ user: '99', score: 50 })
    const above = f.seed({ user: '98', score: 99, config: { ...params, maxScore: 90 } })
    f.seed({ user: '97', score: 85 })
    f.seed({ user: '96', score: 30, shared: false })
    f.seed({ user: '95', score: null, status: 'failed' })
    f.seed({ user: '94', score: null, status: 'processing' })
    f.seed({ user: '93', hongbao: 'other-packet', score: 10 })
    const response = await f.request()
    const gallery = await response.json() as GalleryResponse
    expect(response.status).toBe(200)
    expect(gallery.visibility).toBe('misses')
    expect(gallery.items.map(item => item.id)).toEqual([above, below, own])
    expect(gallery.items.find(item => item.id === own)).toMatchObject({ own: true, score: 90, passed: true })
    for (const item of gallery.items) expect(Object.keys(item).sort()).toEqual(['id', 'model', 'score', 'nsfwScore', 'saved', 'createdAt', 'own', 'width', 'height', 'passed', 'likes'].sort())
    expect(JSON.stringify(gallery)).not.toMatch(/user_id|image_key|private\/|nickname|displayName|galleryGrant/)
    f.sqlite.close()
  })
  it('restores latest unsubmitted result and counts failed/processing reservations, without inventing extra attempts', async () => {
    const f = fixture()
    const legacy = f.seed({ user: '42', score: 60, attempt: 1 })
    const latest = f.seed({ user: '42', score: 80, attempt: 2, nsfwScore: null, config: { ...params, model: '@cf/cloudflare/clef-flash' } })
    f.seed({ user: '42', score: null, attempt: 3, status: 'failed' })
    const gallery = await (await f.request()).json() as GalleryResponse
    expect(gallery.remaining).toBe(0)
    expect(gallery.latest).toMatchObject({ id: latest, model: '@cf/cloudflare/clef-flash', score: 80, remaining: 0, nsfwScore: null, width: 400, height: 600 })
    expect(gallery.items.find(item => item.id === latest)?.model).toBe('@cf/cloudflare/clef-flash')
    expect(gallery.items.find(item => item.id === legacy)?.model).toBe('@cf/cloudflare/clef-omni')
    const ownResult = await (await f.request(`/api/uploads/${latest}`)).json()
    expect(ownResult).toMatchObject({ id: latest, model: '@cf/cloudflare/clef-flash', remaining: 0 })
    expect(await (await f.request(`/api/uploads/${legacy}`)).json()).toMatchObject({ id: legacy, model: '@cf/cloudflare/clef-omni' })
    f.sqlite.close()
  })
  it('keeps score-only records when retention is off', async () => {
    const f = fixture()
    const id = f.seed({ saved: false })
    const gallery = await (await f.request()).json() as GalleryResponse
    expect(gallery.items).toMatchObject([{ id, saved: false, score: 20 }])
    expect((await f.request(`/api/images/${id}`)).status).toBe(404)
    expect(f.get).not.toHaveBeenCalled()
    f.sqlite.close()
  })
  it('paginates newest first without duplicates at equal timestamps, bounds reads and rejects malformed cursors', async () => {
    const f = fixture()
    const ids = Array.from({ length: 5 }, (_, index) => f.seed({ user: String(90 + index), createdAt: 1234 })).sort().reverse()
    const first = await (await f.request('/api/gallery?limit=2')).json() as GalleryResponse
    const second = await (await f.request(`/api/gallery?limit=2&cursor=${first.next}`)).json() as GalleryResponse
    const third = await (await f.request(`/api/gallery?limit=2&cursor=${second.next}`)).json() as GalleryResponse
    expect([...first.items, ...second.items, ...third.items].map(item => item.id)).toEqual(ids)
    expect(third.next).toBeNull()
    expect((await f.request('/api/gallery?limit=61')).status).toBe(400)
    expect((await f.request('/api/gallery?cursor=not-valid-json')).status).toBe(400)
    f.sqlite.close()
  })
  it('unlocks shared successes only with the bound private grant and never exposes the grant to page requests', async () => {
    const f = fixture()
    const own = f.seed({ user: '42', score: 90 })
    const otherSuccess = f.seed({ user: '99', score: 90 })
    const privateLegacy = f.seed({ user: '98', score: 20, shared: false })
    const judge = await f.request(`/api/results/${own}?user=42`, undefined, { 'X-Hb-Token': 'test-judge' })
    const judged = await judge.json() as { galleryGrant: string }
    expect(judged.galleryGrant).toMatch(/^[a-f0-9]{64}$/)
    expect(await (await f.request(`/api/results/${own}?user=42`, undefined, { 'X-Hb-Token': 'test-judge' })).json()).toMatchObject({ galleryGrant: judged.galleryGrant })
    // Merely checking the result must not unlock the public page.
    expect((await (await f.request()).json() as GalleryResponse).visibility).toBe('misses')
    const unlocked = await (await f.request('/api/gallery', judged.galleryGrant)).json() as GalleryResponse
    expect(unlocked.visibility).toBe('all')
    expect(unlocked.items.map(item => item.id)).toContain(otherSuccess)
    expect(unlocked.items.map(item => item.id)).not.toContain(privateLegacy)
    expect((await f.request(`/api/images/${otherSuccess}`, judged.galleryGrant)).status).toBe(200)
    expect((await f.request(`/api/images/${privateLegacy}`, judged.galleryGrant)).status).toBe(404)
    expect(await (await f.request(`/api/uploads/${own}`)).json()).not.toHaveProperty('galleryGrant')
    f.viewer('99')
    expect((await f.request('/api/gallery', judged.galleryGrant)).status).toBe(403)
    f.viewer('42', 'other-packet')
    f.published.activity.id = 'other-packet'
    expect((await f.request('/api/gallery', judged.galleryGrant)).status).toBe(403)
    f.sqlite.close()
  })
  it('never issues a grant for failed matching scores, nor uses claimed=true as authorization', async () => {
    const f = fixture()
    const own = f.seed({ user: '42', score: 20 })
    const success = f.seed({ user: '99', score: 90 })
    expect(await (await f.request(`/api/results/${own}?user=42`, undefined, { 'X-Hb-Token': 'test-judge' })).json()).not.toHaveProperty('galleryGrant')
    expect((await (await f.request('/api/gallery?claimed=true')).json() as GalleryResponse).items.map(item => item.id)).not.toContain(success)
    expect((await f.request(`/api/images/${success}`)).status).toBe(404)
    expect((await f.request('/api/gallery', 'invented-grant')).status).toBe(403)
    f.sqlite.close()
  })
  it('enforces the same visibility on raw image fetches and unlocks only new shared records after trusted end', async () => {
    const f = fixture()
    const miss = f.seed({ user: '99', score: 20 })
    const success = f.seed({ user: '98', score: 90 })
    const legacy = f.seed({ user: '97', score: 20, shared: false })
    expect((await f.request(`/api/images/${miss}`)).status).toBe(200)
    expect((await f.request(`/api/images/${success}`)).status).toBe(404)
    expect((await f.request(`/api/images/${legacy}`)).status).toBe(404)
    f.published.activity.status = 'ended'
    const ended = await (await f.request()).json() as GalleryResponse
    expect(ended.visibility).toBe('all')
    expect(ended.items.map(item => item.id)).toEqual([success, miss])
    expect((await f.request(`/api/images/${success}`)).status).toBe(200)
    expect((await f.request(`/api/images/${legacy}`)).status).toBe(404)
    f.viewer(environment.OWNER_ID)
    expect((await f.request(`/api/images/${legacy}`)).status).toBe(200)
    f.sqlite.close()
  })
  it('defaults pre-migration uploads to private and preserves original frozen reward fields', async () => {
    const f = fixture()
    const id = crypto.randomUUID()
    const legacyConfig = { challenge: params.challenge, minScore: params.minScore, maxScore: params.maxScore, maxAttempts: params.maxAttempts, saveImages: params.saveImages }
    f.sqlite.prepare(`INSERT INTO image_attempts (id,hongbao,user_id,idempotency_key,image_sha256,attempt_no,config_json,status,content_type,score,created_at,updated_at)
      VALUES (?,?,?,?,?,1,?,'ready','image/png',90,1,1)`).run(id, identity.hongbao, '42', crypto.randomUUID(), 'hash', JSON.stringify(legacyConfig))
    expect(f.sqlite.prepare('SELECT gallery_shared FROM image_attempts WHERE id=?').get(id)).toMatchObject({ gallery_shared: 0 })
    const result = await (await f.request(`/api/results/${id}?user=42`, undefined, { 'X-Hb-Token': 'test-judge' })).json()
    expect(result).toMatchObject({ found: true, score: 90 })
    expect(result).not.toHaveProperty('reward')
    f.sqlite.close()
  })
})
