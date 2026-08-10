import { describe, expect, it } from 'vitest';
import {
  buildCcSwitchRelayDeeplink,
  buildCcSwitchPoolDeeplink,
  DEFAULT_CC_SWITCH_CODEX_MODEL,
  poolUsageScript
} from '../src/utils/cc-switch';

function paramsFromDeeplink(deeplink: string): URLSearchParams {
  return new URLSearchParams(deeplink.split('?')[1] ?? '');
}

describe('CC Switch pool deeplink', () => {
  it('builds a Codex provider import with the selected model and usage script', () => {
    const params = paramsFromDeeplink(buildCcSwitchPoolDeeplink({
      baseUrl: 'http://127.0.0.1:58000/',
      platform: 'openai',
      providerName: 'Relay Pulse OpenAI 号池',
      apiKey: 'rp_openai',
      model: 'gpt-test'
    }));

    expect(params.get('resource')).toBe('provider');
    expect(params.get('app')).toBe('codex');
    expect(params.get('homepage')).toBe('http://127.0.0.1:58000');
    expect(params.get('endpoint')).toBe('http://127.0.0.1:58000/v1');
    expect(params.get('model')).toBe('gpt-test');
    expect(params.get('apiKey')).toBe('rp_openai');
    expect(atob(params.get('usageScript') ?? '')).toBe(poolUsageScript);
    expect(poolUsageScript.replace('{{baseUrl}}', params.get('endpoint') ?? '')).toContain(
      'url: "http://127.0.0.1:58000/v1/usage"'
    );
    expect(params.get('usageAutoInterval')).toBe('30');
  });

  it('builds a Claude provider without a model and falls back to the current Codex model', () => {
    const claude = paramsFromDeeplink(buildCcSwitchPoolDeeplink({
      baseUrl: 'http://127.0.0.1:58001',
      platform: 'anthropic',
      providerName: 'Relay Pulse Anthropic 号池',
      apiKey: 'rp_anthropic',
      model: 'claude-test'
    }));
    const codex = paramsFromDeeplink(buildCcSwitchPoolDeeplink({
      baseUrl: 'http://127.0.0.1:58002',
      platform: 'openai',
      providerName: 'Relay Pulse OpenAI 号池',
      apiKey: 'rp_openai'
    }));

    expect(claude.get('app')).toBe('claude');
    expect(claude.get('endpoint')).toBe('http://127.0.0.1:58001');
    expect(claude.has('model')).toBe(false);
    expect(poolUsageScript.replace('{{baseUrl}}', claude.get('endpoint') ?? '')).toContain(
      'url: "http://127.0.0.1:58001/usage"'
    );
    expect(codex.get('model')).toBe(DEFAULT_CC_SWITCH_CODEX_MODEL);
  });

  it('builds a single relay provider with a default generic balance query', () => {
    const params = paramsFromDeeplink(buildCcSwitchRelayDeeplink({
      baseUrl: 'https://relay.example.com/v1/',
      platform: 'openai',
      providerName: '我的中转站',
      apiKey: 'sk-relay',
      model: 'gpt-5.6-sol'
    }));

    expect(params.get('name')).toBe('我的中转站');
    expect(params.get('endpoint')).toBe('https://relay.example.com/v1');
    expect(params.get('model')).toBe('gpt-5.6-sol');
    expect(params.get('usageEnabled')).toBe('true');
    expect(params.get('usageBaseUrl')).toBe('https://relay.example.com/v1/usage');
    expect(atob(params.get('usageScript') ?? '')).toContain('url: "{{baseUrl}}"');
  });

  it('uses configured New API credentials and balance endpoint for a relay', () => {
    const params = paramsFromDeeplink(buildCcSwitchRelayDeeplink({
      baseUrl: 'https://relay.example.com',
      platform: 'openai',
      providerName: 'New API 中转站',
      apiKey: 'sk-relay',
      model: 'gpt-5.6-sol',
      balance: {
        config: {
          template: 'newapi',
          requestUrl: 'https://balance.example.com/',
          userId: '42',
          timeout: 10000,
          intervalMinutes: 5,
          enabled: true
        },
        accessToken: 'balance-token'
      }
    }));

    const script = atob(params.get('usageScript') ?? '');
    expect(params.get('usageAutoInterval')).toBe('5');
    expect(params.get('usageBaseUrl')).toBe('https://balance.example.com/api/user/self');
    expect(params.get('usageAccessToken')).toBe('balance-token');
    expect(params.get('usageUserId')).toBe('42');
    expect(script).toContain('Bearer {{accessToken}}');
    expect(script).toContain('"New-Api-User": "{{userId}}"');
    expect(script).not.toContain('balance-token');
    expect(script).toContain('quota / 500000');
  });

  it('uses a dedicated generic balance key when one is configured', () => {
    const params = paramsFromDeeplink(buildCcSwitchRelayDeeplink({
      baseUrl: 'https://relay.example.com',
      platform: 'openai',
      providerName: '专用余额凭据',
      apiKey: 'sk-relay',
      balance: {
        config: {
          template: 'generic',
          requestUrl: 'https://balance.example.com/v1',
          userId: '',
          timeout: 10000,
          intervalMinutes: 15,
          enabled: true
        },
        apiKey: 'sk-balance'
      }
    }));

    expect(params.get('usageBaseUrl')).toBe('https://balance.example.com/v1/usage');
    expect(params.get('usageApiKey')).toBe('sk-balance');
    expect(params.get('usageAutoInterval')).toBe('15');
    expect(atob(params.get('usageScript') ?? '')).toContain('Bearer {{apiKey}}');
  });

  it('does not enable balance queries when the relay balance configuration is disabled', () => {
    const params = paramsFromDeeplink(buildCcSwitchRelayDeeplink({
      baseUrl: 'https://relay.example.com',
      platform: 'anthropic',
      providerName: '已停用余额查询',
      apiKey: 'sk-relay',
      balance: {
        config: {
          template: 'generic',
          requestUrl: '',
          userId: '',
          timeout: 10000,
          intervalMinutes: 1,
          enabled: false
        }
      }
    }));

    expect(params.has('usageEnabled')).toBe(false);
    expect(params.has('usageScript')).toBe(false);
  });
});
