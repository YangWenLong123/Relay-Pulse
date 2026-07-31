# Relay Pulse 浏览器扩展

扩展默认以“扩展 UI + 本机后端”模式运行，配置、API Key、CC Switch 导入、号池服务和中转站测试都由本机 Node.js 后端处理。使用扩展前先在项目根目录运行：

```bash
npm run start:extension
```

默认后端地址为 `http://127.0.0.1:3100`。

## 构建

```bash
npm run build:extension
```

构建产物：

- `extension/dist`：Chrome、Edge、Brave、Opera 与 Firefox 可加载的解压目录
- `extension/packages/relay-pulse-chromium.zip`：Chromium 分发包，解压后加载
- `extension/packages/relay-pulse-firefox.xpi`：Firefox 开发测试包

## Chromium 浏览器

1. 打开扩展管理页，例如 Chrome 使用 `chrome://extensions`，Edge 使用 `edge://extensions`。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择 `extension/dist`。
4. 固定 Relay Pulse 图标。点击图标会在新标签页打开管理工具。

Chromium 浏览器不会直接安装普通 ZIP 文件。请先解压 ZIP，或直接选择 `extension/dist`。

## Firefox

1. 打开 `about:debugging#/runtime/this-firefox`。
2. 点击“临时载入附加组件”。
3. 选择 `extension/packages/relay-pulse-firefox.xpi` 或 `extension/dist/manifest.json`。
4. 点击工具栏图标，在新标签页打开管理工具。

Firefox 稳定版的永久安装要求 Mozilla 签名。当前 XPI 用于本地开发和临时加载；提交 AMO 签名后才能作为永久扩展安装。

## 自定义后端地址

扩展构建默认读取 `client/.env.extension`。需要更换端口时，在构建命令前覆盖地址：

```bash
VITE_API_BASE_URL=http://127.0.0.1:4100/api npm run build:extension
```

同时确保根目录 `.env` 中的 `SERVER_PORT` 与该端口一致。扩展清单允许访问本机任意 HTTP 端口，不允许访问远程 API；所有中转站请求继续由后端发出。

## Standalone 模式

如需构建不依赖本机后端的纯扩展版本，可设置：

```bash
VITE_EXTENSION_DATA_MODE=standalone npm run build:extension
```

Standalone 模式使用浏览器扩展本地存储，不能读取 CC Switch 本地数据库，也不能启动本机号池服务。
