# 同频

公司内部每日任务桌面软件。包含邮箱注册验证、管理员准入、个人任务隔离、老板查看全员进度、即时桌面通知和 Windows 在线升级流程。

## 本地运行

环境要求：Node.js 24+、Windows 10/11。

```powershell
npm.cmd install
npm.cmd run dev
```

`npm run dev` 会同时启动：

- API：`http://127.0.0.1:4318`
- 浏览器预览：`http://127.0.0.1:5173`
- Electron 桌面窗口

开发预览管理员：

- 邮箱：`admin@company.local`
- 密码：`Admin123!`

没有配置 Resend 或 SMTP 时，注册和找回密码会明确返回“邮件服务尚未配置”，不会伪装成发送成功，也不会在界面泄露验证码。只有自动化测试或明确设置 `DEV_EMAIL_PREVIEW=true` 的本地调试环境才会返回测试验证码。

## Resend 免费版真实邮箱验证码

本项目优先使用 Resend，SMTP 只作为本地 Express API 的可选回退。生产 Cloudflare Worker 使用以下闭环配置：

1. 在 [Resend Domains](https://resend.com/domains) 添加自己拥有的域名或子域名，并按提示配置 DNS，等待状态变为 `Verified`。
2. 创建一个只用于发信的 Resend API Key。
3. 在项目目录运行：

```powershell
npm.cmd run resend:setup
```

脚本会隐藏读取 API Key，通过内存管道一次性写入 Cloudflare Worker 的 `RESEND_API_KEY` 和 `RESEND_FROM` Secret，不会把 Key 写进文件、命令历史或安装包。随后它会检查线上 `mailMode=resend`，通过真实注册接口发验证码，并要求输入邮箱实际收到的 6 位验证码；只有线上验证通过才报告完成。

本地 Express API 调试时才将 `.env.example` 复制为 `.env`：

```dotenv
RESEND_API_KEY=re_你的密钥
RESEND_FROM=同频 <verify@notify.你的域名.com>
DEV_EMAIL_PREVIEW=false
```

`RESEND_API_KEY` 是服务端秘密，不能写入 React、Electron 配置、安装包或 Git，也不要粘贴到聊天窗口。Resend 的测试发件地址 `onboarding@resend.dev` 只能发到当前 Resend 账号自己的邮箱；要给任意 Outlook、QQ 或 Gmail 地址发信，必须先验证自己拥有的发件域名。

按 Resend 当前官方免费额度，免费版包含每天 100 封邮件和 1 个自定义域名，足够小团队试点，但不是无限额度；注册和重发接口因此设置了 60 秒冷却。

## 完整业务流程

1. 成员用邮箱、姓名和密码注册。
2. 系统发送 6 位邮箱验证码，验证码 10 分钟有效，错误 5 次后锁定。
3. 邮箱验证完成后，账号进入“待管理员批准”状态，仍不能登录。
4. 管理员允许进入后，成员才可登录。
5. 成员只能查询、创建、编辑和删除自己的任务。任务隔离由 API 强制执行，不依赖前端隐藏。
6. 管理员可以停用账号或设置“老板”角色；角色变更会撤销该账号现有刷新会话。
7. 老板可以按日期查看全员完成率和任务明细，并向指定成员或所有成员发通知。
8. 已登录且正在运行的桌面端通过 WebSocket 收到消息，并在桌面左下角显示自定义呼吸圆点；鼠标悬停后展开完整通知。

任务优先级：

- `P0 加急`：红色，必须立即处理。
- `P1 当日须完成`：浅红色，今天必须清账。
- `P2 重要推进`：黄色，重要但不需要中断当前工作。
- `P3 一般事项`：浅蓝色，按正常顺序处理。
- `已完成`：无论原优先级是什么，整条任务统一变为绿色。

成员注册时会得到一枚系统默认头像，也可以上传 PNG、JPG 或 WebP 自定义头像。管理员把成员设为老板后，所有界面立即使用老板专属头像；老板头像由系统锁定，服务端会拒绝老板自行修改。成员恢复为普通角色后，先前的自定义头像仍可继续使用。

角色边界：

| 角色 | 自己的任务 | 全员进度 | 发送通知 | 账号审批 | 设置老板 |
| --- | --- | --- | --- | --- | --- |
| 普通成员 | 可管理 | 不可见 | 不可用 | 不可用 | 不可用 |
| 老板 | 可管理 | 可查看 | 可用 | 不可用 | 不可用 |
| 管理员 | 不读取 | 不可见 | 不可用 | 可用 | 可用 |

## 验证与构建

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run dist:win
npm.cmd run dist:mac
```

macOS 的本地开发、通用安装包、签名公证和双平台更新说明见 [docs/MACOS.md](docs/MACOS.md)。

Windows 安装包输出到 `artifacts/`。桌面端使用一体式无边框标题栏，默认 Electron 菜单已移除，最小化、最大化、还原与关闭由受限 IPC 控制。当前测试覆盖：

- 注册、邮箱验证、等待审批、管理员批准、登录
- 访问令牌刷新和找回密码
- 两位成员之间的任务数据隔离
- P0/P1/P2/P3 优先级与完成状态
- 成员默认头像、自定义头像和老板头像锁定
- 服务重新打开同一持久化数据文件后仍能读取账号与任务
- 管理员设置老板
- 老板查看进度、发送通知
- 普通成员访问管理员/老板接口时被拒绝

## 生产部署必须配置的内容

### 1. 中央 API、持久化数据和邮箱

“换电脑后数据还在”的前提是每台电脑都连接同一个中央 API。正式客户端通过 `https://notify.samhubs.com` 连接 Cloudflare Worker，任务、账号、头像、联系人和消息由 Durable Object SQLite 持久化，不保存在某一台成员电脑。不要把 `workers.dev` 地址重新写回客户端；国内网络可能无法直连该公共开发域。

仓库中的 Express API 和 `docker-compose.yml` 是本地开发或私有化部署回退方案；该方案把 `/data` 挂载到具名卷 `tongpin-data`：

```powershell
docker compose up -d --build
```

只在开发机运行 `127.0.0.1:4318` 不具备跨电脑能力。当前安装包的 `electron/app-config.json` 已指向线上 Cloudflare Worker；如果改用私有化 Express API，必须部署 HTTPS、更新客户端 API 地址并为 `tongpin-data` 做定期异机备份。

复制 `.env.example` 并至少替换：

```dotenv
NODE_ENV=production
HOST=0.0.0.0
JWT_SECRET=至少32位的随机密钥
BOOTSTRAP_ADMIN_EMAIL=真实管理员邮箱
BOOTSTRAP_ADMIN_PASSWORD=高强度初始密码
RESEND_API_KEY=Resend服务端密钥
RESEND_FROM=同频 <verify@notify.your-company.com>
DEV_EMAIL_PREVIEW=false
CLIENT_ORIGINS=https://你的客户端来源
```

API 也可不用 Compose 单独启动：

```powershell
docker build -t tongpin-api .
docker run -d --name tongpin-api -p 4318:4318 --env-file .env -v tongpin-data:/data tongpin-api
```

当前数据层是带原子写入队列的单实例服务器端 JSON 存储，适合公司内部试点和单节点部署。它已经满足“同一中央服务器下换电脑重新登录仍能读取数据”，但不等于多实例数据库。若要多实例、高可用或大量并发，必须迁移到 PostgreSQL，或将 API 迁移到 Cloudflare Workers + D1/R2；不能把单文件存储包装成“企业级集群”。

### 2. 桌面客户端 API 地址

将 `electron/app-config.json` 中的 `apiUrl` 改为公司 API 的 HTTPS 地址，并将 `updateUrl` 改为安装包更新文件的 HTTPS 地址。保留 `example.com` 占位地址时，客户端会明确跳过联网检查，避免把占位配置伪装成升级故障。

### 3. 在线升级

Electron 已实现以下流程：

- 软件启动 8 秒后自动检查更新
- 发现新版本后后台自动下载
- 显示下载进度
- 下载完成后在左下角呼吸圆点中提示，鼠标悬停后显示“立即安装 / 稍后安装”
- 选择立即安装后关闭软件并执行升级
- 选择稍后安装时退出软件后自动安装

更新地址已经接入 Cloudflare R2。发布 Windows 新版本时执行：

```powershell
npm.cmd run dist:win
npm.cmd run release:verify
npm.cmd exec -- wrangler login
npm.cmd run release:upload
```

`release:upload` 会校验安装包大小和 SHA-512，先上传版本化安装包与差分
`.blockmap`，最后才更新 `latest.yml`，并通过公开更新地址复核线上文件。

正式大范围分发前仍应配置 Windows 代码签名证书。未签名安装包可以完成内部
升级测试，但会触发 SmartScreen 警告。

## 安全设计

- 密码使用 bcrypt 哈希，不保存明文。
- 邮箱和重置验证码只保存 SHA-256 摘要。
- 访问令牌 15 分钟过期，刷新令牌 30 天且每次刷新都会轮换。
- 停用账号和角色变更会撤销刷新会话。
- Electron 开启 `contextIsolation`、关闭 `nodeIntegration`、启用沙箱。
- 桌面登录状态使用 Electron `safeStorage` 加密；系统安全存储不可用时拒绝明文持久化。
- 管理员、老板和成员权限在服务端路由再次校验。
