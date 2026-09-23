# 工作包 04：隔离本地 Worker/DO 实跑

开工：2026-09-23（Asia/Hong_Kong）。基线：`codex/ai-continuation-20260923` @ `6d93e84`，工作树干净。目标：补 `8787` 独立运行时缺口，并以真实 workerd/SQLite DO 对已保护的任务、客户、登录和通知路径做隔离回归。

已逐行读 `scripts/verify-cloudflare.mjs`：它会注册/审批成员、改任务和客户消息、重置测试管理员密码，并把假测试成员密码写入当前工作目录的 `output/cloudflare-e2e-result.json`。**绝不能**指向生产或现有 DO，也不能从仓库根目录运行以免覆盖现有未跟踪结果。它不覆盖 `/api/ai/*`，故不能冒充 AI 端到端测试。

允许范围：只新增本地专用 Wrangler 配置和本日志；不用生产 account ID/域名/R2 名，禁 `--remote`/公网 tunnel。用 `mktemp -d` 为 DO/R2 持久化及脚本运行分别建临时目录，强制 `127.0.0.1:8787`，只关闭自己启动的进程，不清理用户目录。现有 `cloudflare/wrangler.jsonc` 和生产绑定不改。计划完成后记录命令、运行结果和临时产物位置；若端口占用立即停，不杀其他进程。

## 结果

- 新增 `cloudflare/wrangler.local-acceptance.jsonc`：无生产 account ID、生产 R2 名、线上允许域名或定时触发；`TONGPIN_CORE` 是本地 SQLite DO、`RELEASES` 是本地虚拟 R2。`JWT_SECRET` 仅以本地假值传给 Wrangler CLI，不写入仓库。
- 启动：`wrangler dev --config cloudflare/wrangler.local-acceptance.jsonc --local --ip 127.0.0.1 --port 8787 --persist-to <mktemp-state> --var JWT_SECRET:<local-test-value>`。Wrangler 4.129.0 明示所有绑定为 `local`；健康检查返回 `storage=durable-object-sqlite`、`realtime=websocket`、`mailMode=preview`。
- 从另一独立 `mktemp` 运行目录执行 `TONGPIN_CLOUDFLARE_TEST_URL=http://127.0.0.1:8787 node /Users/sam/Documents/ChatGPT/个人/tongpin-workbench-git/scripts/verify-cloudflare.mjs`：退出码 0，`ok=true`，15 项整站检查通过（任务、客户临时消息、登录/审批、通知 WebSocket 等）。测试输出仅在临时目录 `output/cloudflare-e2e-result.json`，含**假测试凭证**，不复制进仓库或聊天。
- 已向自己启动的 Wrangler 进程发送中断并正常退出；`lsof -nP -iTCP:8787 -sTCP:LISTEN` 无监听。没有使用生产 Cloudflare 端点/绑定，也未触碰仓库已有 `output/cloudflare-e2e-result.json`。
- 此脚本没有 `/api/ai/*`。AI 请求体边界另有 [工作包 02](2026-09-23-02-worker-stream-body.md) 的真 workerd+SQLite DO 17/17；**不能**把整站 15 项视为 AI 主链路验收。UI/真实供应商/多组织与旧 Windows 仍待测。

下一步：以最小兼容方案把 AI 正文/富内容的版本化元数据纳入现有事件，不新增旧客户端会拒绝的 SSE event type；再验证事件重放、存储和单次账本。
