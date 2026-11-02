import type { GalleryItem } from '../shared/contracts'

export const NSFW_THRESHOLD = 50
export const NSFW_PREFERENCE_KEY = 'hb-image-challenge:show-nsfw'

export function mergeGalleryItems(current: GalleryItem[], incoming: GalleryItem[]): GalleryItem[] {
  const byId = new Map(current.map(item => [item.id, item]))
  for (const item of incoming) byId.set(item.id, item)
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
}

export function isCovered(item: Pick<GalleryItem, 'nsfwScore'>, showNsfw: boolean, revealed: boolean): boolean {
  return !revealed && !showNsfw && (item.nsfwScore === null || item.nsfwScore >= NSFW_THRESHOLD)
}

/** Keep every existing card in its column when a new page or new images arrive. */
export function assignGalleryColumns(items: GalleryItem[], assignments: Map<string, number>, count = 2): GalleryItem[][] {
  const columns = Array.from({ length: count }, () => [] as GalleryItem[])
  let nextColumn = assignments.size % count
  for (const item of items) {
    if (!assignments.has(item.id)) { assignments.set(item.id, nextColumn); nextColumn = (nextColumn + 1) % count }
    columns[assignments.get(item.id)! % count].push(item)
  }
  return columns
}

export interface GalleryAnchor { id: string; top: number }

export function captureGalleryAnchor(root: HTMLElement): GalleryAnchor | null {
  if (window.scrollY < 80) return null
  const visible = [...root.querySelectorAll<HTMLElement>('[data-gallery-id]')]
    .map(node => ({ id: node.dataset.galleryId!, rect: node.getBoundingClientRect() }))
    .filter(({ rect }) => rect.bottom > 0 && rect.top < window.innerHeight)
    .sort((a, b) => Math.max(0, a.rect.top) - Math.max(0, b.rect.top) || a.rect.left - b.rect.left)
  return visible[0] ? { id: visible[0].id, top: visible[0].rect.top } : null
}

export function restoreGalleryAnchor(root: HTMLElement, anchor: GalleryAnchor | null): void {
  if (!anchor) return
  const node = [...root.querySelectorAll<HTMLElement>('[data-gallery-id]')].find(node => node.dataset.galleryId === anchor.id)
  if (!node) return
  const delta = node.getBoundingClientRect().top - anchor.top
  const scrolling = document.scrollingElement ?? document.documentElement
  const missingSpace = window.scrollY + delta - (scrolling.scrollHeight - window.innerHeight)
  if (missingSpace > 0) {
    const rect = root.getBoundingClientRect()
    const siblingOverhang = Math.max(0, (root.parentElement?.getBoundingClientRect().bottom ?? rect.bottom) - rect.bottom)
    // A shorter column can grow without increasing the page height. Keep enough
    // bottom space for the reading anchor even when the browser was at its limit.
    root.style.minHeight = `${rect.height + siblingOverhang + Math.ceil(missingSpace)}px`
  }
  window.scrollBy({ top: delta, behavior: 'instant' })
}

export function releaseGalleryAnchorSpace(root: HTMLElement): void {
  if (window.scrollY < 80) root.style.minHeight = ''
}
