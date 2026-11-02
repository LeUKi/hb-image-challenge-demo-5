export const params = [
  { key: 'server', label: '服务地址', type: 'url', hint: '部署自己的图片挑战服务，填入根地址', guide: 'https://github.com/LeUKi/hb-image-challenge#readme' },
  { key: 'challenge', label: '图片要求', type: 'textarea', maxLength: 1000, default: '这张图片里有一只猫', hint: '描述要判断的图片特征；网页标题使用红包标题' },
  { key: 'minScore', label: '最低匹配度（%）', type: 'integer', min: 0, max: 100, default: 70 },
  { key: 'maxScore', label: '最高匹配度（%）', type: 'integer', min: 0, max: 100, default: 100 },
  { key: 'maxAttempts', label: '每人最多上传次数', type: 'integer', min: 1, max: 10, default: 3, hint: '已开始处理的请求计入次数，最多 10 次；查看结果不占次数' },
  { key: 'multiReward', label: '多次奖励', type: 'switch', default: true, hint: '开启后每张合格图片分别累计奖励，结束挑战时一起领取；关闭后首次通过即领取' },
  { key: 'scoreReward', label: '按评分发奖', type: 'switch', default: false, hint: '关闭时统一发最高奖励；开启时将合格评分对应到最低至最高奖励' },
  { key: 'minReward', label: '最低奖励', type: 'money', min: 1, default: 1, hint: '仅开启按评分发奖时生效，对应最低合格分' },
  { key: 'reward', label: '最高奖励', type: 'money', min: 1, default: 100, hint: '对应最高合格分；关闭按评分发奖时统一发此金额' },
  { key: 'saveImages', label: '保存玩家图片', type: 'switch', default: true, hint: '保存到你自己的私有 R2；关闭后仍保存评分与次数' },
]
export const network = [{ param: 'server' }]
export const meta = {
  name: '图片挑战',
  description: '上传图片，由 AI 判断匹配度，落在指定区间即可领取奖励。每位作者部署自己的完整服务。',
  page: { param: 'server' },
}
export const hongbao = {
  pageAutoOpen: true,
  note: '[打开图片挑战，上传你的图片](#附带网页)\n上传图片等待评分，再提交结果。开启多次奖励时，每张合格图片分别累计奖励，结束挑战或红包结束时一起领取；也可以输入“结算”提前结束。每人最多 10 次。分数表示 AI 的匹配判断，不是准确率。',
}
export function check(values) {
  const errors = []
  if (values.minScore > values.maxScore) errors.push({ key: 'maxScore', message: '最高匹配度不能低于最低匹配度' })
  if (values.scoreReward && values.minReward > values.reward) errors.push({ key: 'minReward', message: '最低奖励不能高于最高奖励' })
  try {
    if (new URL(values.server).pathname !== '/') errors.push({ key: 'server', message: '请填写服务根地址，不要附加路径' })
  } catch { errors.push({ key: 'server', message: '请填写有效的服务地址' }) }
  return errors
}

/** All calculations use integer score basis points and integer minor currency units. */
function rewardFor(score, rules) {
  if (!rules.scoreReward || rules.minScore === rules.maxScore) return rules.reward
  const position = BigInt(Math.round(score * 100) - rules.minScore * 100)
  const width = BigInt((rules.maxScore - rules.minScore) * 100)
  return rules.minReward + Number(position * BigInt(rules.reward - rules.minReward) / width)
}

const RESULT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const GALLERY_GRANT = /^[a-f0-9]{64}$/

/** Progress is read from the authenticated service, never from the submitted input. */
function validProgress(progress, result, rules, used) {
  return progress && typeof progress === 'object' &&
    Number.isInteger(progress.remaining) && progress.remaining >= 0 &&
    progress.remaining <= rules.maxAttempts - result.attempt &&
    typeof progress.processing === 'boolean' && Array.isArray(progress.readyIds) &&
    progress.readyIds.length <= rules.maxAttempts - progress.remaining &&
    progress.readyIds.every(id => typeof id === 'string' && RESULT_ID.test(id)) &&
    new Set(progress.readyIds).size === progress.readyIds.length &&
    progress.readyIds.includes(result.id) && used.every(id => progress.readyIds.includes(id))
}

/** @param {import('./judge').Submission} submission */
export async function judge(submission) {
  const { input, player } = submission
  const rules = { reward: 100, scoreReward: false, minReward: 1, multiReward: false, ...submission.params }
  const used = Array.isArray(player.state?.used) ? player.state.used : []
  const results = Array.isArray(player.state?.results) ? player.state.results : []
  const savedGrant = typeof player.state?.galleryGrant === 'string' && GALLERY_GRANT.test(player.state.galleryGrant)
    ? player.state.galleryGrant : null
  if (rules.multiReward && input === '结算') return {
    settle: true,
    player: {
      state: { used, results, ...(savedGrant ? { galleryGrant: savedGrant } : {}) },
      view: { summary: '挑战已结束', data: { ...player.view?.data, v: 2, multiReward: true, results, ...(savedGrant ? { galleryGrant: savedGrant } : {}) } },
    },
    message: player.pending > 0 ? '挑战已结束，累计奖励正在结算' : '挑战已结束，本次没有累计奖励',
  }
  if (!RESULT_ID.test(input)) return { message: '请先在附带网页上传图片，再提交返回的结果编号' }
  if (used.includes(input)) return { message: '这个结果已经提交过了，不需要重复提交' }
  if (rules.multiReward && used.length >= rules.maxAttempts) return { message: '图片结果均已提交，请结束并领取累计奖励' }
  const address = new URL(`api/results/${encodeURIComponent(input)}`, rules.server)
  address.searchParams.set('user', String(submission.user.id))
  let result
  try {
    const response = await fetch(address)
    if (!response.ok) return { message: '评分服务暂时不可用，请稍后提交同一结果，不用重新上传' }
    result = await response.json()
  } catch { return { message: '暂时无法核验，请稍后提交同一结果，不用重新上传' } }
  if (!result || result.found !== true) return { message: '没有找到属于你的有效结果，请先完成图片评分' }
  if (result.id !== input || result.user !== String(submission.user.id) ||
      result.challenge !== rules.challenge || result.minScore !== rules.minScore || result.maxScore !== rules.maxScore ||
      result.maxAttempts !== rules.maxAttempts || result.saveImages !== rules.saveImages ||
      (result.reward ?? rules.reward) !== rules.reward || (result.scoreReward ?? false) !== rules.scoreReward ||
      (result.minReward ?? 1) !== rules.minReward || (result.multiReward ?? false) !== rules.multiReward ||
      (rules.scoreReward && (result.reward === undefined || result.minReward === undefined))) return { message: '这个结果与当前挑战或玩家不匹配，不能领取' }
  if (typeof result.score !== 'number' || !Number.isFinite(result.score) || result.score < 0 || result.score > 100 ||
      !Number.isInteger(result.attempt) || result.attempt < 1 || result.attempt > rules.maxAttempts) return { message: '评分服务返回了无效结果，请联系红包作者' }
  if (rules.multiReward && !validProgress(result.progress, result, rules, used)) return { message: '评分服务返回了无效进度，请联系红包作者或稍后提交同一结果' }
  const passed = result.score >= rules.minScore && result.score <= rules.maxScore
  const exhausted = result.attempt >= rules.maxAttempts
  const reward = passed ? Math.min(rewardFor(result.score, rules), submission.hongbao.unclaimed) : 0
  const galleryGrant = passed && typeof result.galleryGrant === 'string' && GALLERY_GRANT.test(result.galleryGrant)
    ? result.galleryGrant : null
  if (rules.multiReward) {
    const newUsed = [...used, input]
    const newResults = [...results, { id: input, score: result.score, reward }]
    const settle = result.progress.remaining === 0 && !result.progress.processing &&
      result.progress.readyIds.every(id => newUsed.includes(id))
    const grant = galleryGrant ?? savedGrant
    return {
      ...(passed ? { add: reward } : {}),
      ...(settle ? { settle: true } : {}),
      player: {
        state: { used: newUsed, results: newResults, ...(grant ? { galleryGrant: grant } : {}) },
        view: { summary: settle ? '挑战已结束' : passed ? '奖励已累计' : '本次未通过', data: {
          v: 2, multiReward: true, resultId: input, score: result.score,
          remaining: result.progress.remaining, passed, reward, results: newResults,
          ...(settle && grant ? { galleryGrant: grant } : {}),
        } },
      },
      message: settle ? '图片结果均已提交，累计奖励正在结算' : passed
        ? `${result.score.toFixed(1)}% 匹配度，奖励已累计，可以继续上传或结束领取`
        : `${result.score.toFixed(1)}% 匹配度，未落在目标区间，已累计奖励保留`,
    }
  }
  const update = {
    state: { used: [...used, input] },
    view: { summary: passed ? '挑战通过' : '本次未通过', data: { v: 1, resultId: input, score: result.score, remaining: rules.maxAttempts - result.attempt, passed, reward, ...(galleryGrant ? { galleryGrant } : {}) } },
  }
  return passed
    ? { add: reward, settle: true, player: update, message: `${result.score.toFixed(1)}% 匹配度，挑战通过！` }
    : { player: update, ...(exhausted ? { settle: true } : {}), message: exhausted ? '本次未落在目标区间，机会已用完，挑战结束' : `${result.score.toFixed(1)}% 匹配度，未落在目标区间，可以换张图片再试` }
}
