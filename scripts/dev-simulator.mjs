/* global Response, Request, Headers */
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { getPlatformProxy } from 'wrangler'
import { startPage } from '../judge/cli/lib/page.mjs'
import { SENDER_ID } from '../judge/cli/lib/signer.mjs'
import { demoImage } from './demo-images.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const servicePort = 5173
const previewPort = 5175
const stationPort = Number(process.env.SIMULATOR_PORT || 8860)
const service = `http://127.0.0.1:${servicePort}`
const station = `http://127.0.0.1:${stationPort}`
const pageOrigin = `http://localhost:${stationPort + 1}`
const nativeFetch = globalThis.fetch.bind(globalThis)
const require = createRequire(import.meta.url)
// Use Wrangler's already-installed compiler; this is never bundled into the Worker.
const { build } = require(require.resolve('esbuild', { paths: [dirname(require.resolve('wrangler'))] }))
const plan = JSON.parse(await readFile(resolve(root, 'judge/simulate.json'), 'utf8'))
if (new URL(plan.params.server).origin !== service) throw new Error(`judge/simulate.json 的 server 需要是 ${service}/`)
const localDir = resolve(root, '.wrangler/simulator')
await mkdir(localDir, { recursive: true })
const configPath = resolve(localDir, 'wrangler.json')
await writeFile(configPath, JSON.stringify({
  name: 'hb-image-challenge-local-simulator', compatibility_date: '2026-10-30',
  vars: { OWNER_ID: SENDER_ID, HB_SITE: station },
  r2_buckets: [{ binding: 'IMAGES', bucket_name: 'simulator-private-images' }],
  d1_databases: [{ binding: 'DB', database_name: 'simulator', database_id: '00000000-0000-0000-0000-000000000000' }],
}))
const bundle = resolve(localDir, 'api.mjs')
await build({ entryPoints: [resolve(root, 'src/server/api.ts')], outfile: bundle, bundle: true, format: 'esm', platform: 'node', packages: 'external', logLevel: 'warning' })
const { handleApiRequest } = await import(pathToFileURL(bundle).href)
let proxy, simulator, server, preview
let closing = false
let calls = 0
let nextScores = []

function migrationStatements(sql) {
  const statements = []
  const lines = []
  let trigger = false
  // Each migration statement ends on its own line. A trigger's internal
  // semicolons belong to that statement and must reach SQLite together.
  for (const line of sql.replace(/--[^\n]*/g, '').split('\n')) {
    const text = line.trim()
    if (!text) continue
    if (!lines.length) trigger = /^CREATE\s+TRIGGER\b/i.test(text)
    lines.push(text)
    if (trigger ? /^END\s*;$/i.test(text) : text.endsWith(';')) {
      statements.push(lines.join(' '))
      lines.length = 0
      trigger = false
    }
  }
  if (lines.length) throw new Error('本地迁移存在未闭合的 SQL 语句')
  return statements
}

async function close() {
  if (closing) return
  closing = true
  globalThis.fetch = nativeFetch
  preview?.kill('SIGTERM')
  if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)) }
  await simulator?.close()
  await proxy?.dispose()
}
process.once('SIGINT', () => { void close() })
process.once('SIGTERM', () => { void close() })

try {
  proxy = await getPlatformProxy({ configPath, persist: false, remoteBindings: false, envFiles: [] })
  for (const file of (await readdir(resolve(root, 'migrations'))).filter(name => name.endsWith('.sql')).sort()) {
    const sql = await readFile(resolve(root, 'migrations', file), 'utf8')
    // D1 exec expects one complete statement per line, including each trigger.
    await proxy.env.DB.exec(migrationStatements(sql).join('\n'))
  }
  const env = { ...proxy.env, AI: { run: async () => {
    const [score, nsfw] = nextScores.shift() ?? [[35, 75, 91, 72, 57][calls++ % 5], 2]
    await setTimeout(450)
    return { answers: { match: { type: 'noul', noul: score / 100 }, nsfw: { type: 'noul', noul: nsfw / 100 } } }
  } } }
  // The official kit has no public activity endpoint. Translate its trusted
  // local state only here; production authentication and rule loading stay intact.
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (url.origin === station && url.pathname.startsWith('/api/activities/')) {
      const stateResponse = await nativeFetch(`${station}/api/state`)
      const state = await stateResponse.json()
      const id = decodeURIComponent(url.pathname.slice('/api/activities/'.length))
      if (id !== state.hongbao.id) return new Response(null, { status: 404 })
      return Response.json({ activity: {
        id, status: state.hongbao.status,
        deadlineAt: new Date(Date.now() + Date.parse(state.hongbao.deadlineAt) - state.now).toISOString(),
        judge: { params: Object.entries(plan.params).map(([key, value]) => ({ param: { key }, value })) },
      } })
    }
    return nativeFetch(input, init)
  }
  const previewConfig = resolve(localDir, 'preview.json')
  await writeFile(previewConfig, JSON.stringify({
    name: 'image-challenge-ssr-local', compatibility_date: '2026-10-30', compatibility_flags: ['nodejs_compat'],
    main: resolve(root, 'dist/server/index.js'), no_bundle: true,
    find_additional_modules: true, base_dir: resolve(root, 'dist/server'),
    rules: [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }],
    assets: { directory: resolve(root, 'dist/client') }, vars: { OWNER_ID: SENDER_ID, HB_SITE: station },
  }))
  // Render the actual built Worker with no AI, remote binding, or secret file.
  preview = spawn(process.execPath, [resolve(root, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--config', previewConfig, '--local', '--ip', '127.0.0.1', '--port', String(previewPort), '--show-interactive-dev-session', 'false', '--log-level', 'warn'], { cwd: root, stdio: 'inherit', env: { ...process.env, BROWSER: 'none', WRANGLER_SEND_METRICS: 'false' } })
  preview.once('exit', code => { if (!closing && code) { console.error(`SSR 预览退出：${code}`); void close() } })
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await nativeFetch(`http://127.0.0.1:${previewPort}/`)).ok) { ready = true; break } } catch { /* Wait for the local preview only. */ }
    await setTimeout(300)
  }
  if (!ready) throw new Error('本地 SSR 预览未能启动')
  server = createServer(async (incoming, outgoing) => {
    try {
      const url = new URL(incoming.url, service)
      if (url.pathname === '/__demo/image') {
        const image = demoImage(Math.abs(Number(url.searchParams.get('n')) || 0) % 12)
        outgoing.writeHead(200, { 'content-type': 'image/png', 'content-disposition': 'attachment; filename="demo.png"' }).end(image)
        return
      }
      const headers = new Headers()
      for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined && !['host', 'connection', 'accept-encoding', 'content-length'].includes(key)) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
      // Official page.mjs forwards the browser's proxy origin unchanged.
      if (headers.get('Origin') === pageOrigin) headers.set('Origin', service)
      let response
      if (url.pathname.startsWith('/api/')) {
        const chunks = []
        for await (const value of incoming) chunks.push(value)
        const body = ['GET', 'HEAD'].includes(incoming.method) ? undefined : Buffer.concat(chunks)
        response = await handleApiRequest(new Request(url, { method: incoming.method, headers, body }), env)
        if (!response) response = new Response(null, { status: 404 })
      } else {
        response = await nativeFetch(`http://127.0.0.1:${previewPort}${url.pathname}${url.search}`, { headers, redirect: 'manual' })
        if (response.headers.get('content-type')?.includes('text/html')) {
          const body = (await response.text()).replace('<body>', '<body><div role="note" style="padding:10px 18px;background:#efe8d4;color:#403d30;font:16px/1.5 system-ui;text-align:center">本地模拟 · 评分为演示数据，不调用真实 AI、不发真实奖励</div>')
          response = new Response(body, response)
        }
      }
      const back = Object.fromEntries(response.headers)
      for (const key of ['content-encoding', 'content-length', 'transfer-encoding']) delete back[key]
      outgoing.writeHead(response.status, back).end(Buffer.from(await response.arrayBuffer()))
    } catch (error) { console.error(error); outgoing.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: '本地模拟器请求失败，请检查终端日志' })) }
  })
  await new Promise((done, failed) => { server.once('error', failed); server.listen(servicePort, '127.0.0.1', done) })
  simulator = await startPage({ root: resolve(root, 'judge'), port: stationPort, live: true, print: console.log })

  // Seed through the real authenticated upload route, not direct DB inserts.
  const seeds = [[24, 2], [92, 2], [52, 95], [76, 2], [18, 2], [64, 2], [88, 2], [75, 2]]
  for (let index = 0; index < seeds.length; index++) {
    nextScores.push(seeds[index])
    const nonce = await (await nativeFetch(`${service}/api/nonce`, { method: 'POST' })).json()
    const signed = await (await nativeFetch(`${station}/api/identity`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ who: index < 4 ? '小红' : '小刚', nonce: nonce.nonce }) })).json()
    const uploaded = await nativeFetch(`${service}/api/upload`, { method: 'POST', headers: {
      'Content-Type': 'image/png', Authorization: `Bearer ${signed.token}`, 'X-Hb-Nonce': nonce.nonce,
      'Idempotency-Key': randomUUID(), 'X-Hb-Gallery-Consent': 'v1',
    }, body: demoImage(index) })
    if (!uploaded.ok) throw new Error(`本地样例上传失败：${await uploaded.text()}`)
  }
  console.log(`\n官方模拟器：${station}/?layout=multi&players=3&accept=1&open=1`)
  console.log(`页面：${simulator.pageUrl}/ （请经上方模拟器参与）`)
  console.log(`演示图片下载：${service}/__demo/image?n=0`)
  console.log('本地 D1/R2，签名来自官方模拟器；AI 使用明确标注的演示数据。重启命令可清空本轮。')
} catch (error) { console.error(error); await close(); process.exitCode = 1 }
