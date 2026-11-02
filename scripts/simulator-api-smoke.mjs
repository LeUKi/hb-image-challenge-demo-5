/* global AbortSignal */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { demoImage } from './demo-images.mjs'

// Run against a freshly started `npm run simulator`. This consumes four of
// 小明's local attempts plus 小刚's final attempt for a cross-player duplicate,
// and settles one simulated reward. It never resets or ends the activity;
// restarting the simulator restores its seeded state.
const station = process.env.SIMULATOR_URL || 'http://127.0.0.1:8860'
const service = process.env.SERVICE_URL || 'http://127.0.0.1:5173'
for (const address of [station, service]) {
  const url = new URL(address)
  assert.equal(url.protocol, 'http:', 'Only local HTTP simulator endpoints are allowed')
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Never run this smoke check against a deployed service')
  assert.equal(url.origin, address, 'Use a service root without a trailing slash')
}

async function response(address, options) {
  return fetch(address, { ...options, signal: AbortSignal.timeout(15_000) })
}

async function json(address, options) {
  const result = await response(address, options)
  assert.ok(result.ok, `Local API ${new URL(address).pathname} returned ${result.status}: ${await result.clone().text()}`)
  return result.json()
}

async function post(address, data) {
  return json(address, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
}

async function identify(who) {
  const { nonce } = await post(`${service}/api/nonce`, {})
  const signed = await post(`${station}/api/identity`, { who, nonce })
  assert.equal(typeof signed.token, 'string', 'The official simulator must issue a signed page JWT')
  const claims = JSON.parse(Buffer.from(signed.token.split('.')[1], 'base64url').toString('utf8'))
  assert.match(claims.sub, /^\d+$/)
  return { who, nonce, token: signed.token, user: claims.sub }
}

function headers(player, grant) {
  return { Authorization: `Bearer ${player.token}`, ...(grant ? { 'X-Hb-Gallery-Grant': grant } : {}) }
}

async function gallery(player, grant) {
  const result = await json(`${service}/api/gallery`, { headers: headers(player, grant) })
  for (const item of result.items) {
    assert.deepEqual(Object.keys(item).sort(), ['id', 'model', 'score', 'nsfwScore', 'saved', 'createdAt', 'own', 'width', 'height', 'passed', 'likes'].sort(), 'Gallery entries expose only anonymous presentation fields')
    assert.equal(typeof item.own, 'boolean')
    assert.equal(typeof item.score, 'number')
  }
  assert.equal(result.next, null, 'This seeded scenario fits in one page')
  return result
}

async function upload(who, imageIndex) {
  const player = await identify(who)
  const result = await json(`${service}/api/upload`, {
    method: 'POST', headers: {
      ...headers(player), 'Content-Type': 'image/png', 'X-Hb-Nonce': player.nonce,
      'Idempotency-Key': randomUUID(), 'X-Hb-Gallery-Consent': 'v1',
    }, body: demoImage(imageIndex),
  })
  assert.equal('galleryGrant' in result, false, 'An upload result must not grant post-claim access')
  assert.equal(result.saved, true)
  assert.equal(result.model, '@cf/cloudflare/clef-flash')
  assert.equal(result.width, 480)
  assert.ok(result.height > 0)
  return { player, result }
}

async function image(player, id, grant) {
  const result = await response(`${service}/api/images/${id}`, { headers: headers(player, grant) })
  assert.equal(result.status, 200, 'An authorized original image must be readable')
  assert.equal(result.headers.get('Content-Type'), 'image/png')
  assert.equal(result.headers.get('Cache-Control'), 'no-store')
  const bytes = Buffer.from(await result.arrayBuffer())
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'The API returns the actual PNG stored in local R2')
  return bytes
}

const state = await json(`${station}/api/state`)
const config = await json(`${service}/api/config`)
assert.equal(state.hongbao.id, 'test', 'Expected the official local simulator')
assert.equal(state.hongbao.status, 'active')
assert.equal(state.hongbao.judged, 0, 'Restart the simulator before rerunning this stateful check')
assert.equal(state.paid, '0.00')
assert.equal(config.hbSite, station)
assert.equal(config.storage, 'r2')
assert.equal(config.model, '@cf/cloudflare/clef-flash')
assert.deepEqual(
  { min: state.hongbao.params.minScore, max: state.hongbao.params.maxScore, attempts: state.hongbao.params.maxAttempts, multiple: state.hongbao.params.multiReward, dynamic: state.hongbao.params.scoreReward, low: state.hongbao.params.minReward, high: state.hongbao.params.reward },
  { min: 70, max: 80, attempts: 5, multiple: true, dynamic: true, low: 100, high: 1000 },
  'The expected 70–80% → 1.00–10.00 LDC scenario must be loaded',
)

let player = await identify('小明')
const initial = await gallery(player)
assert.equal(initial.visibility, 'misses')
assert.equal(initial.remaining, 5)
assert.equal(initial.latest, null, 'Start with no 小明 uploads so mock AI scores remain deterministic')
assert.equal(initial.items.length, 6)
assert.equal(initial.items.some(item => item.passed), false)
assert.equal(initial.items.some(item => item.nsfwScore === 95), true)
assert.ok(initial.items.every(item => !item.own))
assert.ok(initial.items.every(item => item.model === '@cf/cloudflare/clef-flash'), 'Seed uploads use the current model through the real API')
const originalIds = new Set(initial.items.map(item => item.id))
const sensitive = initial.items.find(item => item.nsfwScore === 95)
await image(player, sensitive.id)
console.log('PASS 初始匿名图库：6 张未达区间图片，包含 NSFW 95 分；真实私有 R2 图片可鉴权读取。')

async function syncLikes(participant, data) {
  return json(`${service}/api/gallery`, { method: 'POST', headers: { ...headers(participant), 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
}
const likedId = initial.items[0].id
const likeBatch = { id: randomUUID(), items: [{ id: likedId, count: 300 }] }
const liked = await syncLikes(player, { batch: likeBatch, watch: [likedId] })
assert.deepEqual(liked.likeReceipt, { id: likeBatch.id, status: 'accepted', retryAfterMs: liked.likeReceipt.retryAfterMs, rejected: [] })
assert.ok(liked.likeReceipt.retryAfterMs > 0 && liked.likeReceipt.retryAfterMs <= 30_000)
assert.equal(liked.likeCounts[likedId], 300)
assert.equal((await syncLikes(player, { batch: likeBatch })).likeCounts[likedId], 300, 'A replay cannot double count in real D1')
const limited = await syncLikes(player, { batch: { id: randomUUID(), items: [{ id: likedId, count: 100 }] } })
assert.equal(limited.likeReceipt.status, 'throttled')
assert.equal(limited.likeCounts[likedId], 300)
const recovered = await syncLikes(player, { receiptFor: likeBatch.id, watch: [likedId] })
assert.equal(recovered.likeReceipt.status, 'accepted')
assert.equal(recovered.likeCounts[likedId], 300, 'Reading a lost acknowledgement never writes likes')
const secondLiker = await identify('小红')
const independentlyLiked = await syncLikes(secondLiker, { batch: { id: randomUUID(), items: [{ id: likedId, count: 2 }] } })
assert.equal(independentlyLiked.likeReceipt.status, 'accepted', 'Numeric player gates are independent')
assert.equal(independentlyLiked.likeCounts[likedId], 302)
assert.equal((await gallery(player)).remaining, 5, 'Likes never consume uploads or reward attempts')
console.log('PASS 真实本地 D1：300 赞一次写入，重放不重复计数，30 秒限制、只读回执恢复及跨账号独立限流正常。')

const first = await upload('小明', 8)
player = first.player
assert.deepEqual({ score: first.result.score, attempt: first.result.attempt, remaining: first.result.remaining, nsfw: first.result.nsfwScore }, { score: 35, attempt: 1, remaining: 4, nsfw: 2 })
const beforeSubmit = await gallery(await identify('小明'))
assert.equal(beforeSubmit.items.length, 7)
assert.equal(beforeSubmit.latest.id, first.result.id)
assert.equal(beforeSubmit.latest.score, 35)
assert.equal(beforeSubmit.latest.model, '@cf/cloudflare/clef-flash')
assert.equal(beforeSubmit.items.find(item => item.id === first.result.id).model, '@cf/cloudflare/clef-flash')
assert.equal(beforeSubmit.remaining, 4)
assert.equal((await json(`${station}/api/mine?who=${encodeURIComponent('小明')}`)).total, 0, 'An uploaded, scored image is recoverable before any judge submission')
assert.deepEqual(await image(player, first.result.id), demoImage(8))
const failed = await post(`${station}/api/submit`, { who: '小明', input: first.result.id })
assert.equal(failed.result.judged, true)
assert.equal(failed.result.claimed, false)
assert.equal(failed.result.settled, false)
assert.equal(failed.state.paid, '0.00')
const afterFailure = await json(`${station}/api/me?who=${encodeURIComponent('小明')}`)
assert.equal(afterFailure.settled, null)
assert.equal(afterFailure.myView.data.passed, false)
assert.equal(afterFailure.myView.data.resultId, first.result.id, 'The private accepted-result marker identifies this exact upload')
assert.equal('galleryGrant' in afterFailure.myView.data, false)
console.log('PASS 35% 未提交评分可刷新恢复，失败提交不发奖、不结算、不授予图库许可；剩余 4 次。')

const duplicatePlayer = await identify('小刚')
const beforeDuplicate = await gallery(duplicatePlayer)
assert.equal(beforeDuplicate.remaining, 1)
assert.notEqual(beforeDuplicate.latest.id, first.result.id, 'The duplicate requester must not own the original result')
const duplicateKey = randomUUID()
const duplicateOptions = {
  method: 'POST', headers: {
    ...headers(duplicatePlayer), 'Content-Type': 'image/png', 'X-Hb-Nonce': duplicatePlayer.nonce,
    'Idempotency-Key': duplicateKey, 'X-Hb-Gallery-Consent': 'v1',
  }, body: demoImage(8),
}
const duplicateResponse = await response(`${service}/api/upload`, duplicateOptions)
assert.equal(duplicateResponse.status, 409)
const duplicate = await duplicateResponse.json()
assert.deepEqual(duplicate, { code: 'duplicate_image', error: '这张图片已提交过，本次已消耗 1 次机会，请换一张', attempt: 5, remaining: 0 })
assert.equal('id' in duplicate || 'score' in duplicate || 'user' in duplicate, false, 'A duplicate error must not reveal another participant or their result')
const afterDuplicate = await gallery(await identify('小刚'))
assert.equal(afterDuplicate.remaining, 0, 'Reusing any participant’s exact file consumes the requester’s attempt')
assert.equal(afterDuplicate.latest.id, beforeDuplicate.latest.id, 'A duplicate never replaces the requester’s own recoverable score')
assert.deepEqual(afterDuplicate.items.map(item => item.id).sort(), beforeDuplicate.items.map(item => item.id).sort(), 'A rejected duplicate adds no gallery record')
const duplicateReplay = await response(`${service}/api/upload`, duplicateOptions)
assert.equal(duplicateReplay.status, 409)
assert.deepEqual(await duplicateReplay.json(), duplicate, 'Replaying the same upload operation returns its existing failure without charging another attempt')
assert.equal((await gallery(await identify('小明'))).remaining, 4, 'Another participant’s duplicate does not charge the original uploader')
console.log('PASS 整个红包精确去重：小刚重复小明图片消耗最后1次，不泄露原结果、不新增作品；同幂等键重试不重复扣次。')

const second = await upload('小明', 9)
player = second.player
assert.deepEqual({ score: second.result.score, attempt: second.result.attempt, remaining: second.result.remaining }, { score: 75, attempt: 2, remaining: 3 })
assert.equal(second.result.score, 75, 'The rejected duplicate must not have consumed the simulator’s next AI inference')
const stillUnclaimed = await gallery(player)
assert.equal(stillUnclaimed.visibility, 'misses')
assert.equal(stillUnclaimed.items.length, 8, 'Own successful but unsubmitted result is visible without revealing others’ successes')
assert.equal(stillUnclaimed.latest.id, second.result.id)
const pageCannotJudge = await response(`${service}/api/results/${second.result.id}?user=${player.user}`, { headers: headers(player) })
assert.equal(pageCannotJudge.status, 401, 'A page JWT cannot query the judge-only endpoint to obtain a grant early')

const succeeded = await post(`${station}/api/submit`, { who: '小明', input: second.result.id })
assert.deepEqual(
  { judged: succeeded.result.judged, claimed: succeeded.result.claimed, settled: succeeded.result.settled, added: succeeded.result.added, pending: succeeded.result.pending },
  { judged: true, claimed: false, settled: false, added: '5.50', pending: '5.50' },
)
assert.equal(succeeded.state.paid, '0.00')
const firstReward = await json(`${station}/api/me?who=${encodeURIComponent('小明')}`)
assert.equal(firstReward.pending, '5.50')
assert.equal(firstReward.settled, null)
assert.equal(firstReward.myView.data.v, 2)
assert.equal(firstReward.myView.data.multiReward, true)
assert.equal(firstReward.myView.data.reward, 550)
assert.equal(firstReward.myView.data.resultId, second.result.id)
assert.equal(firstReward.myView.data.passed, true)
assert.equal(firstReward.myView.data.remaining, 3)
assert.equal('galleryGrant' in firstReward.myView.data, false, 'A qualifying result must not unlock other successes before settlement')
assert.equal((await gallery(await identify('小明'))).visibility, 'misses')
const repeated = await post(`${station}/api/submit`, { who: '小明', input: second.result.id })
assert.equal(repeated.result.judged, true)
assert.equal(repeated.result.added, '0.00')
assert.equal(repeated.result.pending, '5.50')
assert.equal(repeated.result.settled, false)
assert.deepEqual((await json(`${station}/api/me?who=${encodeURIComponent('小明')}`)).myView, firstReward.myView, 'Replaying an accepted result preserves the existing ledger')

const third = await upload('小明', 10)
assert.deepEqual({ score: third.result.score, attempt: third.result.attempt, remaining: third.result.remaining }, { score: 91, attempt: 3, remaining: 2 })
const outside = await post(`${station}/api/submit`, { who: '小明', input: third.result.id })
assert.equal(outside.result.added, '0.00')
assert.equal(outside.result.pending, '5.50')
assert.equal(outside.result.settled, false)

const fourth = await upload('小明', 11)
assert.deepEqual({ score: fourth.result.score, attempt: fourth.result.attempt, remaining: fourth.result.remaining }, { score: 72, attempt: 4, remaining: 1 })
const secondReward = await post(`${station}/api/submit`, { who: '小明', input: fourth.result.id })
assert.deepEqual(
  { judged: secondReward.result.judged, claimed: secondReward.result.claimed, settled: secondReward.result.settled, added: secondReward.result.added, pending: secondReward.result.pending },
  { judged: true, claimed: false, settled: false, added: '2.80', pending: '8.30' },
)
assert.equal(secondReward.state.paid, '0.00')
const beforeSettlement = await json(`${station}/api/me?who=${encodeURIComponent('小明')}`)
assert.equal(beforeSettlement.pending, '8.30')
assert.equal(beforeSettlement.settled, null)
assert.equal(beforeSettlement.myView.data.remaining, 1)
assert.equal('galleryGrant' in beforeSettlement.myView.data, false)
assert.deepEqual(beforeSettlement.myView.data.results.map(item => ({ id: item.id, score: item.score, reward: item.reward })), [
  { id: first.result.id, score: 35, reward: 0 },
  { id: second.result.id, score: 75, reward: 550 },
  { id: third.result.id, score: 91, reward: 0 },
  { id: fourth.result.id, score: 72, reward: 280 },
])
const beforeSettlementGallery = await gallery(await identify('小明'))
assert.equal(beforeSettlementGallery.visibility, 'misses')
assert.equal(beforeSettlementGallery.items.length, 10, 'Other participants’ two qualifying images remain private during accumulation')
assert.equal(beforeSettlementGallery.remaining, 1)
console.log('PASS 75% 与 72% 两张合格图片分别累计 5.50、2.80 LDC；91% 不加奖，同一结果重放不重复累计；刷新可恢复待领取 8.30，成功图库仍私有。')

const settled = await post(`${station}/api/submit`, { who: '小明', input: '结算' })
assert.deepEqual(
  { judged: settled.result.judged, claimed: settled.result.claimed, settled: settled.result.settled, amount: settled.result.amount, unit: settled.result.unit },
  { judged: true, claimed: true, settled: true, amount: '8.30', unit: 'LDC' },
)
assert.equal(settled.state.paid, '8.30')
const me = await json(`${station}/api/me?who=${encodeURIComponent('小明')}`)
assert.equal(me.pending, '0.00')
assert.equal(me.settled, '8.30')
assert.equal(me.myView.data.reward, 280)
assert.equal(me.myView.data.resultId, fourth.result.id)
assert.equal(me.myView.data.passed, true)
assert.equal(me.myView.data.remaining, 1, 'Settlement preserves actual remaining uploads rather than fabricating exhaustion')
assert.deepEqual(me.myView.data.results, beforeSettlement.myView.data.results)
const grant = me.myView.data.galleryGrant
assert.match(grant, /^[a-f0-9]{64}$/)
assert.equal(JSON.stringify(settled.state).includes(grant), false, 'The capability must stay out of the public activity snapshot')
const settledReplay = await post(`${station}/api/submit`, { who: '小明', input: '结算' })
assert.deepEqual(settledReplay.result, { judged: false, reason: 'already_claimed' }, 'A settled participant cannot claim the cumulative reward again')
assert.equal(settledReplay.state.paid, '8.30')
console.log('PASS 主动“结算”一次领取累计 8.30 LDC；再次结算被平台拒绝；图库许可到结算才进入私人视图。')

const refreshedPlayer = await identify('小明')
const lockedWithoutGrant = await gallery(refreshedPlayer)
assert.equal(lockedWithoutGrant.visibility, 'misses', 'Result checking or settlement alone must not replace the bound private capability')
const unlocked = await gallery(refreshedPlayer, grant)
assert.equal(unlocked.visibility, 'all')
assert.equal(unlocked.items.length, 12)
assert.equal(unlocked.remaining, 1)
assert.equal(unlocked.latest.id, fourth.result.id)
assert.equal(unlocked.latest.remaining, 1)
const otherSuccesses = unlocked.items.filter(item => !item.own && item.passed)
assert.equal(otherSuccesses.length, 2)
for (const item of otherSuccesses) {
  assert.equal(originalIds.has(item.id), false)
  assert.equal((await response(`${service}/api/images/${item.id}`, { headers: headers(refreshedPlayer) })).status, 404)
  await image(refreshedPlayer, item.id, grant)
}
console.log('PASS 领取后刷新：私人许可解锁全部 12 条共享评分和原图，最新结果/剩余 1 次准确恢复。')

const otherPlayer = await identify('小红')
const otherState = await json(`${station}/api/me?who=${encodeURIComponent('小红')}`)
assert.equal(otherState.settled, null)
const othersGallery = await gallery(otherPlayer)
assert.equal(othersGallery.visibility, 'misses')
assert.equal(othersGallery.remaining, 1)
assert.equal((await response(`${service}/api/gallery`, { headers: headers(otherPlayer, grant) })).status, 403, 'A different numeric player identity cannot reuse 小明’s capability')
const foreignSuccess = otherSuccesses.find(item => !othersGallery.items.some(visible => visible.id === item.id))
assert.ok(foreignSuccess, 'At least one other participant’s successful upload must remain hidden from 小红')
assert.equal((await response(`${service}/api/images/${foreignSuccess.id}`, { headers: headers(otherPlayer, grant) })).status, 403)
const mine = await json(`${station}/api/mine?who=${encodeURIComponent('小明')}`)
assert.equal(mine.total, 6)
assert.deepEqual(mine.items.map(item => item.claimed), [true, false, false, false, false, false])
assert.deepEqual(mine.items.filter(item => item.added !== '0.00').map(item => item.added), ['2.80', '5.50'])
console.log('PASS 未领取的小红无法借用许可读取图库或成功原图；私人记录完整保留两张加奖、未达标、重放及最终结算。')
console.log('官方模拟器 + 真实产品 API 全流程通过。未调用真实 AI、未产生真实资金；本轮消耗小明 4 次模拟上传及小刚 1 次重复上传，请重启模拟器恢复体验初态。')
