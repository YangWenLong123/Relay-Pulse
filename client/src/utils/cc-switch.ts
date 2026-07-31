import type { RelayPlatform } from '../types';

export const DEFAULT_CC_SWITCH_CODEX_MODEL = 'gpt-5.5';

export interface CcSwitchPoolDeeplinkInput {
  baseUrl: string;
  platform: RelayPlatform;
  providerName: string;
  apiKey: string;
  model?: string;
}

export const poolUsageScript = `({
  request: {
    url: "{{baseUrl}}/usage",
    method: "GET",
    headers: { "Authorization": "Bearer {{apiKey}}" }
  },
  extractor: function(response) {
    return {
      isValid: response?.is_active ?? true,
      remaining: response?.remaining,
      unit: response?.unit ?? "USD"
    };
  }
})`;

export function buildCcSwitchPoolDeeplink(input: CcSwitchPoolDeeplinkInput): string {
  const baseUrl = input.baseUrl.replace(/\/+$/, '');
  const endpoint = input.platform === 'openai' && !baseUrl.toLowerCase().endsWith('/v1')
    ? `${baseUrl}/v1`
    : baseUrl;
  const entries: [string, string][] = [
    ['resource', 'provider'],
    ['app', input.platform === 'anthropic' ? 'claude' : 'codex'],
    ['name', input.providerName],
    ['homepage', baseUrl],
    ['endpoint', endpoint],
    ['apiKey', input.apiKey],
    ['configFormat', 'json'],
    ['usageEnabled', 'true'],
    ['usageScript', btoa(poolUsageScript)],
    ['usageAutoInterval', '30']
  ];
  if (input.platform === 'openai') {
    entries.splice(2, 0, ['model', input.model?.trim() || DEFAULT_CC_SWITCH_CODEX_MODEL]);
  }
  return `ccswitch://v1/import?${new URLSearchParams(entries).toString()}`;
}
