import { describe, expect, it } from 'vitest';
import { DEFAULT_PLAYGROUND_MODEL, isPlaygroundRelayAvailable, preferredDetectedModel } from '../src/utils/playground';

describe('preferredDetectedModel', () => {
  it('uses GPT-5.6 Sol as the playground default', () => {
    expect(DEFAULT_PLAYGROUND_MODEL).toBe('gpt-5.6-sol');
  });

  it('prefers GPT-5.6 Sol regardless of list order or casing', () => {
    expect(preferredDetectedModel(['gpt-other', 'GPT-5.6-SOL', 'gpt-5.6-luna'], 'gpt-other')).toBe('GPT-5.6-SOL');
  });

  it('uses GPT-5.6 Luna when Sol is unavailable', () => {
    expect(preferredDetectedModel(['gpt-other', 'gpt-5.6-luna'], 'gpt-other')).toBe('gpt-5.6-luna');
  });

  it('keeps the configured fallback when no preferred model exists', () => {
    expect(preferredDetectedModel(['gpt-first', 'gpt-default'], 'GPT-DEFAULT')).toBe('gpt-default');
  });

  it('uses the first detected model before an unavailable fallback', () => {
    expect(preferredDetectedModel(['gpt-first', 'gpt-second'], 'gpt-missing')).toBe('gpt-first');
  });
});

describe('isPlaygroundRelayAvailable', () => {
  it('excludes disabled relays and relays with a negative remaining balance', () => {
    expect(isPlaygroundRelayAvailable({ enabled: false })).toBe(false);
    expect(isPlaygroundRelayAvailable({ enabled: true, balance: { remaining: -0.01 } })).toBe(false);
  });

  it('keeps enabled relays whose balance is unknown, zero, or positive', () => {
    expect(isPlaygroundRelayAvailable({ enabled: true })).toBe(true);
    expect(isPlaygroundRelayAvailable({ enabled: true, balance: { remaining: null } })).toBe(true);
    expect(isPlaygroundRelayAvailable({ enabled: true, balance: { remaining: 0 } })).toBe(true);
    expect(isPlaygroundRelayAvailable({ enabled: true, balance: { remaining: 12.5 } })).toBe(true);
  });
});
