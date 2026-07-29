import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelayTester, extractModelIds, extractResponseText } from '../src/services/relay-tester.js';
import type { Relay } from '../src/types.js';

const relay: Relay = {
  id: 'a5a1e098-18c8-41b7-8fca-e682d18609df',
  name: '测试线路',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-secret-value',
  model: 'gpt-test',
  protocol: 'auto',
  enabled: true,
  timeout: 1000,
  remark: '',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  lastTestAt: null,
  lastTestStatus: 'untested',
  lastLatency: null
};

afterEach(() => vi.unstubAllGlobals());

describe('response parsing', () => {
  it('parses chat and responses payloads', () => {
    expect(extractResponseText({ choices: [{ message: { content: 'hello' } }] })).toBe('hello');
    expect(extractResponseText({ output: [{ content: [{ type: 'output_text', text: 'world' }] }] })).toBe('world');
    expect(extractResponseText({ choices: [{ message: { content: [{ type: 'text', text: 'parts' }] } }] })).toBe('parts');
    expect(extractResponseText({ choices: [{ text: 'legacy' }] })).toBe('legacy');
    expect(extractResponseText({ output_text: 'direct' })).toBe('direct');
  });

  it('parses common model list shapes', () => {
    expect(extractModelIds({ data: [{ id: 'gpt-b' }, { id: 'gpt-a' }] })).toEqual(['gpt-a', 'gpt-b']);
    expect(extractModelIds({ models: ['gpt-c', { name: 'gpt-d' }] })).toEqual(['gpt-c', 'gpt-d']);
    expect(extractModelIds([{ id: 'gpt-e' }])).toEqual(['gpt-e']);
  });
});

describe('RelayTester', () => {
  it('falls back from Responses to Chat Completions in auto mode', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"error":"unsupported"}', { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: '你好' } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      );
    vi.stubGlobal('fetch', fetchMock);
    const result = await new RelayTester().test(relay);
    expect(result.success).toBe(true);
    expect(result.protocol).toBe('chat');
    expect(result.responseText).toBe('你好');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('classifies authentication errors and does not expose the key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(`invalid ${relay.apiKey}`, { status: 401 }))
    );
    const result = await new RelayTester().test({ ...relay, protocol: 'chat' });
    expect(result.success).toBe(false);
    expect(result.errorType).toBe('auth');
    expect(result.errorMessage).not.toContain(relay.apiKey);
  });

  it.each([
    [429, '{"error":{"message":"quota"}}', 'rate_limit'],
    [400, '{"error":{"message":"model gpt-test does not exist"}}', 'model_not_found'],
    [404, '<html>missing</html>', 'not_found'],
    [503, 'maintenance', 'server']
  ] as const)('classifies HTTP %s failures as %s', async (status, body, expected) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await new RelayTester().test({ ...relay, protocol: 'chat' });
    expect(result.errorType).toBe(expected);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['ENOTFOUND', 'dns'],
    ['ECONNREFUSED', 'connection'],
    ['CERT_HAS_EXPIRED', 'tls']
  ] as const)('classifies %s network failures', async (code, expected) => {
    const error = Object.assign(new TypeError('fetch failed'), { cause: { code } });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error));
    const result = await new RelayTester().test({ ...relay, protocol: 'chat' });
    expect(result.errorType).toBe(expected);
  });

  it('does not retry Auto mode after authentication or server errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('denied', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await new RelayTester().test(relay);
    expect(result.errorType).toBe('auth');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('classifies timeout and external cancellation without fallback', async () => {
    const abortableFetch = vi.fn((_url: string | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const rejectAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (signal?.aborted) rejectAbort();
        else signal?.addEventListener('abort', rejectAbort, { once: true });
      })
    );
    vi.stubGlobal('fetch', abortableFetch);
    const timedOut = await new RelayTester().test({ ...relay, timeout: 10 });
    expect(timedOut.errorType).toBe('timeout');
    expect(abortableFetch).toHaveBeenCalledTimes(1);

    const controller = new AbortController();
    const cancelledPromise = new RelayTester().test(relay, { signal: controller.signal });
    controller.abort();
    const cancelled = await cancelledPromise;
    expect(cancelled.errorType).toBe('cancelled');
    expect(abortableFetch).toHaveBeenCalledTimes(2);
  });

  it('sanitizes model discovery error bodies', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(`upstream echoed ${relay.apiKey}`, { status: 500 })));
    await expect(new RelayTester().discoverModels(relay)).rejects.not.toThrow(relay.apiKey);
  });
});
