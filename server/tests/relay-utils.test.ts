import { describe, expect, it } from 'vitest';
import { endpointUrl, maskApiKey, normalizeBaseUrl } from '../src/lib/relay-utils.js';

describe('relay URL utilities', () => {
  it('normalizes trailing slashes and concrete endpoint paths', () => {
    expect(normalizeBaseUrl(' https://api.example.com/v1/chat/completions/ ')).toBe('https://api.example.com/v1');
    expect(normalizeBaseUrl('https://api.example.com/openai/v1/models')).toBe('https://api.example.com/openai/v1');
    expect(() => normalizeBaseUrl('https://user:password@api.example.com/v1')).toThrow('URL 不能包含用户名或密码');
  });

  it('does not duplicate v1', () => {
    expect(endpointUrl('https://api.example.com/v1', '/v1/models')).toBe('https://api.example.com/v1/models');
    expect(endpointUrl('https://api.example.com/openai', '/v1/responses')).toBe(
      'https://api.example.com/openai/v1/responses'
    );
    expect(endpointUrl('https://api.example.com/v1/v1', '/v1/models')).toBe('https://api.example.com/v1/models');
    expect(endpointUrl('https://api.example.com/v1/responses', '/v1/models')).toBe('https://api.example.com/v1/models');
  });

  it('masks API keys without exposing the complete value', () => {
    expect(maskApiKey('sk-1234567890abcd')).toMatch(/^sk-1\*+abcd$/);
    expect(maskApiKey('abcd')).toBe('****');
  });
});
