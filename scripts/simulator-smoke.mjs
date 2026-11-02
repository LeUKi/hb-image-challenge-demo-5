/* global document, window */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright-core'
import { demoImage } from './demo-images.mjs'

const station = process.env.SIMULATOR_URL || 'http://127.0.0.1:8860'
const service = process.env.SERVICE_URL || 'http://127.0.0.1:5173'
for (const address of [station, service]) {
  const url = new URL(address)
  assert.equal(url.protocol, 'http:')
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'This stateful check is restricted to the local simulator')
}
const pageOrigin = `http://localhost:${Number(new URL(station).port) + 1}`
const initial = await (await fetch(`${station}/api/state`)).json()
assert.equal(initial.hongbao.judged, 0, 'Restart the simulator for a clean browser test')
assert.equal(initial.hongbao.params.multiReward, true, 'Load the cumulative reward scenario')
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const errors = []
let activeFrame = null
let activePage = null
await mkdir('shots', { recursive: true })

async function api(path, data, origin = station) {
  const response = await fetch(`${origin}${path}`, data ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) } : undefined)
  assert.ok(response.ok, `${path}: ${response.status}`)
  return response.json()
}

async function openPlayer(context, who = '小明', multi = false) {
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  if (process.env.SMOKE_DEBUG) page.on('response', async response => {
    if (!new URL(response.url()).pathname.startsWith('/api/gallery')) return
    try { const value = await response.json(); console.log('Gallery response:', JSON.stringify({ who, status: response.status(), visibility: value.visibility, count: value.items?.length })) } catch { /* Response may be canceled by a navigation. */ }
  })
  await page.goto(`${station}/?layout=${multi ? 'multi&players=3' : 'wide'}&who=${encodeURIComponent(who)}&accept=1&open=1`, { waitUntil: 'domcontentloaded' })
  for (let index = 0; index < (multi ? 3 : 1); index++) await page.getByRole('button', { name: '允许', exact: true }).first().click()
  if (multi) await page.addStyleTag({ content: '.phones{display:block;zoom:1!important}.phone{display:block;width:1440px}.phone-screen{width:1440px;height:1060px;border-radius:18px}.phone:not(:first-child){position:absolute;left:-6000px}.phone .sheet.up{height:100%}.phone .handle,.phone .sheetTitle{display:none}' })
  const frame = page.frames().find(frame => frame.url().startsWith(pageOrigin))
  assert.ok(frame, 'The official simulator must embed the real app')
  await frame.locator('.gallery-item').first().waitFor()
  return { page, frame }
}

async function waitCount(frame, count, timeout = 30_000) {
  await frame.waitForFunction(count => document.querySelectorAll('.gallery-item').length === count, count, { timeout })
}

async function readable(frame, label) {
  const layout = await frame.evaluate(() => ({ width: window.innerWidth, scroll: document.documentElement.scrollWidth,
    small: [...document.querySelectorAll('p, button, a, label, h2, input')]
      .filter(node => node.getClientRects().length && (node.textContent?.trim() || node.tagName === 'INPUT'))
      .filter(node => Number.parseFloat(window.getComputedStyle(node).fontSize) < 16)
      .map(node => node.textContent?.trim().slice(0, 35)),
  }))
  assert.ok(layout.scroll <= layout.width, `${label}: no horizontal overflow`)
  assert.deepEqual(layout.small, [], `${label}: text remains at least 16px`)
}

async function upload(frame, index) {
  await frame.locator('#photo').setInputFiles({ name: `demo-${index}.png`, mimeType: 'image/png', buffer: demoImage(index) })
  const response = frame.page().waitForResponse(response => new URL(response.url()).pathname === '/api/upload' && response.request().method() === 'POST')
  await frame.getByRole('button', { name: '上传并评分', exact: true }).click()
  const uploaded = await response
  assert.equal(uploaded.status(), 200)
  const result = await uploaded.json()
  const viewer = frame.getByRole('dialog', { name: '图片详情', exact: true })
  await viewer.getByRole('button', { name: '提交这次结果', exact: true }).waitFor()
  assert.equal(await frame.getByRole('dialog').count(), 1, 'A completed upload opens only the shared image viewer')
  assert.equal(await frame.locator('.upload-preview, .file-meta').count(), 0)
  assert.deepEqual(await frame.locator('#photo').evaluate(input => ({ value: input.value, files: input.files.length })), { value: '', files: 0 })
  assert.equal(await frame.getByRole('button', { name: '上传并评分', exact: true }).isDisabled(), true)
  await viewer.locator('.detail-photo img').waitFor()
  assert.match(await viewer.innerText(), /匹配评分[\s\S]*NSFW 评分[\s\S]*2\.0%/)
  assert.match(await viewer.innerText(), /70–80%/)
  assert.match(await viewer.innerText(), /Clef Flash/)
  assert.match(await viewer.innerText(), /480\s*×\s*(600|400|540|440)\s*px/)
  return result
}

try {
  const context = await browser.newContext({ viewport: { width: 1940, height: 1100 } })
  const { page, frame } = await openPlayer(context, '小明', true)
  activePage = page
  activeFrame = frame
  await waitCount(frame, 6)
  await frame.getByRole('heading', { name: '找一只猫', exact: true }).waitFor()
  assert.equal(await frame.getByRole('navigation').count(), 0)
  assert.equal(await frame.getByText('选择图片 → 查看评分 → 提交结果', { exact: true }).count(), 1, 'First-use guidance remains present')
  assert.equal(await frame.locator('.gallery-photo[data-covered=true]').count(), 1)
  const cards = await frame.locator('.gallery-item').allInnerTexts()
  assert.ok(cards.every(text => /^(NSFW\s*点击查看\s*)?\d+\.\d%\s*\d[\d,.]*(?:万|亿|万亿)?$/.test(text.trim())), 'Cards contain only score, like count and required NSFW cover')
  await readable(frame, 'desktop')
  await page.screenshot({ path: 'shots/simulator-official-desktop.png', fullPage: true })
  // This must also work as the first real click into the application iframe:
  // receiving focus and rechecking identity may not swallow the file chooser.
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    frame.getByRole('button', { name: '选择图片', exact: true }).click(),
  ])
  await chooser.setFiles({ name: 'first-selection.png', mimeType: 'image/png', buffer: demoImage(8) })
  await frame.getByAltText('所选挑战图片', { exact: true }).waitFor()
  await frame.getByRole('button', { name: '移除图片', exact: true }).click()
  await waitCount(frame, 6)
  await page.locator('iframe').first().screenshot({ path: 'shots/simulator-gallery-desktop.png' })

  const modalBefore = await frame.evaluate(() => {
    const main = document.querySelector('main').getBoundingClientRect()
    const gallery = document.querySelector('.gallery-section').getBoundingClientRect()
    return { mainLeft: main.left, mainWidth: main.width, galleryLeft: gallery.left, galleryWidth: gallery.width }
  })
  await frame.getByRole('button', { name: '浏览设置', exact: true }).click()
  await frame.getByRole('dialog', { name: '浏览设置' }).waitFor()
  const modalAfter = await frame.evaluate(() => {
    const main = document.querySelector('main').getBoundingClientRect()
    const gallery = document.querySelector('.gallery-section').getBoundingClientRect()
    return { mainLeft: main.left, mainWidth: main.width, galleryLeft: gallery.left, galleryWidth: gallery.width }
  })
  assert.deepEqual(modalAfter, modalBefore, 'Locking background scroll must not move or resize the page')
  assert.equal(await frame.locator('html').evaluate(node => window.getComputedStyle(node).scrollbarWidth), 'none', 'Root scrollbar is hidden without disabling scrolling')
  await frame.getByRole('checkbox').check()
  await frame.locator('body').press('Escape')
  await frame.getByRole('dialog').waitFor({ state: 'hidden' })
  assert.equal(await frame.locator('.gallery-photo[data-covered=true]').count(), 0)
  await frame.goto(pageOrigin, { waitUntil: 'domcontentloaded' })
  await waitCount(frame, 6)
  assert.equal(await frame.locator('.gallery-photo[data-covered=true]').count(), 0, 'Browser preference survives refresh')
  await frame.getByRole('button', { name: '浏览设置', exact: true }).click()
  await frame.getByRole('checkbox').uncheck()
  await frame.locator('.modal-overlay').click({ position: { x: 5, y: 5 } })
  await frame.getByRole('dialog').waitFor({ state: 'hidden' })
  assert.equal(await frame.locator('.gallery-photo[data-covered=true]').count(), 1)
  const sensitive = frame.getByRole('button', { name: 'NSFW，点击查看图片', exact: true })
  await sensitive.click()
  assert.equal(await frame.locator('.gallery-photo[data-covered=true]').count(), 0, 'Single reveal affects just its card')
  await frame.getByRole('button', { name: '怎么玩', exact: true }).click()
  await frame.getByRole('dialog', { name: '怎么玩', exact: true }).waitFor()
  await frame.getByRole('button', { name: '关闭弹窗', exact: true }).click()
  await frame.getByRole('dialog').waitFor({ state: 'hidden' })
  console.log('PASS 匿名卡片、首次引导、16px文字、NSFW默认/单图/全局记忆、弹窗Esc/空白/关闭按钮。')

  const first = await upload(frame, 8)
  await frame.locator('.result-score').filter({ hasText: '35.0' }).waitFor()
  await waitCount(frame, 7)
  await readable(frame, 'current result viewer')
  await page.locator('iframe').first().screenshot({ path: 'shots/simulator-current-result.png' })
  await frame.getByRole('dialog', { name: '图片详情', exact: true }).getByRole('button', { name: '关闭弹窗', exact: true }).click()
  await frame.getByRole('dialog').waitFor({ state: 'hidden' })
  assert.equal(await frame.getByRole('button', { name: '提交这次结果', exact: true }).count(), 0, 'The page summary has no duplicate submit action')
  await frame.getByRole('button', { name: '查看本次结果', exact: true }).click()
  await frame.getByRole('dialog', { name: '图片详情', exact: true }).getByRole('button', { name: '提交这次结果', exact: true }).waitFor()
  await frame.goto(pageOrigin, { waitUntil: 'domcontentloaded' })
  await frame.locator('.result-score').filter({ hasText: '35.0' }).waitFor()
  assert.equal(await frame.getByRole('dialog').count(), 0, 'Refreshing recovers the scored result without opening a modal')
  await frame.locator(`[data-gallery-id="${first.id}"] .gallery-photo`).click()
  await frame.getByRole('dialog', { name: '图片详情', exact: true }).waitFor()
  assert.equal(await frame.getByRole('dialog').count(), 1)
  assert.match(await frame.getByRole('dialog').innerText(), /35\.0%/)
  await frame.getByRole('button', { name: '提交这次结果', exact: true }).click()
  await frame.getByRole('button', { name: '继续上传', exact: true }).click()
  await frame.getByRole('dialog').waitFor({ state: 'hidden' })
  const second = await upload(frame, 9)
  await frame.locator('.result-score').filter({ hasText: '75.0' }).waitFor()
  await frame.locator('.reward-preview').filter({ hasText: '5.50' }).waitFor()
  await frame.getByRole('button', { name: '提交这次结果', exact: true }).click()
  await frame.getByRole('button', { name: '继续上传', exact: true }).waitFor()
  await waitCount(frame, 8)
  const firstReward = await api(`/api/me?who=${encodeURIComponent('小明')}`)
  assert.equal(firstReward.pending, '5.50')
  assert.equal(firstReward.settled, null)
  assert.equal(firstReward.myView.data.reward, 550)
  assert.equal('galleryGrant' in firstReward.myView.data, false, 'A qualifying image does not reveal the private gallery grant while accumulation continues')
  assert.equal((await api('/api/state')).paid, '0.00')
  assert.equal(await frame.locator('#photo').count(), 1, 'A first qualifying result keeps the upload flow available')
  await frame.getByRole('button', { name: '继续上传', exact: true }).click()
  await frame.getByRole('dialog').waitFor({ state: 'hidden' })
  await frame.goto(pageOrigin, { waitUntil: 'domcontentloaded' })
  await frame.getByText('累计待领取', { exact: true }).waitFor()
  assert.match(await frame.locator('body').innerText(), /累计待领取[\s\S]*5\.50/)
  assert.equal(await frame.getByRole('dialog').count(), 0, 'Refreshing accumulated rewards restores the page without reopening the viewer')
  await waitCount(frame, 8)
  await frame.locator(`[data-gallery-id="${second.id}"] .gallery-photo`).click()
  await frame.getByRole('button', { name: '继续上传', exact: true }).waitFor()
  assert.equal(await frame.getByRole('button', { name: '提交这次结果', exact: true }).count(), 0, 'An accepted image stays accepted after refresh')
  await frame.getByRole('button', { name: '继续上传', exact: true }).click()
  await frame.getByRole('dialog').waitFor({ state: 'hidden' })
  const repeated = await frame.evaluate(id => window.hb.submit(id), second.id)
  assert.deepEqual({ judged: repeated.judged, added: repeated.added, pending: repeated.pending, settled: repeated.settled }, { judged: true, added: '0.00', pending: '5.50', settled: false })

  const third = await upload(frame, 10)
  assert.equal(third.score, 91)
  await frame.getByRole('button', { name: '提交这次结果', exact: true }).click()
  await frame.getByRole('button', { name: '继续上传', exact: true }).click()
  await frame.getByRole('dialog').waitFor({ state: 'hidden' })
  const fourth = await upload(frame, 11)
  assert.equal(fourth.score, 72)
  await frame.locator('.reward-preview').filter({ hasText: '2.80' }).waitFor()
  await frame.getByRole('button', { name: '提交这次结果', exact: true }).click()
  await frame.getByRole('button', { name: '继续上传', exact: true }).waitFor()
  await waitCount(frame, 10)
  const secondReward = await api(`/api/me?who=${encodeURIComponent('小明')}`)
  assert.equal(secondReward.pending, '8.30')
  assert.equal(secondReward.settled, null)
  assert.equal(secondReward.myView.data.remaining, 1)
  assert.equal('galleryGrant' in secondReward.myView.data, false)
  assert.deepEqual(secondReward.myView.data.results.map(item => ({ id: item.id, score: item.score, reward: item.reward })), [
    { id: first.id, score: 35, reward: 0 }, { id: second.id, score: 75, reward: 550 },
    { id: third.id, score: 91, reward: 0 }, { id: fourth.id, score: 72, reward: 280 },
  ])
  assert.equal((await api('/api/state')).paid, '0.00')
  await frame.getByRole('button', { name: '继续上传', exact: true }).click()
  await frame.getByRole('dialog').waitFor({ state: 'hidden' })
  await frame.getByText('累计待领取', { exact: true }).waitFor()
  assert.match(await frame.locator('body').innerText(), /累计待领取[\s\S]*8\.30/)
  await page.locator('iframe').first().screenshot({ path: 'shots/simulator-accumulated-reward.png' })
  await frame.getByRole('button', { name: '结算并领取', exact: true }).click()
  await frame.getByRole('button', { name: '确认结算', exact: true }).waitFor()
  assert.equal((await api(`/api/me?who=${encodeURIComponent('小明')}`)).settled, null, 'Opening settlement confirmation does not settle the player')
  await frame.locator('.modal-overlay').click({ position: { x: 5, y: 5 } })
  await frame.getByRole('dialog').waitFor({ state: 'hidden' })
  assert.equal((await api(`/api/me?who=${encodeURIComponent('小明')}`)).pending, '8.30')
  await frame.getByRole('button', { name: '结算并领取', exact: true }).click()
  await frame.getByRole('button', { name: '确认结算', exact: true }).click()
  await frame.getByRole('heading', { name: '奖励已领取', exact: true }).waitFor()
  await waitCount(frame, 12)
  assert.equal(await frame.locator('#photo').count(), 0)
  await frame.getByRole('dialog').waitFor({ state: 'hidden' })
  const settled = await api(`/api/me?who=${encodeURIComponent('小明')}`)
  assert.equal(settled.settled, '8.30')
  assert.equal(settled.pending, '0.00')
  assert.match(settled.myView.data.galleryGrant, /^[a-f0-9]{64}$/)
  assert.equal((await api('/api/state')).paid, '8.30')
  const duplicateSettlement = await frame.evaluate(() => window.hb.submit('结算'))
  assert.deepEqual(duplicateSettlement, { judged: false, reason: 'already_claimed' })
  assert.equal((await api('/api/state')).paid, '8.30', 'Repeated settlement never pays twice')
  await frame.goto(pageOrigin, { waitUntil: 'domcontentloaded' })
  await frame.getByRole('heading', { name: '奖励已领取', exact: true }).waitFor()
  await waitCount(frame, 12)
  assert.equal(await frame.locator('#photo').count(), 0, 'Reload never reopens upload after a claim')
  const scoreColors = await frame.locator('.gallery-score').evaluateAll(nodes => nodes.map(node => ({ passed: node.dataset.passed === 'true', color: window.getComputedStyle(node).color })))
  assert.ok(scoreColors.filter(item => item.passed).every(item => item.color === 'rgb(143, 231, 180)'))
  assert.ok(scoreColors.filter(item => !item.passed).every(item => item.color === 'rgb(255, 255, 255)'))
  console.log('PASS 真实上传清空选择框并复用查看器；35%未通过→75%累计5.50→刷新恢复/同图不重复加奖→91%零奖→72%累计2.80；确认弹窗后一次领取8.30，私人图库仅此时解锁，刷新继续禁上传。')

  // Leave the reader partway through the gallery, then cause another player’s
  // judgment. The real station emits its SDK update; no manual refresh click.
  const before = await frame.evaluate(() => {
    const nodes = [...document.querySelectorAll('[data-gallery-id]')]
    nodes[4].scrollIntoView({ block: 'start' })
    // The requested card may be clamped above the bottom of the page. Preserve
    // the first visible reading card, which may be earlier than nodes[4].
    const visible = nodes.map(node => ({ id: node.dataset.galleryId, rect: node.getBoundingClientRect() }))
      .filter(({ rect }) => rect.bottom > 0 && rect.top < window.innerHeight)
      .sort((a, b) => Math.max(0, a.rect.top) - Math.max(0, b.rect.top) || a.rect.left - b.rect.left)
    if (!visible.length) throw new Error('Expected a visible reading card')
    return { id: visible[0].id, top: visible[0].rect.top, scrollY: window.scrollY,
      maxScroll: document.documentElement.scrollHeight - window.innerHeight,
      columns: Object.fromEntries(nodes.map(node => [node.dataset.galleryId, [...node.parentElement.parentElement.children].indexOf(node.parentElement)])) }
  })
  const { nonce } = await api('/api/nonce', {}, service)
  const signed = await api('/api/identity', { who: '小红', nonce })
  const incomingImage = Buffer.from(await frame.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 480; canvas.height = 440
    const drawing = canvas.getContext('2d')
    drawing.fillStyle = '#604d78'; drawing.fillRect(0, 0, 480, 440)
    drawing.fillStyle = '#e8d8c5'; drawing.fillRect(80, 90, 320, 260)
    return canvas.toDataURL('image/png').split(',')[1]
  }), 'base64')
  const resultResponse = await fetch(`${service}/api/upload`, { method: 'POST', headers: { Authorization: `Bearer ${signed.token}`, 'Content-Type': 'image/png', 'X-Hb-Nonce': nonce, 'X-Hb-Gallery-Consent': 'v1', 'Idempotency-Key': randomUUID() }, body: incomingImage })
  assert.ok(resultResponse.ok)
  const incoming = await resultResponse.json()
  assert.equal(incoming.score, 57)
  // The kit broadcasts within one host's multi layout, as the real platform
  // does. Independent host tabs do not subscribe to changes in the kit server.
  const otherFrame = page.frames().filter(frame => frame.url().startsWith(pageOrigin))[1]
  const otherReceipt = await otherFrame.evaluate(id => window.hb.submit(id), incoming.id)
  assert.equal(otherReceipt.judged, true)
  await waitCount(frame, 13)
  const after = await frame.evaluate(id => {
    const nodes = [...document.querySelectorAll('[data-gallery-id]')]
    const anchor = nodes.find(node => node.dataset.galleryId === id)
    return { top: anchor.getBoundingClientRect().top, scrollY: window.scrollY,
      maxScroll: document.documentElement.scrollHeight - window.innerHeight,
      columns: Object.fromEntries(nodes.map(node => [node.dataset.galleryId, [...node.parentElement.parentElement.children].indexOf(node.parentElement)])),
      newest: [...document.querySelectorAll('.gallery-column')].map(node => node.firstElementChild?.dataset.galleryId) }
  }, before.id)
  for (const [id, column] of Object.entries(before.columns)) assert.equal(after.columns[id], column, 'Existing cards retain their columns')
  assert.ok(before.scrollY >= 80, 'This update must exercise scrolled reading position')
  assert.ok(Math.abs(after.top - before.top) <= 2, `Reading anchor must remain stable: ${JSON.stringify({ before, after })}`)
  assert.ok(after.newest.includes(incoming.id), 'New image appears directly at the front')
  assert.equal(await frame.getByText(/有.*张新图/).count(), 0)
  await frame.evaluate(() => window.scrollTo(0, 0))
  await frame.waitForFunction(() => document.querySelector('.gallery-section').style.minHeight === '')
  console.log('PASS 他人新图经官方SDK自动插入；旧图分栏不变、当前图片锚点稳定，无N张新图点击门槛。')

  for (const width of [1440, 390, 320]) {
    // Size only the kit's presentation frame; its SDK, signing, APIs and judge remain untouched.
    await page.addStyleTag({ content: `.phone:first-child,.phone:first-child .phone-screen{width:${width}px}.page-body{min-width:0}` })
    await frame.evaluate(() => window.scrollTo(0, 0))
    await readable(frame, `${width}px`)
    if (width <= 390) await page.locator('iframe').first().screenshot({ path: `shots/simulator-gallery-${width}.png` })
  }
  await page.screenshot({ path: 'shots/simulator-official-claimed.png', fullPage: true })
  await context.close()

  const reduced = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
  const other = await openPlayer(reduced, '小刚')
  activePage = other.page
  activeFrame = other.frame
  await other.frame.getByRole('button', { name: '浏览设置', exact: true }).click()
  await other.frame.getByRole('dialog', { name: '浏览设置', exact: true }).waitFor()
  const transition = await other.frame.locator('.modal-panel').evaluate(node => window.getComputedStyle(node).transform)
  assert.ok(transition === 'none' || transition === 'matrix(1, 0, 0, 1, 0, 0)')
  await other.frame.locator('body').press('Escape')
  let likeWrites = 0
  other.page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/gallery' && request.method() === 'POST' && request.postDataJSON()?.batch) likeWrites += 1
  })
  const likedCard = other.frame.locator('[data-gallery-id]').first()
  const likedId = await likedCard.getAttribute('data-gallery-id')
  const likeButton = likedCard.locator('.gallery-like')
  await likeButton.click()
  await likeButton.evaluate(button => { for (let i = 0; i < 4; i++) button.click() })
  await other.frame.getByRole('button', { name: '点赞，当前 5 次', exact: true }).waitFor()
  assert.equal(likeWrites, 0, 'Real heart clicks update immediately without requests')
  const endedAt = Date.now()
  await other.page.locator('#end').click()
  await other.frame.getByRole('heading', { name: /本次活动已结束|本次挑战已结算/ }).waitFor()
  // Verify the documented visible 60s fallback as well as SDK-driven updates.
  await waitCount(other.frame, 13, 75_000)
  console.log(`活动结束后全部画廊可见：${Date.now() - endedAt}ms`)
  const syncedHeart = other.frame.locator(`[data-gallery-id="${likedId}"] .gallery-like[data-pending=false]`)
  await syncedHeart.waitFor()
  assert.equal(await syncedHeart.getAttribute('aria-label'), '点赞，当前 5 次')
  assert.equal(likeWrites, 1, 'Five real clicks are one batch in the official simulator and D1')
  console.log('PASS 官方模拟器真实点击：5 赞即时显示、30 秒后一次批量保存，活动结束后仍正确显示，无重复写入。')
  assert.equal(await other.frame.locator('#photo').count(), 0)
  await reduced.close()
  assert.deepEqual(errors, [], 'No hydration failures or uncaught browser errors')
  console.log('PASS 1440/390/320px、减少动画、活动结束解锁全部作品及关闭上传。官方模拟器浏览器流程通过；请重启恢复体验初态。')
} catch (error) {
  try {
    if (activeFrame) console.error('Visible app state:', (await activeFrame.locator('body').innerText()).slice(0, 6000))
    if (activePage && !activePage.isClosed()) await activePage.screenshot({ path: 'shots/simulator-failure.png', fullPage: true })
  } catch { /* Preserve the original failure if a context already closed. */ }
  throw error
} finally { await browser.close() }
