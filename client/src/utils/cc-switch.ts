import type { BalanceConfig, RelayPlatform } from '../types';

export const DEFAULT_CC_SWITCH_CODEX_MODEL = 'gpt-5.5';

export interface CcSwitchPoolDeeplinkInput {
  baseUrl: string;
  platform: RelayPlatform;
  providerName: string;
  apiKey: string;
  model?: string;
}

export interface CcSwitchRelayDeeplinkInput extends CcSwitchPoolDeeplinkInput {
  balance?: {
    config: Pick<BalanceConfig, 'template' | 'requestUrl' | 'userId' | 'timeout' | 'intervalMinutes' | 'enabled'>;
    apiKey?: string;
    accessToken?: string;
  };
}

export const poolUsageScript = `({
  request: {
    url: "{{baseUrl}}/usage",
    method: "GET",
    headers: { "Authorization": "Bearer {{apiKey}}" }
  },
  extractor: ${genericBalanceExtractor()}
})`;

export function buildCcSwitchPoolDeeplink(input: CcSwitchPoolDeeplinkInput): string {
  const entries = providerImportEntries(input);
  entries.push(
    ['usageEnabled', 'true'],
    ['usageScript', btoa(poolUsageScript)],
    ['usageAutoInterval', '30']
  );
  return `ccswitch://v1/import?${new URLSearchParams(entries).toString()}`;
}

export function buildCcSwitchRelayDeeplink(input: CcSwitchRelayDeeplinkInput): string {
  const entries = providerImportEntries(input);
  const usage = relayUsageSettings(input);
  if (usage) {
    entries.push(
      ['usageEnabled', 'true'],
      ['usageScript', btoa(usage.script)],
      ['usageBaseUrl', usage.baseUrl],
      ['usageAutoInterval', String(usage.intervalMinutes)]
    );
    if (usage.apiKey) entries.push(['usageApiKey', usage.apiKey]);
    if (usage.accessToken) entries.push(['usageAccessToken', usage.accessToken]);
    if (usage.userId) entries.push(['usageUserId', usage.userId]);
  }
  return `ccswitch://v1/import?${new URLSearchParams(entries).toString()}`;
}

function providerImportEntries(input: CcSwitchPoolDeeplinkInput): [string, string][] {
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
    ['configFormat', 'json']
  ];
  if (input.platform === 'openai') {
    entries.splice(2, 0, ['model', input.model?.trim() || DEFAULT_CC_SWITCH_CODEX_MODEL]);
  }
  return entries;
}

function balanceEndpoint(baseUrl: string, endpoint: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  if (base.toLowerCase().endsWith(normalizedEndpoint.toLowerCase())) return base;
  if (base.toLowerCase().endsWith('/v1') && normalizedEndpoint.toLowerCase().startsWith('/v1/')) {
    return `${base}${normalizedEndpoint.slice(3)}`;
  }
  return `${base}${normalizedEndpoint}`;
}

function genericBalanceExtractor(): string {
  return `function(response) {
    var payload = response && response.data && typeof response.data === "object" ? response.data : (response || {});
    var quota = payload.quota && typeof payload.quota === "object" ? payload.quota : {};
    var numberOf = function(value) {
      var parsed = typeof value === "number" ? value : Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    var firstNumber = function(values) {
      for (var index = 0; index < values.length; index += 1) {
        var parsed = numberOf(values[index]);
        if (parsed !== null) return parsed;
      }
      return null;
    };
    var total = firstNumber([payload.total, quota.total, payload.limit]);
    var used = firstNumber([payload.used, quota.used, payload.usedQuota]);
    var remaining = firstNumber([payload.remaining, quota.remaining, payload.balance]);
    if (remaining === null && total !== null && used !== null) remaining = total - used;
    return {
      isValid: remaining !== null,
      remaining: remaining,
      unit: payload.unit || quota.unit || "USD"
    };
  }`;
}

function genericUsageScript(): string {
  return `({
    request: {
      url: "{{baseUrl}}",
      method: "GET",
      headers: { "Authorization": "Bearer {{apiKey}}" }
    },
    extractor: ${genericBalanceExtractor()}
  })`;
}

function newApiUsageScript(): string {
  return `({
    request: {
      url: "{{baseUrl}}",
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer {{accessToken}}",
        "New-Api-User": "{{userId}}"
      }
    },
    extractor: function(response) {
      var payload = response || {};
      var data = payload.data && typeof payload.data === "object" ? payload.data : {};
      var numberOf = function(value) {
        var parsed = typeof value === "number" ? value : Number(value);
        return Number.isFinite(parsed) ? parsed : null;
      };
      var quota = numberOf(data.quota);
      var used = numberOf(data.used_quota !== undefined ? data.used_quota : data.usedQuota);
      if (payload.success !== true || quota === null || used === null) {
        return { isValid: false, remaining: null, unit: "USD" };
      }
      return {
        isValid: true,
        planName: data.group || "Default plan",
        remaining: quota / 500000,
        used: used / 500000,
        total: (quota + used) / 500000,
        unit: "USD"
      };
    }
  })`;
}

interface CcSwitchUsageSettings {
  script: string;
  baseUrl: string;
  intervalMinutes: number;
  apiKey?: string;
  accessToken?: string;
  userId?: string;
}

function relayUsageSettings(input: CcSwitchRelayDeeplinkInput): CcSwitchUsageSettings | undefined {
  const balance = input.balance;
  if (!balance) {
    return {
      script: genericUsageScript(),
      baseUrl: balanceEndpoint(input.baseUrl, '/v1/usage'),
      intervalMinutes: 30
    };
  }
  if (!balance.config.enabled) return undefined;
  const intervalMinutes = balance.config.intervalMinutes > 0 ? balance.config.intervalMinutes : 30;
  const baseUrl = balance.config.requestUrl || input.baseUrl;
  if (balance.config.template === 'newapi') {
    if (!balance.accessToken?.trim() || !balance.config.userId.trim()) return undefined;
    return {
      script: newApiUsageScript(),
      baseUrl: balanceEndpoint(baseUrl, '/api/user/self'),
      intervalMinutes,
      accessToken: balance.accessToken.trim(),
      userId: balance.config.userId.trim()
    };
  }
  return {
    script: genericUsageScript(),
    baseUrl: balanceEndpoint(baseUrl, '/v1/usage'),
    intervalMinutes,
    apiKey: balance.apiKey?.trim() || undefined
  };
}
