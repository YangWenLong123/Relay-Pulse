import { fetch as undiciFetch, ProxyAgent } from 'undici';
/**
 * Native fetch in Node 18 does not observe the operating system's proxy
 * configuration. Keep Codex traffic on a dedicated dispatcher so an optional
 * local HTTP(S) proxy is used consistently for model discovery and responses.
 */
export function createCodexUpstreamFetch(proxyUrl) {
    if (!proxyUrl)
        return fetch;
    const dispatcher = new ProxyAgent(proxyUrl);
    return async (input, init) => {
        const response = await undiciFetch(input.toString(), {
            ...init,
            dispatcher
        });
        return response;
    };
}
