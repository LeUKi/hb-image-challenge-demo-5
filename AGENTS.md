# hb-image-challenge

这是一个独立的新项目。遵循根设计文档 `DESIGN.md`，使用 TanStack Start SSR、Router、Query、Form，Tailwind CSS、Motion、Jotai，部署到 Cloudflare Workers。

- Worker、AI、R2、D1 均归红包作者；不要引入共享代理，也不要要求作者提供 Cloudflare API Token。
- 上传使用红包站的页面身份 JWT；判定核验使用 `X-Hb-Token`。核对签名、issuer、audience、expiry、sender、hongbao；按 sub 认人。
- 玩家次数必须通过数据库原子预占；每红包每玩家最多 10 次，客户端参数不能扩大作者设定的上限。
- 图片保存和 AI 推理并行启动，分别处理失败；不得把假分数当作真实推理结果。
- 图片默认私有；图片读取鉴权，不开放公共 R2 桶。
- 不自动重试涉及 AI 消耗或红包提交的操作；尤其不自动重试 SDK 的 unconfirmed。
- SSR 的 QueryClient 和 Jotai store 必须隔离请求。不要全局共享玩家状态。
- 相关验证：`npm run check`。判定器还需运行官方开发包的测试和检查。
- 本地和 CI 使用模拟 AI；真实 AI 和生产部署需要单独明确授权。
