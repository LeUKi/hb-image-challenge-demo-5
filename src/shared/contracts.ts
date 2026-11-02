export const MODEL_NAME = 'clef-flash' as const
export const MODEL = `@cf/cloudflare/${MODEL_NAME}` as const
export const LEGACY_MODEL = '@cf/cloudflare/clef-omni' as const

export function modelLabel(model: string = LEGACY_MODEL): string {
  if (model === MODEL) return 'Clef Flash'
  if (model === LEGACY_MODEL) return 'Clef Omni'
  return model
}
export const MAX_ATTEMPTS = 10
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024
export const MAX_IMAGE_PIXELS = 16_000_000

export interface ChallengeConfig {
  challenge: string
  minScore: number
  maxScore: number
  maxAttempts: number
  multiReward: boolean
  saveImages: boolean
  reward: number
  scoreReward: boolean
  minReward: number
}

export const DEFAULT_CHALLENGE: ChallengeConfig = {
  challenge: '这张图片里有一只猫',
  minScore: 70,
  maxScore: 100,
  maxAttempts: 3,
  multiReward: false,
  saveImages: true,
  reward: 100,
  scoreReward: false,
  minReward: 1,
}

export interface PublicConfig {
  model: string
  ownerConfigured: boolean
  maxImageBytes: number
  maxImagePixels: number
  maxAttempts: number
  storage: 'r2'
  hbSite: string
}

export interface UploadResult {
  id: string
  model?: string
  score: number
  challenge: string
  attempt: number
  remaining: number
  saved: boolean
  nsfwScore: number | null
  width: number | null
  height: number | null
}

export interface GalleryItem {
  id: string
  model?: string
  score: number
  nsfwScore: number | null
  saved: boolean
  createdAt: number
  own: boolean
  width: number | null
  height: number | null
  passed: boolean
  likes?: number
}

export interface GalleryLikeEntry {
  id: string
  count: number
}

export interface GalleryLikeBatch {
  id: string
  items: GalleryLikeEntry[]
}

export interface GalleryLikeReceipt {
  id: string
  status: 'accepted' | 'throttled'
  retryAfterMs: number
  rejected: string[]
}

export interface GallerySyncRequest {
  batch?: GalleryLikeBatch
  watch?: string[]
  receiptFor?: string
}

export interface GalleryResponse {
  items: GalleryItem[]
  next: string | null
  visibility: 'misses' | 'all'
  remaining: number
  latest: UploadResult | null
  likeCounts?: Record<string, number>
  likeReceipt?: GalleryLikeReceipt
}

export interface ApiError {
  error: string
  code?: string
  attempt?: number
  remaining?: number
}
