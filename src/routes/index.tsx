import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useForm } from '@tanstack/react-form'
import { useAtom } from 'jotai'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { ArrowRight, Check, CheckCircle2, CircleHelp, EyeOff, ImagePlus, LoaderCircle, RotateCcw, Settings2, Sparkles, X } from 'lucide-react'
import { Layout } from '../components/layout'
import { Modal } from '../components/modal'
import { Gallery } from '../components/gallery'
import { ApiRequestError, apiJson, connectHongbao } from '../lib/hongbao'
import { displayedChallenge, expectedReward, formatReward } from '../lib/challenge'
import { galleryGrant, galleryHeaders, PageIdentityCache } from '../lib/identity'
import { NSFW_PREFERENCE_KEY } from '../lib/gallery'
import { useGallery } from '../lib/use-gallery'
import { ParticipantScope } from '../lib/participant-scope'
import { acceptedResults, canChooseImage, canSubmitScore, challengeProgress, confirmedSubmission, participationState, readPendingSubmission, SETTLE_INPUT, submittedResult, writePendingSubmission } from '../lib/participant'
import type { PendingSubmission } from '../lib/participant'
import { instructionsAtom, noticeAtom, phaseAtom, resultAtom, sessionAtom } from '../lib/state'
import { MAX_IMAGE_BYTES, MODEL, modelLabel } from '../shared/contracts'
import type { GalleryItem, PublicConfig, UploadResult } from '../shared/contracts'

export const Route = createFileRoute('/')({ component: ChallengePage })

function ChallengePage() {
  const [session, setSession] = useAtom(sessionAtom)
  const [notice, setNotice] = useAtom(noticeAtom)
  const [result, setResult] = useAtom(resultAtom)
  const [phase, setPhase] = useAtom(phaseAtom)
  const [instructions, setInstructions] = useAtom(instructionsAtom)
  const [preview, setPreview] = useState<string | null>(null)
  const [resultImage, setResultImage] = useState<{ id: string; url: string } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [fileMeta, setFileMeta] = useState<{ name: string; size: number } | null>(null)
  const [remaining, setRemaining] = useState<number | null>(null)
  const [modal, setModal] = useState<'settings' | 'help' | 'preview' | 'result' | 'settle' | GalleryItem | null>(null)
  const [showNsfw, setShowNsfw] = useState(false)
  const [verifiedIdentity, setVerifiedIdentity] = useState<{ key: string; version: number; userId: string } | null>(null)
  const [scopeGuard] = useState(() => new ParticipantScope())
  const reducedMotion = useReducedMotion()
  const inputRef = useRef<HTMLInputElement>(null)
  const idempotency = useRef('')
  const actionInProgress = useRef(false)
  const refreshParticipant = useRef<(() => Promise<void>) | null>(null)
  const refreshGallery = useRef<(() => void) | null>(null)
  const currentIdentity = useRef<PageIdentityCache | null>(null)
  const verifiedActor = useRef<string | null>(null)
  const suppressRestore = useRef(false)
  const pendingSubmissionRef = useRef<PendingSubmission | null>(null)
  const [pendingSubmission, setPendingSubmission] = useState<PendingSubmission | null>(null)
  const [submittedResults, setSubmittedResults] = useState(() => new Set<string>())
  const config = useQuery({ queryKey: ['service-config'], queryFn: () => apiJson<PublicConfig>('/api/config'), enabled: typeof window !== 'undefined' })
  const challenge = displayedChallenge(session.hongbao)
  const connected = session.status === 'connected'
  const busy = phase !== 'idle'
  const viewerKey = session.me?.signedIn ? session.me.name : ''
  const identityScope = session.hongbao?.id ?? ''
  const identity = useMemo(() => session.sdk ? new PageIdentityCache(session.sdk, () => session.sdk!.now(), identityScope) : null, [session.sdk, identityScope])
  useLayoutEffect(() => { currentIdentity.current = identity }, [identity])
  const identityVerified = Boolean(identity && verifiedIdentity?.key === identity.cacheKey && verifiedIdentity.version === identity.version)
  // A focus recheck hides private content without discarding local file selection.
  const trustedWorkspace = identity && verifiedIdentity?.key === identity.cacheKey ? `${identityScope}:${verifiedIdentity.userId}` : ''
  const workspaceScope = connected && session.me ? session.me.signedIn ? trustedWorkspace : `${identityScope}:anonymous` : ''
  const grant = galleryGrant(session.myView)
  const acceptIdentity = useCallback((cache: PageIdentityCache, value: Awaited<ReturnType<PageIdentityCache['get']>>) => {
    if (currentIdentity.current !== cache) throw new Error('参与身份正在重新核对，请稍后继续')
    const actor = `${cache.scope}:${value.user.id}`
    const changedActor = verifiedActor.current !== null && verifiedActor.current !== actor
    verifiedActor.current = actor
    setVerifiedIdentity(previous => previous?.key === cache.cacheKey && previous.version === cache.version && previous.userId === value.user.id
      ? previous : { key: cache.cacheKey, version: cache.version, userId: value.user.id })
    if (changedActor) {
      setModal(null)
      setSession(previous => ({ ...previous, me: undefined, myView: null, participantStatus: 'checking' }))
      void refreshParticipant.current?.()
    }
  }, [setSession])
  const getHeaders = useCallback(async () => {
    if (!identity) throw new Error('请从红包页打开后查看作品')
    const expectedUser = verifiedIdentity?.key === identity.cacheKey ? verifiedIdentity.userId : identity.subject()
    const value = await identity.get()
    acceptIdentity(identity, value)
    if (expectedUser && value.user.id !== expectedUser) throw new Error('登录账号已切换，请稍后继续')
    return galleryHeaders(value.token, grant)
  }, [identity, grant, acceptIdentity, verifiedIdentity])
  const galleryScope = `${identityScope}:${identity?.cacheKey ?? 'anonymous'}:${identityVerified ? verifiedIdentity!.userId : `checking-${identity?.version ?? 0}`}`
  const gallery = useGallery({ scope: galleryScope, actorScope: identityVerified ? trustedWorkspace : '', grant,
    enabled: connected && Boolean(session.me?.signedIn) && session.participantStatus === 'ready' && Boolean(config.data?.ownerConfigured), getHeaders })
  const refetchGallery = gallery.refresh
  useEffect(() => { refreshGallery.current = () => { void refetchGallery() } }, [refetchGallery])
  const progress = challengeProgress(session.myView, challenge.maxAttempts)
  const remainingSources = [remaining, gallery.remaining, progress?.remaining].filter((value): value is number => typeof value === 'number')
  const remainingAttempts = remainingSources.length ? Math.min(...remainingSources) : null
  const participation = participationState({
    session: session.status, checked: session.me?.signedIn && (!identityVerified || (gallery.isLoading && !session.me.claim && !session.me.settled)) ? 'checking' : session.participantStatus ?? 'checking', hongbao: session.hongbao,
    me: session.me, remaining: remainingAttempts, unconfirmed: Boolean(pendingSubmission) && phase !== 'submitting',
  })
  const awards = acceptedResults(session.myView)
  const isSubmittedResult = (id: string) => submittedResults.has(id) || submittedResult(session.myView, id)
  const retainedChooser = participation.kind === 'checking' && connected && Boolean(session.me?.signedIn) && Boolean(trustedWorkspace) &&
    canChooseImage(participationState({ session: session.status, checked: 'ready', hongbao: session.hongbao, me: session.me, remaining: remainingAttempts, unconfirmed: Boolean(pendingSubmission) && phase !== 'submitting' }))
  const showChooser = canChooseImage(participation) || retainedChooser
  const privateWorkspaceVisible = !connected || identityVerified
  const canSelect = !busy && showChooser
  const canUpload = !busy && participation.kind === 'ready' && Boolean(config.data?.ownerConfigured)
  const canSubmit = !busy && canSubmitScore(participation)
  const settlementParticipation = participationState({ session: session.status, checked: identityVerified ? session.participantStatus ?? 'checking' : 'checking',
    hongbao: session.hongbao, me: session.me, remaining: null, unconfirmed: Boolean(pendingSubmission) && phase !== 'submitting' })
  const canSettle = challenge.multiReward && identityVerified && !busy && canSubmitScore(settlementParticipation)
  const score = connected && !identityVerified ? undefined : result?.score ?? progress?.score
  const latestItem: GalleryItem | null = result ? {
    id: result.id, model: result.model, score: result.score, nsfwScore: result.nsfwScore, saved: result.saved,
    width: result.width, height: result.height, createdAt: 0, own: true,
    passed: result.score >= challenge.minScore && result.score <= challenge.maxScore,
  } : null
  const selectedImage = identityVerified ? modal === 'result' ? latestItem : typeof modal === 'object' ? modal : null : null
  const selectedResultId = selectedImage?.own && selectedImage.id !== result?.id ? selectedImage.id : null
  const selectedResult = useQuery({
    queryKey: ['player-result', galleryScope, selectedResultId],
    enabled: Boolean(selectedResultId && canSubmitScore(participation)),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      const operationScope = scopeGuard.ticket()
      const operationUser = identity?.subject()
      const headers = await getHeaders()
      signal.throwIfAborted()
      scopeGuard.assertCurrent(operationScope)
      const value = await apiJson<UploadResult>(`/api/uploads/${encodeURIComponent(selectedResultId!)}`, { headers, signal })
      if (!identity || (await identity.get()).user.id !== operationUser) throw new Error('参与身份已变化，本次回应不再显示')
      signal.throwIfAborted()
      scopeGuard.assertCurrent(operationScope)
      if (value.id !== selectedResultId || typeof value.score !== 'number') throw new Error('这次评分记录暂时无法读取')
      return value
    },
  })
  const viewerResult = selectedImage?.own ? selectedImage.id === result?.id ? result : selectedResult.data ?? null : null

  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Hydrate browser-only preferences after SSR; the safe default keeps images covered.
      setShowNsfw(window.localStorage.getItem(NSFW_PREFERENCE_KEY) === 'true')
      setInstructions(window.localStorage.getItem('hb-image-challenge:guided') !== 'true')
    } catch { /* Default to covered images and a visible first-use guide. */ }
  }, [setInstructions])

  useEffect(() => {
    if (identityVerified && gallery.latest && !result && !fileMeta && !suppressRestore.current && !busy) setResult(gallery.latest)
  }, [identityVerified, gallery.latest, result, fileMeta, busy, setResult])

  function dismissGuide() {
    setInstructions(false)
    try { window.localStorage.setItem('hb-image-challenge:guided', 'true') } catch { /* Keep the in-memory preference. */ }
  }

  function updateNsfw(value: boolean) {
    setShowNsfw(value)
    try { window.localStorage.setItem(NSFW_PREFERENCE_KEY, String(value)) } catch { /* Keep the in-memory preference. */ }
  }

  function persistPending(pending: PendingSubmission | null) {
    pendingSubmissionRef.current = pending
    setPendingSubmission(pending)
    if (!session.hongbao) return
    try { writePendingSubmission(window.sessionStorage, session.hongbao.id, pending, pending?.userId ?? identity?.subject() ?? undefined) } catch { /* The in-memory guard still applies. */ }
  }

  useEffect(() => {
    if (window.parent === window) { setSession({ status: 'standalone' }); return }
    if (!config.data) return
    let disposed = false
    const unsubscribe: (() => void)[] = []
    void connectHongbao(config.data.hbSite).then(async sdk => {
      const ready = await sdk.ready()
      if (disposed) return
      setSession({ status: 'connected', sdk, ...ready, participantStatus: 'checking' })
      setRemaining(null)
      setPendingSubmission(null)
      pendingSubmissionRef.current = null
      setSubmittedResults(new Set())
      suppressRestore.current = false
      let refreshing: Promise<void> | null = null
      let refreshAgain = false
      const refresh = () => {
        if (refreshing) { refreshAgain = true; return refreshing }
        refreshing = (async () => {
          const actorAtStart = verifiedActor.current
          const identityAtStart = currentIdentity.current
          const identityVersionAtStart = identityAtStart?.version
          const stale = () => actorAtStart !== verifiedActor.current || identityAtStart !== currentIdentity.current || identityVersionAtStart !== identityAtStart?.version
          try {
            const [me, myView] = await Promise.all([sdk.me(), sdk.myView()])
            if (stale()) { refreshAgain = true; return }
            let pending = pendingSubmissionRef.current
            const subject = currentIdentity.current?.subject() ?? undefined
            try { pending ??= readPendingSubmission(window.sessionStorage, ready.hongbao.id, subject) } catch { /* Storage may be unavailable. */ }
            if (!me.signedIn || (pending?.userId ? subject && pending.userId !== subject : pending?.name !== me.name)) pending = null
            if (pending && me.signedIn) {
              const confirmed = me.claim !== null || me.settled || me.why === 'already_claimed' ||
                confirmedSubmission((await sdk.mine())?.items ?? [], pending.resultId)
              if (stale()) { refreshAgain = true; return }
              if (confirmed) {
                const accepted = submittedResult(myView, pending.resultId)
                if (!disposed && (accepted || me.claim || me.settled || me.why === 'already_claimed')) {
                  const acceptedId = pending.resultId
                  setSubmittedResults(previous => new Set(previous).add(acceptedId))
                }
                try { writePendingSubmission(window.sessionStorage, ready.hongbao.id, null, pending.userId ?? subject) } catch { /* Storage may be unavailable. */ }
                pending = null
              }
            }
            if (disposed || stale()) { refreshAgain = !disposed; return }
            const sameActor = actorAtStart !== null && actorAtStart === `${currentIdentity.current?.scope}:${currentIdentity.current?.subject()}`
            pendingSubmissionRef.current = pending
            setPendingSubmission(pending)
            setSession(previous => ({
              ...previous,
              me: sameActor && previous.me?.signedIn && me.signedIn &&
                (previous.me.claim || previous.me.settled) && !me.claim && !me.settled ? previous.me : me,
              myView, viewer: me.signedIn ? { signedIn: true, name: me.name } : { signedIn: false }, participantStatus: 'ready',
            }))
          } catch {
            if (!disposed) {
              if (stale()) refreshAgain = true
              else setSession(previous => ({ ...previous, participantStatus: 'error' }))
            }
          }
        })().finally(() => {
          refreshing = null
          if (disposed) return
          if (refreshAgain) { refreshAgain = false; void refresh() } else refreshGallery.current?.()
        })
        return refreshing
      }
      refreshParticipant.current = refresh
      let eventTimer: number | undefined
      const scheduleRefresh = () => { window.clearTimeout(eventTimer); eventTimer = window.setTimeout(() => { void refresh() }, 80) }
      const invalidateIdentity = () => {
        currentIdentity.current?.clear()
        // Claim/status events also invalidate identity. Keep the selected result
        // for the same verified actor; private content is gated while checking.
        setModal(previous => previous === 'preview' ? null : previous)
        setSession(previous => ({ ...previous, participantStatus: 'checking' }))
      }
      unsubscribe.push(
        sdk.on('hongbao', hongbao => { setSession(previous => ({ ...previous, hongbao })); scheduleRefresh() }),
        sdk.on('me', () => { invalidateIdentity(); scheduleRefresh() }), sdk.on('myView', scheduleRefresh),
        () => window.clearTimeout(eventTimer),
      )
      let poll: number | undefined
      const revalidateIdentity = async () => {
        const cache = currentIdentity.current
        if (!cache) { await refresh(); return }
        const version = cache.version
        try {
          const value = await cache.revalidate()
          if (disposed) return
          acceptIdentity(cache, value)
          await refresh()
        } catch {
          if (!disposed && cache === currentIdentity.current && version === cache.version) setNotice({ kind: 'info', text: '暂时无法重新核对身份。上传或提交前会再次验证，请稍后重试。' })
        }
      }
      const onVisible = () => {
        window.clearInterval(poll)
        if (!document.hidden) { void revalidateIdentity(); poll = window.setInterval(() => { void refresh() }, 60_000) }
      }
      window.addEventListener('focus', onVisible)
      document.addEventListener('visibilitychange', onVisible)
      unsubscribe.push(() => window.removeEventListener('focus', onVisible), () => document.removeEventListener('visibilitychange', onVisible), () => window.clearInterval(poll))
      await refresh()
      if (!document.hidden) poll = window.setInterval(() => { void refresh() }, 60_000)
    }).catch(error => { if (!disposed) setSession({ status: 'error', error: error instanceof Error ? error.message : '无法连接红包站' }) })
    return () => { disposed = true; for (const stop of unsubscribe) stop(); refreshParticipant.current = null }
  }, [config.data, setSession, setNotice, acceptIdentity])

  useEffect(() => {
    if (!preview) return
    return () => URL.revokeObjectURL(preview)
  }, [preview])
  useEffect(() => {
    if (!resultImage) return
    return () => URL.revokeObjectURL(resultImage.url)
  }, [resultImage])

  const upload = useMutation({
    retry: false,
    onMutate: () => ({ scope: scopeGuard.ticket(), userId: identity?.subject() }),
    mutationFn: async (file: File) => {
      if (!session.sdk || !canUpload || actionInProgress.current) throw new Error('当前无法上传，请先核对红包页的参与状态')
      actionInProgress.current = true
      const operationScope = scopeGuard.ticket()
      const operationUser = identity?.subject()
      setPhase('identity')
      const me = await session.sdk.me()
      scopeGuard.assertCurrent(operationScope)
      const current = participationState({ session: 'connected', checked: 'ready', hongbao: session.hongbao, me, remaining: remainingAttempts, unconfirmed: Boolean(pendingSubmission) })
      if (current.kind !== 'ready') { void refreshParticipant.current?.(); throw new Error(current.description) }
      const { nonce } = await apiJson<{ nonce: string }>('/api/nonce', { method: 'POST' })
      scopeGuard.assertCurrent(operationScope)
      const pageIdentity = await session.sdk.identity({ nonce })
      scopeGuard.assertCurrent(operationScope)
      if (!pageIdentity.identified) throw new Error(pageIdentity.message || '需要允许身份验证，才能上传图片')
      if (pageIdentity.user.id !== operationUser) throw new Error('参与身份已变化，请重新选择图片')
      // Gallery/image reads can reuse this token, while the nonce itself remains one-use.
      // The cache does not outlive the SDK identity's expiry or this page.
      identity?.remember(pageIdentity)
      const latestMe = await session.sdk.me()
      scopeGuard.assertCurrent(operationScope)
      const afterConsent = participationState({ session: 'connected', checked: 'ready', hongbao: session.hongbao, me: latestMe, remaining: remainingAttempts, unconfirmed: Boolean(pendingSubmission) })
      if (afterConsent.kind !== 'ready') { void refreshParticipant.current?.(); throw new Error(afterConsent.description) }
      setPhase('processing')
      const value = await apiJson<UploadResult>('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': file.type, Authorization: `Bearer ${pageIdentity.token}`, 'X-Hb-Nonce': nonce, 'Idempotency-Key': idempotency.current, 'X-Hb-Gallery-Consent': 'v1' },
        body: file,
      })
      if (!identity || (await identity.get()).user.id !== operationUser) throw new Error('参与身份已变化，本次回应不再显示')
      scopeGuard.assertCurrent(operationScope)
      return value
    },
    onSuccess: (value, file, context) => {
      if (!context || !scopeGuard.isCurrent(context.scope) || identity?.subject() !== context.userId) return
      setResultImage({ id: value.id, url: URL.createObjectURL(file) })
      form.reset()
      setPreview(null)
      setFileMeta(null)
      if (inputRef.current) inputRef.current.value = ''
      idempotency.current = ''
      setResult(value)
      setRemaining(value.remaining)
      setNotice(null)
      setModal('result')
      refreshGallery.current?.()
    },
    onError: (error, _file, context) => {
      if (!context || !scopeGuard.isCurrent(context.scope) || identity?.subject() !== context.userId) return
      if (error instanceof ApiRequestError && error.remaining !== undefined && error.remaining <= challenge.maxAttempts) setRemaining(error.remaining)
      setNotice({ kind: 'error', text: error.message })
      refreshGallery.current?.()
    },
    onSettled: (_value, _error, _file, context) => { if (!context || !scopeGuard.isCurrent(context.scope)) return; actionInProgress.current = false; setPhase('idle') },
  })

  const form = useForm({
    defaultValues: { photo: null as File | null },
    onSubmit: async ({ value }) => {
      if (!value.photo || busy || actionInProgress.current) return
      if (session.sdk && participation.kind === 'login') {
        await session.sdk.login()
        await refreshParticipant.current?.()
        return
      }
      if (!canUpload) {
        setNotice({ kind: 'info', text: participation.kind === 'checking' ? '正在核对参与状态，请稍后再点“上传并评分”。' : participation.description })
        return
      }
      setNotice(null)
      await upload.mutateAsync(value.photo).catch(() => undefined)
    },
  })

  useLayoutEffect(() => {
    if (!scopeGuard.enter(workspaceScope)) return
    // Clear the previous participant's workspace before the new identity paints.
    form.reset()
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Identity changes must clear private content before the next browser paint.
    setPreview(null)
    setResultImage(null)
    setFileMeta(null)
    setResult(null)
    setRemaining(null)
    setNotice(null)
    setPhase('idle')
    setSubmittedResults(new Set())
    setModal(null)
    suppressRestore.current = false
    actionInProgress.current = false
    idempotency.current = ''
    if (inputRef.current) inputRef.current.value = ''
    let pending: PendingSubmission | null = null
    const subject = identity?.subject() ?? undefined
    try { if (session.hongbao?.id) pending = readPendingSubmission(window.sessionStorage, session.hongbao.id, subject) } catch { /* Storage may be unavailable. */ }
    if (pending?.userId ? pending.userId !== subject : pending?.name !== viewerKey) pending = null
    pendingSubmissionRef.current = pending
    setPendingSubmission(pending)
    if (pending) void refreshParticipant.current?.()
  }, [workspaceScope, scopeGuard, form, session.hongbao?.id, viewerKey, identity, setNotice, setResult, setPhase])

  function selectFile(file?: File) {
    if (!file || !canSelect) return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setNotice({ kind: 'error', text: '请选择 JPG、PNG 或 WebP 图片' }); return
    }
    if (file.size === 0 || file.size > MAX_IMAGE_BYTES) {
      setNotice({ kind: 'error', text: '图片大小需在 0–4 MiB 之间，请换一张或先压缩' }); return
    }
    form.setFieldValue('photo', file)
    suppressRestore.current = true
    setFileMeta({ name: file.name, size: file.size })
    setPreview(URL.createObjectURL(file))
    setResultImage(null)
    idempotency.current = crypto.randomUUID()
    setNotice(null)
    setResult(null)
  }

  function clearFile() {
    if (busy) return
    suppressRestore.current = true
    form.reset()
    setPreview(null)
    setResultImage(null)
    setFileMeta(null)
    setResult(null)
    setModal(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  async function submitResult(target: UploadResult | typeof SETTLE_INPUT) {
    const input = typeof target === 'string' ? target : target.id
    const settling = input === SETTLE_INPUT
    if (!session.sdk || (settling ? !canSettle : !canSubmit || isSubmittedResult(input)) || actionInProgress.current) return
    actionInProgress.current = true
    const operationScope = scopeGuard.ticket()
    const operationUser = identity?.subject()
    setPhase('submitting')
    setNotice(null)
    let sent = false
    try {
      if (!identity) throw new Error('暂时无法核对参与身份，请稍后手动提交这次结果')
      const checkedIdentity = await identity.revalidate()
      acceptIdentity(identity, checkedIdentity)
      if (!scopeGuard.isCurrent(operationScope)) return
      if (checkedIdentity.user.id !== operationUser) throw new Error('参与身份已变化，请重新核对本轮结果')
      const me = await session.sdk.me()
      if (!scopeGuard.isCurrent(operationScope) || identity.subject() !== operationUser) return
      const current = participationState({ session: 'connected', checked: 'ready', hongbao: session.hongbao, me, remaining: remainingAttempts, unconfirmed: false })
      if (!canSubmitScore(current)) { void refreshParticipant.current?.(); throw new Error(current.description) }
      persistPending({ resultId: input, name: me.signedIn ? me.name : '', userId: operationUser ?? undefined })
      sent = true
      const receipt = await session.sdk.submit(input)
      if (!identity || (await identity.get()).user.id !== operationUser) return
      if (!scopeGuard.isCurrent(operationScope)) return
      if (!receipt.judged) {
        if (receipt.reason !== 'unconfirmed') persistPending(null)
        setNotice({ kind: 'info', text: receipt.reason === 'unconfirmed'
          ? '提交结果尚未确认，请到红包页查看领取记录。为避免重复操作，这里不会再次提交。'
          : receipt.message || (receipt.seconds ? `请等待 ${receipt.seconds} 秒后，再提交这次结果，无需重新上传` : '暂时无法提交，请回到红包页查看状态') })
      } else {
        persistPending(null)
        const pending = receipt.pending
        if (typeof pending === 'string') setSession(previous => previous.me?.signedIn ? { ...previous, me: { ...previous.me, pending } } : previous)
        setNotice({ kind: receipt.claimed ? 'success' : 'info', text: receipt.reply || (receipt.claimed ? `挑战完成，已领取 ${receipt.amount ?? ''} ${session.hongbao?.unit ?? 'LDC'}` : '结果已提交，请查看红包页的判定') })
      }
      await refreshParticipant.current?.()
      if (!scopeGuard.isCurrent(operationScope)) return
      if (receipt.judged) {
        const view = await session.sdk.myView()
        if ((await identity.get()).user.id !== operationUser || !scopeGuard.isCurrent(operationScope)) return
        const accepted = submittedResult(view, input)
        if (!settling && (receipt.claimed || receipt.settled || accepted)) setSubmittedResults(previous => new Set(previous).add(input))
      }
      if (receipt.judged && (receipt.claimed || receipt.settled)) {
        if (settling) setModal(null)
        setSession(previous => previous.me?.signedIn ? { ...previous, me: {
          ...previous.me, open: false, why: 'already_claimed', settled: true,
          ...(receipt.claimed ? { claim: previous.me.claim ?? { amount: receipt.amount, unit: receipt.unit, payment: 'paying' as const } } : {}),
        } } : previous)
      }
    } catch (error) {
      if (!scopeGuard.isCurrent(operationScope)) return
      setNotice({ kind: 'info', text: sent ? '没有收到提交回应。请先查看红包页的领取记录，这里不会自动重试。' : error instanceof Error ? error.message : '暂时无法核对参与身份，请稍后手动提交这次结果' })
    } finally { if (scopeGuard.isCurrent(operationScope)) { actionInProgress.current = false; setPhase('idle') } }
  }

  const matched = score !== undefined && score >= challenge.minScore && score <= challenge.maxScore

  const transition = { duration: reducedMotion ? 0 : .18 }
  const completed = ['claimed', 'settled', 'ended'].includes(participation.kind)
  const estimate = selectedImage?.own ? expectedReward(selectedImage.score, challenge) : null
  const selectedMatched = selectedImage && selectedImage.score >= challenge.minScore && selectedImage.score <= challenge.maxScore
  const viewingOwnResult = Boolean(selectedImage?.own)
  const selectedAward = selectedImage?.own ? awards.find(award => award.id === selectedImage.id) : undefined
  const pendingReward = session.me?.signedIn ? session.me.pending ?? '0.00' : '0.00'
  const feedback = notice && <div role={notice.kind === 'error' ? 'alert' : 'status'} className="notice" data-kind={notice.kind}><CircleHelp size={20} aria-hidden="true" /><p>{notice.text}</p></div>
  const resultActions = viewingOwnResult && <>
    {challenge.multiReward && selectedAward && <div className="reward-preview"><span>{selectedAward.reward > 0 ? '本图已计奖' : '评分已提交'}</span><strong>{formatReward(selectedAward.reward)} <span>{session.hongbao?.unit ?? 'LDC'}</span></strong></div>}
    {completed ? <p className="viewer-participation">{participation.kind === 'claimed' && session.me?.signedIn && session.me.claim
      ? `已领取 ${session.me.claim.amount} ${session.me.claim.unit}` : participation.title}</p> : <>
      {estimate !== null && !selectedAward && <div className="reward-preview"><span>预计奖励</span><strong>{formatReward(estimate)} <span>{session.hongbao?.unit ?? 'LDC'}</span></strong></div>}
      <p className="upload-disclosure">{selectedAward ? selectedAward.reward > 0 ? '已计入累计奖励，结算后统一领取。' : '本图未获得奖励，可以继续挑战。' : selectedMatched ? '最终奖励以红包站核验回执为准。' : '区间外不获奖，仍可提交评分记录。'}{selectedImage && !selectedImage.saved ? ' 本次未保存图片。' : ''}</p>
      {selectedResult.isLoading && <p className="text-muted" role="status">正在读取评分记录…</p>}
      {selectedResult.isError && !viewerResult && <div className="notice" role="status"><p>{selectedResult.error.message}</p><button type="button" className="text-action" onClick={() => void selectedResult.refetch()}>重新读取</button></div>}
      {viewerResult && !isSubmittedResult(viewerResult.id) && canSubmitScore(participation) && <button type="button" className="button-primary upload-submit" disabled={!canSubmit} onClick={() => void submitResult(viewerResult)}>{phase === 'submitting' ? <LoaderCircle className="animate-spin" size={19} aria-hidden="true" /> : <Check size={19} aria-hidden="true" />}提交这次结果</button>}
      {selectedImage && isSubmittedResult(selectedImage.id) && participation.kind === 'ready' && <button type="button" className="button-secondary upload-submit" disabled={busy} onClick={clearFile}><RotateCcw size={19} aria-hidden="true" />{challenge.multiReward ? '继续上传' : '换张图片再试'}</button>}
    </>}
    {feedback}
  </>

  return <Layout>
    <main className="challenge-page">
      <header className="challenge-intro">
        <div className="challenge-eyebrow"><span className="context-label"><span className="status-dot" data-connected={connected} aria-hidden="true" />{connected ? '本轮挑战' : '玩法预览'}</span><span>{modelLabel(MODEL)} · Cloudflare Workers AI</span></div>
        <div className="title-row"><h1 className="page-title">{session.hongbao?.title || '图片挑战'}</h1><button type="button" className="icon-button" onClick={() => setModal('settings')} aria-label="浏览设置"><Settings2 size={22} aria-hidden="true" /></button></div>
        <p className="challenge-prompt">{challenge.challenge}</p>
      </header>

      <div className="challenge-layout">
        <section className="challenge-workspace" aria-label="上传与评分">
          <div className="challenge-summary">
            <section><h2>目标评分</h2><p className="summary-value text-accent">{challenge.minScore}–{challenge.maxScore}<span>%</span></p><div className="score-band" aria-hidden="true"><span style={{ marginLeft: `${challenge.minScore}%`, width: `${Math.max(1, challenge.maxScore - challenge.minScore)}%` }} /></div></section>
            <section><h2>{completed ? '参与状态' : remainingAttempts === null ? '上传机会' : '剩余机会'}</h2><p className="summary-value">{participation.kind === 'claimed' ? '已领取' : participation.kind === 'settled' ? '已结算' : participation.kind === 'ended' ? '已结束' : <>{remainingAttempts ?? challenge.maxAttempts}<span>次</span></>}</p></section>
          </div>

          {challenge.multiReward && identityVerified && session.me?.signedIn && !completed && <div className="pending-reward"><div><span>累计待领取</span><strong>{pendingReward}<span>{session.hongbao?.unit ?? 'LDC'}</span></strong></div><button type="button" className="button-secondary" disabled={!canSettle} onClick={() => setModal('settle')}>结算并领取</button></div>}

          <AnimatePresence mode="wait" initial={false}>
            {showChooser ? <motion.div key="upload" initial={{ opacity: 0, y: reducedMotion ? 0 : 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={transition}>
              <form onSubmit={event => { event.preventDefault(); event.stopPropagation(); void form.handleSubmit() }}>
                <form.Field name="photo">{field => <>
                  <input ref={inputRef} id="photo" name={field.name} type="file" tabIndex={-1} accept="image/jpeg,image/png,image/webp" className="sr-only" disabled={!canSelect} onBlur={field.handleBlur} onChange={event => selectFile(event.target.files?.[0])} aria-label="选择挑战图片" />
                  <div className="upload-area" data-dragging={dragging} data-preview={Boolean(preview)} onDragOver={event => { event.preventDefault(); if (canSelect) setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); selectFile(event.dataTransfer.files[0]) }}>
                    {preview ? <><button className="preview-trigger" type="button" style={{ visibility: privateWorkspaceVisible ? 'visible' : 'hidden' }} onClick={() => setModal('preview')} aria-label="放大查看所选图片"><img src={preview} alt="所选挑战图片" className="upload-preview" /></button><button type="button" disabled={busy} style={{ visibility: privateWorkspaceVisible ? 'visible' : 'hidden' }} onClick={clearFile} className="remove-image" aria-label="移除图片"><X size={22} aria-hidden="true" /></button></> : <div className="upload-placeholder"><ImagePlus size={34} strokeWidth={1.4} aria-hidden="true" /><h2>选一张符合要求的图片</h2><p>拖放到这里，或从设备中选择</p><button type="button" disabled={!canSelect} className="button-secondary" onClick={() => inputRef.current?.click()}>选择图片<ArrowRight size={18} aria-hidden="true" /></button><p>JPG、PNG、WebP · 不超过 4 MiB</p></div>}
                  </div>
                  {fileMeta && <div className="file-meta"><span className="file-name" style={{ visibility: privateWorkspaceVisible ? 'visible' : 'hidden' }}>{fileMeta.name}</span><button type="button" className="text-action" disabled={!canSelect} onClick={() => inputRef.current?.click()}>换一张</button></div>}
                </>}</form.Field>
                <form.Subscribe selector={state => state.values.photo}>{photo => <button type="submit" className="button-primary upload-submit" disabled={!photo || busy || (!canUpload && participation.kind !== 'login') || !config.data?.ownerConfigured}>
                  {busy || participation.kind === 'checking' ? <LoaderCircle size={19} className="animate-spin" aria-hidden="true" /> : <Sparkles size={19} aria-hidden="true" />}{phase === 'identity' ? '正在验证身份' : phase === 'processing' ? '保存与评分中' : participation.kind === 'checking' ? '正在核对参与状态' : participation.kind === 'login' ? '登录后继续' : connected ? '上传并评分' : '请从红包页参与'}
                </button>}</form.Subscribe>
              </form>
              <p className="upload-disclosure">{challenge.saveImages ? '上传即同意按本轮规则展示图片与评分，其他玩家看不到你的身份。' : '图片只用于评分；本轮作品仅展示评分记录。'}</p>
              <p className="upload-disclosure">每次评分使用 1 次机会，处理失败也可能消耗。</p>
            </motion.div> : <motion.div className="participation-panel" key={participation.kind} role="status" initial={{ opacity: 0, y: reducedMotion ? 0 : 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={transition}>
              <span className="participation-symbol">{participation.kind === 'checking' ? <LoaderCircle className="animate-spin" size={26} aria-hidden="true" /> : completed ? <CheckCircle2 size={26} aria-hidden="true" /> : <CircleHelp size={26} aria-hidden="true" />}</span>
              <h2>{participation.title}</h2><p>{participation.description}</p>
              {participation.kind === 'claimed' && session.me?.signedIn && session.me.claim && <p className="claimed-reward">{session.me.claim.amount}<span>{session.me.claim.unit}</span></p>}
              <div className="participation-actions">{session.hongbao?.url && <a className="button-secondary" href={session.hongbao.url} target="_top">回红包页查看记录<ArrowRight size={18} aria-hidden="true" /></a>}{(participation.kind === 'unconfirmed' || participation.kind === 'unavailable') && <button type="button" className="text-action" onClick={() => void refreshParticipant.current?.()}><RotateCcw size={18} aria-hidden="true" />重新核对</button>}</div>
            </motion.div>}
          </AnimatePresence>

          <div className="feedback-section" aria-live="polite" aria-atomic="true">
            <AnimatePresence mode="wait">
              {phase === 'processing' ? <motion.section key="processing" className="processing-state" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={transition}><LoaderCircle className="animate-spin" size={24} aria-hidden="true" /><div><h2>正在处理这张图片</h2><p>{challenge.saveImages ? '保存图片与 AI 评分同时进行。' : 'AI 正在判断图片，请稍等片刻。'}</p></div></motion.section> : score !== undefined && <motion.section key={result?.id ?? 'previous-result'} className="score-result result-summary" initial={{ opacity: 0, y: reducedMotion ? 0 : 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={transition}>
                <div><h2>{result ? '本次评分' : '最近一次评分'}</h2><p className="result-score" data-matched={matched}>{score.toFixed(1)}<span>%</span></p></div>
                {result && <button type="button" className="button-secondary" onClick={() => setModal('result')}>查看本次结果<ArrowRight size={18} aria-hidden="true" /></button>}
              </motion.section>}
            </AnimatePresence>
            {!viewingOwnResult && feedback}
            {session.status === 'standalone' && <p className="notice">请从红包页打开后参与，系统会带入真实规则与身份。</p>}
            {session.error && <p role="alert" className="notice" data-kind="error">{session.error}</p>}
            {config.isError && <p role="alert" className="notice" data-kind="error">服务配置暂时无法读取，请刷新页面。</p>}
            {config.data && !config.data.ownerConfigured && <p className="notice">服务尚未完成配置，暂时无法上传。</p>}
          </div>

          <div className="help-trigger"><span>{challenge.scoreReward ? `${challenge.multiReward ? '每图' : '达标后'}按评分奖励 ${formatReward(challenge.minReward)}–${formatReward(challenge.reward)} ${session.hongbao?.unit ?? 'LDC'}` : `${challenge.multiReward ? '每图达标' : '达标'}奖励 ${formatReward(challenge.reward)} ${session.hongbao?.unit ?? 'LDC'}`}</span><button type="button" className="text-action" onClick={() => setModal('help')}><CircleHelp size={19} aria-hidden="true" />怎么玩</button></div>
          <AnimatePresence>{instructions && <motion.aside className="first-use-guide" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, height: 0 }} transition={transition} aria-label="首次玩法引导"><p>选择图片 → 查看评分 → 提交结果</p><p>{challenge.multiReward ? '每张分别计奖，可继续上传，最后统一领取。' : '分数落在目标区间，即可提交领取。'}</p><button type="button" className="text-action" onClick={dismissGuide}>知道了<Check size={18} aria-hidden="true" /></button></motion.aside>}</AnimatePresence>
        </section>

        <Gallery key={galleryScope} items={identityVerified ? gallery.items : []} next={identityVerified ? gallery.next : null} visibility={gallery.visibility} isLoading={gallery.isLoading} isRefreshing={gallery.isRefreshing} error={gallery.error} loadingMore={gallery.loadingMore} onLoadMore={() => void gallery.loadMore()} onRefresh={() => { if (session.me?.signedIn) refreshGallery.current?.() }} showNsfw={showNsfw} getHeaders={getHeaders} likeCounts={gallery.likeCounts} pendingLikes={gallery.pendingLikes} canLike={identityVerified && gallery.canLike} onLike={gallery.like} onWatch={gallery.watch}
          selected={selectedImage} onSelect={setModal} selectedSource={selectedImage?.id === resultImage?.id ? resultImage?.url : undefined} selectedActions={resultActions} minScore={challenge.minScore} maxScore={challenge.maxScore} />
      </div>
      <footer className="challenge-footer"><p>{modelLabel(MODEL)} · Cloudflare Workers AI</p><p>AI 分数表示匹配程度，奖励以红包站为准。</p></footer>
    </main>

    <Modal open={modal === 'settings'} title="浏览设置" onClose={() => setModal(null)}>
      <label className="setting-row"><span><strong>直接显示 NSFW 图片</strong><span>仅影响本浏览器的查看方式，默认保持模糊。也可以逐张点击查看。</span></span><input className="setting-switch" type="checkbox" checked={showNsfw} onChange={event => updateNsfw(event.target.checked)} /></label><p className="modal-note"><EyeOff size={20} aria-hidden="true" />敏感提示由模型生成；未知敏感度也会先遮罩。</p>
    </Modal>
    <Modal open={modal === 'help'} title="怎么玩" onClose={() => setModal(null)}>
      <ol className="help-steps">{[['选择图片', '按图片要求选择照片或截图，每张不超过 4 MiB。'], ['查看评分', `匹配评分落在 ${challenge.minScore}–${challenge.maxScore}% 之间即达标，每次评分使用 1 次上传机会。`], ['提交结果', challenge.multiReward ? '每张图片分别提交并计奖，还能继续上传。点击“结算并领取”结束参与，累计奖励统一到账；未提交的评分不计奖。' : '点击“提交这次结果”，由红包站核验并结算。上传完成不等于已经领取。']].map(([title, detail], index) => <li key={title}><span className="step-number">{index + 1}</span><div><h3>{title}</h3><p>{detail}</p></div></li>)}</ol>
      <h3 className="modal-subheading">图片要求</h3><p className="prompt-quote">{challenge.challenge}</p>
      <h3 className="modal-subheading">奖励</h3><p className="text-muted">{challenge.scoreReward ? `区间内从最低 ${formatReward(challenge.minReward)} 到最高 ${formatReward(challenge.reward)} ${session.hongbao?.unit ?? 'LDC'} 递增，按分向下取整；上下限相同时达标即发最高奖励。` : `达标后统一奖励 ${formatReward(challenge.reward)} ${session.hongbao?.unit ?? 'LDC'}。`}区间外不获奖，最终以红包站核验结果为准。</p>
      {challenge.multiReward && <p className="modal-note">每图独立计奖。上传机会用完且全部评分已提交后自动结算；活动结束或奖池分配完也会统一结算。最后一次上传失败时，仍可主动结算。</p>}
      <h3 className="modal-subheading">作品展示</h3><p className="text-muted">本轮匿名展示评分记录。参与时能看到自己的作品与其他人的未达标作品；领取成功或活动结束后解锁本轮全部作品。关闭图片保存时只展示评分，旧版承诺私密的图片继续保持原权限。浏览设置只改变遮罩，不会解锁无权查看的图片。</p>
    </Modal>
    <Modal open={modal === 'settle' && identityVerified && !completed} title="结算并领取" onClose={() => setModal(null)}>
      <div className="settle-total"><span>累计待领取</span><strong>{pendingReward}<span>{session.hongbao?.unit ?? 'LDC'}</span></strong></div>
      <p className="text-muted">结算后结束本轮参与，剩余上传机会和未提交的评分将不再计奖。</p>
      <div className="settle-actions"><button type="button" className="button-secondary" disabled={busy} onClick={() => setModal(null)}>继续挑战</button><button type="button" className="button-primary" disabled={!canSettle} onClick={() => void submitResult(SETTLE_INPUT)}>{phase === 'submitting' && <LoaderCircle size={19} className="animate-spin" aria-hidden="true" />}确认结算</button></div>
      {feedback}
    </Modal>
    <Modal open={modal === 'preview'} title="所选图片" onClose={() => setModal(null)} wide>{preview && <img src={preview} alt="所选挑战图片" className="selected-image-detail" />}</Modal>
  </Layout>
}
