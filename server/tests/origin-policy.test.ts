import { describe, expect, it } from 'vitest';
import { isAllowedClientOrigin, isBrowserExtensionOrigin } from '../src/lib/origin-policy.js';

const chromiumOrigin = 'chrome-extension://nplnfohmiahjljnemfcjklclaoecogpi';
const firefoxOrigin = 'moz-extension://b2436814-3d3e-4d71-99db-386f6ad18ec3';

describe('client origin policy', () => {
  it('recognizes supported extension origins without accepting arbitrary schemes', () => {
    expect(isBrowserExtensionOrigin(chromiumOrigin)).toBe(true);
    expect(isBrowserExtensionOrigin(firefoxOrigin)).toBe(true);
    expect(isBrowserExtensionOrigin('https://example.com')).toBe(false);
    expect(isBrowserExtensionOrigin('chrome-extension://invalid')).toBe(false);
  });

  it('allows configured web origins and optionally allows browser extensions', () => {
    const configured = ['http://localhost:5173'];
    expect(isAllowedClientOrigin(undefined, configured, true)).toBe(true);
    expect(isAllowedClientOrigin(configured[0], configured, false)).toBe(true);
    expect(isAllowedClientOrigin('http://127.0.0.1:5175', configured, false)).toBe(true);
    expect(isAllowedClientOrigin('http://[::1]:5176', configured, false)).toBe(true);
    expect(isAllowedClientOrigin(chromiumOrigin, configured, true)).toBe(true);
    expect(isAllowedClientOrigin(chromiumOrigin, configured, false)).toBe(false);
    expect(isAllowedClientOrigin('https://example.com', configured, true)).toBe(false);
    expect(isAllowedClientOrigin('http://192.168.1.20:5173', configured, true)).toBe(false);
  });
});
