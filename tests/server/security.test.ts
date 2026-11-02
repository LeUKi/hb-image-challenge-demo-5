import { beforeAll, describe, expect, it } from 'vitest'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import type { JWTVerifyGetKey, JWTPayload } from 'jose'
import type { AppEnv } from '../../src/server/env'
import { platformSite, verifyIdentity } from '../../src/server/auth'
import { challengeFromActivity, parseChallenge } from '../../src/server/challenge'
import { validateImage } from '../../src/server/images'
import { clefInput, parseScore } from '../../src/server/ai'
import { activity, environment, identity, params, png } from './helpers'

describe('platform identities', () => {
  let privateKey: CryptoKey, localKeys: JWTVerifyGetKey
  const request = new Request('https://challenge.example.com/api/upload')
  beforeAll(async () => {
    const pair = await generateKeyPair('ES256')
    privateKey = pair.privateKey
    localKeys = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'test', alg: 'ES256' }] })
  })
  async function token(kind = 'page', changes: JWTPayload = {}, site = environment.HB_SITE): Promise<string> {
    return new SignJWT({ ...identity, ...changes }).setProtectedHeader({ alg: 'ES256', kid: 'test' })
      .setIssuer(kind === 'page' ? site : `${site}/judge`)
      .setAudience('https://challenge.example.com').setIssuedAt().setExpirationTime('10m').sign(privateKey)
  }
  it('accepts a signed player bound to the author, activity and service', async () => {
    expect((await verifyIdentity(await token(), 'page', request, environment, localKeys)).sub).toBe('42')
  })
  it('defaults to the official site without trusting a different issuer', async () => {
    const defaults: Pick<AppEnv, 'OWNER_ID' | 'HB_SITE'> = { OWNER_ID: environment.OWNER_ID }
    expect(platformSite(defaults)).toBe('https://hb.lafi.sh')
    for (const kind of ['page', 'judge'] as const) {
      await expect(verifyIdentity(await token(kind, {}, 'https://hb.lafi.sh'), kind, request, defaults, localKeys)).resolves.toMatchObject({ sender: environment.OWNER_ID })
      await expect(verifyIdentity(await token(kind), kind, request, defaults, localKeys)).rejects.toMatchObject({ status: 401 })
    }
  })
  it('keeps explicit platform overrides strict and supports a local simulator', () => {
    expect(platformSite({ HB_SITE: 'http://127.0.0.1:8850' })).toBe('http://127.0.0.1:8850')
    for (const HB_SITE of ['', 'http://hb.lafi.sh', 'https://hb.lafi.sh/', 'https://hb.lafi.sh/path', 'https://user:pass@hb.lafi.sh']) {
      expect(() => platformSite({ HB_SITE })).toThrow()
    }
  })
  it('separates judge and page identities', async () => {
    await expect(verifyIdentity(await token(), 'judge', request, environment, localKeys)).rejects.toMatchObject({ status: 401 })
    await expect(verifyIdentity(await token('judge'), 'page', request, environment, localKeys)).rejects.toMatchObject({ status: 401 })
  })
  it('rejects foreign author, absent player, absent packet, foreign audience and expired tokens', async () => {
    for (const change of [{ sender: '99999' }, { sub: undefined }, { hongbao: '' }]) {
      await expect(verifyIdentity(await token('page', change), 'page', request, environment, localKeys)).rejects.toMatchObject({ status: 401 })
    }
    await expect(verifyIdentity(await token(), 'page', new Request('https://other.example.com/api/upload'), environment, localKeys)).rejects.toMatchObject({ status: 401 })
    const expired = await new SignJWT(identity).setProtectedHeader({ alg: 'ES256', kid: 'test' }).setIssuer(environment.HB_SITE)
      .setAudience('https://challenge.example.com').setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) - 60).sign(privateKey)
    await expect(verifyIdentity(expired, 'page', request, environment, localKeys)).rejects.toMatchObject({ status: 401 })
  })
})

describe('trusted author configuration', () => {
  it('binds published rules to the signed packet while author metadata uses an internal UUID', () => {
    expect(challengeFromActivity(activity, identity, 'https://challenge.example.com')).toMatchObject({ maxAttempts: 3, minScore: 70 })
  })
  it('rejects a different packet, closed packet and mismatched service', () => {
    expect(() => challengeFromActivity({ activity: { ...activity.activity, id: 'different-packet' } }, identity, 'https://challenge.example.com')).toThrow()
    expect(() => challengeFromActivity({ activity: { ...activity.activity, status: 'ended' } }, identity, 'https://challenge.example.com')).toThrow()
    expect(() => parseChallenge({ ...params, server: 'https://other.example.com/' }, 'https://challenge.example.com')).toThrow()
  })
  it('enforces author attempts, hard maximum, valid range and explicit retention', () => {
    for (const change of [{ maxAttempts: 11 }, { maxAttempts: 0 }, { maxAttempts: 1.5 }, { minScore: -1 }, { maxScore: 101 }, { minScore: 90, maxScore: 80 }, { saveImages: 'true' }]) {
      expect(() => parseChallenge({ ...params, ...change }, 'https://challenge.example.com')).toThrow()
    }
  })
})

describe('uploaded images and model probability', () => {
  it('accepts the actual PNG signature and reads pixel dimensions', () => {
    expect(validateImage(png(), 'image/png')).toEqual({ contentType: 'image/png', width: 1, height: 1 })
  })
  it('rejects mislabeled content, oversized dimensions, zero dimensions and incomplete images', () => {
    expect(() => validateImage(png(), 'image/jpeg')).toThrow()
    expect(() => validateImage(png(5000, 5000), 'image/png')).toThrow()
    expect(() => validateImage(png(0, 1), 'image/png')).toThrow()
    expect(() => validateImage(png().subarray(0, 32), 'image/png')).toThrow()
    expect(() => validateImage(new TextEncoder().encode('<svg/>'), 'image/png')).toThrow()
  })
  it('uses the documented embedded-image input and probability output', () => {
    expect(clefInput(png(), 'image/png', params.challenge)).toMatchObject({ model: 'clef-flash', images: [{ content_type: 'image/png' }], questions: { match: { type: 'noul', instructions: params.challenge } } })
    expect(parseScore({ answers: { match: { type: 'noul', noul: 0.87425 } } })).toBe(87.43)
    for (const value of [NaN, -0.1, 1.1, '0.9', undefined]) expect(() => parseScore({ answers: { match: { type: 'noul', noul: value } } })).toThrow()
    expect(() => parseScore({ answers: { match: { type: 'score', score: 90 } } })).toThrow()
  })
})
