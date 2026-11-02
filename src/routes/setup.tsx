import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useForm } from '@tanstack/react-form'
import { ArrowRight, Check, Copy, Database, ExternalLink, HardDrive, Sparkles } from 'lucide-react'
import { Layout } from '../components/layout'
import { MODEL, modelLabel } from '../shared/contracts'

export const Route = createFileRoute('/setup')({
  head: () => ({ meta: [{ title: '部署服务 · 图片挑战' }] }),
  component: SetupPage,
})

const DEPLOY_URL = 'https://deploy.workers.cloudflare.com/?url=https://github.com/LeUKi/hb-image-challenge'
const CREATE_HONGBAO_URL = 'https://hb.lafi.sh/new?judge=0f06222c-e8b2-4683-89d9-ae8900e66cea'
const resources = [
  { icon: Sparkles, title: 'AI 评分', detail: `使用你账户的 ${modelLabel(MODEL)} 模型额度。` },
  { icon: HardDrive, title: '图片保存', detail: '图片存入私有 R2，按红包选择是否保存。' },
  { icon: Database, title: '结果记录', detail: 'D1 记录上传次数与评分，供判定器核验。' },
]

function SetupPage() {
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState('')
  const form = useForm({
    defaultValues: { ownerId: '' },
    onSubmit: async ({ value }) => {
      try {
        await navigator.clipboard.writeText(`OWNER_ID=${value.ownerId.trim()}\n`)
        setCopied(true)
        setCopyError('')
      } catch { setCopyError('复制未完成，请手动把数字 ID 填入本地 .dev.vars 的 OWNER_ID。') }
    },
  })

  return <Layout>
    <main>
      <header className="page-intro">
        <p className="context-label">红包作者</p>
        <h1 className="page-title">部署图片挑战服务</h1>
        <p className="page-description">把网页、AI 和图片存储部署到自己的 Cloudflare 账户，图片与使用量由你管理。</p>
      </header>

      <div className="setup-layout">
        <div className="setup-content">
          <section className="setup-section">
            <h2><span className="step-number" aria-hidden="true">1</span>填写作者 ID 并部署</h2>
            <p>点击部署按钮并连接 GitHub。应用参数只需填写你的 LINUX DO 数字用户 ID，服务默认连接正式红包站。</p>
            <dl className="mt-5 space-y-5 rounded-xl border border-line bg-white p-5">
              <div><dt className="font-mono font-semibold">OWNER_ID</dt><dd className="mt-1 text-muted">你的 LINUX DO 数字用户 ID。服务只处理这个作者发出的红包。</dd></div>
            </dl>
            <p className="mt-4">Cloudflare 的“启用预览构建”如已勾选，请取消；Access 无需开启，高级设置中的构建和部署命令保持默认。</p>
            <details className="mt-5">
              <summary className="min-h-11 py-2 font-medium">本地开发配置</summary>
              <p className="mt-3">在本地运行时，将下面生成的配置写入 <code>.dev.vars</code> 文件。</p>
              <form className="mt-4" onSubmit={event => { event.preventDefault(); void form.handleSubmit() }}>
                <form.Field name="ownerId" validators={{ onChange: ({ value }) => /^\d{1,20}$/.test(value.trim()) ? undefined : '请输入 LINUX DO 数字 ID' }}>{field => <div>
                  <label htmlFor="owner-id" className="field-label">LINUX DO 数字 ID</label>
                  <input className="text-input max-w-sm" id="owner-id" name={field.name} inputMode="numeric" placeholder="例如 10000" value={field.state.value}
                    onChange={event => { field.handleChange(event.target.value); setCopied(false) }} onBlur={field.handleBlur}
                    aria-invalid={field.state.meta.isTouched && field.state.meta.errors.length > 0} aria-describedby="owner-error" />
                  {field.state.meta.isTouched && field.state.meta.errors.length > 0 && <p id="owner-error" className="mt-2 !text-[#953d3b]">{field.state.meta.errors.join('，')}</p>}
                </div>}</form.Field>
                <form.Subscribe selector={state => [state.canSubmit, state.values.ownerId] as const}>{([canSubmit, ownerId]) => <button type="submit" disabled={!canSubmit || !/^\d{1,20}$/.test(ownerId.trim())} className="button-secondary mt-4">
                  {copied ? <Check size={18} aria-hidden="true" /> : <Copy size={18} aria-hidden="true" />}{copied ? '已复制本地开发配置' : '复制本地开发配置'}
                </button>}</form.Subscribe>
                {copyError && <p role="alert" className="mt-3 !text-[#953d3b]">{copyError}</p>}
              </form>
            </details>
          </section>
          <section className="setup-section">
            <h2><span className="step-number" aria-hidden="true">2</span>在红包站创建挑战</h2>
            <p>点击下方按钮，使用已发布的图片挑战判定器。填入部署后的服务根地址，例如 <code>https://你的服务.workers.dev/</code>，再填写挑战描述、目标评分区间、每人上传次数、是否保存图片和成功奖励。</p>
            <a href={CREATE_HONGBAO_URL} target="_blank" rel="noreferrer" className="button-secondary mt-4">使用此判定器发红包<ArrowRight size={18} aria-hidden="true" /></a>
            <p className="mt-3">每人默认 3 次，最多 10 次。R2 会随服务一起部署，是否保存图片可按每个红包调整。</p>
          </section>
          <section className="setup-section">
            <h2><span className="step-number" aria-hidden="true">3</span>开放红包，邀请玩家</h2>
            <p>玩家从红包页打开图片挑战，上传图片后等待评分。提交结果时，判定器会向你的服务核验，符合目标区间再发放奖励。</p>
          </section>
        </div>

        <aside className="deployment-card" aria-label="部署到 Cloudflare">
          <h2 className="section-title">完整部署到你的账户</h2>
          <ul className="resource-list">{resources.map(({ icon: Icon, title, detail }) => <li key={title}>
            <Icon size={22} strokeWidth={1.7} aria-hidden="true" />
            <div><h3>{title}</h3><p>{detail}</p></div>
          </li>)}</ul>
          <a className="button-primary w-full" href={DEPLOY_URL} target="_blank" rel="noreferrer">Deploy to Cloudflare<ExternalLink size={18} aria-hidden="true" /></a>
          <p className="mt-5 text-muted">首次使用 R2 时，按 Cloudflare 的提示完成账户开通。部署后请确认资源和作者 ID 配置正确。</p>
        </aside>
      </div>

      <div className="notice mt-8">
        <HardDrive size={22} aria-hidden="true" />
        <p>AI、R2 和数据库用量计入你的 Cloudflare 账户。保存的图片默认私有，其他玩家无法访问。</p>
      </div>
      <a href="https://github.com/LeUKi/hb-image-challenge#readme" target="_blank" rel="noreferrer" className="text-action mt-5">查看完整部署说明<ArrowRight size={18} aria-hidden="true" /></a>
    </main>
  </Layout>
}
