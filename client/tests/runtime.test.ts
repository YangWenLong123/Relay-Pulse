import { describe, expect, it } from 'vitest';
import {
  extensionDataMode,
  isExtensionProtocol,
  isStandaloneExtensionRuntime,
  resolveApiBaseUrl
} from '../src/utils/runtime';

describe('extension runtime', () => {
  it('recognizes major browser extension protocols', () => {
    expect(isExtensionProtocol('chrome-extension:')).toBe(true);
    expect(isExtensionProtocol('moz-extension:')).toBe(true);
    expect(isExtensionProtocol('safari-web-extension:')).toBe(true);
    expect(isExtensionProtocol('https:')).toBe(false);
  });

  it('defaults extension builds to backend mode and only uses standalone when configured', () => {
    expect(extensionDataMode(undefined)).toBe('backend');
    expect(extensionDataMode('standalone')).toBe('standalone');
    expect(isStandaloneExtensionRuntime('extension', 'http:')).toBe(false);
    expect(isStandaloneExtensionRuntime(undefined, 'moz-extension:')).toBe(false);
    expect(isStandaloneExtensionRuntime('extension', 'http:', 'standalone')).toBe(true);
    expect(isStandaloneExtensionRuntime(undefined, 'moz-extension:', 'standalone')).toBe(true);
    expect(isStandaloneExtensionRuntime('web', 'https:')).toBe(false);
  });

  it('uses the local backend default for extension backend mode and normalizes configured URLs', () => {
    expect(resolveApiBaseUrl(undefined, 'http:')).toBe('/api');
    expect(resolveApiBaseUrl(undefined, 'chrome-extension:', 'extension')).toBe('http://127.0.0.1:3100/api');
    expect(resolveApiBaseUrl(undefined, 'chrome-extension:', 'extension', 'standalone')).toBe('/api');
    expect(resolveApiBaseUrl(' http://localhost:4100/api/ ', 'moz-extension:', 'extension')).toBe('http://localhost:4100/api');
  });
});
