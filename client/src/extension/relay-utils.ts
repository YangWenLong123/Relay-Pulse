import type { BalanceConfig, BalanceConfigFormValue, Relay } from '../types';

export interface StoredRelay extends Omit<Relay, 'apiKeyMasked' | 'balanceConfig'> {
  apiKey: string;
  balanceConfig?: BalanceConfigFormValue;
}

const terminalPaths = ['/chat/completions', '/responses', '/models'];

export function normalizeBaseUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('URL 仅支持 http 或 https 协议');
  if (url.username || url.password) throw new Error('URL 不能包含用户名或密码');
  url.search = '';
  url.hash = '';
  let pathname = url.pathname.replace(/\/+$/, '');
  for (const terminalPath of terminalPaths) {
    if (pathname.toLowerCase().endsWith(terminalPath)) {
      pathname = pathname.slice(0, -terminalPath.length).replace(/\/+$/, '');
      break;
    }
  }
  while (/\/v1\/v1$/i.test(pathname)) pathname = pathname.slice(0, -3);
  url.pathname = pathname || '/';
  return url.toString().replace(/\/$/, '');
}

export function endpointUrl(baseUrl: string, endpoint: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  const suffix = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  if (normalized.toLowerCase().endsWith('/v1') && suffix.toLowerCase().startsWith('/v1/')) {
    return `${normalized}${suffix.slice(3)}`;
  }
  return `${normalized}${suffix}`;
}

export function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 4) return '*'.repeat(Math.max(apiKey.length, 4));
  if (apiKey.length <= 8) return `${apiKey.slice(0, 2)}${'*'.repeat(apiKey.length - 4)}${apiKey.slice(-2)}`;
  return `${apiKey.slice(0, 4)}${'*'.repeat(Math.min(12, apiKey.length - 8))}${apiKey.slice(-4)}`;
}

export function publicRelay(relay: StoredRelay): Relay {
  const { apiKey, balanceConfig, ...safe } = relay;
  return {
    ...safe,
    apiKeyMasked: maskApiKey(apiKey),
    balanceConfig: balanceConfig ? publicBalanceConfig(balanceConfig) : undefined
  };
}

export function publicBalanceConfig(config: BalanceConfigFormValue): BalanceConfig {
  const { apiKey, accessToken, ...safe } = config;
  return { ...safe, apiKeyConfigured: Boolean(apiKey), accessTokenConfigured: Boolean(accessToken) };
}
