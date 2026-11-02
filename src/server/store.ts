import { MODEL } from '../shared/contracts'
import type { ChallengeConfig } from '../shared/contracts'
import type { Identity } from './auth'
import type { ImageType } from './images'
import { ApiFailure } from './errors'

export interface Attempt {
  id: string
  hongbao: string
  user_id: string
  idempotency_key: string
  image_sha256: string
  attempt_no: number
  config_json: string
  status: 'processing' | 'ready' | 'failed'
  image_key: string | null
  content_type: ImageType
  score: number | null
  nsfw_score: number | null
  image_width: number | null
  image_height: number | null
  gallery_shared: 0 | 1
  error_code: string | null
  created_at: number
  updated_at: number
}

export const RESERVE_SQL = `INSERT INTO image_attempts
  (id, hongbao, user_id, idempotency_key, image_sha256, attempt_no, config_json,
   status, content_type, created_at, updated_at, gallery_shared, image_width, image_height)
  SELECT ?, ?, ?, ?, ?, COALESCE(MAX(attempt_no), 0) + 1, ?, 'processing', ?, ?, ?, ?, ?, ?
  FROM image_attempts WHERE hongbao = ? AND user_id = ?
  HAVING COUNT(*) < ?
  ON CONFLICT DO NOTHING RETURNING id`

export async function existingAttempt(db: D1Database, identity: Identity, idempotencyKey: string): Promise<Attempt | null> {
  return db.prepare('SELECT * FROM image_attempts WHERE hongbao = ? AND user_id = ? AND idempotency_key = ?')
    .bind(identity.hongbao, identity.sub, idempotencyKey).first<Attempt>()
}

export async function reserveAttempt(db: D1Database, identity: Identity, key: string, hash: string, contentType: ImageType, config: ChallengeConfig, image: { shared: boolean; width: number; height: number } | null = null): Promise<{ attempt: Attempt; created: boolean }> {
  const id = crypto.randomUUID(), now = Date.now()
  const inserted = await db.prepare(RESERVE_SQL).bind(
    id, identity.hongbao, identity.sub, key, hash, JSON.stringify({ ...config, model: MODEL }), contentType,
    now, now, image?.shared ? 1 : 0, image?.width ?? null, image?.height ?? null,
    identity.hongbao, identity.sub, config.maxAttempts,
  ).first<{ id: string }>()
  if (inserted) {
    // SQLite RETURNING observes values before AFTER triggers; re-read the
    // persisted status so a duplicate can never start inference or storage.
    const attempt = await existingAttempt(db, identity, key)
    if (!attempt) throw new Error('Reserved attempt was not stored')
    return { attempt, created: true }
  }
  const existing = await existingAttempt(db, identity, key)
  if (existing) return { attempt: existing, created: false }
  throw new ApiFailure(429, 'attempts_exhausted', '这个红包的图片尝试次数已用完')
}

export async function galleryGrant(db: D1Database, hongbao: string, user: string): Promise<string> {
  const grant = (crypto.randomUUID() + crypto.randomUUID()).replaceAll('-', '')
  await db.prepare('INSERT INTO gallery_grants (hongbao, user_id, grant, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (hongbao, user_id) DO NOTHING')
    .bind(hongbao, user, grant, Date.now()).run()
  const stored = await db.prepare('SELECT grant FROM gallery_grants WHERE hongbao = ? AND user_id = ?')
    .bind(hongbao, user).first<{ grant: string }>()
  if (!stored) throw new Error('Gallery grant was not stored')
  return stored.grant
}

export async function hasGalleryGrant(db: D1Database, identity: Identity, grant: string | null): Promise<boolean> {
  if (!grant) return false
  if (!/^[a-f0-9]{64}$/.test(grant)) throw new ApiFailure(403, 'invalid_gallery_grant', '查看许可无效，请重新读取领取状态')
  const stored = await db.prepare('SELECT 1 AS valid FROM gallery_grants WHERE hongbao = ? AND user_id = ? AND grant = ?')
    .bind(identity.hongbao, identity.sub, grant).first<{ valid: number }>()
  if (!stored) throw new ApiFailure(403, 'invalid_gallery_grant', '查看许可无效，请重新读取领取状态')
  return true
}

export async function createNonce(db: D1Database): Promise<string> {
  const nonce = crypto.randomUUID() + crypto.randomUUID(), now = Date.now()
  await db.batch([
    db.prepare('DELETE FROM upload_nonces WHERE expires_at < ?').bind(now),
    db.prepare('INSERT INTO upload_nonces (nonce, expires_at) VALUES (?, ?)').bind(nonce, now + 5 * 60_000),
  ])
  return nonce
}

export async function consumeNonce(db: D1Database, nonce: string): Promise<void> {
  const consumed = await db.prepare('DELETE FROM upload_nonces WHERE nonce = ? AND expires_at > ? RETURNING nonce')
    .bind(nonce, Date.now()).first<{ nonce: string }>()
  if (!consumed) throw new ApiFailure(401, 'nonce_used', '上传许可已过期或已使用，请重新验证身份')
}
