import type { ApiEnvelope, PoolRoutingStrategy, PoolStartResult, PoolStatus, PoolUsageQuery, PoolUsageReport } from '../types';
import { isStandaloneExtensionRuntime } from '../utils/runtime';
import { http } from './http';

const runtimeProtocol = typeof window === 'undefined' ? '' : window.location.protocol;
const standaloneExtension = isStandaloneExtensionRuntime(
  import.meta.env.VITE_BUILD_TARGET,
  runtimeProtocol,
  import.meta.env.VITE_EXTENSION_DATA_MODE
);

function requireServer(): void {
  if (standaloneExtension) throw new Error('浏览器扩展模式无法启动本机号池服务');
}

export async function getPoolStatus(signal?: AbortSignal): Promise<PoolStatus> {
  requireServer();
  return (await http.get<ApiEnvelope<PoolStatus>>('/pool', { signal })).data.data;
}

export async function startPool(
  port = 0,
  relayIds: string[] = [],
  routingStrategy: PoolRoutingStrategy = 'round-robin',
  modelMap: Record<string, string[]> = {}
): Promise<PoolStartResult> {
  requireServer();
  return (await http.post<ApiEnvelope<PoolStartResult>>('/pool/start', { port, relayIds, routingStrategy, modelMap })).data.data;
}

export async function updatePoolRoutingStrategy(routingStrategy: PoolRoutingStrategy): Promise<PoolStatus> {
  requireServer();
  return (await http.post<ApiEnvelope<PoolStatus>>('/pool/strategy', { routingStrategy })).data.data;
}

export async function addPoolRelays(
  relayIds: string[],
  modelMap: Record<string, string[]> = {}
): Promise<PoolStatus> {
  requireServer();
  return (await http.post<ApiEnvelope<PoolStatus>>('/pool/relays', { relayIds, modelMap })).data.data;
}

export async function stopPool(): Promise<PoolStatus> {
  requireServer();
  return (await http.post<ApiEnvelope<PoolStatus>>('/pool/stop')).data.data;
}

export async function rotatePoolKey(): Promise<PoolStartResult> {
  requireServer();
  return (await http.post<ApiEnvelope<PoolStartResult>>('/pool/key/rotate')).data.data;
}

export async function listPoolUsage(query: PoolUsageQuery = {}, signal?: AbortSignal): Promise<PoolUsageReport> {
  requireServer();
  return (await http.get<ApiEnvelope<PoolUsageReport>>('/pool/usage', { params: query, signal })).data.data;
}

export function poolUsageExportUrl(query: PoolUsageQuery = {}): string {
  requireServer();
  return http.getUri({ url: '/pool/usage/export', params: query });
}
