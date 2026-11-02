import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { handleApiRequest } from '../../src/server/api'
import * as auth from '../../src/server/auth'
import type { AppEnv } from '../../src/server/env'
import { createNonce } from '../../src/server/store'
import { activity, environment, identity, params, png, sqliteD1 } from './helpers'

const verifySignedIdentity = auth.verifyIdentity

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function fixture(saveImages = true) {
  const { db, sqlite } = sqliteD1()
  const nonce = await createNonce(db)
  vi.spyOn(auth, 'verifyIdentity').mockResolvedValue({ ...identity, nonce })
  const published = structuredClone(activity)
  const saveParam = published.activity.judge.params.find(entry => entry.param.key === 'saveImages')!
  saveParam.value = saveImages
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(Response.json(published))))
  const run = vi.fn().mockResolvedValue({ answers: { match: { type: 'noul', noul: 0.85 }, nsfw: { type: 'noul', noul: 0.12 } } })
  const put = vi.fn().mockResolvedValue({ key: 'saved' })
  const env = { ...environment, DB: db, AI: { run }, IMAGES: { put } } as unknown as AppEnv
  const key = crypto.randomUUID()
  const request = (overrides: { key?: string; bytes?: Uint8Array<ArrayBuffer>; nonce?: string } = {}) => new Request('https://challenge.example.com/api/upload', {
    method: 'POST', body: overrides.bytes ?? png(), headers: {
      Authorization: 'Bearer signed-page-token', 'X-Hb-Nonce': overrides.nonce ?? nonce,
      'Idempotency-Key': overrides.key ?? key, 'Content-Type': 'image/png',
    },
  })
  return { db, sqlite, env, request, run, put, nonce }
}

describe('upload workflow', () => {
  it('starts storage and inference together, waits for both, then replays without extra AI', async () => {
    const { sqlite, env, request, run, put } = await fixture()
    let finishAI!: (value: unknown) => void, finishR2!: (value: unknown) => void
    run.mockImplementation(() => new Promise(resolve => { finishAI = resolve }))
    put.mockImplementation(() => new Promise(resolve => { finishR2 = resolve }))
    let finished = false
    const pending = handleApiRequest(request(), env).then(response => { finished = true; return response! })
    await vi.waitFor(() => { expect(run).toHaveBeenCalledTimes(1); expect(put).toHaveBeenCalledTimes(1) })
    finishAI({ answers: { match: { type: 'noul', noul: 0.85 }, nsfw: { type: 'noul', noul: 0.12 } } })
    await Promise.resolve()
    expect(finished).toBe(false)
    finishR2({ key: 'saved' })
    const response = await pending
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ model: '@cf/cloudflare/clef-flash', score: 85, nsfwScore: 12, width: 1, height: 1, attempt: 1, remaining: 2, saved: true })
    const frozen = sqlite.prepare('SELECT config_json FROM image_attempts').get() as { config_json: string }
    expect(JSON.parse(frozen.config_json)).toMatchObject({ model: '@cf/cloudflare/clef-flash' })
    const repeated = await handleApiRequest(request(), env)
    expect(repeated!.status).toBe(200)
    expect(await repeated!.json()).toMatchObject({ model: '@cf/cloudflare/clef-flash', score: 85 })
    expect(run).toHaveBeenCalledTimes(1); expect(put).toHaveBeenCalledTimes(1)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM image_attempts').get()).toMatchObject({ n: 1 })
    sqlite.close()
  })
  it('shares new uploads only with an explicit v1 disclosure acknowledgment, leaving older clients private', async () => {
    const { sqlite, env, request } = await fixture()
    const optedIn = request()
    optedIn.headers.set('X-Hb-Gallery-Consent', 'v1')
    expect((await handleApiRequest(optedIn, env))!.status).toBe(200)
    expect(sqlite.prepare('SELECT gallery_shared, image_width, image_height, nsfw_score FROM image_attempts').get())
      .toMatchObject({ gallery_shared: 1, image_width: 1, image_height: 1, nsfw_score: 12 })
    sqlite.close()

    const legacy = await fixture()
    expect((await handleApiRequest(legacy.request(), legacy.env))!.status).toBe(200)
    expect(legacy.sqlite.prepare('SELECT gallery_shared FROM image_attempts').get()).toMatchObject({ gallery_shared: 0 })
    legacy.sqlite.close()
  })
  it('retains a matching score with unknown safety if the NSFW answer is absent', async () => {
    const { sqlite, env, request, run } = await fixture()
    run.mockResolvedValue({ answers: { match: { type: 'noul', noul: 0.9 } } })
    const response = await handleApiRequest(request(), env)
    expect(await response!.json()).toMatchObject({ score: 90, nsfwScore: null })
    expect(sqlite.prepare('SELECT nsfw_score FROM image_attempts').get()).toMatchObject({ nsfw_score: null })
    sqlite.close()
  })
  it('never declares a ready result if R2 fails even when AI succeeds', async () => {
    const { sqlite, env, request, run, put } = await fixture()
    put.mockRejectedValue(new Error('R2 unavailable'))
    const response = await handleApiRequest(request(), env)
    expect(response!.status).toBe(502)
    expect(await response!.json()).toMatchObject({ code: 'image_save_failed' })
    expect(run).toHaveBeenCalledTimes(1)
    expect(sqlite.prepare('SELECT status, score FROM image_attempts').get()).toMatchObject({ status: 'failed', score: null })
    sqlite.close()
  })
  it('retains author-requested metadata without saving images when retention is off', async () => {
    const { sqlite, env, request, put } = await fixture(false)
    const response = await handleApiRequest(request(), env)
    expect(response!.status).toBe(200)
    expect(await response!.json()).toMatchObject({ saved: false, score: 85 })
    expect(put).not.toHaveBeenCalled()
    expect(sqlite.prepare('SELECT status, image_key FROM image_attempts').get()).toMatchObject({ status: 'ready', image_key: null })
    sqlite.close()
  })
  it('rejects changed bytes for a reused idempotency key and a reused nonce for a new request', async () => {
    const { sqlite, env, request, run } = await fixture()
    expect((await handleApiRequest(request(), env))!.status).toBe(200)
    const conflict = await handleApiRequest(request({ bytes: png(2, 1) }), env)
    expect(conflict!.status).toBe(409)
    expect(await conflict!.json()).toMatchObject({ code: 'idempotency_conflict' })
    const replay = await handleApiRequest(request({ key: crypto.randomUUID() }), env)
    expect(replay!.status).toBe(401)
    expect(run).toHaveBeenCalledTimes(1)
    sqlite.close()
  })
  it('does not expose another player result to the judge', async () => {
    const { sqlite, env, request } = await fixture()
    const saved = await (await handleApiRequest(request(), env))!.json() as { id: string }
    const wrongPlayer = await handleApiRequest(new Request(`https://challenge.example.com/api/results/${saved.id}?user=99`, { headers: { 'X-Hb-Token': 'signed-judge-token' } }), env)
    expect(await wrongPlayer!.json()).toEqual({ found: false })
    const correctPlayer = await handleApiRequest(new Request(`https://challenge.example.com/api/results/${saved.id}?user=42`, { headers: { 'X-Hb-Token': 'signed-judge-token' } }), env)
    expect(await correctPlayer!.json()).toMatchObject({ found: true, score: 85, minScore: 70, maxScore: 100, maxAttempts: 3 })
    sqlite.close()
  })
  it('rejects a cross-origin browser request and preserves SSR routing', async () => {
    const { sqlite, env } = await fixture()
    const cross = await handleApiRequest(new Request('https://challenge.example.com/api/nonce', { method: 'POST', headers: { Origin: 'https://evil.example' } }), env)
    expect(cross!.status).toBe(403)
    expect(await handleApiRequest(new Request('https://challenge.example.com/'), env)).toBeNull()
    sqlite.close()
  })
})

function judgeFixture() {
  const { db, sqlite } = sqliteD1()
  let currentIdentity = { ...identity }
  vi.spyOn(auth, 'verifyIdentity').mockImplementation(async () => currentIdentity)
  const env = { ...environment, DB: db } as AppEnv
  function seed(options: { user?: string; hongbao?: string; attempt?: number; status?: 'ready' | 'processing' | 'failed'; error?: string; config?: Record<string, unknown> } = {}) {
    const id = crypto.randomUUID(), status = options.status ?? 'ready'
    sqlite.prepare(`INSERT INTO image_attempts
      (id,hongbao,user_id,idempotency_key,image_sha256,attempt_no,config_json,status,content_type,score,error_code,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, options.hongbao ?? identity.hongbao, options.user ?? identity.sub,
      crypto.randomUUID(), crypto.randomUUID(), options.attempt ?? 1,
      JSON.stringify(options.config ?? { ...params, multiReward: true, maxAttempts: 7 }),
      status, 'image/png', status === 'ready' ? 85 : null, options.error ?? null, 1, 1,
    )
    return id
  }
  async function request(id: string, user = identity.sub, headers: Record<string, string> = { 'X-Hb-Token': 'judge-token' }) {
    return (await handleApiRequest(new Request(`https://challenge.example.com/api/results/${id}?user=${user}`, { headers }), env))!
  }
  return { db, sqlite, env, seed, request, scope: (hongbao: string) => { currentIdentity = { ...identity, hongbao } } }
}

describe('multiple-reward judge progress', () => {
  it('counts all scoped reservations while exposing only ready result IDs, including older unsubmitted images', async () => {
    const f = judgeFixture()
    const first = f.seed({ attempt: 1 })
    const current = f.seed({ attempt: 2 })
    f.seed({ attempt: 3, status: 'failed', error: 'ai_failed' })
    f.seed({ attempt: 4, status: 'failed', error: 'duplicate_image' })
    f.seed({ attempt: 5, status: 'processing' })
    f.seed({ user: '99', attempt: 10 })
    f.seed({ hongbao: 'other-packet', attempt: 10 })
    const response = await f.request(current)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      found: true, multiReward: true, attempt: 2,
      progress: { remaining: 2, readyIds: [first, current], processing: true },
    })
    expect(await (await f.request(current, '99')).json()).toEqual({ found: false })
    f.scope('other-packet')
    expect(await (await f.request(current)).json()).toEqual({ found: false })
    f.sqlite.close()
  })

  it('keeps exhausted progress accurate when the final reservations failed or were duplicates', async () => {
    const f = judgeFixture()
    const ready = f.seed({ attempt: 1, config: { ...params, multiReward: true } })
    f.seed({ attempt: 2, status: 'failed', error: 'ai_failed' })
    f.seed({ attempt: 3, status: 'failed', error: 'duplicate_image' })
    expect(await (await f.request(ready)).json()).toMatchObject({
      progress: { remaining: 0, readyIds: [ready], processing: false },
    })
    // Player reads retain the existing public contract, with no other ready IDs.
    const own = await handleApiRequest(new Request(`https://challenge.example.com/api/uploads/${ready}`, {
      headers: { Authorization: 'Bearer page-token' },
    }), f.env)
    const playerData = await own!.json()
    expect(playerData).toMatchObject({ id: ready, remaining: 0 })
    expect(playerData).not.toHaveProperty('progress')
    f.sqlite.close()
  })

  it('bounds ready IDs to the ten permitted attempts without dropping the requested result', async () => {
    const f = judgeFixture()
    const ids = Array.from({ length: 10 }, (_, index) => f.seed({ attempt: index + 1, config: { ...params, multiReward: true, maxAttempts: 10 } }))
    expect(await (await f.request(ids[9])).json()).toMatchObject({
      progress: { remaining: 0, readyIds: ids, processing: false },
    })
    f.sqlite.close()
  })

  it('defaults old frozen configurations to one reward and omits progress for single-reward records', async () => {
    const f = judgeFixture()
    const legacy: Record<string, unknown> = { ...params }
    delete legacy.multiReward
    const old = f.seed({ config: legacy })
    const single = f.seed({ attempt: 2, config: { ...params, multiReward: false } })
    for (const id of [old, single]) {
      const data = await (await f.request(id)).json()
      expect(data).toMatchObject({ found: true, multiReward: false, model: '@cf/cloudflare/clef-omni' })
      expect(data).not.toHaveProperty('progress')
    }
    f.sqlite.close()
  })

  it('requires a judge identity even when a valid signed page token is supplied', async () => {
    const f = judgeFixture()
    const pair = await generateKeyPair('ES256')
    const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'api-test', alg: 'ES256' }] })
    vi.mocked(auth.verifyIdentity).mockImplementation((token, kind, request, env) => verifySignedIdentity(token, kind, request, env, keys))
    const token = (issuer: string) => new SignJWT(identity).setProtectedHeader({ alg: 'ES256', kid: 'api-test' })
      .setIssuer(issuer).setAudience('https://challenge.example.com').setIssuedAt().setExpirationTime('10m').sign(pair.privateKey)
    const pageToken = await token(environment.HB_SITE)
    const id = f.seed()
    const wrongKind = await f.request(id, identity.sub, { 'X-Hb-Token': pageToken })
    expect(wrongKind.status).toBe(401)
    expect(await wrongKind.json()).toMatchObject({ code: 'invalid_identity' })
    const wrongHeader = await f.request(id, identity.sub, { Authorization: `Bearer ${pageToken}` })
    expect(wrongHeader.status).toBe(401)
    expect(await wrongHeader.json()).toMatchObject({ code: 'identity_required' })
    const permitted = await f.request(id, identity.sub, { 'X-Hb-Token': await token(`${environment.HB_SITE}/judge`) })
    expect(permitted.status).toBe(200)
    expect(await permitted.json()).toMatchObject({ found: true, progress: { readyIds: [id] } })
    f.sqlite.close()
  })
})
