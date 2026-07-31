const extensionProtocols = new Set(['chrome-extension:', 'moz-extension:', 'safari-web-extension:']);
const defaultExtensionBackendUrl = 'http://127.0.0.1:3100/api';

export type ExtensionDataMode = 'backend' | 'standalone';

export function isExtensionProtocol(protocol: string): boolean {
  return extensionProtocols.has(protocol.toLowerCase());
}

export function isExtensionRuntime(buildTarget: string | undefined, protocol: string): boolean {
  return buildTarget === 'extension' || isExtensionProtocol(protocol);
}

export function extensionDataMode(value: string | undefined): ExtensionDataMode {
  return value?.trim().toLowerCase() === 'standalone' ? 'standalone' : 'backend';
}

export function isStandaloneExtensionRuntime(
  buildTarget: string | undefined,
  protocol: string,
  configuredMode?: string
): boolean {
  return isExtensionRuntime(buildTarget, protocol) && extensionDataMode(configuredMode) === 'standalone';
}

export function resolveApiBaseUrl(
  configuredUrl: string | undefined,
  protocol: string,
  buildTarget?: string,
  configuredMode?: string
): string {
  const configured = configuredUrl?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  if (isExtensionRuntime(buildTarget, protocol) && extensionDataMode(configuredMode) === 'backend') {
    return defaultExtensionBackendUrl;
  }
  return '/api';
}
