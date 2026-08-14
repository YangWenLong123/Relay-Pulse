import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHROMIUM_EXTENSION_ID,
  FIREFOX_EXTENSION_ID,
  NATIVE_MESSAGING_HOST_NAME,
  nativeHostExecutableName
} from './native-messaging-host.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const NATIVE_HOST_INSTALL_COMMAND_NAME = 'install-native-host.command';

export const MACOS_NATIVE_MESSAGING_BROWSERS = {
  chrome: {
    label: 'Google Chrome',
    manifestType: 'chromium',
    directory: ['Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts']
  },
  chromium: {
    label: 'Chromium',
    manifestType: 'chromium',
    directory: ['Library', 'Application Support', 'Chromium', 'NativeMessagingHosts']
  },
  edge: {
    label: 'Microsoft Edge',
    manifestType: 'chromium',
    directory: ['Library', 'Application Support', 'Microsoft Edge', 'NativeMessagingHosts']
  },
  brave: {
    label: 'Brave',
    manifestType: 'chromium',
    directory: ['Library', 'Application Support', 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts']
  },
  opera: {
    label: 'Opera',
    manifestType: 'chromium',
    directory: ['Library', 'Application Support', 'com.operasoftware.Opera', 'NativeMessagingHosts']
  },
  firefox: {
    label: 'Firefox',
    manifestType: 'firefox',
    directory: ['Library', 'Application Support', 'Mozilla', 'NativeMessagingHosts']
  }
};

function supportedBrowserNames() {
  return Object.keys(MACOS_NATIVE_MESSAGING_BROWSERS);
}

function pathFromOption(value, optionName) {
  if (!value) throw new Error(`${optionName} 需要一个路径参数`);
  return path.resolve(value);
}

function splitBrowserNames(value) {
  return value.split(',').map((name) => name.trim().toLowerCase()).filter(Boolean);
}

export function normalizeBrowserNames(names = ['chrome']) {
  const requested = names.flatMap((name) => splitBrowserNames(String(name)));
  const expanded = requested.includes('all') ? supportedBrowserNames() : requested;
  const unique = [...new Set(expanded)];
  if (!unique.length) throw new Error('至少需要指定一个浏览器');
  for (const browser of unique) {
    if (!MACOS_NATIVE_MESSAGING_BROWSERS[browser]) {
      throw new Error(`不支持的浏览器: ${browser}。可用值: ${[...supportedBrowserNames(), 'all'].join('、')}`);
    }
  }
  return unique;
}

export function nativeMessagingManifest(hostPath, manifestType) {
  if (!path.isAbsolute(hostPath)) throw new Error('Native Messaging host 路径必须是绝对路径');
  const common = {
    name: NATIVE_MESSAGING_HOST_NAME,
    description: 'Relay Pulse local backend launcher',
    path: hostPath,
    type: 'stdio'
  };
  if (manifestType === 'firefox') {
    return {
      ...common,
      allowed_extensions: [FIREFOX_EXTENSION_ID]
    };
  }
  if (manifestType !== 'chromium') throw new Error(`不支持的 Native Messaging manifest 类型: ${manifestType}`);
  return {
    ...common,
    allowed_origins: [`chrome-extension://${CHROMIUM_EXTENSION_ID}/`]
  };
}

export function nativeMessagingManifestPath(homeDirectory, browser) {
  const registration = MACOS_NATIVE_MESSAGING_BROWSERS[browser];
  if (!registration) throw new Error(`不支持的浏览器: ${browser}`);
  return path.join(homeDirectory, ...registration.directory, `${NATIVE_MESSAGING_HOST_NAME}.json`);
}

export function renderNativeHostInstallCommand(hostName = nativeHostExecutableName('darwin')) {
  return `#!/bin/sh
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
exec "$script_dir/${hostName}" --install "$@"
`;
}

export function defaultNativeHostPath({
  platform = process.platform,
  arch = process.arch,
  executablePath = process.execPath,
  argv = process.argv
} = {}) {
  const invokedPath = path.resolve(argv[1] ?? '');
  if (invokedPath && invokedPath === path.resolve(executablePath)) return executablePath;
  return path.join(projectRoot, 'release', `relay-pulse-${platform}-${arch}`, nativeHostExecutableName(platform));
}

export async function registerNativeMessagingHost({
  platform = process.platform,
  homeDirectory = os.homedir(),
  nativeHostPath = defaultNativeHostPath(),
  browsers = ['chrome'],
  uninstall = false,
  dryRun = false,
  accessImpl = access,
  mkdirImpl = mkdir,
  rmImpl = rm,
  writeFileImpl = writeFile
} = {}) {
  if (platform !== 'darwin') {
    throw new Error('当前安装器仅支持 macOS。Windows 注册表安装将在后续版本提供。');
  }

  const selectedBrowsers = normalizeBrowserNames(browsers);
  const resolvedHostPath = path.resolve(nativeHostPath);
  if (!uninstall) {
    try {
      await accessImpl(resolvedHostPath);
    } catch {
      throw new Error(`找不到 Native Messaging host: ${resolvedHostPath}。请先运行 npm run package:server。`);
    }
  }

  const registrations = [];
  for (const browser of selectedBrowsers) {
    const registration = MACOS_NATIVE_MESSAGING_BROWSERS[browser];
    const manifestPath = nativeMessagingManifestPath(homeDirectory, browser);
    registrations.push({ browser, label: registration.label, manifestPath });

    if (dryRun) continue;
    if (uninstall) {
      await rmImpl(manifestPath, { force: true });
      continue;
    }

    await mkdirImpl(path.dirname(manifestPath), { recursive: true });
    const manifest = nativeMessagingManifest(resolvedHostPath, registration.manifestType);
    await writeFileImpl(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  return {
    nativeHostPath: resolvedHostPath,
    registrations,
    uninstall,
    dryRun
  };
}

export function parseNativeMessagingInstallerArguments(args) {
  const options = {
    browsers: [],
    uninstall: false,
    dryRun: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--install' || argument === '--repair') continue;
    if (argument === '--uninstall') {
      options.uninstall = true;
      continue;
    }
    if (argument === '--all-browsers') {
      options.browsers.push('all');
      continue;
    }
    if (argument === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (argument === '--browser') {
      options.browsers.push(args[index + 1] ?? '');
      index += 1;
      continue;
    }
    if (argument.startsWith('--browser=')) {
      options.browsers.push(argument.slice('--browser='.length));
      continue;
    }
    if (argument === '--host-path') {
      options.nativeHostPath = pathFromOption(args[index + 1], '--host-path');
      index += 1;
      continue;
    }
    if (argument.startsWith('--host-path=')) {
      options.nativeHostPath = pathFromOption(argument.slice('--host-path='.length), '--host-path');
      continue;
    }
    throw new Error(`不支持的参数: ${argument}`);
  }

  if (!options.browsers.length) options.browsers.push('chrome');
  return options;
}

export function nativeMessagingInstallerHelp() {
  return `用法：
  npm run install:native-host -- [--browser chrome|edge|brave|chromium|opera|firefox|all]
  npm run install:native-host -- --all-browsers
  npm run uninstall:native-host -- --browser chrome

打包后的 relay-pulse-native-host 也可以直接执行：
  ./relay-pulse-native-host --install --browser chrome
  ./relay-pulse-native-host --uninstall --browser chrome
`;
}

export async function runNativeMessagingInstaller(args = process.argv.slice(2), options = {}) {
  const parsed = parseNativeMessagingInstallerArguments(args);
  if (parsed.help) return { help: nativeMessagingInstallerHelp() };
  return registerNativeMessagingHost({
    ...options,
    ...parsed,
    nativeHostPath: parsed.nativeHostPath ?? options.nativeHostPath ?? defaultNativeHostPath(options)
  });
}

async function main() {
  try {
    const result = await runNativeMessagingInstaller();
    if (result.help) {
      process.stdout.write(result.help);
      return;
    }
    const action = result.dryRun ? (result.uninstall ? '将移除' : '将登记') : (result.uninstall ? '已移除' : '已注册');
    for (const registration of result.registrations) {
      process.stdout.write(`${action} ${registration.label} Native Messaging manifest: ${registration.manifestPath}\n`);
    }
    if (!result.uninstall && !result.dryRun) {
      process.stdout.write(`Native Messaging host: ${result.nativeHostPath}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = path.resolve(process.argv[1] ?? '');
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main();
}
