import type { ReactNode } from 'react'
import type { QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, HeadContent, Link, Outlet, Scripts } from '@tanstack/react-router'
import stylesheet from '../styles.css?url'

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: '图片挑战' },
      { name: 'description', content: '选一张图片，让 AI 判断。落在挑战区间，就有机会领到红包。' },
      { name: 'theme-color', content: '#f5f7f8' },
    ],
    links: [{ rel: 'stylesheet', href: stylesheet }],
  }),
  shellComponent: Document,
  component: Outlet,
  notFoundComponent: () => <main className="mx-auto max-w-lg p-8"><h1 className="text-2xl font-semibold">没有找到这个页面</h1><Link to="/" className="mt-4 inline-block underline">回到图片挑战</Link></main>,
  errorComponent: ({ reset }) => <main className="mx-auto max-w-lg p-8"><h1 className="text-2xl font-semibold">页面暂时没有加载完成</h1><button className="mt-4 rounded-xl bg-slate-900 px-5 py-3 text-white" onClick={reset}>重新加载</button></main>,
})

function Document({ children }: { children: ReactNode }) {
  return <html lang="zh-CN"><head><HeadContent /><script src="https://hb.lafi.sh/sdk/v1.js" data-hongbao-sdk="" defer /></head><body>{children}<Scripts /></body></html>
}
