import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { EyeOff, Heart, ImageOff, Images, LoaderCircle, RefreshCw } from 'lucide-react'
import { assignGalleryColumns, captureGalleryAnchor, isCovered, releaseGalleryAnchorSpace, restoreGalleryAnchor } from '../lib/gallery'
import type { GalleryAnchor } from '../lib/gallery'
import { PrivateImageCache } from '../lib/private-images'
import { modelLabel } from '../shared/contracts'
import type { GalleryItem } from '../shared/contracts'
import { Modal } from './modal'

function PrivateImage({ item, cache, eager = false, source }: { item: GalleryItem; cache: PrivateImageCache; eager?: boolean; source?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [image, setImage] = useState<{ id: string; url?: string; error?: string }>({ id: item.id })
  useEffect(() => {
    if (source) return
    let disposed = false
    let observer: IntersectionObserver | null = null
    const load = () => {
      observer?.disconnect()
      void cache.get(item.id).then(url => { if (!disposed) setImage({ id: item.id, url }) }).catch(error => {
        if (!disposed) setImage({ id: item.id, error: error instanceof Error ? error.message : '图片暂时无法读取' })
      })
    }
    if (eager || !('IntersectionObserver' in window)) load()
    else {
      observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) load() }, { rootMargin: '400px' })
      if (ref.current) observer.observe(ref.current)
    }
    return () => { disposed = true; observer?.disconnect() }
  }, [item.id, cache, eager, source])
  const url = source ?? (image.id === item.id ? image.url : undefined)
  const error = image.id === item.id ? image.error : undefined
  return <span className="private-image" ref={ref}>
    {url ? <img src={url} alt="挑战作品" width={item.width ?? 600} height={item.height ?? 800} decoding="async" />
      : error ? <span className="image-placeholder"><ImageOff size={24} aria-hidden="true" /><span>{error}</span></span>
        : <span className="image-placeholder" aria-label="图片加载中"><Images size={28} strokeWidth={1.4} aria-hidden="true" /></span>}
  </span>
}

function LikeButton({ count, pending, disabled, onLike, detail = false }: {
  count: number; pending: boolean; disabled: boolean; onLike: () => void; detail?: boolean
}) {
  const reducedMotion = useReducedMotion()
  const formatted = new Intl.NumberFormat('zh-CN', { notation: count >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(count)
  return <motion.button type="button" className={detail ? 'detail-like' : 'gallery-like'} data-pending={pending}
    disabled={disabled} aria-label={`点赞，当前 ${count} 次`} title="可以连续点赞，后台定时同步"
    whileTap={reducedMotion ? undefined : { scale: .88 }} transition={{ type: 'spring', stiffness: 500, damping: 22 }}
    onClick={event => { event.stopPropagation(); onLike() }}>
    <Heart size={20} aria-hidden="true" fill={pending ? 'currentColor' : 'none'} /><span aria-hidden="true">{formatted}</span>
  </motion.button>
}

export function Gallery({ items, next, visibility, isLoading, isRefreshing, error, loadingMore, onLoadMore, onRefresh, showNsfw, getHeaders, likeCounts, pendingLikes, canLike, onLike, onWatch, selected, onSelect, selectedSource, selectedActions, minScore, maxScore }: {
  items: GalleryItem[]; next: string | null; visibility: 'misses' | 'all'; isLoading: boolean; isRefreshing: boolean
  error: string | null; loadingMore: boolean; onLoadMore: () => void; onRefresh: () => void
  showNsfw: boolean; getHeaders: () => Promise<Headers>
  likeCounts: Record<string, number>; pendingLikes: Record<string, number>; canLike: boolean
  onLike: (id: string) => void; onWatch: (ids: string[]) => void
  selected: GalleryItem | null; onSelect: (item: GalleryItem | null) => void
  selectedSource?: string; selectedActions?: ReactNode; minScore: number; maxScore: number
}) {
  const root = useRef<HTMLDivElement>(null)
  const anchor = useRef<GalleryAnchor | null>(null)
  const [layout, setLayout] = useState(() => {
    const assignments = new Map<string, number>()
    return { items, assignments, columns: assignGalleryColumns(items, assignments) }
  })
  const [revealed, setRevealed] = useState(new Set<string>())
  const [cache] = useState(() => new PrivateImageCache(getHeaders))
  useLayoutEffect(() => { cache.updateHeaders(getHeaders) }, [cache, getHeaders])
  useEffect(() => () => cache.dispose(), [cache])
  useEffect(() => {
    const releaseSpace = () => { if (root.current) releaseGalleryAnchorSpace(root.current) }
    window.addEventListener('scroll', releaseSpace, { passive: true })
    return () => window.removeEventListener('scroll', releaseSpace)
  }, [])
  useEffect(() => {
    if (!root.current || !('IntersectionObserver' in window)) { onWatch(items.slice(0, 200).map(item => item.id)); return }
    const visible = new Set<string>()
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.galleryId!
        if (entry.isIntersecting) visible.add(id)
        else visible.delete(id)
      }
      onWatch([...visible])
    }, { rootMargin: '400px' })
    for (const node of root.current.querySelectorAll('[data-gallery-id]')) observer.observe(node)
    return () => { observer.disconnect(); onWatch([]) }
  }, [items, onWatch, layout])
  useLayoutEffect(() => {
    if (layout.items === items) return
    anchor.current = root.current ? captureGalleryAnchor(root.current) : null
    const assignments = new Map(layout.assignments)
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Preserve old DOM geometry, then restore its visible anchor in the following layout commit.
    setLayout({ items, assignments, columns: assignGalleryColumns(items, assignments) })
  }, [items, layout])
  useLayoutEffect(() => {
    if (root.current && anchor.current) { restoreGalleryAnchor(root.current, anchor.current); anchor.current = null }
  }, [layout])
  const { columns } = layout
  const reveal = (id: string) => setRevealed(previous => new Set(previous).add(id))
  const selectedCovered = selected ? isCovered(selected, showNsfw, revealed.has(selected.id)) : false

  return <section className="gallery-section" aria-labelledby="gallery-title" ref={root}>
    <div className="gallery-heading"><h2 id="gallery-title">本轮作品</h2><button type="button" className="icon-button" onClick={onRefresh} disabled={isRefreshing} aria-label="刷新作品">
      <RefreshCw size={20} className={isRefreshing ? 'animate-spin' : ''} aria-hidden="true" /></button></div>
    <p className="gallery-description">{visibility === 'all' ? '已解锁本轮全部评分记录。' : '先看未达标作品；领取成功或活动结束后解锁全部。'}</p>
    <div className="gallery-live" aria-live="polite" aria-atomic="true"><span className="sr-only">已显示 {items.length} 条评分记录，新作品会自动更新。</span></div>
    {layout.items.length ? <div className="gallery-columns">{columns.map((column, index) => <div className="gallery-column" key={index}>
      {column.map(item => {
        const covered = isCovered(item, showNsfw, revealed.has(item.id))
        return <article className="gallery-item" key={item.id} data-gallery-id={item.id}>
          {item.saved ? <button type="button" className="gallery-photo" style={{ aspectRatio: `${item.width ?? 3} / ${item.height ?? 4}` }} data-covered={covered}
            aria-label={covered ? 'NSFW，点击查看图片' : `查看评分 ${item.score.toFixed(1)}% 的图片`} onClick={() => covered ? reveal(item.id) : onSelect(item)}>
            <PrivateImage item={item} cache={cache} />
            {covered && <span className="nsfw-cover"><EyeOff size={24} aria-hidden="true" /><strong>NSFW</strong><span>点击查看</span></span>}
            <span className="gallery-score" data-passed={item.passed}>{item.score.toFixed(1)}%</span>
          </button> : <button type="button" className="score-only-record" onClick={() => onSelect(item)} aria-label={`查看评分 ${item.score.toFixed(1)}% 的记录`}>
            <ImageOff size={24} aria-hidden="true" /><strong data-passed={item.passed}>{item.score.toFixed(1)}%</strong><span>仅评分记录</span>
          </button>}
          <LikeButton count={likeCounts[item.id] ?? item.likes ?? 0} pending={Boolean(pendingLikes[item.id])} disabled={!canLike} onLike={() => onLike(item.id)} />
        </article>
      })}
    </div>)}</div> : <div className="gallery-empty">
      {isLoading ? <LoaderCircle className="animate-spin" size={28} aria-hidden="true" /> : <Images size={32} strokeWidth={1.4} aria-hidden="true" />}
      <p>{isLoading ? '正在读取本轮作品' : '还没有可展示的评分记录'}</p>
      <p>最新作品会自动显示在这里。</p>
    </div>}
    {error && <div className="notice" role="status"><p>{error}</p><button type="button" className="text-action" onClick={onRefresh}>重新读取</button></div>}
    {next && <button type="button" className="button-secondary load-more" disabled={loadingMore} onClick={onLoadMore}>
      {loadingMore && <LoaderCircle className="animate-spin" size={18} aria-hidden="true" />}{loadingMore ? '正在加载' : '加载更早作品'}
    </button>}
    <Modal open={Boolean(selected)} title={selected?.saved || selectedSource ? '图片详情' : '评分记录'} onClose={() => onSelect(null)} wide>
      {selected && <>
        {selected.saved || selectedSource ? <button className="detail-photo" type="button" data-covered={selectedCovered} disabled={!selectedCovered} onClick={() => reveal(selected.id)}
          style={{ aspectRatio: `${selected.width ?? 3} / ${selected.height ?? 4}` }} aria-label={selectedCovered ? 'NSFW，点击查看图片' : '挑战作品'}>
          <PrivateImage item={selected} cache={cache} source={selectedSource} eager />
          {selectedCovered && <span className="nsfw-cover"><EyeOff size={26} aria-hidden="true" /><strong>NSFW</strong><span>点击查看</span></span>}
        </button> : <p className="text-muted">本次只保存评分记录，没有保存图片。</p>}
        <div className="image-detail-scores">
          <div className="image-detail-score"><span>匹配评分</span><strong data-passed={selected.passed}>{selected.score.toFixed(1)}%</strong></div>
          <div className="image-detail-score image-detail-nsfw"><span>NSFW 评分</span><strong>{selected.nsfwScore === null ? '未返回' : `${selected.nsfwScore.toFixed(1)}%`}</strong></div>
        </div>
        <div className="image-detail-context"><span>目标区间 {minScore}–{maxScore}%</span>{selected.width && selected.height ? <span>{selected.width} × {selected.height} px</span> : null}</div>
        <div className="image-detail-meta"><p>{modelLabel(selected.model)} · Cloudflare Workers AI</p><LikeButton count={likeCounts[selected.id] ?? selected.likes ?? 0} pending={Boolean(pendingLikes[selected.id])} disabled={!canLike} onLike={() => onLike(selected.id)} detail /></div>
        {selected.nsfwScore === null && <p className="text-muted mt-3">未取得敏感提示分，默认遮罩展示。</p>}
        {selectedActions && <div className="image-detail-actions">{selectedActions}</div>}
      </>}
    </Modal>
  </section>
}
