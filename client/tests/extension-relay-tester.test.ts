import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExtensionRelayTester, extractModelIds, extractResponseText } from '../src/extension/relay-tester';
import type { StoredRelay } from '../src/extension/relay-utils';

const relay: StoredRelay = {
  id: 'relay-1',
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

afterEach(() => vi.restoreAllMocks());

describe('extension response parsing', () => {
  it('parses common chat, Responses, and model list payloads', () => {
    expect(extractResponseText({ choices: [{ message: { content: 'hello' } }] })).toBe('hello');
    expect(extractResponseText({ output: [{ content: [{ type: 'output_text', text: 'world' }] }] })).toBe('world');
    expect(extractResponseText({ output_text: 'direct' })).toBe('direct');
    expect(extractModelIds({ data: [{ id: 'gpt-b' }, { id: 'gpt-a' }] })).toEqual(['gpt-a', 'gpt-b']);
    expect(extractModelIds({ models: ['gpt-c', { name: 'gpt-d' }] })).toEqual(['gpt-c', 'gpt-d']);
  });
});

describe('ExtensionRelayTester', () => {
  it('binds the default fetch implementation to the global receiver', async () => {
    const originalFetch = globalThis.fetch;
    const boundFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'gpt-a' }] }), { status: 200 }));
    globalThis.fetch = boundFetch as typeof fetch;
    try {
      await expect(new ExtensionRelayTester().discoverModels(relay)).resolves.toEqual(['gpt-a']);
      expect(boundFetch).toHaveBeenCalledWith(
        'https://api.example.com/v1/models',
        expect.objectContaining({ headers: expect.any(Object) })
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('falls back from Responses to Chat Completions in auto mode', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"error":"unsupported"}', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '你好' } }] }), { status: 200 }));
    const result = await new ExtensionRelayTester(fetchMock).test(relay);
    expect(result.success).toBe(true);
    expect(result.protocol).toBe('chat');
    expect(result.responseText).toBe('你好');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('classifies authentication errors without exposing the key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(`invalid ${relay.apiKey}`, { status: 401 }));
    const result = await new ExtensionRelayTester(fetchMock).test({ ...relay, protocol: 'chat' });
    expect(result.errorType).toBe('auth');
    expect(result.errorMessage).not.toContain(relay.apiKey);
  });

  it.each([
    [429, '{"error":{"message":"quota"}}', 'rate_limit'],
    [400, '{"error":{"message":"model gpt-test does not exist"}}', 'model_not_found'],
    [404, '<html>missing</html>', 'not_found'],
    [503, 'maintenance', 'server']
  ] as const)('classifies HTTP %s as %s', async (status, body, expected) => {
    const result = await new ExtensionRelayTester(vi.fn().mockResolvedValue(new Response(body, { status }))).test({
      ...relay,
      protocol: 'chat'
    });
    expect(result.errorType).toBe(expected);
  });

  it('rejects non-JSON success responses and parses model discovery', async () => {
    const invalid = await new ExtensionRelayTester(vi.fn().mockResolvedValue(new Response('plain text', { status: 200 }))).test({
      ...relay,
      protocol: 'chat'
    });
    expect(invalid.errorType).toBe('invalid_response');

    const tester = new ExtensionRelayTester(
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'gpt-a' }] }), { status: 200 }))
    );
    await expect(tester.discoverModels(relay)).resolves.toEqual(['gpt-a']);
  });

  it('classifies timeout and external cancellation', async () => {
    const abortableFetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const rejectAbort = () => reject(new DOMException('aborted', 'AbortError'));
        if (init?.signal?.aborted) rejectAbort();
        else init?.signal?.addEventListener('abort', rejectAbort, { once: true });
      })
    );
    const tester = new ExtensionRelayTester(abortableFetch);
    expect((await tester.test({ ...relay, timeout: 5 })).errorType).toBe('timeout');
    const controller = new AbortController();
    const pending = tester.test(relay, { signal: controller.signal });
    controller.abort();
    expect((await pending).errorType).toBe('cancelled');
  });
});
