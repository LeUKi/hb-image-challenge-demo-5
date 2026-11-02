import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiJson } from './hongbao'
import { mergeGalleryItems } from './gallery'
import { LikeQueue } from './likes'
import type { GalleryItem, GalleryResponse } from '../shared/contracts'

interface GalleryState { scope: string; items: GalleryItem[]; next: string | null; visibility: 'misses' | 'all'; counts: Record<string, number> }

export function useGallery({ scope, actorScope, grant, enabled, getHeaders }: {
  scope: string
  actorScope: string
  grant: string | null
  enabled: boolean
  getHeaders: () => Promise<Headers>
}) {
  const [state, setState] = useState<GalleryState>({ scope: '', items: [], next: null, visibility: 'misses', counts: {} })
  const [loadingMore, setLoadingMore] = useState(false)
  const [pageError, setPageError] = useState<string | null>(null)
  const [likeRevision, reviseLikes] = useReducer(value => value + 1, 0)
  const [outboxes] = useState(() => new Map<string, LikeQueue>())
  const watched = useRef<string[]>([])
  const queue = useMemo(() => {
    if (!actorScope || typeof window === 'undefined') return null
    const existing = outboxes.get(actorScope)
    if (existing) return existing
    let storage: Storage | null = null
    try { storage = window.sessionStorage } catch { /* Keep optimistic likes in memory when storage is unavailable. */ }
    const created = new LikeQueue(actorScope, storage)
    outboxes.set(actorScope, created)
    return created
  }, [actorScope, outboxes])
  const current = useRef(state)
  const currentScope = useRef(scope)
  useLayoutEffect(() => { current.current = state; currentScope.current = scope }, [state, scope])
  const latest = useQuery({
    queryKey: ['gallery', scope, grant],
    enabled,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async ({ signal }) => {
      const batch = queue?.batch()
      let first: GalleryResponse
      try {
        const headers = await getHeaders()
        signal.throwIfAborted()
        if (currentScope.current !== scope) throw new DOMException('参与身份已切换', 'AbortError')
        headers.set('Content-Type', 'application/json')
        const knownItems = current.current.scope === scope ? current.current.items : []
        // Pending targets come first, including an immutable batch whose response
        // was lost. Its acknowledgement must arrive with fresh base counts even
        // after the player has scrolled far beyond that card.
        const watch = [...new Set([...Object.keys(queue?.pendingSnapshot() ?? {}), ...watched.current, ...knownItems.map(item => item.id)])].slice(0, 200)
        first = await apiJson<GalleryResponse>('/api/gallery', {
          method: 'POST', headers, signal,
          body: JSON.stringify({ watch, batch, receiptFor: queue?.unacknowledgedBatchId() }),
        })
      } catch (error) { if (batch) queue?.failure(); throw error }
      const previous = current.current.scope === scope ? current.current : null
      const known = new Set(previous?.items.map(item => item.id))
      let items = first.items
      let next = first.next
      const seen = new Set<string>()
      // Fill a busy interval, rather than silently skipping images beyond the first page.
      while (known.size && items.length && !items.some(item => known.has(item.id)) && next && !seen.has(next)) {
        seen.add(next)
        const headers = await getHeaders()
        signal.throwIfAborted()
        if (currentScope.current !== scope) throw new DOMException('参与身份已切换', 'AbortError')
        const page = await apiJson<GalleryResponse>(`/api/gallery?cursor=${encodeURIComponent(next)}`, { headers, signal })
        items = mergeGalleryItems(items, page.items)
        first.likeCounts = { ...first.likeCounts, ...page.likeCounts }
        next = page.next
      }
      return { ...first, items, next }
    },
  })

  useEffect(() => {
    if (!latest.data) return
    const data = latest.data
    if (data.likeReceipt) queue?.ack(data.likeReceipt)
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Reconcile an external server snapshot and its durable optimistic receipt together.
    setState(previous => {
      const sameScope = previous.scope === scope
      const restricted = previous.visibility === 'all' && data.visibility === 'misses'
      const keep = sameScope && !restricted
      const counts = { ...(keep ? previous.counts : {}), ...data.likeCounts }
      for (const item of data.items) if (item.likes !== undefined) counts[item.id] = item.likes
      return { scope, items: mergeGalleryItems(keep ? previous.items : [], data.items), counts,
        next: keep && previous.items.length && previous.visibility === data.visibility ? previous.next : data.next, visibility: data.visibility }
    })
  }, [latest.data, queue, scope])

  const refetch = latest.refetch
  useEffect(() => {
    if (!enabled || !queue || !queue.hasPending()) return
    let timer: number | undefined
    const schedule = () => {
      window.clearTimeout(timer)
      if (document.hidden || latest.isFetching || !queue.hasPending()) return
      timer = window.setTimeout(() => {
        if (!document.hidden) void refetch({ cancelRefetch: false }).finally(reviseLikes)
      }, queue.dueIn())
    }
    schedule()
    document.addEventListener('visibilitychange', schedule)
    return () => { window.clearTimeout(timer); document.removeEventListener('visibilitychange', schedule) }
  }, [enabled, queue, likeRevision, latest.data, latest.isFetching, refetch])

  const like = useCallback((id: string) => {
    if (!enabled || !queue || current.current.scope !== scope || !current.current.items.some(item => item.id === id)) return
    if (!queue.add(id)) setPageError('待同步的点赞较多，请稍后再试；已有点赞已保留。')
    reviseLikes()
  }, [enabled, queue, scope])

  const watch = useCallback((ids: string[]) => { watched.current = ids.slice(0, 200) }, [])

  async function loadMore() {
    if (loadingMore || state.scope !== scope || !state.next) return
    setLoadingMore(true)
    setPageError(null)
    const cursor = state.next
    try {
      const headers = await getHeaders()
      const page = await apiJson<GalleryResponse>(`/api/gallery?cursor=${encodeURIComponent(cursor)}`, { headers })
      if (currentScope.current !== scope) return
      setState(previous => {
        const keep = previous.scope === scope && !(previous.visibility === 'all' && page.visibility === 'misses')
        const counts = { ...(keep ? previous.counts : {}) }
        for (const item of page.items) if (!(item.id in counts)) counts[item.id] = item.likes ?? 0
        return { scope, items: mergeGalleryItems(keep ? previous.items : [], page.items), counts, next: page.next, visibility: page.visibility }
      })
    } catch (error) { setPageError(error instanceof Error ? error.message : '旧作品暂时无法加载') }
    finally { setLoadingMore(false) }
  }

  return {
    items: enabled && state.scope === scope ? state.items : [],
    next: enabled && state.scope === scope ? state.next : null,
    visibility: state.scope === scope ? state.visibility : 'misses' as const,
    latest: latest.data?.latest ?? null,
    remaining: latest.data?.remaining ?? null,
    isLoading: enabled && latest.isPending,
    isRefreshing: latest.isFetching,
    error: pageError ?? (latest.isError ? queue?.hasPending() ? '暂时无法更新作品；点赞已保留，将在恢复连接后同步。' : latest.error.message : null),
    likeCounts: Object.fromEntries(state.scope === scope ? state.items.map(item => [item.id, Math.min(Number.MAX_SAFE_INTEGER, (state.counts[item.id] ?? item.likes ?? 0) + (queue?.pending(item.id) ?? 0))]) : []),
    pendingLikes: queue?.pendingSnapshot() ?? {},
    canLike: enabled && Boolean(queue), like, watch,
    loadingMore, loadMore, refresh: () => latest.refetch({ cancelRefetch: false }),
  }
}
