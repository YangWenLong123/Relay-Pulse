import { describe, expect, it } from 'vitest';
import { allowsExtensionRequest } from '../src/lib/extension-access.js';

const chromiumOrigin = 'chrome-extension://nplnfohmiahjljnemfcjklclaoecogpi';
const firefoxOrigin = 'moz-extension://b2436814-3d3e-4d71-99db-386f6ad18ec3';
const token = 'jKx0p8rEtQ4zS2uV6wY9aBcDeFgHiLmNoPqRsTuVwXy';

describe('extension access token', () => {
  it('requires the configured token for browser extension requests', () => {
    expect(allowsExtensionRequest(chromiumOrigin, token, token)).toBe(true);
    expect(allowsExtensionRequest(firefoxOrigin, token, token)).toBe(true);
    expect(allowsExtensionRequest(chromiumOrigin, undefined, token)).toBe(false);
    expect(allowsExtensionRequest(chromiumOrigin, `${token}x`, token)).toBe(false);
  });

  it('does not change local development, command-line, or unconfigured behavior', () => {
    expect(allowsExtensionRequest('http://127.0.0.1:5173', undefined, token)).toBe(true);
    expect(allowsExtensionRequest(undefined, undefined, token)).toBe(true);
    expect(allowsExtensionRequest(chromiumOrigin, undefined, undefined)).toBe(true);
  });
});
