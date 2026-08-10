import type {
  ApiEnvelope,
  CodexAccount,
  CodexAccountImportResult,
  CodexAccountModelsResult,
  CodexAccountUsageResult,
  CodexProxyStatus,
  CodexRoutingStrategy,
  CodexUsageQuery,
  CodexUsageReport
} from '../types';
import { isStandaloneExtensionRuntime } from '../utils/runtime';
import { http } from './http';

const runtimeProtocol = typeof window === 'undefined' ? '' : window.location.protocol;
const standaloneExtension = isStandaloneExtensionRuntime(
  import.meta.env.VITE_BUILD_TARGET,
  runtimeProtocol,
  import.meta.env.VITE_EXTENSION_DATA_MODE
);

export interface CodexSessionFile {
  access_token: string;
  account_id?: string;
  chatgpt_account_id?: string;
  email?: string;
  name?: string;
  expired?: string;
  [key: string]: unknown;
}

function requireServer(): void {
  if (standaloneExtension) throw new Error('浏览器扩展独立模式无法管理本机 GPT 账号服务');
}

export async function listCodexAccounts(signal?: AbortSignal): Promise<CodexAccount[]> {
  requireServer();
  return (await http.get<ApiEnvelope<CodexAccount[]>>('/codex-accounts', { signal })).data.data;
}

export async function importCodexSessions(sessions: CodexSessionFile[]): Promise<CodexAccountImportResult> {
  requireServer();
  return (await http.post<ApiEnvelope<CodexAccountImportResult>>('/codex-accounts/import', { sessions })).data.data;
}

export async function updateCodexAccount(id: string, patch: { enabled?: boolean; name?: string }): Promise<CodexAccount> {
  requireServer();
  return (await http.patch<ApiEnvelope<CodexAccount>>(`/codex-accounts/${encodeURIComponent(id)}`, patch)).data.data;
}

export async function deleteCodexAccount(id: string): Promise<void> {
  requireServer();
  await http.delete(`/codex-accounts/${encodeURIComponent(id)}`);
}

export async function syncCodexAccountModels(id: string, signal?: AbortSignal): Promise<CodexAccountModelsResult> {
  requireServer();
  return (await http.post<ApiEnvelope<CodexAccountModelsResult>>(`/codex-accounts/${encodeURIComponent(id)}/models`, {}, { signal })).data.data;
}

export async function syncCodexModels(accountIds: string[] = [], signal?: AbortSignal): Promise<{
  accounts: CodexAccount[];
  failed: Array<{ id: string; message: string }>;
}> {
  requireServer();
  return (await http.post<ApiEnvelope<{
    accounts: CodexAccount[];
    failed: Array<{ id: string; message: string }>;
  }>>('/codex-accounts/models', { accountIds }, { signal })).data.data;
}

export async function refreshCodexAccountUsage(id: string, signal?: AbortSignal): Promise<CodexAccountUsageResult> {
  requireServer();
  return (await http.post<ApiEnvelope<CodexAccountUsageResult>>(`/codex-accounts/${encodeURIComponent(id)}/usage`, {}, { signal })).data.data;
}

export async function getCodexProxyStatus(signal?: AbortSignal): Promise<CodexProxyStatus> {
  requireServer();
  return (await http.get<ApiEnvelope<CodexProxyStatus>>('/codex-proxy', { signal })).data.data;
}

export async function startCodexProxy(
  port = 0,
  accountIds: string[] = [],
  routingStrategy: CodexRoutingStrategy = 'round-robin'
): Promise<CodexProxyStatus> {
  requireServer();
  return (await http.post<ApiEnvelope<CodexProxyStatus>>('/codex-proxy/start', { port, accountIds, routingStrategy })).data.data;
}

export async function stopCodexProxy(): Promise<CodexProxyStatus> {
  requireServer();
  return (await http.post<ApiEnvelope<CodexProxyStatus>>('/codex-proxy/stop')).data.data;
}

export async function rotateCodexProxyKey(): Promise<CodexProxyStatus> {
  requireServer();
  return (await http.post<ApiEnvelope<CodexProxyStatus>>('/codex-proxy/key/rotate')).data.data;
}

export async function listCodexUsage(query: CodexUsageQuery = {}, signal?: AbortSignal): Promise<CodexUsageReport> {
  requireServer();
  return (await http.get<ApiEnvelope<CodexUsageReport>>('/codex-proxy/usage', { params: query, signal })).data.data;
}

export async function clearCodexUsage(): Promise<void> {
  requireServer();
  await http.delete('/codex-proxy/usage');
}
