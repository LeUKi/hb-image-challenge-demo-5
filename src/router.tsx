import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRouter } from '@tanstack/react-router'
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query'
import { Provider as JotaiProvider } from 'jotai'
import { MotionConfig } from 'motion/react'
import { routeTree } from './routeTree.gen'

export function getRouter() {
  // Every SSR request owns its own cache and atom store.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, retry: false, refetchOnWindowFocus: false } },
  })
  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreload: 'intent',
    Wrap: ({ children }) => (
      <QueryClientProvider client={queryClient}>
        <JotaiProvider>
          <MotionConfig reducedMotion="user">{children}</MotionConfig>
        </JotaiProvider>
      </QueryClientProvider>
    ),
  })
  setupRouterSsrQueryIntegration({ router, queryClient, wrapQueryClient: false })
  return router
}

declare module '@tanstack/react-router' {
  interface Register { router: ReturnType<typeof getRouter> }
}
