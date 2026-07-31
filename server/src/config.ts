import dotenv from 'dotenv';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const isPackagedExecutable = path.resolve(process.argv[1] ?? '') === path.resolve(process.execPath);

function packagedDataDir(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Relay Pulse');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Relay Pulse');
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'relay-pulse');
}

export const projectRoot = isPackagedExecutable
  ? path.dirname(process.execPath)
  : path.resolve(moduleDir, '../..');

dotenv.config({ path: path.join(projectRoot, '.env') });

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function booleanFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

function commaSeparated(value: string | undefined, fallback: string): string[] {
  const entries = (value ?? fallback)
    .split(',')
    .map((entry) => entry.trim().replace(/\/$/, ''))
    .filter(Boolean);
  return entries.length ? entries : [fallback];
}

export const config = {
  port: positiveInteger(process.env.SERVER_PORT, 3100),
  host: process.env.SERVER_HOST ?? '127.0.0.1',
  clientOrigins: commaSeparated(process.env.CLIENT_ORIGIN, 'http://localhost:5173,http://127.0.0.1:5173'),
  allowExtensionOrigins: booleanFlag(process.env.ALLOW_EXTENSION_ORIGINS, true),
  dataDir: process.env.DATA_DIR
    ? path.resolve(projectRoot, process.env.DATA_DIR)
    : isPackagedExecutable ? packagedDataDir() : path.join(projectRoot, 'data'),
  historyLimit: positiveInteger(process.env.HISTORY_LIMIT, 1000),
  poolUsageLimit: Math.min(100000, positiveInteger(process.env.POOL_USAGE_LIMIT, 10000)),
  batchConcurrency: Math.min(10, positiveInteger(process.env.BATCH_CONCURRENCY, 4)),
  apiKeyEncryptionSecret: process.env.API_KEY_ENCRYPTION_SECRET?.trim() || undefined,
  ccSwitchDbPath: path.resolve(process.env.CC_SWITCH_DB_PATH?.trim() || path.join(os.homedir(), '.cc-switch', 'cc-switch.db'))
};
