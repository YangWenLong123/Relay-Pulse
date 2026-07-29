const chromiumExtensionOrigin = /^chrome-extension:\/\/[a-p]{32}$/;
const firefoxExtensionOrigin = /^moz-extension:\/\/[a-z0-9-]{20,64}$/i;
const safariExtensionOrigin = /^safari-web-extension:\/\/[a-z0-9.-]{3,255}$/i;

function isLocalDevelopmentOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const port = Number(url.port);
    return (
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      Number.isInteger(port) &&
      port >= 1 &&
      port <= 65535
    );
  } catch {
    return false;
  }
}

export function isBrowserExtensionOrigin(origin: string): boolean {
  return (
    chromiumExtensionOrigin.test(origin) ||
    firefoxExtensionOrigin.test(origin) ||
    safariExtensionOrigin.test(origin)
  );
}

export function isAllowedClientOrigin(
  origin: string | undefined,
  allowedOrigins: readonly string[],
  allowExtensionOrigins: boolean
): boolean {
  if (!origin) return true;
  if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return true;
  if (isLocalDevelopmentOrigin(origin)) return true;
  return allowExtensionOrigins && isBrowserExtensionOrigin(origin);
}
