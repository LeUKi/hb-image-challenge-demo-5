import { describe, expect, it, vi } from 'vitest'
import { assignGalleryColumns, isCovered, mergeGalleryItems, releaseGalleryAnchorSpace, restoreGalleryAnchor } from '../../src/lib/gallery'
import type { GalleryItem } from '../../src/shared/contracts'

const item = (id: string, createdAt = 1, nsfwScore: number | null = 10): GalleryItem => ({ id, createdAt, nsfwScore, score: 80, passed: true, own: false, saved: true, width: 600, height: 800 })

describe('automatic anonymous gallery updates', () => {
  it('prepends new images, refreshes duplicate metadata and retains paginated old records', () => {
    const old = [item('c', 3), item('b', 2), item('a', 1)]
    expect(mergeGalleryItems(old, [item('d', 4), { ...item('c', 3), saved: false }])).toEqual([item('d', 4), { ...item('c', 3), saved: false }, item('b', 2), item('a', 1)])
  })

  it('keeps old cards in their existing columns after both prepend and pagination', () => {
    const assignments = new Map<string, number>()
    const first = [item('d', 4), item('c', 3), item('b', 2), item('a', 1)]
    assignGalleryColumns(first, assignments)
    const old = new Map(assignments)
    const columns = assignGalleryColumns([item('f', 6), item('e', 5), ...first, item('z', 0)], assignments)
    for (const [id, column] of old) expect(assignments.get(id)).toBe(column)
    expect(columns.flat().map(x => x.id).sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'z'])
    expect(columns[0][0].id).toBe('f')
    expect(columns[1][0].id).toBe('e')
  })

  it('covers unknown scores before image loading and reveals only the chosen card', () => {
    const unknown = item('unknown', 1, null)
    const nsfw = item('sensitive', 2, 50)
    expect(isCovered(unknown, false, false)).toBe(true)
    expect(isCovered(nsfw, false, false)).toBe(true)
    expect(isCovered(item('safe', 1, 49.9), false, false)).toBe(false)
    expect(isCovered(unknown, false, true)).toBe(false)
    expect(isCovered(nsfw, false, false)).toBe(true)
    expect(isCovered(unknown, true, false)).toBe(false)
  })

  it('alternates columns across successive updates that each add only one new image', () => {
    const assignments = new Map<string, number>()
    let items = [item('first', 1), item('second', 0)]
    assignGalleryColumns(items, assignments)
    for (let n = 2; n <= 4; n++) {
      items = [item(`new-${n}`, n), ...items]
      assignGalleryColumns(items, assignments)
    }
    expect([assignments.get('new-2'), assignments.get('new-3'), assignments.get('new-4')]).toEqual([0, 1, 0])
    expect(assignments.get('first')).toBe(0)
    expect(assignments.get('second')).toBe(1)
  })

  it.each([0, 200])('keeps a bottom reading anchor when an insertion adds no page height (sibling overhang %ipx)', siblingOverhang => {
    const before = { scrollY: 1294, anchorTop: -151.75, documentHeight: 2194, rootHeight: 1900 }
    const style = { minHeight: '' }
    const rootHeight = () => Math.max(before.rootHeight, Number.parseFloat(style.minHeight) || 0)
    const documentHeight = () => before.documentHeight + Math.max(0, rootHeight() - before.rootHeight - siblingOverhang)
    const viewport = {
      scrollY: before.scrollY, innerHeight: 900,
      scrollBy({ top }: ScrollToOptions) { this.scrollY = Math.max(0, Math.min(this.scrollY + (top ?? 0), documentHeight() - this.innerHeight)) },
    }
    const node = { dataset: { galleryId: 'reading' }, getBoundingClientRect: () => ({ top: 206.7 - (viewport.scrollY - before.scrollY) }) }
    const root = {
      style, querySelectorAll: () => [node],
      getBoundingClientRect: () => ({ height: rootHeight(), bottom: 100 + rootHeight() }),
      parentElement: { getBoundingClientRect: () => ({ bottom: 100 + Math.max(rootHeight(), before.rootHeight + siblingOverhang) }) },
    } as unknown as HTMLElement
    vi.stubGlobal('window', viewport)
    vi.stubGlobal('document', { scrollingElement: { get scrollHeight() { return documentHeight() } } })
    try {
      restoreGalleryAnchor(root, { id: 'reading', top: before.anchorTop })
      expect(node.getBoundingClientRect().top).toBeCloseTo(before.anchorTop, 5)
      expect(documentHeight() - viewport.innerHeight - viewport.scrollY).toBeLessThan(1)
      releaseGalleryAnchorSpace(root)
      expect(style.minHeight).not.toBe('')
      viewport.scrollY = 0
      releaseGalleryAnchorSpace(root)
      expect(style.minHeight).toBe('')
      expect(documentHeight()).toBe(before.documentHeight)
    } finally { vi.unstubAllGlobals() }
  })
})
