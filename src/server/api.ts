import { LEGACY_MODEL, MAX_ATTEMPTS, MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, MODEL } from '../shared/contracts'
import type { ChallengeConfig, GalleryItem, GalleryResponse, PublicConfig, UploadResult } from '../shared/contracts'
import type { AppEnv } from './env'
import { pageToken, platformSite, verifyIdentity } from './auth'
import { loadChallenge, loadChallengeContext } from './challenge'
import { ApiFailure } from './errors'
import { imageHash, readImage, validateImage } from './images'
import { scoreImage } from './ai'
import { applyLikeBatch, GALLERY_VISIBILITY_SQL, galleryLikeCounts, galleryLikeReceipt, galleryScopeBindings, readGallerySync } from './likes'
import { consumeNonce, createNonce, existingAttempt, galleryGrant, hasGalleryGrant, reserveAttempt } from './store'
import type { Attempt } from './store'
import type { Identity } from './auth'

function json(value: unknown, status = 200): Response { return Response.json(value, { status }) }

function attemptConfig(attempt: Attempt): ChallengeConfig & { model: string } {
  const config = JSON.parse(attempt.config_json) as ChallengeConfig & { model?: string }
  return { ...config, multiReward: config.multiReward ?? false, model: config.model ?? LEGACY_MODEL }
}

function uploadResult(attempt: Attempt, remaining?: number): UploadResult {
  const config = attemptConfig(attempt)
  if (attempt.score === null) throw new Error('Ready result is missing score')
  return {
    id: attempt.id, model: config.model, score: attempt.score, challenge: config.challenge,
    attempt: attempt.attempt_no, remaining: remaining ?? Math.max(0, config.maxAttempts - attempt.attempt_no),
    saved: attempt.image_key !== null, nsfwScore: attempt.nsfw_score ?? null,
    width: attempt.image_width ?? null, height: attempt.image_height ?? null,
  }
}

async function remainingAttempts(db: D1Database, identity: Pick<Identity, 'hongbao' | 'sub'>, maxAttempts: number): Promise<number> {
  const used = await db.prepare('SELECT COALESCE(MAX(attempt_no), 0) AS used FROM image_attempts WHERE hongbao = ? AND user_id = ?')
    .bind(identity.hongbao, identity.sub).first<{ used: number }>()
  return Math.max(0, maxAttempts - (used?.used ?? 0))
}

async function replay(attempt: Attempt, hash: string, db: D1Database): Promise<Response> {
  if (attempt.image_sha256 !== hash) throw new ApiFailure(409, 'idempotency_conflict', '同一个上传编号不能用于不同的图片')
  if (attempt.status === 'failed' && attempt.error_code === 'duplicate_image') {
    const config = attemptConfig(attempt)
    return json({
      error: '这张图片已提交过，本次已消耗 1 次机会，请换一张', code: 'duplicate_image',
      attempt: attempt.attempt_no,
      remaining: await remainingAttempts(db, { hongbao: attempt.hongbao, sub: attempt.user_id }, config.maxAttempts),
    }, 409)
  }
  if (attempt.status === 'processing') throw new ApiFailure(409, 'processing', '这张图片仍在处理，请稍后查询已有结果，不要重新上传')
  if (attempt.status === 'failed') throw new ApiFailure(502, attempt.error_code ?? 'processing_failed', '本次处理未完成，已记录这次尝试，请勿重复提交同一上传')
  const config = attemptConfig(attempt)
  const remaining = await remainingAttempts(db, { hongbao: attempt.hongbao, sub: attempt.user_id }, config.maxAttempts)
  return json(uploadResult(attempt, remaining))
}

async function upload(request: Request, env: AppEnv): Promise<Response> {
  const identity = await verifyIdentity(pageToken(request), 'page', request, env)
  const nonce = request.headers.get('X-Hb-Nonce') ?? ''
  if (!/^[a-zA-Z0-9_.~-]{8,128}$/.test(nonce) || identity.nonce !== nonce) throw new ApiFailure(401, 'nonce_mismatch', '上传许可与身份令牌不匹配，请重新验证身份')
  const key = request.headers.get('Idempotency-Key') ?? ''
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(key)) throw new ApiFailure(400, 'idempotency_required', '上传缺少有效的唯一编号')
  const bytes = await readImage(request)
  const info = validateImage(bytes, request.headers.get('Content-Type'))
  const hash = await imageHash(bytes)
  const existing = await existingAttempt(env.DB, identity, key)
  if (existing) return replay(existing, hash, env.DB)
  const config = await loadChallenge(env, identity, new URL(request.url).origin)
  await consumeNonce(env.DB, nonce)
  const reserved = await reserveAttempt(env.DB, identity, key, hash, info.contentType, config, {
    shared: request.headers.get('X-Hb-Gallery-Consent') === 'v1', width: info.width, height: info.height,
  })
  if (!reserved.created) return replay(reserved.attempt, hash, env.DB)
  const attempt = reserved.attempt
  if (attempt.status !== 'processing') return replay(attempt, hash, env.DB)
  const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[info.contentType]
  const imageKey = config.saveImages ? `images/${identity.hongbao}/${identity.sub}/${attempt.id}.${extension}` : null
  // Neither operation depends on the other. Await both before declaring a result ready.
  const [stored, evaluated] = await Promise.allSettled([
    imageKey ? env.IMAGES.put(imageKey, bytes, {
      httpMetadata: { contentType: info.contentType },
      customMetadata: { hongbao: identity.hongbao, user: identity.sub, result: attempt.id },
    }).then(object => { if (!object) throw new Error('Image write returned no object'); return imageKey }) : Promise.resolve(null),
    scoreImage(env, bytes, info.contentType, config.challenge),
  ])
  const savedKey = stored.status === 'fulfilled' ? stored.value : null
  if (stored.status === 'rejected' || evaluated.status === 'rejected') {
    const code = stored.status === 'rejected' ? 'image_save_failed' : 'ai_failed'
    await env.DB.prepare("UPDATE image_attempts SET status = 'failed', image_key = ?, error_code = ?, updated_at = ? WHERE id = ? AND status = 'processing'")
      .bind(savedKey, code, Date.now(), attempt.id).run()
    throw new ApiFailure(502, code, stored.status === 'rejected' ? '图片保存失败，本次没有生成可兑奖结果；已记录这次尝试' : 'AI 评分失败，本次没有生成可兑奖结果；已记录这次尝试')
  }
  await env.DB.prepare("UPDATE image_attempts SET status = 'ready', image_key = ?, score = ?, nsfw_score = ?, updated_at = ? WHERE id = ? AND status = 'processing'")
    .bind(savedKey, evaluated.value.score, evaluated.value.nsfwScore, Date.now(), attempt.id).run()
  return replay({ ...attempt, status: 'ready', image_key: savedKey, score: evaluated.value.score, nsfw_score: evaluated.value.nsfwScore }, hash, env.DB)
}

async function judgeResult(request: Request, env: AppEnv, id: string): Promise<Response> {
  const identity = await verifyIdentity(request.headers.get('X-Hb-Token'), 'judge', request, env)
  const user = new URL(request.url).searchParams.get('user') ?? ''
  if (!/^\d+$/.test(user)) throw new ApiFailure(400, 'player_required', '缺少待核验的玩家 ID')
  const result = await env.DB.prepare("SELECT * FROM image_attempts WHERE id = ? AND hongbao = ? AND user_id = ? AND status = 'ready'")
    .bind(id, identity.hongbao, user).first<Attempt>()
  if (!result || result.score === null) return json({ found: false })
  const config = attemptConfig(result)
  const passed = result.score >= config.minScore && result.score <= config.maxScore
  const attempts = config.multiReward ? await env.DB.prepare('SELECT id, attempt_no, status FROM image_attempts WHERE hongbao = ? AND user_id = ? ORDER BY attempt_no LIMIT ?')
    .bind(identity.hongbao, user, MAX_ATTEMPTS).all<Pick<Attempt, 'id' | 'attempt_no' | 'status'>>() : null
  const progress = attempts ? {
    remaining: Math.max(0, config.maxAttempts - Math.max(0, ...attempts.results.map(attempt => attempt.attempt_no))),
    readyIds: attempts.results.filter(attempt => attempt.status === 'ready').map(attempt => attempt.id),
    processing: attempts.results.some(attempt => attempt.status === 'processing'),
  } : null
  return json({
    found: true, id: result.id, hongbao: result.hongbao, user: result.user_id,
    ...config, score: result.score, attempt: result.attempt_no, saved: result.image_key !== null,
    ...(progress ? { progress } : {}),
    ...(passed ? { galleryGrant: await galleryGrant(env.DB, identity.hongbao, user) } : {}),
  })
}

async function playerResult(request: Request, env: AppEnv, id: string): Promise<Response> {
  const identity = await verifyIdentity(pageToken(request), 'page', request, env)
  const result = await env.DB.prepare('SELECT * FROM image_attempts WHERE id = ? AND hongbao = ? AND user_id = ?')
    .bind(id, identity.hongbao, identity.sub).first<Attempt>()
  if (!result) throw new ApiFailure(404, 'result_not_found', '没有找到这次上传')
  if (result.error_code === 'duplicate_image') return replay(result, result.image_sha256, env.DB)
  if (result.status !== 'ready') return json({ id: result.id, status: result.status, code: result.error_code })
  return replay(result, result.image_sha256, env.DB)
}

async function fullGallery(request: Request, env: AppEnv, identity: Identity, ended: boolean): Promise<boolean> {
  if (ended || identity.sub === env.OWNER_ID) return true
  return hasGalleryGrant(env.DB, identity, request.headers.get('X-Hb-Gallery-Grant'))
}

function passed(attempt: Attempt): boolean {
  const config = attemptConfig(attempt)
  return attempt.score !== null && attempt.score >= config.minScore && attempt.score <= config.maxScore
}

function encodeCursor(attempt: Attempt): string {
  return btoa(JSON.stringify([attempt.created_at, attempt.id])).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function decodeCursor(value: string | null): [number, string] | null {
  if (value === null) return null
  try {
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(value)) throw new Error('Invalid cursor')
    const decoded: unknown = JSON.parse(atob(value.replaceAll('-', '+').replaceAll('_', '/')))
    if (!Array.isArray(decoded) || decoded.length !== 2 || !Number.isSafeInteger(decoded[0]) || decoded[0] < 0 || typeof decoded[1] !== 'string' || !/^[a-f0-9-]{36}$/.test(decoded[1])) throw new Error('Invalid cursor')
    return decoded as [number, string]
  } catch { throw new ApiFailure(400, 'invalid_cursor', '图片列表的分页位置无效，请刷新后重试') }
}

async function gallery(request: Request, env: AppEnv): Promise<Response> {
  const identity = await verifyIdentity(pageToken(request), 'page', request, env)
  const sync = request.method === 'POST' ? await readGallerySync(request) : {}
  const url = new URL(request.url)
  const context = await loadChallengeContext(env, identity, url.origin)
  const all = await fullGallery(request, env, identity, context.ended)
  const cursor = decodeCursor(url.searchParams.get('cursor'))
  const size = url.searchParams.get('limit') ?? '24'
  if (!/^\d{1,2}$/.test(size) || Number(size) < 1 || Number(size) > 60) throw new ApiFailure(400, 'invalid_limit', '每次最多读取 60 张图片')
  const limit = Number(size)
  const scope = { identity, owner: identity.sub === env.OWNER_ID, all }
  const likeReceipt = sync.batch ? await applyLikeBatch(env.DB, scope, sync.batch)
    : sync.receiptFor ? await galleryLikeReceipt(env.DB, scope, sync.receiptFor) : undefined
  const bindings: (string | number)[] = [...galleryScopeBindings(scope)]
  let sql = `SELECT a.* FROM image_attempts AS a WHERE ${GALLERY_VISIBILITY_SQL}`
  if (cursor) {
    sql += ' AND (a.created_at < ? OR (a.created_at = ? AND a.id < ?))'
    bindings.push(cursor[0], cursor[0], cursor[1])
  }
  sql += ' ORDER BY a.created_at DESC, a.id DESC LIMIT ?'
  bindings.push(limit + 1)
  const records = await env.DB.prepare(sql).bind(...bindings).all<Attempt>()
  const page = records.results.slice(0, limit)
  const likeCounts = await galleryLikeCounts(env.DB, scope, [...page.map(attempt => attempt.id), ...(sync.watch ?? [])])
  const items: GalleryItem[] = page.map(attempt => ({
    id: attempt.id, model: attemptConfig(attempt).model, score: attempt.score!, nsfwScore: attempt.nsfw_score,
    saved: attempt.image_key !== null, createdAt: attempt.created_at,
    own: attempt.user_id === identity.sub, width: attempt.image_width,
    height: attempt.image_height, passed: passed(attempt), likes: likeCounts[attempt.id] ?? 0,
  }))
  const remaining = await remainingAttempts(env.DB, identity, context.config.maxAttempts)
  const latest = await env.DB.prepare("SELECT * FROM image_attempts WHERE hongbao = ? AND user_id = ? AND status = 'ready' ORDER BY attempt_no DESC LIMIT 1")
    .bind(identity.hongbao, identity.sub).first<Attempt>()
  const response: GalleryResponse = {
    items, next: records.results.length > limit ? encodeCursor(page[page.length - 1]) : null,
    visibility: all ? 'all' : 'misses', remaining,
    latest: latest ? uploadResult(latest, remaining) : null,
    likeCounts, ...(likeReceipt ? { likeReceipt } : {}),
  }
  return json(response)
}

async function image(request: Request, env: AppEnv, id: string): Promise<Response> {
  const identity = await verifyIdentity(pageToken(request), 'page', request, env)
  const result = await env.DB.prepare('SELECT * FROM image_attempts WHERE id = ? AND hongbao = ?')
    .bind(id, identity.hongbao).first<Attempt>()
  if (!result?.image_key) throw new ApiFailure(404, 'image_not_found', '图片不存在或你没有查看权限')
  if (result.user_id !== identity.sub && identity.sub !== env.OWNER_ID) {
    if (result.status !== 'ready' || !result.gallery_shared) throw new ApiFailure(404, 'image_not_found', '图片不存在或你没有查看权限')
    const context = await loadChallengeContext(env, identity, new URL(request.url).origin)
    if (passed(result) && !await fullGallery(request, env, identity, context.ended)) throw new ApiFailure(404, 'image_not_found', '图片不存在或你没有查看权限')
  }
  const object = await env.IMAGES.get(result.image_key)
  if (!object) throw new ApiFailure(404, 'image_not_found', '图片不存在')
  return new Response(object.body, { headers: { 'Content-Type': result.content_type, 'Content-Disposition': 'inline', 'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Content-Type-Options': 'nosniff' } })
}

async function route(request: Request, env: AppEnv): Promise<Response> {
  const url = new URL(request.url)
  const origin = request.headers.get('Origin')
  if (origin && origin !== url.origin) throw new ApiFailure(403, 'cross_origin', '请从当前服务的网页发起请求')
  if (url.pathname === '/api/config' && request.method === 'GET') {
    const config: PublicConfig = {
      model: MODEL, ownerConfigured: /^\d+$/.test(env.OWNER_ID),
      maxImageBytes: MAX_IMAGE_BYTES, maxImagePixels: MAX_IMAGE_PIXELS,
      maxAttempts: MAX_ATTEMPTS, storage: 'r2', hbSite: platformSite(env),
    }
    return json(config)
  }
  if (url.pathname === '/api/nonce' && request.method === 'POST') {
    if (!/^\d+$/.test(env.OWNER_ID)) throw new ApiFailure(503, 'owner_not_configured', '服务尚未配置红包作者 ID')
    return json({ nonce: await createNonce(env.DB) })
  }
  if (url.pathname === '/api/upload' && request.method === 'POST') return upload(request, env)
  if (url.pathname === '/api/gallery' && (request.method === 'GET' || request.method === 'POST')) return gallery(request, env)
  const resultMatch = /^\/api\/results\/([a-f0-9-]{36})$/.exec(url.pathname)
  if (resultMatch && request.method === 'GET') return judgeResult(request, env, resultMatch[1])
  const imageMatch = /^\/api\/images\/([a-f0-9-]{36})$/.exec(url.pathname)
  if (imageMatch && request.method === 'GET') return image(request, env, imageMatch[1])
  const uploadMatch = /^\/api\/uploads\/([a-f0-9-]{36})$/.exec(url.pathname)
  if (uploadMatch && request.method === 'GET') return playerResult(request, env, uploadMatch[1])
  throw new ApiFailure(404, 'not_found', '接口不存在')
}

export async function handleApiRequest(request: Request, env: AppEnv): Promise<Response | null> {
  if (!new URL(request.url).pathname.startsWith('/api/')) return null
  let response: Response
  try { response = await route(request, env) }
  catch (error) {
    response = error instanceof ApiFailure
      ? json({ error: error.message, code: error.code }, error.status)
      : json({ error: '服务暂时无法完成请求，请稍后重试', code: 'service_unavailable' }, 503)
  }
  response.headers.set('Cache-Control', 'no-store')
  response.headers.set('X-Content-Type-Options', 'nosniff')
  return response
}
