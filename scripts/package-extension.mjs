import { execFileSync } from 'node:child_process';
import { access, copyFile, cp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
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
const extensionDataMode = configuredExtensionDataMode?.trim().toLowerCase() === 'standalone'
  ? 'standalone'
  : 'backend';

await access(path.join(distDir, 'index.html'));
await cp(sourceDir, distDir, { recursive: true, force: true });

const manifest = JSON.parse(await readFile(path.join(distDir, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3 || manifest.action?.default_popup !== 'launcher.html') {
  throw new Error('扩展 Manifest 缺少 Manifest V3 或点击启动页配置');
}
if (!manifest.permissions?.includes('storage')) {
  throw new Error('扩展 Manifest 缺少 storage 权限');
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
await Promise.all(requiredFiles.map((file) => access(path.join(distDir, file))));

const indexHtml = await readFile(path.join(distDir, 'index.html'), 'utf8');
if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(indexHtml)) {
  throw new Error('扩展页面包含被 Manifest V3 CSP 禁止的内联脚本');
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
if (extensionDataMode === 'standalone' && hasLocalBackendApi) {
  throw new Error('扩展 standalone 模式不应包含本机后端 API 地址');
}

await mkdir(packagesDir, { recursive: true });
await Promise.all([rm(chromiumArchive, { force: true }), rm(firefoxArchive, { force: true })]);
execFileSync('zip', ['-q', '-r', chromiumArchive, '.'], { cwd: distDir });
await copyFile(chromiumArchive, firefoxArchive);

console.log(`扩展目录: ${distDir}`);
console.log(`Chromium 包: ${chromiumArchive}`);
console.log(`Firefox 包: ${firefoxArchive}`);
