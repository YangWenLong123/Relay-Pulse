import { timingSafeEqual } from 'node:crypto';
import { isBrowserExtensionOrigin } from './origin-policy.js';

export const extensionAccessTokenHeader = 'x-relay-pulse-extension-token';

function matchesToken(candidate: string | undefined, expected: string): boolean {
  if (!candidate) return false;
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes);
}

export function allowsExtensionRequest(
  origin: string | undefined,
  token: string | undefined,
  expectedToken: string | undefined
): boolean {
  if (!expectedToken || !origin || !isBrowserExtensionOrigin(origin)) return true;
  return matchesToken(token, expectedToken);
}
