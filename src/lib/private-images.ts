/** Authenticated image URLs are never put into links or query strings. */
export class PrivateImageCache {
  private urls = new Map<string, string>()
  private pending = new Map<string, Promise<string>>()
  private controller = new AbortController()

  constructor(private getHeaders: () => Promise<Headers>) {}

  updateHeaders(getHeaders: () => Promise<Headers>): void { this.getHeaders = getHeaders }

  async get(id: string): Promise<string> {
    if (this.controller.signal.aborted) this.controller = new AbortController()
    const cached = this.urls.get(id)
    if (cached) return cached
    const pending = this.pending.get(id)
    if (pending) return pending
    const controller = this.controller
    const request = (async () => {
      const headers = await this.getHeaders()
      const response = await fetch(`/api/images/${encodeURIComponent(id)}`, { headers, credentials: 'omit', signal: controller.signal })
      if (!response.ok) throw new Error('图片暂时无法读取')
      const blob = await response.blob()
      controller.signal.throwIfAborted()
      const url = URL.createObjectURL(blob)
      this.urls.set(id, url)
      return url
    })().finally(() => { if (this.pending.get(id) === request) this.pending.delete(id) })
    this.pending.set(id, request)
    return request
  }

  dispose(): void {
    this.controller.abort()
    for (const url of this.urls.values()) URL.revokeObjectURL(url)
    this.urls.clear()
    this.pending.clear()
  }
}
