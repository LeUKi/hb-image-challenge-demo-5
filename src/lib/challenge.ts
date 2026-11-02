import { DEFAULT_CHALLENGE, MAX_ATTEMPTS } from '../shared/contracts'
import type { ChallengeConfig } from '../shared/contracts'
import type { HbHongbao } from '../types/hb-sdk'

export function displayedChallenge(hongbao?: HbHongbao): ChallengeConfig {
  const params = hongbao?.params ?? {}
  const number = (key: keyof ChallengeConfig, min: number, max: number, integer = false) => {
    const value = params[key]
    return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value))
      ? value : DEFAULT_CHALLENGE[key] as number
  }
  return {
    challenge: typeof params.challenge === 'string' && params.challenge.trim() ? params.challenge : DEFAULT_CHALLENGE.challenge,
    minScore: number('minScore', 0, 100),
    maxScore: number('maxScore', 0, 100),
    maxAttempts: number('maxAttempts', 1, MAX_ATTEMPTS, true),
    multiReward: typeof params.multiReward === 'boolean' ? params.multiReward : false,
    saveImages: typeof params.saveImages === 'boolean' ? params.saveImages : DEFAULT_CHALLENGE.saveImages,
    reward: number('reward', 1, Number.MAX_SAFE_INTEGER, true),
    minReward: number('minReward', 1, Number.MAX_SAFE_INTEGER, true),
    scoreReward: typeof params.scoreReward === 'boolean' ? params.scoreReward : DEFAULT_CHALLENGE.scoreReward,
  }
}

/** Rewards are integer cents, matching the judge's floor-at-the-end rule. */
export function expectedReward(score: number, config: ChallengeConfig): number {
  if (!Number.isFinite(score) || score < config.minScore || score > config.maxScore) return 0
  if (!config.scoreReward || config.minScore === config.maxScore) return config.reward
  return Math.floor(config.minReward + (score - config.minScore) / (config.maxScore - config.minScore) * (config.reward - config.minReward))
}

export function formatReward(cents: number): string { return (cents / 100).toFixed(2) }
