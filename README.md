# Relay Pulse

Relay Pulse 是一个本地运行的 AI 中转站连接测试工具。它管理 OpenAI 兼容中转站配置，并通过服务端测试 `/v1/responses`、`/v1/chat/completions` 和 `/v1/models`，避免浏览器 CORS 与密钥暴露问题。

项目同时提供普通网页和 WebExtension 两种前端形态。浏览器扩展支持 Chrome、Edge、Brave、Opera 等 Chromium 浏览器及 Firefox；点击扩展图标会在新标签页打开完整管理界面。扩展仍依赖本机 Node.js 后端，避免把完整 API Key 和中转站请求放进浏览器端。

## 功能

- 中转站配置增删改查、复制、批量启停
- 从本机 CC Switch 预览并批量导入 Codex、Claude 中转站配置
- 本机号池服务：为余额充足的 OpenAI 兼容中转提供统一 Base URL 与临时 API Key，失败自动回退
- 号池使用记录：按模型、中转站、端点和时间查看请求、Token、成功率与耗时，并支持 CSV 导出
- API Key 服务端保存、接口脱敏、编辑留空保留原 Key
- Responses、Chat Completions 与自动回退模式
- 模型列表探测、默认发送 `hi` 的单连接测试
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

本机产物位于 `release/relay-pulse-<平台>-<架构>/relay-pulse-start`，Windows x64 产物位于 `release/relay-pulse-windows-x64/relay-pulse-start.exe`。Windows 版本可以在 macOS、Linux 或 Windows 上交叉构建；脚本通过当前 npm registry 下载 Windows Node.js 运行时并校验包完整性。双击或从终端运行该程序即可启动后端；同目录可放置 `.env` 覆盖配置。打包版默认将数据写入系统用户应用数据目录，而不是程序安装目录。

## 浏览器扩展

生成扩展目录和安装包：

```bash
npm run build:extension
```

启动扩展所需的本地后端：

```bash
npm run start:extension
```

构建产物位于：

- `extension/dist`：所有支持浏览器可加载的解压目录
- `extension/packages/relay-pulse-chromium.zip`：Chrome、Edge、Brave、Opera 分发包
- `extension/packages/relay-pulse-firefox.xpi`：Firefox 本地测试包

### 下载

无需本地构建时，可直接下载 Chromium 浏览器扩展安装包：[relay-pulse-chromium.zip](https://github.com/YangWenLong123/Relay-Pulse/blob/main/extension/packages/relay-pulse-chromium.zip)。下载并解压后，在 Chrome、Edge、Brave 或 Opera 的扩展管理页开启开发者模式，再选择“加载已解压的扩展程序”。

Chromium 浏览器需要在扩展管理页开启开发者模式，使用“加载已解压的扩展程序”选择 `extension/dist`。Firefox 在 `about:debugging#/runtime/this-firefox` 中选择“临时载入附加组件”，再选择 XPI 或 `manifest.json`。详细步骤见 [extension/README.md](extension/README.md)。

Firefox 稳定版不允许永久安装未签名 XPI；本地产物可临时加载，永久安装需要提交 Mozilla AMO 签名。Safari 需要通过 Xcode 的 Web Extension Converter 转换和签名，不属于可直接拖入安装的通用产物。

## 配置

根目录 `.env` 支持：

| 变量                        | 默认值                  | 说明                                          |
| --------------------------- | ----------------------- | --------------------------------------------- |
| `SERVER_PORT`               | `3100`                  | API 端口                                      |
| `SERVER_HOST`               | `127.0.0.1`             | API 监听地址；默认仅允许本机访问              |
| `CLIENT_ORIGIN`             | `http://localhost:5173` | 允许的网页前端来源，多个值使用英文逗号分隔    |
| `ALLOW_EXTENSION_ORIGINS`   | `true`                  | 是否允许格式合法的浏览器扩展来源访问本机 API  |
| `DATA_DIR`                  | `./data`                | JSON 数据目录                                 |
| `HISTORY_LIMIT`             | `1000`                  | 历史记录上限                                  |
| `POOL_USAGE_LIMIT`          | `10000`                 | 本机号池使用记录保留上限，最高 100000 条       |
| `BATCH_CONCURRENCY`         | `4`                     | 服务端批测并发数，最高 10                     |
| `API_KEY_ENCRYPTION_SECRET` | 空                      | 可选；设置后使用 AES-256-GCM 加密本地 API Key |
| `CC_SWITCH_DB_PATH`         | `~/.cc-switch/cc-switch.db` | CC Switch SQLite 数据库路径               |
| `VITE_API_BASE_URL`         | `/api`                  | 前端 API 地址，配置在 `client/.env*` 中       |

Vite 的环境变量需要放在 `client/.env` 中。开发环境默认通过 Vite 代理访问本地 API，因此通常不需要额外配置。扩展模式使用 `client/.env.extension`，默认连接 `http://127.0.0.1:3100/api`；如需纯扩展本地存储，可将 `VITE_EXTENSION_DATA_MODE` 设为 `standalone`。

CC Switch 导入由本机 Node.js 后端只读访问 SQLite 数据库。打开导入窗口后会先展示脱敏预览，并按 Base URL 与完整 API Key 判断重复项；只有确认勾选后才写入 Relay Pulse。当前支持 Codex 和 Claude 配置，Gemini 暂不支持。扩展后端模式可使用该入口；Standalone 模式无法访问电脑文件系统，点击后会提示不可用。

## 数据与安全

数据保存在：

- `data/relays.json`
- `data/test-history.json`

这些 JSON 文件会在首次启动时创建，使用临时文件原子替换并串行写入，文件权限为当前用户可读写。JSON 损坏时服务会明确报错并保留原文件，不会自动覆盖。号池使用记录仅保存在当前后端进程内存中；每次本机号池启动会重新开始记录，停止号池或关闭服务后记录会清空，不会写入数据目录。

默认情况下，API Key 因测试请求需要会以明文保存在 `data/relays.json`。本工具仅适用于可信本地环境。建议在 `.env` 设置高强度的 `API_KEY_ENCRYPTION_SECRET`；服务启动时会将已有明文 Key 自动迁移为 AES-256-GCM 密文。该密钥不会写入数据文件，必须单独安全备份；丢失或修改后原数据无法解密。列表、详情、历史和错误响应始终不会返回完整 Key。

服务默认只监听 `127.0.0.1`。扩展来源放行仅适用于这个可信本地运行模式；如需部署到公网，应关闭 `ALLOW_EXTENSION_ORIGINS`，并增加身份认证、访问控制和 HTTPS，同时启用密钥加密存储。

DNS、TCP 与 TLS 分段耗时在 Node 原生 Fetch 中无法可靠获取，因此返回 `null`；首字节耗时使用收到响应头的时间，总耗时覆盖整个测试过程。

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

## API

主要接口位于 `/api`：

- `GET/POST /relays`
- `GET/PUT/DELETE /relays/:id`
- `POST /relays/:id/test`
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

## 开源协议

本项目采用 [MIT License](LICENSE) 开源。
