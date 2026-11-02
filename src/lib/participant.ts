import type { HbHongbao, HbMe, HbMyJudgment, HbMyView } from '../types/hb-sdk'

export const SETTLE_INPUT = '结算' as const
const RESULT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

export interface AcceptedResult { id: string; score: number; reward: number }

export function acceptedResults(view: HbMyView | null | undefined): AcceptedResult[] {
  const data = view?.data
  if (!data || typeof data !== 'object' || !('v' in data) || data.v !== 2 ||
    !('multiReward' in data) || data.multiReward !== true || !('results' in data) ||
    !Array.isArray(data.results) || data.results.length > 10) return []
  const results: AcceptedResult[] = []
  for (const item of data.results) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !RESULT_ID.test(item.id) ||
      typeof item.score !== 'number' || !Number.isFinite(item.score) || item.score < 0 || item.score > 100 ||
      !Number.isSafeInteger(item.reward) || item.reward < 0 || results.some(result => result.id === item.id)) return []
    results.push({ id: item.id, score: item.score, reward: item.reward })
  }
  return results
}

export function submittedResult(view: HbMyView | null | undefined, id: string): boolean {
  const data = view?.data
  if (data && typeof data === 'object' && 'v' in data && data.v === 1 && 'resultId' in data) return data.resultId === id
  return acceptedResults(view).some(result => result.id === id)
}

export interface ChallengeProgress {
  score: number
  remaining: number
  passed: boolean
}

export type ParticipationKind = 'checking' | 'unavailable' | 'preview' | 'login' | 'ready' | 'claimed' | 'settled' | 'ended' | 'exhausted' | 'not_open' | 'paused' | 'not_in_scope' | 'unconfirmed'

export interface ParticipationState {
  kind: ParticipationKind
  title: string
  description: string
}

export function challengeProgress(view: HbMyView | null | undefined, maxAttempts: number): ChallengeProgress | null {
  const data = view?.data
  if (!data || typeof data !== 'object' || !('v' in data) || !(data.v === 1 || (data.v === 2 && 'multiReward' in data && data.multiReward === true)) ||
    !('score' in data) || typeof data.score !== 'number' || !Number.isFinite(data.score) || data.score < 0 || data.score > 100 ||
    !('remaining' in data) || typeof data.remaining !== 'number' || !Number.isInteger(data.remaining) || data.remaining < 0 || data.remaining > maxAttempts ||
    !('passed' in data) || typeof data.passed !== 'boolean') return null
  return { score: data.score, remaining: data.remaining, passed: data.passed }
}

export function participationState(input: {
  session: 'connecting' | 'connected' | 'standalone' | 'error'
  checked: 'checking' | 'ready' | 'error'
  hongbao?: HbHongbao
  me?: HbMe
  remaining: number | null
  unconfirmed: boolean
}): ParticipationState {
  if (input.session === 'standalone') return { kind: 'preview', title: '玩法预览', description: '请从红包页打开后参与挑战。' }
  if (input.session === 'error' || input.checked === 'error') return { kind: 'unavailable', title: '暂时无法核对参与状态', description: '核对完成后才能继续上传，请重新核对或回红包页查看。' }
  if (input.session !== 'connected' || input.checked !== 'ready' || !input.me) return { kind: 'checking', title: '正在核对参与状态', description: '正在读取你的领取记录和剩余机会。' }
  const me = input.me
  if (me.signedIn && me.claim) return { kind: 'claimed', title: '奖励已领取', description: `本次领取 ${me.claim.amount} ${me.claim.unit}，可以回红包页查看记录。` }
  if (me.signedIn && (me.settled || me.why === 'already_claimed')) return { kind: 'settled', title: '本次挑战已结算', description: '本次没有获得奖励，可以回红包页查看判定记录。' }
  if (input.hongbao?.status === 'ended' || (me.signedIn && me.why === 'ended')) return { kind: 'ended', title: '本次活动已结束', description: '上传已关闭，可以回红包页查看最终结果。' }
  if (input.unconfirmed) return { kind: 'unconfirmed', title: '正在等待提交确认', description: '这次提交可能已经生效。请先核对红包页的领取记录，暂不继续上传或重复提交。' }
  if (input.hongbao?.status !== 'active' || (me.signedIn && me.why === 'not_open')) return { kind: 'not_open', title: '挑战尚未开放', description: '红包开放后即可参与。' }
  if (!me.signedIn) return { kind: 'login', title: '登录后参与', description: '选择图片后，先登录红包站再开始评分。' }
  if (me.why === 'paused') return { kind: 'paused', title: '挑战暂时暂停', description: '红包站恢复判定后即可继续，请保留已有评分。' }
  if (me.why === 'not_in_scope') return { kind: 'not_in_scope', title: '暂不满足参与条件', description: '请回红包页查看领取范围。' }
  if (!me.open) return { kind: 'unavailable', title: '当前无法参与', description: '请回红包页查看状态，确认后再继续。' }
  if (input.remaining === 0) return { kind: 'exhausted', title: '上传机会已用完', description: '如果还有未提交的评分，可以提交这次结果；否则请回红包页查看记录。' }
  return { kind: 'ready', title: '上传图片', description: '选择一张图片开始评分。' }
}

export function canChooseImage(state: ParticipationState): boolean {
  return state.kind === 'ready' || state.kind === 'login' || state.kind === 'preview'
}

export function canSubmitScore(state: ParticipationState): boolean {
  return state.kind === 'ready' || state.kind === 'exhausted'
}

export function confirmedSubmission(items: HbMyJudgment[], resultId: string): boolean {
  return items.some(item => item.input === resultId && !item.by)
}

export interface PendingSubmission {
  resultId: string
  name: string
  userId?: string
}

function pendingKey(hongbaoId: string, userId?: string): string { return `hb-image-challenge:pending:${hongbaoId}${userId ? `:${userId}` : ''}` }

// A persisted marker only means "check this uncertain submission". Platform
// me/myView/mine remain the source of truth for settlement and rewards.
export function readPendingSubmission(storage: Pick<Storage, 'getItem'>, hongbaoId: string, userId?: string): PendingSubmission | null {
  try {
    const value: unknown = JSON.parse(storage.getItem(pendingKey(hongbaoId, userId)) ?? storage.getItem(pendingKey(hongbaoId)) ?? 'null')
    if (value && typeof value === 'object' && 'resultId' in value && typeof value.resultId === 'string' &&
      (RESULT_ID.test(value.resultId) || value.resultId === SETTLE_INPUT) && 'name' in value && typeof value.name === 'string') {
      const storedUser = 'userId' in value && typeof value.userId === 'string' && /^\d+$/.test(value.userId) ? value.userId : undefined
      if (userId && storedUser && userId !== storedUser) return null
      return { resultId: value.resultId, name: value.name, ...(storedUser ? { userId: storedUser } : {}) }
    }
  } catch { /* Storage can be unavailable in a private/embedded browser. */ }
  return null
}

export function writePendingSubmission(storage: Pick<Storage, 'setItem' | 'removeItem'>, hongbaoId: string, pending: PendingSubmission | null, userId = pending?.userId): void {
  try {
    if (pending) storage.setItem(pendingKey(hongbaoId, userId), JSON.stringify(pending))
    else { storage.removeItem(pendingKey(hongbaoId, userId)); storage.removeItem(pendingKey(hongbaoId)) }
  } catch { /* Keep the in-memory guard when storage is unavailable. */ }
}
