import { execFileSync } from 'node:child_process';
import { copyFile, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { extract } from 'tar';
import { nativeHostExecutableName } from './native-messaging-host.mjs';
import {
  NATIVE_HOST_INSTALL_COMMAND_NAME,
  renderNativeHostInstallCommand
} from './native-messaging-installer.mjs';
import {
  PACKAGED_ENV_EXAMPLE_FILE,
  PACKAGED_ENV_FILE,
  writePackagedRuntimeConfig
} from './package-runtime-config.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodeVersion = '22.17.0';
const requestedTarget = process.argv.includes('--target')
  ? process.argv[process.argv.indexOf('--target') + 1]
  : process.argv.find((argument) => argument.startsWith('--target='))?.slice('--target='.length);
const hostTarget = `${process.platform}-${process.arch}`;
const target = requestedTarget ?? hostTarget;
const targetPlatform = target === 'windows-x64' ? 'win32' : target.split('-')[0];
const targetArch = target === 'windows-x64' ? 'x64' : target.split('-')[1];

if (!targetPlatform || !targetArch || (target !== hostTarget && target !== 'windows-x64')) {
  throw new Error(`不支持的目标平台: ${target}。可用目标: ${hostTarget}, windows-x64`);
}

const targetName = `relay-pulse-${target}`;
const outputDir = path.join(projectRoot, 'release', targetName);
const executableName = targetPlatform === 'win32' ? 'relay-pulse-start.exe' : 'relay-pulse-start';
const executablePath = path.join(outputDir, executableName);
const nativeHostName = nativeHostExecutableName(targetPlatform);
const nativeHostPath = path.join(outputDir, nativeHostName);
const nativeHostInstallCommandPath = path.join(outputDir, NATIVE_HOST_INSTALL_COMMAND_NAME);
const packageNativeMessagingHost = targetPlatform === 'darwin' && targetArch === 'arm64';
const localDataFiles = new Set([
  'relays.json',
  'test-history.json',
  'codex-accounts.json',
  'codex-usage.json'
]);
const temporaryDir = await mkdtemp(path.join(os.tmpdir(), 'relay-pulse-sea-'));
const bundlePath = path.join(temporaryDir, 'server.cjs');
const seaConfigPath = path.join(temporaryDir, 'sea-config.json');
const seaBlobPath = path.join(temporaryDir, 'sea-prep.blob');
const nativeHostBundlePath = path.join(temporaryDir, 'native-host.cjs');
const nativeHostSeaConfigPath = path.join(temporaryDir, 'native-host-sea-config.json');
const nativeHostSeaBlobPath = path.join(temporaryDir, 'native-host-sea-prep.blob');
const postjectPath = path.join(projectRoot, 'node_modules', 'postject', 'dist', 'cli.js');
const buildNodePath = path.join(projectRoot, 'node_modules', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node');

function run(command, args) {
  execFileSync(command, args, { cwd: projectRoot, stdio: 'inherit' });
}

async function downloadWindowsNode() {
  console.log(`下载 Windows Node.js 运行时: node-win-x64@${nodeVersion}`);
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const packOutput = execFileSync(npmCommand, [
    'pack',
    `node-win-x64@${nodeVersion}`,
    '--pack-destination',
    temporaryDir,
    '--ignore-scripts',
    '--json'
  ], { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const packResult = JSON.parse(packOutput)[0];
  if (!packResult?.filename || !packResult?.integrity) {
    throw new Error('npm 未返回 Windows Node.js 运行时的完整性信息');
  }

  const archivePath = path.join(temporaryDir, packResult.filename);
  await extract({
    cwd: temporaryDir,
    file: archivePath,
    filter: (entryPath) => entryPath === 'package/bin/node.exe'
  });
  const targetNodePath = path.join(temporaryDir, 'package', 'bin', 'node.exe');
  return targetNodePath;
}

async function stripWindowsSignature(filePath) {
  const executable = await readFile(filePath);
  const peHeaderOffset = executable.readUInt32LE(0x3c);
  if (executable.toString('ascii', peHeaderOffset, peHeaderOffset + 4) !== 'PE\0\0') {
    throw new Error('Windows Node.js 运行时不是有效的 PE 文件');
  }

  const optionalHeaderOffset = peHeaderOffset + 24;
  const optionalHeaderMagic = executable.readUInt16LE(optionalHeaderOffset);
  const dataDirectoryOffset = optionalHeaderOffset + (optionalHeaderMagic === 0x20b ? 112 : 96);
  const securityDirectoryOffset = dataDirectoryOffset + (4 * 8);
  const certificateOffset = executable.readUInt32LE(securityDirectoryOffset);
  const certificateSize = executable.readUInt32LE(securityDirectoryOffset + 4);
  executable.fill(0, securityDirectoryOffset, securityDirectoryOffset + 8);

  const certificateEndsAtEof = certificateOffset > 0
    && certificateOffset + certificateSize === executable.length;
  await writeFile(filePath, certificateEndsAtEof ? executable.subarray(0, certificateOffset) : executable);
}

async function assertDataFreePackage() {
  const entries = await readdir(outputDir, { withFileTypes: true });
  const allowedEntries = new Set([
    executableName,
    PACKAGED_ENV_FILE,
    PACKAGED_ENV_EXAMPLE_FILE,
    ...(packageNativeMessagingHost ? [nativeHostName, NATIVE_HOST_INSTALL_COMMAND_NAME] : [])
  ]);
  const unexpectedEntries = entries
    .filter((entry) => !allowedEntries.has(entry.name))
    .map((entry) => entry.name);
  const localDataEntries = entries
    .filter((entry) => localDataFiles.has(entry.name))
    .map((entry) => entry.name);

  if (localDataEntries.length) {
    throw new Error(`打包产物禁止包含本地数据文件：${localDataEntries.join('、')}`);
  }
  if (unexpectedEntries.length) {
    throw new Error(`打包产物包含未允许的文件：${unexpectedEntries.join('、')}`);
  }
}

try {
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  await build({
    entryPoints: [path.join(projectRoot, 'server', 'src', 'server.ts')],
    outfile: bundlePath,
    bundle: true,
    minify: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    sourcemap: false,
    legalComments: 'none',
    define: {
      'import.meta.url': JSON.stringify('file:///__relay_pulse_packaged__/server/dist/config.js')
    }
  });

  if (packageNativeMessagingHost) {
    await build({
      entryPoints: [path.join(projectRoot, 'scripts', 'native-messaging-host-entry.mjs')],
      outfile: nativeHostBundlePath,
      bundle: true,
      minify: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      sourcemap: false,
      legalComments: 'none',
      define: {
        'import.meta.url': JSON.stringify('file:///__relay_pulse_packaged__/scripts/native-messaging-host-entry.mjs')
      }
    });
  }

  await writeFile(seaConfigPath, JSON.stringify({
    main: bundlePath,
    output: seaBlobPath,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false
  }, null, 2));

  run(buildNodePath, ['--experimental-sea-config', seaConfigPath]);
  if (packageNativeMessagingHost) {
    await writeFile(nativeHostSeaConfigPath, JSON.stringify({
      main: nativeHostBundlePath,
      output: nativeHostSeaBlobPath,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false
    }, null, 2));
    run(buildNodePath, ['--experimental-sea-config', nativeHostSeaConfigPath]);
  }
  const targetNodePath = targetPlatform === 'win32' && process.platform !== 'win32'
    ? await downloadWindowsNode()
    : buildNodePath;
  await copyFile(targetNodePath, executablePath);
  if (packageNativeMessagingHost) await copyFile(targetNodePath, nativeHostPath);

  if (targetPlatform === 'win32') {
    await stripWindowsSignature(executablePath);
  }
  if (targetPlatform === 'darwin') {
    run('codesign', ['--remove-signature', executablePath]);
    if (packageNativeMessagingHost) run('codesign', ['--remove-signature', nativeHostPath]);
  }

  const postjectArgs = [
    postjectPath,
    executablePath,
    'NODE_SEA_BLOB',
    seaBlobPath,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
  ];
  if (targetPlatform === 'darwin') {
    postjectArgs.push('--macho-segment-name', 'NODE_SEA');
  }
  run(buildNodePath, postjectArgs);

  if (packageNativeMessagingHost) {
    const nativeHostPostjectArgs = [
      postjectPath,
      nativeHostPath,
      'NODE_SEA_BLOB',
      nativeHostSeaBlobPath,
      '--sentinel-fuse',
      'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
    ];
    nativeHostPostjectArgs.push('--macho-segment-name', 'NODE_SEA');
    run(buildNodePath, nativeHostPostjectArgs);
  }

  if (targetPlatform === 'darwin') {
    run('codesign', ['--sign', '-', executablePath]);
    if (packageNativeMessagingHost) run('codesign', ['--sign', '-', nativeHostPath]);
  }
  if (targetPlatform !== 'win32') {
    await chmod(executablePath, 0o755);
    if (packageNativeMessagingHost) await chmod(nativeHostPath, 0o755);
  }
  if (packageNativeMessagingHost) {
    await writeFile(nativeHostInstallCommandPath, renderNativeHostInstallCommand(nativeHostName), 'utf8');
    await chmod(nativeHostInstallCommandPath, 0o755);
  }

  const sourceEnv = await readFile(path.join(projectRoot, '.env'), 'utf8').catch(() => '');
  const packagedConfig = await writePackagedRuntimeConfig(outputDir, sourceEnv);
  await assertDataFreePackage();

  console.log(`\n后端可执行程序: ${executablePath}`);
  if (packageNativeMessagingHost) console.log(`Native Messaging host: ${nativeHostPath}`);
  if (packageNativeMessagingHost) console.log(`Native Messaging 安装命令: ${nativeHostInstallCommandPath}`);
  console.log(`产物包含可执行文件和 ${PACKAGED_ENV_FILE} 配置，不包含本地中转站、CC Switch 导入结果或 GPT 账号数据。`);
  console.log(`已生成 ${PACKAGED_ENV_EXAMPLE_FILE}；加密密钥等敏感配置不会自动打包，请按需手动写入 ${PACKAGED_ENV_FILE}。`);
  if (packagedConfig.excludedKeys.length) {
    console.warn(`以下敏感配置未随包复制：${packagedConfig.excludedKeys.join('、')}`);
  }
} finally {
  await rm(temporaryDir, { recursive: true, force: true });
}
