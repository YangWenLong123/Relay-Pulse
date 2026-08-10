/**
 * Formats a relay URL for user-facing website display without changing the
 * endpoint stored or used for requests.
 */
export function displayRelayUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;

  try {
    const url = new URL(trimmed);
    const pathname = url.pathname.replace(/\/+$|\s+$/g, '');
    const websitePath = pathname.replace(/\/v1$/i, '') || '/';
    return `${url.origin}${websitePath === '/' ? '' : websitePath}${url.search}${url.hash}`;
  } catch {
    return trimmed.replace(/\/v1\/?$/i, '');
  }
}
