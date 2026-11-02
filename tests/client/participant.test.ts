import { describe, expect, it } from 'vitest'
import { acceptedResults, canChooseImage, canSubmitScore, challengeProgress, confirmedSubmission, participationState, readPendingSubmission, SETTLE_INPUT, submittedResult, writePendingSubmission } from '../../src/lib/participant'
import type { HbHongbao, HbMe } from '../../src/types/hb-sdk'

const hongbao = { status: 'active' } as HbHongbao
const available: HbMe = { signedIn: true, name: '小明', open: true, cooldownUntil: null, claim: null, registered: false, pending: null, settled: false }
const base = { session: 'connected' as const, checked: 'ready' as const, hongbao, me: available, remaining: 4, unconfirmed: false }

function state(overrides: Partial<Parameters<typeof participationState>[0]> = {}) { return participationState({ ...base, ...overrides }) }

describe('participant lifecycle restored from the hongbao SDK', () => {
  it('keeps every upload entry closed until the initial state is checked', () => {
    const checking = state({ checked: 'checking' })
    expect(checking.kind).toBe('checking')
    expect(canChooseImage(checking)).toBe(false)
    expect(canSubmitScore(checking)).toBe(false)
  })

  it('restores a paid claim after a fresh page load, including after the activity ended', () => {
    const claimed = state({ hongbao: { ...hongbao, status: 'ended' }, me: { ...available, open: false, settled: true, why: 'already_claimed', claim: { amount: '0.50', unit: 'LDC', payment: 'paid' } } })
    expect(claimed.kind).toBe('claimed')
    expect(claimed.description).toContain('0.50 LDC')
    expect(canChooseImage(claimed)).toBe(false)
    expect(canSubmitScore(claimed)).toBe(false)
  })

  it('distinguishes zero-reward settlement from claiming a reward', () => {
    expect(state({ me: { ...available, open: false, settled: true } }).kind).toBe('settled')
    expect(state({ me: { ...available, open: false, why: 'already_claimed' } }).kind).toBe('settled')
  })

  it('closes upload and result submission when the activity ends', () => {
    const ended = state({ hongbao: { ...hongbao, status: 'ended' } })
    expect(ended.kind).toBe('ended')
    expect(canChooseImage(ended)).toBe(false)
    expect(canSubmitScore(ended)).toBe(false)
  })

  it('allows the last score to be submitted after upload opportunities run out', () => {
    const exhausted = state({ remaining: 0 })
    expect(exhausted.kind).toBe('exhausted')
    expect(canChooseImage(exhausted)).toBe(false)
    expect(canSubmitScore(exhausted)).toBe(true)
  })

  it('still allows another image after a failed score with remaining attempts', () => {
    const progress = challengeProgress({ summary: '本次未通过', data: { v: 1, score: 34, remaining: 3, passed: false } }, 5)
    const retry = state({ remaining: progress?.remaining ?? null })
    expect(retry.kind).toBe('ready')
    expect(canChooseImage(retry)).toBe(true)
    expect(canSubmitScore(retry)).toBe(true)
  })

  it('blocks unconfirmed submissions without calling them successful claims', () => {
    const uncertain = state({ unconfirmed: true })
    expect(uncertain.kind).toBe('unconfirmed')
    expect(canChooseImage(uncertain)).toBe(false)
    expect(canSubmitScore(uncertain)).toBe(false)
  })

  it.each(['paused', 'not_in_scope', 'not_open'] as const)('respects the platform %s restriction', why => {
    const restricted = state({ me: { ...available, open: false, why } })
    expect(restricted.kind).toBe(why)
    expect(canChooseImage(restricted)).toBe(false)
    expect(canSubmitScore(restricted)).toBe(false)
  })

  it('uses only compatible valid private progress records', () => {
    expect(challengeProgress({ summary: null, data: { v: 1, score: 80, remaining: 4, passed: true } }, 5)).toEqual({ score: 80, remaining: 4, passed: true })
    for (const data of [null, {}, { v: 2, score: 80, remaining: 4, passed: true }, { v: 1, score: 80, remaining: 99, passed: true }, { v: 1, score: Number.NaN, remaining: 4, passed: true }]) {
      expect(challengeProgress({ summary: null, data }, 5)).toBeNull()
    }
  })

  it('confirms an uncertain operation only when its exact input appears in personal records', () => {
    expect(confirmedSubmission([{ n: 1, at: '', input: 'result-1', claimed: false }], 'result-1')).toBe(true)
    expect(confirmedSubmission([{ n: 1, at: '', input: 'result-2', claimed: true }], 'result-1')).toBe(false)
    expect(confirmedSubmission([{ n: 1, at: '', input: 'result-1', by: '其他人', claimed: true }], 'result-1')).toBe(false)
  })

  it('restores each accepted image and its actual reward from the private multi-reward ledger', () => {
    const first = { id: '2b990cc9-45da-44e2-8ce5-45a7bd6257d3', score: 75, reward: 550 }
    const last = { id: '2b990cc9-45da-44e2-8ce5-45a7bd6257d4', score: 35, reward: 0 }
    const view = { summary: null, data: { v: 2, multiReward: true, resultId: last.id, score: last.score, remaining: 1, passed: false, reward: 0, results: [first, last] } }
    expect(acceptedResults(view)).toEqual([first, last])
    expect(submittedResult(view, first.id)).toBe(true)
    expect(submittedResult(view, last.id)).toBe(true)
    expect(submittedResult(view, '2b990cc9-45da-44e2-8ce5-45a7bd6257d5')).toBe(false)
    expect(challengeProgress(view, 5)).toEqual({ score: 35, remaining: 1, passed: false })
    expect(submittedResult({ summary: null, data: { v: 1, resultId: first.id } }, first.id)).toBe(true)
    expect(state({ me: { ...available, pending: '5.50' } }).kind).toBe('ready')
    expect(state({ me: { ...available, pending: '5.50' }, remaining: 0 }).kind).toBe('exhausted')
  })

  it('does not mark results accepted from a malformed or unbounded private ledger', () => {
    const result = { id: '2b990cc9-45da-44e2-8ce5-45a7bd6257d3', score: 75, reward: 550 }
    for (const results of [[result, result], Array(11).fill(result), [{ ...result, id: '结算' }], [{ ...result, reward: -1 }], [{ ...result, reward: 0.5 }], [{ ...result, score: Number.NaN }], [{ ...result, score: 101 }], [null], {}]) {
      const view = { summary: null, data: { v: 2, multiReward: true, resultId: result.id, results } }
      expect(acceptedResults(view)).toEqual([])
      expect(submittedResult(view, result.id)).toBe(false)
    }
    expect(acceptedResults({ summary: null, data: { v: 2, multiReward: false, results: [result] } })).toEqual([])
  })

  it('persists uncertain settlement without permitting arbitrary command replay', () => {
    const values = new Map<string, string>()
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) }
    const pending = { resultId: SETTLE_INPUT, name: '小明', userId: '123' }
    writePendingSubmission(storage, 'hongbao-1', pending)
    expect(readPendingSubmission(storage, 'hongbao-1', '123')).toEqual(pending)
    expect(readPendingSubmission(storage, 'hongbao-1', '456')).toBeNull()
    writePendingSubmission(storage, 'hongbao-1', { ...pending, resultId: '随便执行' })
    expect(readPendingSubmission(storage, 'hongbao-1', '123')).toBeNull()
    expect(confirmedSubmission([{ n: 1, at: '', input: SETTLE_INPUT, claimed: true }], SETTLE_INPUT)).toBe(true)
  })

  it('persists only an uncertainty marker and tolerates denied storage access', () => {
    const values = new Map<string, string>()
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) }
    const pending = { resultId: '2b990cc9-45da-44e2-8ce5-45a7bd6257d3', name: '小明' }
    writePendingSubmission(storage, 'hongbao-1', pending)
    expect(readPendingSubmission(storage, 'hongbao-1')).toEqual(pending)
    expect(readPendingSubmission(storage, 'hongbao-2')).toBeNull()
    writePendingSubmission(storage, 'hongbao-1', null)
    expect(readPendingSubmission(storage, 'hongbao-1')).toBeNull()
    expect(readPendingSubmission({ getItem: () => { throw new Error('denied') } }, 'hongbao-1')).toBeNull()
    expect(() => writePendingSubmission({ setItem: () => { throw new Error('denied') }, removeItem: () => { throw new Error('denied') } }, 'hongbao-1', pending)).not.toThrow()
  })

  it('isolates uncertain operations for different user IDs that share the same display name', () => {
    const values = new Map<string, string>()
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) }
    const a = { resultId: '2b990cc9-45da-44e2-8ce5-45a7bd6257d3', name: '同名', userId: '123' }
    const b = { ...a, resultId: '2b990cc9-45da-44e2-8ce5-45a7bd6257d4', userId: '456' }
    writePendingSubmission(storage, 'hongbao-1', a)
    expect(readPendingSubmission(storage, 'hongbao-1', '456')).toBeNull()
    writePendingSubmission(storage, 'hongbao-1', b)
    expect(readPendingSubmission(storage, 'hongbao-1', '123')).toEqual(a)
    expect(readPendingSubmission(storage, 'hongbao-1', '456')).toEqual(b)
    writePendingSubmission(storage, 'hongbao-1', null, '123')
    expect(readPendingSubmission(storage, 'hongbao-1', '123')).toBeNull()
    expect(readPendingSubmission(storage, 'hongbao-1', '456')).toEqual(b)
  })
})
