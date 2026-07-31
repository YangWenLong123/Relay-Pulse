import { execFileSync } from 'node:child_process';
import { copyFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { extract } from 'tar';

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
const temporaryDir = await mkdtemp(path.join(os.tmpdir(), 'relay-pulse-sea-'));
const bundlePath = path.join(temporaryDir, 'server.cjs');
const seaConfigPath = path.join(temporaryDir, 'sea-config.json');
const seaBlobPath = path.join(temporaryDir, 'sea-prep.blob');
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

  await writeFile(seaConfigPath, JSON.stringify({
    main: bundlePath,
    output: seaBlobPath,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false
  }, null, 2));

  run(buildNodePath, ['--experimental-sea-config', seaConfigPath]);
  const targetNodePath = targetPlatform === 'win32' && process.platform !== 'win32'
    ? await downloadWindowsNode()
    : buildNodePath;
  await copyFile(targetNodePath, executablePath);

  if (targetPlatform === 'win32') {
    await stripWindowsSignature(executablePath);
  }
  if (targetPlatform === 'darwin') {
    run('codesign', ['--remove-signature', executablePath]);
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

  if (targetPlatform === 'darwin') {
    run('codesign', ['--sign', '-', executablePath]);
  }
  if (targetPlatform !== 'win32') {
    await chmod(executablePath, 0o755);
  }

  console.log(`\n后端可执行程序: ${executablePath}`);
  console.log('可在同目录放置 .env 覆盖端口、数据目录等配置。');
} finally {
  await rm(temporaryDir, { recursive: true, force: true });
}
