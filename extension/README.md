# Relay Pulse 浏览器扩展

扩展默认以“扩展 UI + 本机后端”模式运行，配置、API Key、CC Switch 导入、号池服务和中转站测试都由本机后端处理。开发环境可在项目根目录手动运行：

```bash
npm run start:extension
```

默认后端地址为 `http://127.0.0.1:3100`。

macOS arm64 的打包版不需要每次手动启动后端。`npm run package:server` 会在 `relay-pulse-start` 同目录生成 `relay-pulse-native-host`；为浏览器登记一次后，扩展会自动检查、启动或复用本机后端：

```bash
npm run package:server
npm run install:native-host -- --browser chrome
```

只有打包目录时，可直接执行：

```bash
cd release/relay-pulse-darwin-arm64
./relay-pulse-native-host --install --browser chrome
```

打包目录也包含可双击的 `install-native-host.command`；它默认登记 Chrome，并可在终端附加浏览器参数，例如 `./install-native-host.command --browser edge`。

默认登记 Google Chrome。可将 `chrome` 换成 `edge`、`brave`、`chromium`、`opera` 或 `firefox`，或使用 `--all-browsers`。安装器向当前用户的浏览器 Native Messaging 目录写入 `com.relaypulse.host.json`，其中只允许固定扩展 ID 连接；它不会开放任意命令、端口或环境变量给扩展。

Native Messaging manifest 使用后端目录的绝对路径。因此移动打包目录或替换 Host 文件后，需要重新登记：

```bash
./relay-pulse-native-host --repair --browser chrome
./relay-pulse-native-host --uninstall --browser chrome
```

浏览器扩展无法直接启动任意本机程序；首次登记是浏览器安全模型要求。首次自动启动会在后端目录 `.env` 写入随机扩展访问令牌，令牌不会进入扩展包。登记完成后重新加载扩展，之后不必再运行 `npm run start:extension`。当前自动启动仅提供 macOS arm64 包；Windows 版本仍需手动启动后端。

使用 `npm run package:server` 生成配套后端时，`relay-pulse-start` 同目录会生成 `.env` 和 `.env.example`。构建机器 `.env` 中不含凭据的 `CODEX_UPSTREAM_PROXY_URL` 会自动带入 `.env`；若需要凭据、加密密钥或其他敏感配置，请仅在该目录的 `.env` 中手动填写后再启动服务。

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
