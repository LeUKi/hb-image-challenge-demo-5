import { describe, expect, it } from 'vitest'
import { displayedChallenge, expectedReward, formatReward } from '../../src/lib/challenge'
import { DEFAULT_CHALLENGE } from '../../src/shared/contracts'
import type { HbHongbao } from '../../src/types/hb-sdk'

const dynamic = { ...DEFAULT_CHALLENGE, minScore: 80, maxScore: 90, minReward: 1, reward: 100, scoreReward: true }

describe('reward shown before submission', () => {
  it('defaults to the fixed highest reward and separates the title from the scoring prompt', () => {
    const config = displayedChallenge({ title: '红包标题', params: { challenge: '找猫' } } as unknown as HbHongbao)
    expect(config.challenge).toBe('找猫')
    expect(config.scoreReward).toBe(false)
    expect(config.reward).toBe(100)
    expect(config.minReward).toBe(1)
    expect(expectedReward(80, config)).toBe(100)
    expect(formatReward(100)).toBe('1.00')
  })

  it('spreads the full reward range over a narrow passing interval and floors integer cents', () => {
    expect(expectedReward(79.999, dynamic)).toBe(0)
    expect(expectedReward(80, dynamic)).toBe(1)
    expect(expectedReward(85, dynamic)).toBe(50)
    expect(expectedReward(89.999, dynamic)).toBe(99)
    expect(expectedReward(90, dynamic)).toBe(100)
    expect(expectedReward(90.001, dynamic)).toBe(0)
    expect(expectedReward(Number.NaN, dynamic)).toBe(0)
  })

  it('awards the highest reward for a passing equal-bound interval', () => {
    const config = { ...dynamic, minScore: 80, maxScore: 80 }
    expect(expectedReward(80, config)).toBe(100)
    expect(expectedReward(79.9, config)).toBe(0)
    expect(expectedReward(80.1, config)).toBe(0)
  })

  it('does not allow malformed public params to expand attempts or introduce fractional cents', () => {
    const config = displayedChallenge({ params: { maxAttempts: 999, reward: 2.5, minReward: -1, minScore: Number.NaN } } as unknown as HbHongbao)
    expect(config).toMatchObject({ maxAttempts: 3, reward: 100, minReward: 1, minScore: 70 })
  })
  it('shows multiple rewards only for an explicit compatible author switch', () => {
    for (const value of [undefined, null, 'true', false]) {
      expect(displayedChallenge({ params: { multiReward: value } } as unknown as HbHongbao).multiReward).toBe(false)
    }
    expect(displayedChallenge({ params: { multiReward: true } } as unknown as HbHongbao).multiReward).toBe(true)
  })
})
