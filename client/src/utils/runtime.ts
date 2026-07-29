const extensionProtocols = new Set(['chrome-extension:', 'moz-extension:', 'safari-web-extension:']);

export function isExtensionProtocol(protocol: string): boolean {
  return extensionProtocols.has(protocol.toLowerCase());
}

export function isStandaloneExtensionRuntime(buildTarget: string | undefined, protocol: string): boolean {
  return buildTarget === 'extension' || isExtensionProtocol(protocol);
}

export function resolveApiBaseUrl(configuredUrl: string | undefined, _protocol: string): string {
  const configured = configuredUrl?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  return '/api';
}
