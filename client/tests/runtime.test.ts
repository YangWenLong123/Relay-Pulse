import { describe, expect, it } from 'vitest';
import { isExtensionProtocol, isStandaloneExtensionRuntime, resolveApiBaseUrl } from '../src/utils/runtime';

describe('extension runtime', () => {
  it('recognizes major browser extension protocols', () => {
    expect(isExtensionProtocol('chrome-extension:')).toBe(true);
    expect(isExtensionProtocol('moz-extension:')).toBe(true);
    expect(isExtensionProtocol('safari-web-extension:')).toBe(true);
    expect(isExtensionProtocol('https:')).toBe(false);
  });

  it('detects standalone extension builds without requiring an extension URL', () => {
    expect(isStandaloneExtensionRuntime('extension', 'http:')).toBe(true);
    expect(isStandaloneExtensionRuntime(undefined, 'moz-extension:')).toBe(true);
    expect(isStandaloneExtensionRuntime('web', 'https:')).toBe(false);
  });

  it('keeps the web proxy default and normalizes configured URLs', () => {
    expect(resolveApiBaseUrl(undefined, 'http:')).toBe('/api');
    expect(resolveApiBaseUrl(undefined, 'chrome-extension:')).toBe('/api');
    expect(resolveApiBaseUrl(' http://localhost:4100/api/ ', 'moz-extension:')).toBe('http://localhost:4100/api');
  });
});
