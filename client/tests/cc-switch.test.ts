import { describe, expect, it } from 'vitest';
import {
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
});
