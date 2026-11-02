import { describe, expect, it } from 'vitest'
import { consumeNonce, createNonce, reserveAttempt } from '../../src/server/store'
import { identity, params, sqliteD1 } from './helpers'

describe('SQLite attempt reservation and replay protection', () => {
  it('atomically accepts only the author limit when 20 requests compete', async () => {
    const { db, sqlite } = sqliteD1()
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => reserveAttempt(db, identity, crypto.randomUUID(), 'hash', 'image/png', params)))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(3)
    const accepted = results.filter(result => result.status === 'fulfilled').map(result => result.value.attempt)
    expect(accepted.filter(attempt => attempt.status === 'processing')).toHaveLength(1)
    expect(accepted.filter(attempt => attempt.error_code === 'duplicate_image')).toHaveLength(2)
    expect(sqlite.prepare('SELECT count(*) AS n FROM image_attempts').get()).toMatchObject({ n: 3 })
    const failures = results.filter(result => result.status === 'rejected')
    expect(failures.every(result => result.reason.status === 429)).toBe(true)
    sqlite.close()
  })
  it('returns an existing idempotency key without a second reservation and separates users', async () => {
    const { db, sqlite } = sqliteD1(), key = crypto.randomUUID()
    const first = await reserveAttempt(db, identity, key, 'hash', 'image/png', params)
    const repeat = await reserveAttempt(db, identity, key, 'hash', 'image/png', params)
    expect(first.created).toBe(true); expect(repeat.created).toBe(false); expect(repeat.attempt.id).toBe(first.attempt.id)
    expect((await reserveAttempt(db, { ...identity, sub: '99' }, key, 'hash', 'image/png', params)).attempt.attempt_no).toBe(1)
    sqlite.close()
  })
  it('consumes a nonce once, including two concurrent consumers', async () => {
    const { db, sqlite } = sqliteD1()
    const nonce = await createNonce(db)
    const results = await Promise.allSettled([consumeNonce(db, nonce), consumeNonce(db, nonce)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    await db.prepare('INSERT INTO upload_nonces (nonce, expires_at) VALUES (?, ?)').bind('expired-nonce', Date.now() - 1000).run()
    await expect(consumeNonce(db, 'expired-nonce')).rejects.toMatchObject({ status: 401 })
    sqlite.close()
  })
})
