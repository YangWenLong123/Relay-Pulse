import type {
  ApiEnvelope,
  CcSwitchImportPreview,
  CcSwitchImportResult,
  Relay,
  RelayFormValue,
  RelayPlatform,
  RelayProtocol,
  TestResult
} from '../types';
import { ExtensionRelayService } from '../extension/service';
import { createBrowserExtensionStorage } from '../extension/storage';
import { isStandaloneExtensionRuntime } from '../utils/runtime';
import { http } from './http';

const runtimeProtocol = typeof window === 'undefined' ? '' : window.location.protocol;
const standaloneExtension = isStandaloneExtensionRuntime(
  import.meta.env.VITE_BUILD_TARGET,
  runtimeProtocol,
  import.meta.env.VITE_EXTENSION_DATA_MODE
);
let extensionService: ExtensionRelayService | undefined;

function localService(): ExtensionRelayService {
  extensionService ??= new ExtensionRelayService(createBrowserExtensionStorage());
  return extensionService;
}

export async function listRelays(): Promise<Relay[]> {
  if (standaloneExtension) return localService().listRelays();
  return (await http.get<ApiEnvelope<Relay[]>>('/relays')).data.data;
}

export async function reorderRelays(relayIds: string[]): Promise<Relay[]> {
  if (standaloneExtension) return localService().reorderRelays(relayIds);
  return (await http.patch<ApiEnvelope<Relay[]>>('/relays/order', { relayIds })).data.data;
}

export async function previewCcSwitchImport(signal?: AbortSignal): Promise<CcSwitchImportPreview> {
  if (standaloneExtension) throw new Error('浏览器扩展模式无法直接读取电脑上的 CC Switch 数据库');
  return (await http.get<ApiEnvelope<CcSwitchImportPreview>>('/import/cc-switch', { signal })).data.data;
}

export async function importFromCcSwitch(candidateIds: string[]): Promise<CcSwitchImportResult> {
  if (standaloneExtension) throw new Error('浏览器扩展模式无法直接读取电脑上的 CC Switch 数据库');
  return (await http.post<ApiEnvelope<CcSwitchImportResult>>('/import/cc-switch', { candidateIds })).data.data;
}

export async function createRelay(value: RelayFormValue): Promise<Relay> {
  if (standaloneExtension) return localService().createRelay(value);
  return (await http.post<ApiEnvelope<Relay>>('/relays', value)).data.data;
}

export async function updateRelay(id: string, value: Partial<RelayFormValue>): Promise<Relay> {
  if (standaloneExtension) return localService().updateRelay(id, value);
  return (await http.put<ApiEnvelope<Relay>>(`/relays/${id}`, value)).data.data;
}

export async function deleteRelay(id: string): Promise<void> {
  if (standaloneExtension) return localService().deleteRelay(id);
  await http.delete(`/relays/${id}`);
}

export async function duplicateRelay(id: string): Promise<Relay> {
  if (standaloneExtension) return localService().duplicateRelay(id);
  return (await http.post<ApiEnvelope<Relay>>(`/relays/${id}/duplicate`)).data.data;
}

export async function getRelayApiKey(id: string, signal?: AbortSignal): Promise<string> {
  if (standaloneExtension) return localService().getRelayApiKey(id);
  return (await http.get<ApiEnvelope<{ apiKey: string }>>(`/relays/${id}/api-key`, { signal })).data.data.apiKey;
}

export interface RelayBalanceCredentials {
  apiKey: string;
  accessToken: string;
}

export async function getRelayBalanceCredentials(id: string, signal?: AbortSignal): Promise<RelayBalanceCredentials> {
  if (standaloneExtension) return localService().getRelayBalanceCredentials(id);
  return (await http.get<ApiEnvelope<RelayBalanceCredentials>>(`/relays/${id}/balance-access-token`, { signal })).data.data;
}

export async function batchToggleRelays(relayIds: string[], enabled: boolean): Promise<Relay[]> {
  if (standaloneExtension) return localService().batchToggleRelays(relayIds, enabled);
  return (await http.patch<ApiEnvelope<Relay[]>>('/relays/batch', { relayIds, enabled })).data.data;
}

export async function testRelay(
  id: string,
  value: { model?: string; message?: string; protocol?: RelayProtocol },
  signal?: AbortSignal
): Promise<TestResult> {
  if (standaloneExtension) return localService().testRelay(id, value, signal);
  return (await http.post<ApiEnvelope<TestResult>>(`/relays/${id}/test`, value, { signal })).data.data;
}

export async function cancelRelayTest(id: string): Promise<void> {
  if (standaloneExtension) return localService().cancelRelayTest(id);
  await http.delete(`/relays/${id}/test`);
}

export async function queryRelayBalance(id: string, signal?: AbortSignal): Promise<Relay> {
  if (standaloneExtension) return localService().queryBalance(id, signal);
  return (await http.post<ApiEnvelope<Relay>>(`/relays/${id}/balance`, {}, { signal })).data.data;
}

export async function discoverRelayModels(id: string, signal?: AbortSignal): Promise<string[]> {
  if (standaloneExtension) return localService().discoverRelayModels(id, signal);
  return (await http.get<ApiEnvelope<string[]>>(`/relays/${id}/models`, { signal })).data.data;
}

export async function discoverDraftModels(
  value: { baseUrl: string; apiKey: string; platform: RelayPlatform; timeout: number },
  signal?: AbortSignal
): Promise<string[]> {
  if (standaloneExtension) return localService().discoverDraftModels(value, signal);
  return (await http.post<ApiEnvelope<string[]>>('/models/discover', value, { signal })).data.data;
}

export interface HistoryQuery {
  relayId?: string;
  success?: boolean;
  from?: string;
  to?: string;
}

export async function listHistory(query: HistoryQuery = {}, signal?: AbortSignal): Promise<TestResult[]> {
  if (standaloneExtension) return localService().listHistory(query, signal);
  return (await http.get<ApiEnvelope<TestResult[]>>('/test-history', { params: query, signal })).data.data;
}

export async function deleteHistory(id: string): Promise<void> {
  if (standaloneExtension) return localService().deleteHistory(id);
  await http.delete(`/test-history/${id}`);
}

export async function clearHistory(): Promise<void> {
  if (standaloneExtension) return localService().clearHistory();
  await http.delete('/test-history');
}
