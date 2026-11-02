import type { Hb } from '../types/hb-sdk'

export class ApiRequestError extends Error {
  readonly code?: string
  readonly remaining?: number

  constructor(message: string, details: unknown) {
    super(message)
    this.name = 'ApiRequestError'
    if (details && typeof details === 'object') {
      if ('code' in details && typeof details.code === 'string') this.code = details.code
      if ('remaining' in details && typeof details.remaining === 'number' && Number.isInteger(details.remaining) && details.remaining >= 0) this.remaining = details.remaining
    }
  }
}

export async function connectHongbao(site: string): Promise<Hb> {
  if (window.parent === window) throw new Error('请从红包页打开这个挑战')
  if (!window.hb) {
    await new Promise<void>((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>('script[data-hongbao-sdk]')
      const script = existing ?? document.createElement('script')
      const timeout = window.setTimeout(() => reject(new Error('暂时无法连接红包站，请重新打开挑战')), 12_000)
      script.addEventListener('load', () => { window.clearTimeout(timeout); resolve() }, { once: true })
      script.addEventListener('error', () => { window.clearTimeout(timeout); reject(new Error('暂时无法连接红包站，请重新打开挑战')) }, { once: true })
      if (!existing) {
        script.src = `${site.replace(/\/$/, '')}/sdk/v1.js`
        document.head.appendChild(script)
      }
    })
  }
  return window.hb
}

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'omit', ...init })
  const data: unknown = await response.json()
  if (!response.ok) {
    const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
      ? data.error : '服务暂时不可用，请稍后再试'
    throw new ApiRequestError(message, data)
  }
  return data as T
}
