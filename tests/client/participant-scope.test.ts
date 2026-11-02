import { describe, expect, it } from 'vitest'
import { ParticipantScope } from '../../src/lib/participant-scope'

describe('participant scope guards asynchronous replies', () => {
  it('keeps current operations valid across refreshes but rejects replies after an account or hongbao switch', () => {
    const scope = new ParticipantScope()
    expect(scope.enter('hongbao-1:123')).toBe(true)
    const first = scope.ticket()
    expect(scope.enter('hongbao-1:123')).toBe(false)
    expect(scope.isCurrent(first)).toBe(true)
    expect(scope.enter('hongbao-1:456')).toBe(true)
    expect(scope.isCurrent(first)).toBe(false)
    expect(() => scope.assertCurrent(first)).toThrow('参与身份已变化')
    const second = scope.ticket()
    scope.enter('hongbao-2:456')
    expect(scope.isCurrent(second)).toBe(false)
  })
})
