import { MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS } from '../shared/contracts'
import { ApiFailure } from './errors'

export type ImageType = 'image/png' | 'image/jpeg' | 'image/webp'
export interface ImageInfo { contentType: ImageType; width: number; height: number }

function invalid(): never { throw new ApiFailure(422, 'invalid_image', '图片格式无效，请使用完整的 PNG、JPEG 或 WebP 静态图片') }
function ascii(bytes: Uint8Array, start: number, size: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + size))
}

function png(bytes: Uint8Array): ImageInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 33 || view.getUint32(8) !== 13 || ascii(bytes, 12, 4) !== 'IHDR') invalid()
  const width = view.getUint32(16), height = view.getUint32(20)
  let offset = 8, imageData = false, ended = false
  while (offset + 12 <= bytes.length) {
    const size = view.getUint32(offset), type = ascii(bytes, offset + 4, 4)
    if (offset + size + 12 > bytes.length || type === 'acTL') invalid()
    if (type === 'IDAT' && size > 0) imageData = true
    offset += size + 12
    if (type === 'IEND') { if (size !== 0 || offset !== bytes.length) invalid(); ended = true; break }
  }
  if (!ended || !imageData) invalid()
  return { contentType: 'image/png', width, height }
}

function jpeg(bytes: Uint8Array): ImageInfo {
  if (bytes.length < 12 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) invalid()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 2, width = 0, height = 0
  while (offset + 1 < bytes.length) {
    if (bytes[offset++] !== 0xff) invalid()
    while (bytes[offset] === 0xff) offset++
    const marker = bytes[offset++]
    if (marker === 0xda) { if (!width || !height) invalid(); return { contentType: 'image/jpeg', width, height } }
    if (marker === 0xd9 || marker === undefined) invalid()
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.length) invalid()
    const size = view.getUint16(offset)
    if (size < 2 || offset + size > bytes.length) invalid()
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (size < 8) invalid()
      height = view.getUint16(offset + 3); width = view.getUint16(offset + 5)
    } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) invalid()
    offset += size
  }
  return invalid()
}

function webp(bytes: Uint8Array): ImageInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 20 || view.getUint32(4, true) + 8 !== bytes.length) invalid()
  let offset = 12, width = 0, height = 0, imageData = false
  while (offset + 8 <= bytes.length) {
    const kind = ascii(bytes, offset, 4), size = view.getUint32(offset + 4, true), at = offset + 8
    if (at + size > bytes.length || ['ANIM', 'ANMF'].includes(kind)) invalid()
    if (kind === 'VP8X') {
      if (size !== 10 || (bytes[at] & 0x02)) invalid()
      width = 1 + bytes[at + 4] + (bytes[at + 5] << 8) + (bytes[at + 6] << 16)
      height = 1 + bytes[at + 7] + (bytes[at + 8] << 8) + (bytes[at + 9] << 16)
    }
    if (kind === 'VP8 ') {
      if (size < 10 || ascii(bytes, at + 3, 3) !== '\x9d\x01\x2a') invalid()
      const frameWidth = view.getUint16(at + 6, true) & 0x3fff, frameHeight = view.getUint16(at + 8, true) & 0x3fff
      if (width && (width !== frameWidth || height !== frameHeight)) invalid()
      width = frameWidth; height = frameHeight; imageData = true
    }
    if (kind === 'VP8L') {
      if (size < 5 || bytes[at] !== 0x2f || (bytes[at + 4] >> 5) !== 0) invalid()
      const packed = view.getUint32(at + 1, true)
      const frameWidth = (packed & 0x3fff) + 1, frameHeight = ((packed >> 14) & 0x3fff) + 1
      if (width && (width !== frameWidth || height !== frameHeight)) invalid()
      width = frameWidth; height = frameHeight; imageData = true
    }
    offset = at + size + (size % 2)
  }
  if (!imageData || offset !== bytes.length) invalid()
  return { contentType: 'image/webp', width, height }
}

export function validateImage(bytes: Uint8Array, declaredContentType: string | null): ImageInfo {
  if (bytes.length > MAX_IMAGE_BYTES) throw new ApiFailure(413, 'image_too_large', '图片不能超过 4 MiB')
  let info: ImageInfo
  if (bytes.length >= 8 && ascii(bytes, 0, 8) === '\x89PNG\r\n\x1a\n') info = png(bytes)
  else if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) info = jpeg(bytes)
  else if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') info = webp(bytes)
  else return invalid()
  if (declaredContentType?.split(';')[0].trim().toLowerCase() !== info.contentType) throw new ApiFailure(415, 'wrong_content_type', '图片内容与文件格式不一致')
  if (!info.width || !info.height || info.width * info.height > MAX_IMAGE_PIXELS) throw new ApiFailure(413, 'image_dimensions', '图片不能超过 1600 万像素')
  return info
}

export async function readImage(request: Request): Promise<Uint8Array<ArrayBuffer>> {
  const length = request.headers.get('Content-Length')
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_IMAGE_BYTES)) throw new ApiFailure(413, 'image_too_large', '图片不能超过 4 MiB')
  if (!request.body) invalid()
  const reader = request.body.getReader(), chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_IMAGE_BYTES) { await reader.cancel(); throw new ApiFailure(413, 'image_too_large', '图片不能超过 4 MiB') }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return bytes
}

export async function imageHash(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
