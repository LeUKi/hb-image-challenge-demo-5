import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import type { AppEnv } from '../../src/server/env'
import type { Identity } from '../../src/server/auth'

export function sqliteD1(): { db: D1Database; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(':memory:')
  const migrations = new URL('../../migrations/', import.meta.url)
  for (const file of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(file, migrations), 'utf8'))
  function prepare(sql: string, bindings: unknown[] = []): object {
    return {
      bind: (...values: unknown[]) => prepare(sql, values),
      first: async () => sqlite.prepare(sql).get(...bindings as (string | number | null)[]) ?? null,
      all: async () => ({ success: true, results: sqlite.prepare(sql).all(...bindings as (string | number | null)[]) }),
      run: async () => {
        const result = sqlite.prepare(sql).run(...bindings as (string | number | null)[])
        return { success: true, meta: { changes: Number(result.changes) } }
      },
    }
  }
  const db = {
    prepare,
    batch: async (statements: { run: () => Promise<unknown> }[]) => {
      sqlite.exec('BEGIN')
      try {
        const results = []
        for (const statement of statements) results.push(await statement.run())
        sqlite.exec('COMMIT')
        return results
      } catch (error) { sqlite.exec('ROLLBACK'); throw error }
    },
  } as unknown as D1Database
  return { db, sqlite }
}

export const identity = { hongbao: '12345678-1234-4234-8234-123456789012', sender: '10000', sub: '42', nonce: 'valid-nonce-example' } satisfies Identity
export const environment = { OWNER_ID: '10000', HB_SITE: 'https://hb.example.com' } satisfies Pick<AppEnv, 'OWNER_ID' | 'HB_SITE'>
export const params = { server: 'https://challenge.example.com/', challenge: '这是一只猫吗？', minScore: 70, maxScore: 100, maxAttempts: 3, saveImages: true, reward: 100, scoreReward: false, minReward: 1, multiReward: false }
export const activity = {
  activity: {
    id: identity.hongbao, status: 'active', author: { id: '11111111-2222-4333-8444-555555555555' },
    judge: { params: Object.entries(params).map(([key, value]) => ({ param: { key }, value })) },
  },
}

export function png(width = 1, height = 1): Uint8Array<ArrayBuffer> {
  const real = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jx94AAAAASUVORK5CYII=', 'base64'))
  const view = new DataView(real.buffer)
  view.setUint32(16, width); view.setUint32(20, height)
  return real
}
