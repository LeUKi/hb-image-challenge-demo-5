import type { ReactNode } from 'react'

export function Layout({ children }: { children: ReactNode }) {
  return <div className="site-shell">
    {children}
  </div>
}
