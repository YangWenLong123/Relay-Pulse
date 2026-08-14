import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MACOS_NATIVE_MESSAGING_BROWSERS,
  NATIVE_HOST_INSTALL_COMMAND_NAME,
  defaultNativeHostPath,
  nativeMessagingInstallerHelp,
  nativeMessagingManifest,
  nativeMessagingManifestPath,
  normalizeBrowserNames,
  parseNativeMessagingInstallerArguments,
  registerNativeMessagingHost,
  runNativeMessagingInstaller
} from './native-messaging-installer.mjs';

export {
  MACOS_NATIVE_MESSAGING_BROWSERS,
  NATIVE_HOST_INSTALL_COMMAND_NAME,
  defaultNativeHostPath,
  nativeMessagingInstallerHelp,
  nativeMessagingManifest,
  nativeMessagingManifestPath,
  normalizeBrowserNames,
  parseNativeMessagingInstallerArguments,
  registerNativeMessagingHost,
  runNativeMessagingInstaller
};

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

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  void main();
}
