import handler from '@tanstack/react-start/server-entry'
import { handleApiRequest } from './server/api'
import type { AppEnv } from './server/env'

export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const response = await handleApiRequest(request, env)
    if (response) return response
    const rendered = await handler.fetch(request)
    const secured = new Response(rendered.body, rendered)
    secured.headers.set('X-Content-Type-Options', 'nosniff')
    secured.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
    return secured
  },
}
