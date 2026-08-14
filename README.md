# Relay Pulse

Relay Pulse 是一个本地运行的 AI 中转站连接测试工具。它管理 OpenAI 兼容中转站配置，并通过服务端测试 `/v1/responses`、`/v1/chat/completions` 和 `/v1/models`，避免浏览器 CORS 与密钥暴露问题。

项目同时提供普通网页和 WebExtension 两种前端形态。浏览器扩展支持 Chrome、Edge、Brave、Opera 等 Chromium 浏览器及 Firefox；点击扩展图标会在新标签页打开完整管理界面。扩展仍依赖本机 Node.js 后端，避免把完整 API Key 和中转站请求放进浏览器端。

## 功能

- 中转站配置增删改查、复制、批量启停
- 从本机 CC Switch 预览并批量导入 Codex、Claude 中转站配置
- 本机号池服务：为余额充足的 OpenAI 兼容中转提供统一 Base URL 与临时 API Key，失败自动回退
- 号池使用记录：按模型、中转站、端点和时间查看请求、Token、成功率与耗时，并支持 CSV 导出
- GPT/Codex 账号管理：导入 CPA、sub2api、Codex-Manager 与 Codex auth.json，展示额度、同步可用模型、启动仅本机可访问的 Responses 代理，并通过 Deep Link 导入 CC Switch
- GPT 账号调用明细：持久化记录账号、模型、重试次数、Token、耗时和脱敏错误摘要
- API Key 服务端保存、接口脱敏、编辑留空保留原 Key
- Responses、Chat Completions 与自动回退模式
- 模型列表探测、默认发送 `hi` 的单连接测试
- 中转站纯度检测：自动探测全部可用模型，并实时展示模型声明、协议形状、Token 计数、能力透传与重复稳定性探针
- 固定并发批量测试、停止任务、重试失败项
- 测试历史筛选、单条删除与清空，默认最多保留 1000 条
- 浅色、深色、跟随系统主题及响应式界面
- JSON 串行原子写入，无数据库依赖

## 界面预览

### 批量测试

![批量测试预览](image-1.png)

### 单个测试

![单个测试预览](image.png)

## 环境要求

- Node.js 18.17 或更高版本
- npm 9 或更高版本
- 使用 CC Switch 导入时需要系统已安装 `sqlite3` 命令

## 安装与运行

```bash
npm install
cp .env.example .env
npm run dev
```

- 前端：http://127.0.0.1:5173
- 后端：http://localhost:3100
- 健康检查：http://localhost:3100/api/health

也可以分别运行：

```bash
npm run dev:server
npm run dev:client
```

## 构建与检查

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

生产构建后可执行 `npm run start -w server` 启动 API；`client/dist` 可由任意静态服务器托管，并将 `/api` 反向代理到后端。

生成无需安装 Node.js 的本机后端可执行程序：

```bash
npm run package:server
npm run package:server:windows
```

本机产物位于 `release/relay-pulse-<平台>-<架构>/relay-pulse-start`，Windows x64 产物位于 `release/relay-pulse-windows-x64/relay-pulse-start.exe`。Windows 版本可以在 macOS、Linux 或 Windows 上交叉构建；脚本通过当前 npm registry 下载 Windows Node.js 运行时并校验包完整性。macOS arm64 包还会生成同目录的 `relay-pulse-native-host`，供浏览器扩展自动启动本机后端；Windows 当前仍需手动启动 `relay-pulse-start.exe`。打包目录会同时生成 `.env` 和 `.env.example`：`.env` 自动带入构建环境中的非敏感运行时配置（包括无账号密码的 `CODEX_UPSTREAM_PROXY_URL`），`.env.example` 可作为手动配置模板；加密密钥不会自动复制。双击或从终端运行 `relay-pulse-start` 仍可手动启动后端；打包版默认将数据写入系统用户应用数据目录，而不是程序安装目录；打包产物不会带入本地中转站、CC Switch 导入结果或 GPT 账号数据。

## 浏览器扩展

生成扩展目录和安装包：

```bash
npm run build:extension
```

开发时仍可手动启动扩展所需的本地后端：

```bash
npm run start:extension
```

macOS arm64 打包版可通过 Native Messaging 在扩展打开时自动启动或复用后端。先构建配套后端，然后为实际使用的浏览器登记一次 Host：

```bash
npm run package:server
npm run install:native-host -- --browser chrome
```

也可以进入打包目录直接登记，无需另行安装 Node.js：

```bash
cd release/relay-pulse-darwin-arm64
./relay-pulse-native-host --install --browser chrome
```

同目录的 `install-native-host.command` 可在 Finder 双击，或在终端执行；默认登记 Chrome，后接的参数会转给安装器：

```bash
./install-native-host.command --browser edge
```

安装后扩展会连接固定名称 `com.relaypulse.host`，由它检查 `http://127.0.0.1:<端口>/api/health`；后端已在运行时直接复用，未运行时由同目录的 `relay-pulse-start` 启动。首次自动启动会在该目录 `.env` 写入随机的扩展访问令牌，令牌不会进入扩展包。以后无需再运行 `npm run start:extension`。Native Messaging 是浏览器为本机进程提供的受控通道，浏览器扩展不能仅凭 ZIP 自行启动任意程序，因此这个登记步骤不可省略。

Host manifest 仅允许扩展固定 Chromium ID `nplnfohmiahjljnemfcjklclaoecogpi` 连接，后端仍仅监听本机回环地址。默认登记 Chrome；Edge、Brave、Chromium、Opera 或 Firefox 可改用相应名称，或一次登记全部：

```bash
npm run install:native-host -- --all-browsers
```

移动打包目录或更新 `relay-pulse-native-host` 后，重新执行 `--repair` 更新绝对路径。移除登记而不删除后端文件可使用 `--uninstall`：

```bash
./relay-pulse-native-host --repair --browser chrome
./relay-pulse-native-host --uninstall --browser chrome
```

构建产物位于：

- `extension/dist`：所有支持浏览器可加载的解压目录
- `extension/packages/relay-pulse-chromium.zip`：Chrome、Edge、Brave、Opera 分发包
- `extension/packages/relay-pulse-firefox.xpi`：Firefox 本地测试包

### 下载

无需本地构建时，可直接下载 Chromium 浏览器扩展安装包：[relay-pulse-chromium.zip](https://github.com/YangWenLong123/Relay-Pulse/blob/main/extension/packages/relay-pulse-chromium.zip)。下载并解压后，在 Chrome、Edge、Brave 或 Opera 的扩展管理页开启开发者模式，再选择“加载已解压的扩展程序”。

Chromium 浏览器需要在扩展管理页开启开发者模式，使用“加载已解压的扩展程序”选择 `extension/dist`。Firefox 在 `about:debugging#/runtime/this-firefox` 中选择“临时载入附加组件”，再选择 XPI 或 `manifest.json`。使用自动启动时，先完成上面的 Native Messaging Host 登记并重新加载扩展。详细步骤见 [extension/README.md](extension/README.md)。

Firefox 稳定版不允许永久安装未签名 XPI；本地产物可临时加载，永久安装需要提交 Mozilla AMO 签名。Safari 需要通过 Xcode 的 Web Extension Converter 转换和签名，不属于可直接拖入安装的通用产物。

## 配置

根目录 `.env` 支持：

| 变量                        | 默认值                  | 说明                                          |
| --------------------------- | ----------------------- | --------------------------------------------- |
| `SERVER_PORT`               | `3100`                  | API 端口                                      |
| `SERVER_HOST`               | `127.0.0.1`             | API 监听地址；默认仅允许本机访问              |
| `CLIENT_ORIGIN`             | `http://localhost:5173` | 允许的网页前端来源，多个值使用英文逗号分隔    |
| `ALLOW_EXTENSION_ORIGINS`   | `true`                  | 是否允许格式合法的浏览器扩展来源访问本机 API  |
| `EXTENSION_ACCESS_TOKEN`    | 自动生成                | Native Messaging 自动启动时生成的本机扩展访问令牌；不要共享 |
| `DATA_DIR`                  | `./data`                | JSON 数据目录                                 |
| `HISTORY_LIMIT`             | `1000`                  | 历史记录上限                                  |
| `POOL_USAGE_LIMIT`          | `10000`                 | 本机号池使用记录保留上限，最高 100000 条       |
| `CODEX_USAGE_LIMIT`         | `10000`                 | GPT 账号调用明细保留上限，最高 100000 条       |
| `BATCH_CONCURRENCY`         | `4`                     | 服务端批测并发数，最高 10                     |
| `API_KEY_ENCRYPTION_SECRET` | 空                      | 可选；使用 AES-256-GCM 加密本地中转 API Key；也作为未单独配置 session 密钥时的后备密钥 |
| `ACCOUNT_SESSION_ENCRYPTION_SECRET` | 空              | 可选；使用 AES-256-GCM 加密本地 GPT/Codex session；优先于 `API_KEY_ENCRYPTION_SECRET` |
| `CODEX_UPSTREAM_BASE_URL`   | `https://chatgpt.com/backend-api/codex` | GPT/Codex session 的上游基础地址；服务会追加 `/responses` 或 `/models` |
| `CODEX_UPSTREAM_PROXY_URL`  | 空                      | 可选；GPT/Codex 上游专用 HTTP(S) 代理，例如 `http://127.0.0.1:7890`；同步模型和本机代理请求都会走该代理 |
| `CODEX_CLIENT_VERSION`      | `0.145.0`               | 模型同步请求发送的 Codex 客户端版本；上游升级后可按本机 Codex CLI 版本覆盖 |
| `CC_SWITCH_DB_PATH`         | `~/.cc-switch/cc-switch.db` | CC Switch SQLite 数据库路径               |
| `VITE_API_BASE_URL`         | `/api`                  | 前端 API 地址，配置在 `client/.env*` 中       |

Vite 的环境变量需要放在 `client/.env` 中。开发环境默认通过 Vite 代理访问本地 API，因此通常不需要额外配置。扩展模式使用 `client/.env.extension`，默认连接 `http://127.0.0.1:3100/api`；如需纯扩展本地存储，可将 `VITE_EXTENSION_DATA_MODE` 设为 `standalone`。

CC Switch 导入由本机 Node.js 后端只读访问 SQLite 数据库。打开导入窗口后会先展示脱敏预览，并按 Base URL 与完整 API Key 判断重复项；只有确认勾选后才写入 Relay Pulse。当前支持 Codex 和 Claude 配置，Gemini 暂不支持。扩展后端模式可使用该入口；Standalone 模式无法访问电脑文件系统，点击后会提示不可用。

## 数据与安全

数据保存在：

- `data/relays.json`
- `data/test-history.json`
- `data/codex-accounts.json`
- `data/codex-usage.json`

这些 JSON 文件会在首次启动时创建，使用临时文件原子替换并串行写入，文件权限为当前用户可读写。JSON 损坏时服务会明确报错并保留原文件，不会自动覆盖。号池使用记录仅保存在当前后端进程内存中；每次本机号池启动会重新开始记录，停止号池或关闭服务后记录会清空，不会写入数据目录。GPT 账号调用明细保存在 `data/codex-usage.json`，并按 `CODEX_USAGE_LIMIT` 自动裁剪。

默认情况下，API Key 因测试请求需要会以明文保存在 `data/relays.json`。GPT/Codex session 保存在 `data/codex-accounts.json`，并且列表与 API 响应不会返回 session、访问令牌或完整账号 ID。本工具仅适用于可信本地环境。建议在 `.env` 设置高强度的 `API_KEY_ENCRYPTION_SECRET`，并为账号 session 设置独立的 `ACCOUNT_SESSION_ENCRYPTION_SECRET`；服务启动时会将已有明文内容自动迁移为 AES-256-GCM 密文。若未设置后者，会回退使用前者。密钥不会写入数据文件，必须单独安全备份；丢失或修改后对应数据无法解密。

服务默认只监听 `127.0.0.1`。扩展来源放行仅适用于这个可信本地运行模式；如需部署到公网，应关闭 `ALLOW_EXTENSION_ORIGINS`，并增加身份认证、访问控制和 HTTPS，同时启用密钥加密存储。

DNS、TCP 与 TLS 分段耗时在 Node 原生 Fetch 中无法可靠获取，因此返回 `null`；首字节耗时使用收到响应头的时间，总耗时覆盖整个测试过程。

## 纯度检测

“纯度检测”会在选择中转站后自动探测并列出全部可用模型，再使用带随机标记的多轮黑盒探针，分别检查返回模型声明、协议字段、Token 计数自洽性、工具调用透传和重复请求稳定性。探针进度、请求数、Token 和已完成结果会在检测期间实时更新。标准模式比快速模式采集更多交叉证据，也会产生更多上游请求和 Token 消耗。检测结果只在当前页面展示，不写入测试历史，也不会包含完整 API Key 或原始上游响应。

黑盒检测无法证明中转站的内部路由，也无法排除针对探针的选择性放行。页面中的结论表示本轮观测置信度，不是官方来源认证；余额不足、鉴权失败、模型不可用或首个请求无法完成时会显示“无法判断”，而不是生成误导性的低分。

## 本机号池

在管理页点击“号池服务”，选择端口后启动。服务只监听 `127.0.0.1`，启动时会生成一次性 API Key，并返回类似 `http://127.0.0.1:58000` 的 Base URL；关闭服务或重启应用后该 Key 失效，运行中可通过“轮换 Key”生成新 Key。

号池只纳入同时满足以下条件的中转站：已启用、余额查询已启用、最近一次余额查询成功且余额大于 0。OpenAI 号池支持 `/v1/chat/completions`、`/v1/responses` 与 `/v1/models`，Anthropic 号池支持 `/v1/messages`；两者都提供 `/v1/usage` 供本机客户端查询当前总余额。推理请求支持顺序轮询与随机轮询，运行中切换会对新请求立即生效；网络错误、超时、服务端错误或额度/限流错误会继续尝试其余中转。余额刷新确认小于等于 0 的中转站会从后续候选中排除，全部已跟踪余额确认耗尽后返回 OpenAI 兼容的 `429` 和 `pool_exhausted` 错误。

服务启动后点击“导入 CC Switch”会生成 `ccswitch://v1/import` Deep Link，由 CC Switch 自己展示并确认 Provider 导入。配置包含本机号池端点、临时 API Key、当前模型和 `/v1/usage` 用量脚本，不再由该按钮直接修改 CC Switch 数据库。停止服务或轮换 Key 后，CC Switch 中原有配置的临时 Key 会失效，需要重新导入。

```bash
curl http://127.0.0.1:58000/v1/chat/completions \
  -H 'Authorization: Bearer rp_...' \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-5.6","messages":[{"role":"user","content":"hi"}]}'
```

调用明细会记录实际响应中转、模型、端点、尝试次数、Token、耗时和错误摘要；不会记录本机号池 API Key 或上游密钥。使用记录仅在当前本机号池启动期间可用，停止号池或关闭后端服务后会清空。

## GPT/Codex 账号代理

在“GPT 账号”页选择一个或多个 JSON 文件导入。支持 CPA 单账号 session、sub2api 的 `accounts[].credentials` 数据包、Codex-Manager 账号数组导出，以及 Codex CLI/Codex-Manager 的 `auth.json`。导入时会统一转换为本地 session；每个账号必须含有 `access_token`，账号 ID 使用 `chatgpt_account_id`、`account_id`，或从 JWT 声明中读取。`email`、`name`、`plan_type` 等字段用于列表展示。单次最多导入 200 个账号，同一账号再次导入会更新本地 session，而不会新建重复账号。请仅导入你有权使用的账号 session，并妥善保管原始文件。

导入后可按账号或批量“同步模型”。服务会使用该账号 session 从 `CODEX_UPSTREAM_BASE_URL` 的 `/models` 上游接口获取模型列表；模型同步失败会保留脱敏错误信息。点击“刷新额度”后，列表会显示短周期和长周期额度的剩余百分比及更新时间，详情弹窗继续展示重置时间、套餐和积分信息。如本机无法直连 ChatGPT，请在根目录 `.env` 配置 `CODEX_UPSTREAM_PROXY_URL=http://127.0.0.1:7890`（端口请按你的代理客户端 HTTP 代理端口调整）后重启后端；模型同步、额度刷新和本机 Responses 代理都会使用该通道。启动服务时可选择账号、端口（`0` 表示由系统分配）和轮询策略。服务只监听 `127.0.0.1`，启动后生成临时 `rp_codex_...` API Key；停止服务、重启后端或轮换 Key 后，旧 Key 会立即失效。

本机代理仅支持 OpenAI Responses 协议，支持普通响应和 SSE 流式响应：

| 方法 | 路径 | 用途 |
| ---- | ---- | ---- |
| `POST` | `/v1/responses` | 转发 Responses 请求至选中的 GPT/Codex 账号 |
| `GET` | `/v1/models` | 返回已同步模型的 OpenAI 兼容列表 |
| `GET` | `/v1/usage` | 返回当前可用账号数，供 CC Switch 用量脚本展示 |

为便于本机客户端接入，`/responses`、`/models` 和 `/usage` 也可省略 `/v1` 前缀。请求可使用 `Authorization: Bearer <临时 Key>` 或 `X-API-Key: <临时 Key>` 鉴权；不支持 `/v1/chat/completions`。代理会在启用且未过期的已选账号之间按顺序轮询或随机路由。连接错误、上游鉴权失败、限流和 5xx 错误会尝试下一个兼容账号；请求的模型已同步时，只会选择声明支持该模型的账号。

```bash
curl http://127.0.0.1:58000/v1/responses \
  -H 'Authorization: Bearer rp_codex_...' \
  -H 'Content-Type: application/json' \
  -d '{"model":"<已同步模型>","input":"hi"}'
```

“调用明细”会持久化记录账号标签、模型、状态、HTTP 状态、尝试次数、首字节/总耗时和可识别的 Token 数；不会保存请求内容、响应正文、session、临时 API Key 或上游凭证。可在界面中按账号、模型和结果筛选或清空记录。

### 导入 CC Switch

GPT 账号服务运行后，点击“导入 CC Switch”会打开 `ccswitch://v1/import` Deep Link。Relay Pulse 会提供 `codex` Provider、`<本机 Base URL>/v1`、当前临时 API Key、首个已同步模型，以及访问 `/v1/usage` 的用量脚本；CC Switch 自己展示并确认导入，Relay Pulse 不会通过该按钮直接写入 CC Switch 数据库。`/v1/usage` 的 `remaining` 是当前可用账号数，单位为 `accounts`，不是账户余额或 Token 配额。服务停止、后端重启或 Key 轮换后，需要在 CC Switch 中重新导入新配置。

## API

主要接口位于 `/api`：

- `GET/POST /relays`
- `GET/PUT/DELETE /relays/:id`
- `POST /relays/:id/test`
- `POST /relays/:id/purity-test`
- `POST /relays/:id/purity-test/stream`（NDJSON 实时进度）
- `DELETE /relays/:id/test`（取消执行中的测试）
- `GET /relays/:id/models`
- `POST /relays/batch-test`
- `PATCH /relays/batch`
- `PATCH /relays/order`
- `GET/POST /import/cc-switch`
- `POST /models/discover`
- `GET/DELETE /test-history`
- `DELETE /test-history/:id`
- `GET /pool`
- `POST /pool/start`、`POST /pool/stop`、`POST /pool/refresh`、`POST /pool/strategy`
- `POST /pool/key/rotate`
- `GET /pool/usage`、`GET /pool/usage/export`
- `GET /codex-accounts`
- `POST /codex-accounts/import`、`PATCH/DELETE /codex-accounts/:id`
- `POST /codex-accounts/:id/models`、`POST /codex-accounts/models`
- `POST /codex-accounts/:id/usage`（刷新套餐信息与额度窗口）
- `GET /codex-proxy`
- `POST /codex-proxy/start`、`POST /codex-proxy/stop`、`POST /codex-proxy/key/rotate`
- `GET/DELETE /codex-proxy/usage`

## 开源协议

本项目采用 [MIT License](LICENSE) 开源。
