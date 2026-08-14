import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  NATIVE_HOST_INSTALL_COMMAND_NAME,
  nativeMessagingManifest,
  nativeMessagingManifestPath,
  normalizeBrowserNames,
  parseNativeMessagingInstallerArguments,
  registerNativeMessagingHost,
  renderNativeHostInstallCommand
} from './native-messaging-installer.mjs';

const execFileAsync = promisify(execFile);

test('generates browser-specific manifests with fixed extension allowlists', () => {
  const hostPath = '/Applications/Relay Pulse/relay-pulse-native-host';
  assert.deepEqual(nativeMessagingManifest(hostPath, 'chromium'), {
    name: 'com.relaypulse.host',
    description: 'Relay Pulse local backend launcher',
    path: hostPath,
    type: 'stdio',
    allowed_origins: ['chrome-extension://nplnfohmiahjljnemfcjklclaoecogpi/']
  });
  assert.deepEqual(nativeMessagingManifest(hostPath, 'firefox'), {
    name: 'com.relaypulse.host',
    description: 'Relay Pulse local backend launcher',
    path: hostPath,
    type: 'stdio',
    allowed_extensions: ['relay-pulse@local']
  });
});

test('normalizes browser selections and installer arguments', () => {
  assert.deepEqual(normalizeBrowserNames(['chrome,edge', 'chrome']), ['chrome', 'edge']);
  assert.deepEqual(normalizeBrowserNames(['all']).sort(), ['brave', 'chrome', 'chromium', 'edge', 'firefox', 'opera']);
  assert.deepEqual(parseNativeMessagingInstallerArguments(['--all-browsers', '--repair']), {
    browsers: ['all'],
    uninstall: false,
    dryRun: false,
    help: false
  });
  assert.throws(() => normalizeBrowserNames(['safari']), /不支持的浏览器/);
});

test('registers and removes manifests under the requested macOS browser directories', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-pulse-native-host-'));
  const homeDirectory = path.join(directory, 'home');
  const hostPath = path.join(directory, 'relay-pulse-native-host');
  try {
    await writeFile(hostPath, 'placeholder', 'utf8');
    const result = await registerNativeMessagingHost({
      platform: 'darwin',
      homeDirectory,
      nativeHostPath: hostPath,
      browsers: ['chrome', 'firefox']
    });

    assert.equal(result.registrations.length, 2);
    const chromeManifestPath = nativeMessagingManifestPath(homeDirectory, 'chrome');
    const firefoxManifestPath = nativeMessagingManifestPath(homeDirectory, 'firefox');
    const chromeManifest = JSON.parse(await readFile(chromeManifestPath, 'utf8'));
    const firefoxManifest = JSON.parse(await readFile(firefoxManifestPath, 'utf8'));
    assert.deepEqual(chromeManifest.allowed_origins, ['chrome-extension://nplnfohmiahjljnemfcjklclaoecogpi/']);
    assert.deepEqual(firefoxManifest.allowed_extensions, ['relay-pulse@local']);

    await registerNativeMessagingHost({
      platform: 'darwin',
      homeDirectory,
      browsers: ['chrome', 'firefox'],
      uninstall: true
    });
    await assert.rejects(readFile(chromeManifestPath, 'utf8'), { code: 'ENOENT' });
    await assert.rejects(readFile(firefoxManifestPath, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('does not attempt a macOS installation on another platform', async () => {
  await assert.rejects(
    registerNativeMessagingHost({ platform: 'linux', nativeHostPath: '/tmp/relay-pulse-native-host' }),
    /仅支持 macOS/
  );
});

test('generated macOS command launches the sibling host in installer mode', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-pulse-native-command-'));
  const hostPath = path.join(directory, 'relay-pulse-native-host');
  const commandPath = path.join(directory, NATIVE_HOST_INSTALL_COMMAND_NAME);
  const capturedArgumentsPath = path.join(directory, 'arguments.txt');
  try {
    await writeFile(hostPath, `#!/bin/sh\nprintf '%s\\n' "$@" > "${capturedArgumentsPath}"\n`, 'utf8');
    await writeFile(commandPath, renderNativeHostInstallCommand(), 'utf8');
    await Promise.all([chmod(hostPath, 0o755), chmod(commandPath, 0o755)]);

    await execFileAsync(commandPath, ['--browser', 'edge']);
    assert.equal(await readFile(capturedArgumentsPath, 'utf8'), '--install\n--browser\nedge\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
