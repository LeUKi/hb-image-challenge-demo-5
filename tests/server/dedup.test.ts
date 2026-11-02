import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleApiRequest } from '../../src/server/api'
import * as auth from '../../src/server/auth'
import type { AppEnv } from '../../src/server/env'
import { createNonce } from '../../src/server/store'
import { activity, environment, identity, params, png, sqliteD1 } from './helpers'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

function fixture(maxAttempts = 3, saveImages = true) {
  const { db, sqlite } = sqliteD1()
  vi.spyOn(auth, 'verifyIdentity').mockImplementation(async (_token, _kind, request) => ({
    ...identity,
    sub: request.headers.get('X-Test-Player') ?? identity.sub,
    hongbao: request.headers.get('X-Test-Packet') ?? identity.hongbao,
    nonce: request.headers.get('X-Hb-Nonce') ?? undefined,
  }))
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => {
    const published = structuredClone(activity)
    published.activity.id = decodeURIComponent(new URL(input).pathname.split('/').at(-1)!)
    for (const entry of published.activity.judge.params) {
      if (entry.param.key === 'maxAttempts') entry.value = maxAttempts
      if (entry.param.key === 'saveImages') entry.value = saveImages
    }
    return Response.json(published)
  }))
  const scored = { answers: { match: { type: 'noul', noul: 0.85 }, nsfw: { type: 'noul', noul: 0.12 } } }
  const run = vi.fn().mockResolvedValue(scored)
  const put = vi.fn().mockResolvedValue({ key: 'saved' })
  const env = { ...environment, DB: db, AI: { run }, IMAGES: { put } } as unknown as AppEnv
  async function request(options: { user?: string; packet?: string; key?: string; bytes?: Uint8Array<ArrayBuffer>; nonce?: string; consent?: boolean } = {}) {
    const nonce = options.nonce ?? await createNonce(db)
    return new Request('https://challenge.example.com/api/upload', {
      method: 'POST', body: options.bytes ?? png(), headers: {
        Authorization: 'Bearer verified-test-token', 'Content-Type': 'image/png',
        'X-Test-Player': options.user ?? identity.sub, 'X-Test-Packet': options.packet ?? identity.hongbao,
        'X-Hb-Nonce': nonce, 'Idempotency-Key': options.key ?? crypto.randomUUID(),
        ...(options.consent ? { 'X-Hb-Gallery-Consent': 'v1' } : {}),
      },
    })
  }
  async function upload(options: Parameters<typeof request>[0] = {}) {
    return (await handleApiRequest(await request(options), env))!
  }
  function read(path: string, user = identity.sub) {
    return handleApiRequest(new Request(`https://challenge.example.com${path}`, {
      headers: { Authorization: 'Bearer verified-test-token', 'X-Hb-Token': 'verified-judge-token', 'X-Test-Player': user },
    }), env)
  }
  return { db, sqlite, env, request, upload, read, run, put, scored }
}

describe('whole-hongbao exact-image deduplication', () => {
  it('charges own and other players for a duplicate without generating a score, gallery item, or disclosing its owner', async () => {
    const f = fixture()
    const original = await (await f.upload()).json() as { id: string }
    const own = await f.upload()
    expect(own.status).toBe(409)
    expect(await own.json()).toEqual({
      error: '这张图片已提交过，本次已消耗 1 次机会，请换一张', code: 'duplicate_image', attempt: 2, remaining: 1,
    })
    const other = await f.upload({ user: '99', consent: true })
    expect(other.status).toBe(409)
    expect(await other.json()).toEqual({
      error: '这张图片已提交过，本次已消耗 1 次机会，请换一张', code: 'duplicate_image', attempt: 1, remaining: 2,
    })
    expect(f.run).toHaveBeenCalledTimes(1)
    expect(f.put).toHaveBeenCalledTimes(1)
    const rejected = f.sqlite.prepare("SELECT id, status, score, image_key, gallery_shared FROM image_attempts WHERE user_id='99'").get()!
    expect(rejected).toMatchObject({ status: 'failed', score: null, image_key: null, gallery_shared: 0 })
    expect(await (await f.read(`/api/results/${rejected.id}?user=99`))!.json()).toEqual({ found: false })
    const gallery = await (await f.read('/api/gallery', '99'))!.json()
    expect(gallery).toMatchObject({ items: [], latest: null, remaining: 2 })
    expect(JSON.stringify(gallery)).not.toContain(original.id)
    expect(f.sqlite.prepare('SELECT attempt_id FROM image_claims').get()).toMatchObject({ attempt_id: original.id })
    f.sqlite.close()
  })

  it('keeps duplicate retries idempotent and rejects changed bytes without consuming another attempt or nonce', async () => {
    const f = fixture()
    await f.upload({ user: '99' })
    const key = crypto.randomUUID(), nonce = await createNonce(f.db)
    const options = { key, nonce }
    const first = await f.upload(options)
    const firstBody = await first.json()
    const retry = await f.upload(options)
    expect(retry.status).toBe(409)
    expect(await retry.json()).toEqual(firstBody)
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM image_attempts WHERE user_id='42'").get()).toMatchObject({ n: 1 })
    const duplicate = f.sqlite.prepare("SELECT id FROM image_attempts WHERE user_id='42'").get()!
    expect(await (await f.read(`/api/uploads/${duplicate.id}`))!.json()).toEqual(firstBody)
    const conflict = await f.upload({ ...options, bytes: png(2, 1) })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ code: 'idempotency_conflict' })
    const reusedNonce = await f.upload({ nonce, bytes: png(2, 1) })
    expect(reusedNonce.status).toBe(401)
    expect(await reusedNonce.json()).toMatchObject({ code: 'nonce_used' })
    expect(f.run).toHaveBeenCalledTimes(1)
    f.sqlite.close()
  })

  it('allows the same bytes in a different hongbao and different bytes within the same hongbao', async () => {
    const f = fixture()
    expect((await f.upload()).status).toBe(200)
    expect((await f.upload({ packet: 'another-packet' })).status).toBe(200)
    expect((await f.upload({ bytes: png(2, 1) })).status).toBe(200)
    expect(f.run).toHaveBeenCalledTimes(3)
    expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM image_claims').get()).toMatchObject({ n: 3 })
    f.sqlite.close()
  })

  it('charges one duplicate attempt when concurrent requests reuse an idempotency key with fresh permits', async () => {
    const f = fixture()
    await f.upload({ user: '99' })
    const key = crypto.randomUUID(), requests: Request[] = []
    for (let index = 0; index < 8; index++) requests.push(await f.request({ key }))
    const responses = await Promise.all(requests.map(async request => (await handleApiRequest(request, f.env))!))
    for (const response of responses) {
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ code: 'duplicate_image', attempt: 1, remaining: 2 })
    }
    expect(f.sqlite.prepare("SELECT COUNT(*) AS n FROM image_attempts WHERE user_id='42'").get()).toMatchObject({ n: 1 })
    expect(f.run).toHaveBeenCalledTimes(1)
    expect(f.put).toHaveBeenCalledTimes(1)
    f.sqlite.close()
  })

  it('atomically reserves processing files across concurrent users and starts only one AI and R2 operation', async () => {
    const f = fixture()
    let finishAI!: (value: unknown) => void
    f.run.mockImplementation(() => new Promise(resolve => { finishAI = resolve }))
    const requests: Request[] = []
    // Mint permits before racing uploads: the local D1 adapter shares a single
    // SQLite connection, so unrelated nonce transactions must not be nested.
    for (let user = 90; user < 99; user++) requests.push(await f.request({ user: String(user) }))
    const responses: Response[] = []
    const pending = Promise.all(requests.map(async request => {
      const response = (await handleApiRequest(request, f.env))!
      responses.push(response)
      return response
    }))
    await vi.waitFor(() => { expect(f.run).toHaveBeenCalledTimes(1); expect(responses).toHaveLength(8) })
    expect(responses.every(response => response.status === 409)).toBe(true)
    for (const response of responses) expect(await response.json()).toMatchObject({ code: 'duplicate_image', attempt: 1, remaining: 2 })
    expect(f.run).toHaveBeenCalledTimes(1)
    expect(f.put).toHaveBeenCalledTimes(1)
    expect(f.sqlite.prepare("SELECT COUNT(*) AS n FROM image_attempts WHERE status='processing'").get()).toMatchObject({ n: 1 })
    finishAI(f.scored)
    expect((await pending).filter(response => response.status === 200)).toHaveLength(1)
    expect(f.sqlite.prepare("SELECT COUNT(*) AS n FROM image_attempts WHERE status='ready'").get()).toMatchObject({ n: 1 })
    f.sqlite.close()
  })

  it.each(['ai', 'r2'] as const)('releases an original %s failure without releasing a later owner on an old retry', async (failure) => {
    const f = fixture()
    if (failure === 'ai') f.run.mockRejectedValueOnce(new Error('AI failed'))
    else f.put.mockRejectedValueOnce(new Error('R2 failed'))
    const key = crypto.randomUUID(), nonce = await createNonce(f.db)
    expect((await f.upload({ key, nonce })).status).toBe(502)
    expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM image_claims').get()).toMatchObject({ n: 0 })
    const next = await f.upload({ user: '99' })
    expect(next.status).toBe(200)
    const nextId = (await next.json() as { id: string }).id
    expect((await f.upload({ key, nonce })).status).toBe(502)
    expect(f.sqlite.prepare('SELECT attempt_id FROM image_claims').get()).toMatchObject({ attempt_id: nextId })
    expect((await f.upload({ user: '98' })).status).toBe(409)
    expect(f.run).toHaveBeenCalledTimes(2)
    expect(f.put).toHaveBeenCalledTimes(2)
    f.sqlite.close()
  })

  it('counts duplicates against all ten available attempts, then enforces the hard limit', async () => {
    const f = fixture(10)
    expect((await f.upload({ user: '99' })).status).toBe(200)
    for (let attempt = 1; attempt <= 10; attempt++) {
      const response = await f.upload()
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ code: 'duplicate_image', attempt, remaining: 10 - attempt })
    }
    const exhausted = await f.upload()
    expect(exhausted.status).toBe(429)
    expect(await exhausted.json()).toMatchObject({ code: 'attempts_exhausted' })
    expect(f.sqlite.prepare("SELECT COUNT(*) AS n, MAX(attempt_no) AS used FROM image_attempts WHERE user_id='42'").get()).toMatchObject({ n: 10, used: 10 })
    expect(f.run).toHaveBeenCalledTimes(1)
    f.sqlite.close()
  })

  it('keeps unretained ready files occupied even though no R2 object exists', async () => {
    const f = fixture(3, false)
    expect((await f.upload()).status).toBe(200)
    expect((await f.upload({ user: '99' })).status).toBe(409)
    expect(f.put).not.toHaveBeenCalled()
    expect(f.run).toHaveBeenCalledTimes(1)
    f.sqlite.close()
  })
})

describe('image dedup migration', () => {
  it('preserves historical duplicates, reserves ready/processing copies, and hands a failed legacy claim to the surviving copy', () => {
    const sqlite = new DatabaseSync(':memory:')
    const migrations = new URL('../../migrations/', import.meta.url)
    for (const file of ['0001_initial.sql', '0002_gallery.sql', '0003_gallery_likes.sql']) {
      sqlite.exec(readFileSync(new URL(file, migrations), 'utf8'))
    }
    const seed = sqlite.prepare(`INSERT INTO image_attempts
      (id,hongbao,user_id,idempotency_key,image_sha256,attempt_no,config_json,status,content_type,score,created_at,updated_at)
      VALUES (?,?,?,?,?,1,?,?,'image/png',?, ?,?)`)
    seed.run('old-processing', 'packet', '1', 'old-1', 'same-file', JSON.stringify(params), 'processing', null, 1, 1)
    seed.run('old-ready', 'packet', '2', 'old-2', 'same-file', JSON.stringify(params), 'ready', 85, 2, 2)
    seed.run('old-failed', 'packet', '3', 'old-3', 'failed-file', JSON.stringify(params), 'failed', null, 3, 3)
    seed.run('different-packet', 'another-packet', '1', 'old-4', 'same-file', JSON.stringify(params), 'ready', 85, 4, 4)
    const before = sqlite.prepare('SELECT * FROM image_attempts ORDER BY id').all()
    sqlite.exec(readFileSync(new URL('0004_image_dedup.sql', migrations), 'utf8'))
    expect(sqlite.prepare('SELECT * FROM image_attempts ORDER BY id').all()).toEqual(before)
    expect(sqlite.prepare('SELECT * FROM image_claims ORDER BY hongbao').all()).toEqual([
      { hongbao: 'another-packet', image_sha256: 'same-file', attempt_id: 'different-packet' },
      { hongbao: 'packet', image_sha256: 'same-file', attempt_id: 'old-processing' },
    ])
    seed.run('new-duplicate', 'packet', '4', 'new-1', 'same-file', JSON.stringify(params), 'processing', null, 5, 5)
    expect(sqlite.prepare('SELECT status,error_code FROM image_attempts WHERE id=?').get('new-duplicate'))
      .toMatchObject({ status: 'failed', error_code: 'duplicate_image' })
    expect(sqlite.prepare("SELECT attempt_id FROM image_claims WHERE hongbao='packet'").get()).toMatchObject({ attempt_id: 'old-processing' })
    sqlite.prepare("UPDATE image_attempts SET status='failed' WHERE id='old-processing'").run()
    expect(sqlite.prepare("SELECT attempt_id FROM image_claims WHERE hongbao='packet'").get()).toMatchObject({ attempt_id: 'old-ready' })
    seed.run('failed-file-retry', 'packet', '5', 'new-2', 'failed-file', JSON.stringify(params), 'processing', null, 6, 6)
    expect(sqlite.prepare('SELECT status FROM image_attempts WHERE id=?').get('failed-file-retry')).toMatchObject({ status: 'processing' })
    sqlite.close()
  })
})
