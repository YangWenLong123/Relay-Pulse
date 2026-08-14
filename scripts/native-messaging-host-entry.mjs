import path from 'node:path';
import { runNativeMessagingHost } from './native-messaging-host.mjs';
import { runNativeMessagingInstaller, nativeMessagingInstallerHelp } from './native-messaging-installer.mjs';

const chromiumOrigin = 'chrome-extension://nplnfohmiahjljnemfcjklclaoecogpi/';
const firefoxExtensionId = 'relay-pulse@local';

function invocationArguments(argv = process.argv, executablePath = process.execPath) {
  const values = argv.slice(1);
  const firstArgument = values[0];
  const isExecutableArgument = firstArgument && path.resolve(firstArgument) === path.resolve(executablePath);
  const isSourceEntry = typeof firstArgument === 'string' && /\.(?:mjs|cjs|js)$/i.test(firstArgument);
  return isExecutableArgument || isSourceEntry ? values.slice(1) : values;
}

function validateBrowserArguments(args) {
  if (!args.length) return;
  const chromiumInvocation = args.includes(chromiumOrigin);
  const firefoxInvocation = args.includes(firefoxExtensionId);
  if (!chromiumInvocation && !firefoxInvocation) {
    throw new Error('Native Messaging host 未收到受允许扩展的来源标识');
  }
}

async function main() {
  const args = invocationArguments();
  if (args[0] === '--install' || args[0] === '--repair' || args[0] === '--uninstall') {
    const result = await runNativeMessagingInstaller(args, { nativeHostPath: process.execPath });
    if (result.help) {
      process.stdout.write(result.help);
      return;
    }
    const action = result.dryRun ? (result.uninstall ? '将移除' : '将登记') : (result.uninstall ? '已移除' : '已注册');
    for (const registration of result.registrations) {
      process.stdout.write(`${action} ${registration.label} Native Messaging manifest: ${registration.manifestPath}\n`);
    }
    return;
  }
  if (args.some((argument) => argument.startsWith('--'))) {
    process.stderr.write(`不支持的 Native Messaging host 参数。${nativeMessagingInstallerHelp()}`);
    process.exitCode = 1;
    return;
  }

  validateBrowserArguments(args);
  await runNativeMessagingHost();
}

void main().catch((error) => {
  process.stderr.write(`Relay Pulse Native Messaging host 失败: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
