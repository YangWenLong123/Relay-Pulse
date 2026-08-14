import { execFileSync } from 'node:child_process';
import { access, copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(projectRoot, 'extension/source');
const distDir = path.join(projectRoot, 'extension/dist');
const packagesDir = path.join(projectRoot, 'extension/packages');
const chromiumArchive = path.join(packagesDir, 'relay-pulse-chromium.zip');
const firefoxArchive = path.join(packagesDir, 'relay-pulse-firefox.xpi');
const extensionEnv = await readFile(path.join(projectRoot, 'client/.env.extension'), 'utf8').catch(() => '');
const configuredExtensionDataMode =
  process.env.VITE_EXTENSION_DATA_MODE ??
  /^VITE_EXTENSION_DATA_MODE\s*=\s*(\w+)\s*$/im.exec(extensionEnv)?.[1];
const configuredApiBaseUrl =
  process.env.VITE_API_BASE_URL ??
  /^VITE_API_BASE_URL\s*=\s*(.+?)\s*$/im.exec(extensionEnv)?.[1];
const extensionDataMode = configuredExtensionDataMode?.trim().toLowerCase() === 'standalone'
  ? 'standalone'
  : 'backend';
const manifestPath = path.join(distDir, 'manifest.json');
const launcherPath = path.join(distDir, 'launcher.html');
const nativeBackendPath = path.join(distDir, 'native-backend.js');

function unquoteEnvValue(value) {
  const trimmed = value?.trim().replace(/\s+#.*$/, '').trim();
  if (
    trimmed &&
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function normalizeLauncherApiUrl(value) {
  const configuredValue = unquoteEnvValue(value) || 'http://127.0.0.1:3100/api';
  let url;
  try {
    url = new URL(configuredValue);
  } catch {
    throw new Error('VITE_API_BASE_URL 必须是 http://127.0.0.1:<端口>/api');
  }

  const port = Number(url.port);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    url.username ||
    url.password ||
    url.pathname !== '/api' ||
    url.search ||
    url.hash
  ) {
    throw new Error('VITE_API_BASE_URL 必须是 http://127.0.0.1:<端口>/api');
  }

  return url.toString().replace(/\/$/, '');
}

const launcherApiUrl = extensionDataMode === 'backend'
  ? normalizeLauncherApiUrl(configuredApiBaseUrl)
  : '';

await access(path.join(distDir, 'index.html'));
await cp(sourceDir, distDir, { recursive: true, force: true });

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (manifest.manifest_version !== 3 || manifest.action?.default_popup !== 'launcher.html') {
  throw new Error('扩展 Manifest 缺少 Manifest V3 或点击启动页配置');
}
if (!manifest.permissions?.includes('storage')) {
  throw new Error('扩展 Manifest 缺少 storage 权限');
}
if (extensionDataMode === 'standalone') {
  manifest.permissions = manifest.permissions.filter((permission) => permission !== 'nativeMessaging');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
if (extensionDataMode === 'backend' && !manifest.permissions?.includes('nativeMessaging')) {
  throw new Error('扩展后端模式缺少 nativeMessaging 权限');
}
if (extensionDataMode === 'standalone' && manifest.permissions?.includes('nativeMessaging')) {
  throw new Error('扩展 standalone 模式不应请求 nativeMessaging 权限');
}
if (manifest.background) {
  throw new Error('扩展不应依赖后台 Worker 启动本机服务，以保持 Firefox 109 兼容');
}
for (const permission of ['http://*/*', 'https://*/*']) {
  if (!manifest.host_permissions?.includes(permission)) {
    throw new Error(`扩展 Manifest 缺少中转站访问权限：${permission}`);
  }
}

const requiredFiles = [
  'index.html',
  'launcher.html',
  'launcher.js',
  'theme-bootstrap.js',
  'icons/icon-16.png',
  'icons/icon-32.png',
  'icons/icon-48.png',
  'icons/icon-128.png'
];
if (extensionDataMode === 'backend') requiredFiles.push('native-backend.js');

let launcherHtml = await readFile(launcherPath, 'utf8');
const modeMeta = /(<meta\s+name=["']relay-pulse-data-mode["']\s+content=["'])[^"']*(["']\s*\/?>)/i;
if (!modeMeta.test(launcherHtml)) {
  throw new Error('扩展启动页缺少数据模式标记');
}
launcherHtml = launcherHtml.replace(modeMeta, `$1${extensionDataMode}$2`);

const apiUrlMeta = /(<meta\s+name=["']relay-pulse-api-url["']\s+content=["'])[^"']*(["']\s*\/?>)/i;
if (!apiUrlMeta.test(launcherHtml)) {
  throw new Error('扩展启动页缺少本机 API 地址标记');
}
launcherHtml = launcherHtml.replace(apiUrlMeta, `$1${launcherApiUrl}$2`);

const nativeBackendScript = /\s*<script\s+src=["']native-backend\.js["']\s*><\/script>/i;
if (extensionDataMode === 'backend') {
  if (!nativeBackendScript.test(launcherHtml)) {
    throw new Error('扩展启动页缺少 Native Messaging 本机服务启动器');
  }
} else {
  if (!nativeBackendScript.test(launcherHtml)) {
    throw new Error('扩展 standalone 启动页缺少可移除的 Native Messaging 启动器');
  }
  launcherHtml = launcherHtml.replace(nativeBackendScript, '');
  await rm(nativeBackendPath, { force: true });
}
await writeFile(launcherPath, launcherHtml);

await Promise.all(requiredFiles.map((file) => access(path.join(distDir, file))));

const indexHtml = await readFile(path.join(distDir, 'index.html'), 'utf8');
if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(indexHtml)) {
  throw new Error('扩展页面包含被 Manifest V3 CSP 禁止的内联脚本');
}
if (extensionDataMode === 'standalone' && /本机服务/.test(launcherHtml)) {
  throw new Error('扩展 standalone 启动页不应显示本机服务文案');
}
if (extensionDataMode === 'standalone' && /native-backend\.js/i.test(launcherHtml)) {
  throw new Error('扩展 standalone 启动页不应加载 Native Messaging 启动器');
}

const assetFiles = (await readdir(path.join(distDir, 'assets'))).filter((file) => file.endsWith('.js'));
const bundledJavaScript = (await Promise.all(assetFiles.map((file) => readFile(path.join(distDir, 'assets', file), 'utf8')))).join('\n');
if (extensionDataMode === 'standalone' && !bundledJavaScript.includes('relay-pulse-state-v1')) {
  throw new Error('扩展构建未包含浏览器本地存储服务');
}
const hasLocalBackendApi = /https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/api/.test(bundledJavaScript);
if (extensionDataMode === 'backend' && !hasLocalBackendApi) {
  throw new Error('扩展后端模式缺少本机后端 API 地址');
}

await mkdir(packagesDir, { recursive: true });
await Promise.all([rm(chromiumArchive, { force: true }), rm(firefoxArchive, { force: true })]);
execFileSync('zip', ['-q', '-r', chromiumArchive, '.'], { cwd: distDir });
await copyFile(chromiumArchive, firefoxArchive);

console.log(`扩展目录: ${distDir}`);
console.log(`Chromium 包: ${chromiumArchive}`);
console.log(`Firefox 包: ${firefoxArchive}`);
