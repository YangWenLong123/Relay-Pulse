import { fetch as undiciFetch, ProxyAgent, type RequestInit as UndiciRequestInit } from 'undici';

export type CodexUpstreamFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Native fetch in Node 18 does not observe the operating system's proxy
 * configuration. Keep Codex traffic on a dedicated dispatcher so an optional
 * local HTTP(S) proxy is used consistently for model discovery and responses.
 */
export function createCodexUpstreamFetch(proxyUrl?: string): CodexUpstreamFetch {
  if (!proxyUrl) return fetch;
  const dispatcher = new ProxyAgent(proxyUrl);
  return async (input, init) => {
    const response = await undiciFetch(input.toString(), {
      ...(init as UndiciRequestInit | undefined),
      dispatcher
    });
    return response as unknown as Response;
  };
}
