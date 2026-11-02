import type { GalleryLikeBatch, GalleryLikeReceipt, GallerySyncRequest } from '../shared/contracts'
import type { Identity } from './auth'
import { ApiFailure } from './errors'

const MAX_BODY_BYTES = 32 * 1024
const LIKE_INTERVAL_MS = 30_000
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

export interface GalleryScope {
  identity: Identity
  owner: boolean
  all: boolean
}

// Reuse exactly the same predicate for reads, count watches, and vote targets.
export const GALLERY_VISIBILITY_SQL = `a.hongbao = ? AND a.status = 'ready' AND a.score IS NOT NULL
  AND (a.user_id = ? OR ? = 1 OR (a.gallery_shared = 1 AND (? = 1
    OR a.score < CAST(json_extract(a.config_json, '$.minScore') AS REAL)
    OR a.score > CAST(json_extract(a.config_json, '$.maxScore') AS REAL))))`

export function galleryScopeBindings(scope: GalleryScope): [string, string, number, number] {
  return [scope.identity.hongbao, scope.identity.sub, scope.owner ? 1 : 0, scope.all ? 1 : 0]
}

function invalidSync(): never {
  throw new ApiFailure(400, 'invalid_gallery_sync', '点赞同步参数无效，请刷新后重试')
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) invalidSync()
  return value.toLowerCase()
}

export async function readGallerySync(request: Request): Promise<GallerySyncRequest> {
  const length = request.headers.get('Content-Length')
  if (length && /^\d+$/.test(length) && Number(length) > MAX_BODY_BYTES) throw new ApiFailure(413, 'gallery_sync_too_large', '单次点赞同步数据过大')
  const reader = request.body?.getReader()
  if (!reader) invalidSync()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_BODY_BYTES) {
        await reader.cancel()
        throw new ApiFailure(413, 'gallery_sync_too_large', '单次点赞同步数据过大')
      }
      chunks.push(next.value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  let input: unknown
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { invalidSync() }
  if (!record(input) || !keys(input, ['batch', 'watch', 'receiptFor'])) invalidSync()
  const sync: GallerySyncRequest = {}
  if (input.receiptFor !== undefined) sync.receiptFor = uuid(input.receiptFor)
  if (input.watch !== undefined) {
    if (!Array.isArray(input.watch) || input.watch.length > 200) invalidSync()
    sync.watch = input.watch.map(uuid)
    if (new Set(sync.watch).size !== sync.watch.length) invalidSync()
  }
  if (input.batch !== undefined) {
    const batch = input.batch
    if (!record(batch) || !keys(batch, ['id', 'items']) || !Array.isArray(batch.items) || batch.items.length < 1 || batch.items.length > 50) invalidSync()
    const id = uuid(batch.id)
    const items = batch.items.map(item => {
      if (!record(item) || !keys(item, ['id', 'count']) || typeof item.count !== 'number' || !Number.isInteger(item.count) || item.count < 1 || item.count > 1000) invalidSync()
      return { id: uuid(item.id), count: item.count }
    }).sort((left, right) => left.id.localeCompare(right.id))
    if (new Set(items.map(item => item.id)).size !== items.length) invalidSync()
    sync.batch = { id, items }
  }
  return sync
}

export async function applyLikeBatch(db: D1Database, scope: GalleryScope, batch: GalleryLikeBatch): Promise<GalleryLikeReceipt> {
  const { hongbao, sub } = scope.identity
  const now = Date.now(), operation = crypto.randomUUID()
  const payload = JSON.stringify(batch.items)
  // D1 batch is one transaction. The operation token limits increments and gate
  // advancement to the request that actually inserted this immutable ledger row.
  await db.batch([
    db.prepare(`INSERT INTO gallery_like_batches
      (hongbao, user_id, batch_id, items_json, rejected_json, accepted_at, operation_id)
      SELECT ?, ?, ?, ?, COALESCE((
        SELECT json_group_array(json_extract(item.value, '$.id')) FROM json_each(?) AS item
        WHERE NOT EXISTS (SELECT 1 FROM image_attempts AS a
          WHERE a.id = json_extract(item.value, '$.id') AND ${GALLERY_VISIBILITY_SQL})
      ), '[]'), ?, ?
      WHERE COALESCE((SELECT next_allowed_at FROM gallery_like_gates WHERE hongbao = ? AND user_id = ?), 0) <= ?
      ON CONFLICT (hongbao, user_id, batch_id) DO NOTHING`)
      .bind(hongbao, sub, batch.id, payload, payload, ...galleryScopeBindings(scope), now, operation, hongbao, sub, now),
    db.prepare(`INSERT INTO gallery_like_counts (image_id, likes)
      SELECT json_extract(item.value, '$.id'), CAST(json_extract(item.value, '$.count') AS INTEGER)
      FROM gallery_like_batches AS b, json_each(b.items_json) AS item
      WHERE b.hongbao = ? AND b.user_id = ? AND b.batch_id = ? AND b.operation_id = ?
        AND NOT EXISTS (SELECT 1 FROM json_each(b.rejected_json) AS rejected
          WHERE rejected.value = json_extract(item.value, '$.id'))
      ON CONFLICT (image_id) DO UPDATE SET likes = MIN(9007199254740991, gallery_like_counts.likes + excluded.likes)`)
      .bind(hongbao, sub, batch.id, operation),
    db.prepare(`INSERT INTO gallery_like_gates (hongbao, user_id, next_allowed_at)
      SELECT hongbao, user_id, accepted_at + ? FROM gallery_like_batches
      WHERE hongbao = ? AND user_id = ? AND batch_id = ? AND operation_id = ?
      ON CONFLICT (hongbao, user_id) DO UPDATE SET next_allowed_at = excluded.next_allowed_at`)
      .bind(LIKE_INTERVAL_MS, hongbao, sub, batch.id, operation),
  ])
  const stored = await storedLikeBatch(db, scope, batch.id)
  if (stored.items_json !== null && stored.items_json !== payload) throw new ApiFailure(409, 'like_batch_conflict', '同一个点赞编号不能用于不同的内容')
  return {
    id: batch.id,
    status: stored.items_json === null ? 'throttled' : 'accepted',
    retryAfterMs: Math.max(0, stored.next_allowed_at - now),
    rejected: stored.items_json === null ? [] : JSON.parse(stored.rejected_json!) as string[],
  }
}

async function storedLikeBatch(db: D1Database, scope: GalleryScope, id: string): Promise<{ items_json: string | null; rejected_json: string | null; next_allowed_at: number }> {
  const { hongbao, sub } = scope.identity
  const stored = await db.prepare(`SELECT
    (SELECT items_json FROM gallery_like_batches WHERE hongbao = ? AND user_id = ? AND batch_id = ?) AS items_json,
    (SELECT rejected_json FROM gallery_like_batches WHERE hongbao = ? AND user_id = ? AND batch_id = ?) AS rejected_json,
    COALESCE((SELECT next_allowed_at FROM gallery_like_gates WHERE hongbao = ? AND user_id = ?), 0) AS next_allowed_at`)
    .bind(hongbao, sub, id, hongbao, sub, id, hongbao, sub)
    .first<{ items_json: string | null; rejected_json: string | null; next_allowed_at: number }>()
  if (!stored) throw new Error('Missing gallery like receipt')
  return stored
}

export async function galleryLikeReceipt(db: D1Database, scope: GalleryScope, id: string): Promise<GalleryLikeReceipt | undefined> {
  const stored = await storedLikeBatch(db, scope, id)
  if (stored.items_json === null) return undefined
  return {
    id, status: 'accepted', retryAfterMs: Math.max(0, stored.next_allowed_at - Date.now()),
    rejected: JSON.parse(stored.rejected_json!) as string[],
  }
}

export async function galleryLikeCounts(db: D1Database, scope: GalleryScope, ids: string[]): Promise<Record<string, number>> {
  if (ids.length === 0) return {}
  const records = await db.prepare(`SELECT a.id, COALESCE(l.likes, 0) AS likes
    FROM image_attempts AS a LEFT JOIN gallery_like_counts AS l ON l.image_id = a.id
    WHERE ${GALLERY_VISIBILITY_SQL} AND a.id IN (SELECT value FROM json_each(?))`)
    .bind(...galleryScopeBindings(scope), JSON.stringify([...new Set(ids)]))
    .all<{ id: string; likes: number }>()
  return Object.fromEntries(records.results.map(item => [item.id, item.likes]))
}
