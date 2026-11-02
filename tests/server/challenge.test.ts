import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadChallenge, loadChallengeContext, parseChallenge } from '../../src/server/challenge'
import type { AppEnv } from '../../src/server/env'
import { activity, environment, identity, params } from './helpers'

afterEach(() => { vi.unstubAllGlobals() })

const env = environment as AppEnv
const origin = 'https://challenge.example.com'

describe('trusted platform requests', () => {
  it('uses the Workers-supported manual redirect policy to load the signed packet rules', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(activity))
    vi.stubGlobal('fetch', fetcher)
    await expect(loadChallenge(env, identity, origin)).resolves.toMatchObject({ challenge: params.challenge, maxAttempts: 3 })
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`${environment.HB_SITE}/api/activities/${identity.hongbao}`, expect.objectContaining({
      redirect: 'manual', headers: { Accept: 'application/json' }, signal: expect.any(AbortSignal),
    }))
  })
  it('rejects redirects without following or retrying another endpoint', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { Location: 'https://other.example.com/rules' } }))
    vi.stubGlobal('fetch', fetcher)
    await expect(loadChallenge(env, identity, origin)).rejects.toMatchObject({ status: 502, code: 'activity_unavailable' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('preserves a connection error without retrying or treating it as valid rules', async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError('connection failed'))
    vi.stubGlobal('fetch', fetcher)
    await expect(loadChallenge(env, identity, origin)).rejects.toMatchObject({ status: 502, code: 'activity_unavailable' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('rejects non-successful responses and invalid JSON', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    for (const response of [new Response(null, { status: 503 }), new Response('<html>not JSON</html>')]) {
      fetcher.mockResolvedValueOnce(response)
      await expect(loadChallenge(env, identity, origin)).rejects.toMatchObject({ status: 502, code: 'activity_unavailable' })
    }
  })
  it('rejects trusted responses for a different packet', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ activity: { ...activity.activity, id: 'another-packet' } })))
    await expect(loadChallenge(env, identity, origin)).rejects.toMatchObject({ status: 403, code: 'wrong_activity' })
  })
  it('allows an ended gallery context while refusing new uploads for the same activity', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json({ activity: { ...activity.activity, status: 'ended' } })))
    await expect(loadChallengeContext(env, identity, origin)).resolves.toMatchObject({ ended: true, active: false })
    await expect(loadChallenge(env, identity, origin)).rejects.toMatchObject({ code: 'activity_inactive' })
  })
  it('freezes current author reward rules and supplies fixed-reward defaults only when absent', () => {
    const original = { server: params.server, challenge: params.challenge, minScore: params.minScore, maxScore: params.maxScore, maxAttempts: params.maxAttempts, saveImages: params.saveImages }
    expect(parseChallenge(original, origin)).toMatchObject({ reward: 100, scoreReward: false, minReward: 1 })
    expect(parseChallenge({ ...params, reward: 1000, scoreReward: true, minReward: 10 }, origin)).toMatchObject({ reward: 1000, scoreReward: true, minReward: 10 })
    for (const change of [{ reward: 0 }, { reward: 1.5 }, { reward: Number.MAX_SAFE_INTEGER + 1 }, { scoreReward: 'true' }, { scoreReward: true, reward: 10, minReward: 11 }, { minReward: 0 }]) {
      expect(() => parseChallenge({ ...params, ...change }, origin)).toThrow()
    }
  })
  it('keeps old activities single-reward and freezes an explicit multi-reward switch', () => {
    const legacy: Record<string, unknown> = { ...params }
    delete legacy.multiReward
    expect(parseChallenge(legacy, origin).multiReward).toBe(false)
    expect(parseChallenge({ ...params, multiReward: true }, origin).multiReward).toBe(true)
    for (const value of ['true', 1, null]) expect(() => parseChallenge({ ...params, multiReward: value }, origin)).toThrow()
  })
})
