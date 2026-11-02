import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { JWTVerifyGetKey, JWTPayload } from 'jose'
import type { AppEnv } from './env'
import { ApiFailure } from './errors'

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

export interface Identity extends JWTPayload {
  hongbao: string
  sender: string
  sub: string
}

export function platformSite(env: Pick<AppEnv, 'HB_SITE'>): string {
  const site = env.HB_SITE ?? 'https://hb.lafi.sh'
  const url = new URL(site)
  if (url.origin !== site || (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new ApiFailure(503, 'invalid_site', '红包站地址配置无效')
  }
  return url.origin
}

export async function verifyIdentity(
  token: string | null,
  kind: 'page' | 'judge',
  request: Request,
  env: Pick<AppEnv, 'HB_SITE' | 'OWNER_ID'>,
  testKey?: JWTVerifyGetKey,
): Promise<Identity> {
  if (!/^\d+$/.test(env.OWNER_ID)) throw new ApiFailure(503, 'owner_not_configured', '服务尚未配置红包作者 ID')
  if (!token) throw new ApiFailure(401, 'identity_required', '请在红包页面验证身份后再试')
  const site = platformSite(env)
  let key = testKey
  if (!key) {
    if (!keySets.has(site)) keySets.set(site, createRemoteJWKSet(new URL(`${site}/api/page-identity/keys`)))
    key = keySets.get(site)!
  }
  try {
    const { payload } = await jwtVerify(token, key, {
      issuer: kind === 'judge' ? `${site}/judge` : site,
      audience: new URL(request.url).origin,
      algorithms: ['ES256'],
      clockTolerance: 5,
      requiredClaims: ['exp', 'iat', 'hongbao', 'sender'],
    })
    if (payload.sender !== env.OWNER_ID || typeof payload.hongbao !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(payload.hongbao)) {
      throw new Error('Identity belongs to another author or has no activity')
    }
    if (kind === 'page' && (typeof payload.sub !== 'string' || !/^\d+$/.test(payload.sub))) throw new Error('No player')
    return payload as Identity
  } catch {
    throw new ApiFailure(401, 'invalid_identity', '身份已过期，或这个服务不属于当前红包作者')
  }
}

export function pageToken(request: Request): string | null {
  const header = request.headers.get('Authorization')
  return header?.startsWith('Bearer ') ? header.slice(7) : null
}
