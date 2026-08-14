import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamPlaygroundReply } from '../src/api/playground';
import { extensionAccessTokenHeader, http, setHttpApiBaseUrl } from '../src/api/http';
import type { PlaygroundCompletion, PlaygroundInput } from '../src/types';

const originalBaseUrl = http.defaults.baseURL;
const originalExtensionToken = http.defaults.headers.common[extensionAccessTokenHeader];
const encoder = new TextEncoder();
const input: PlaygroundInput = {
  model: 'gpt-test',
  messages: [{ role: 'user', content: '你好' }],
  systemPrompt: '',
  temperature: 1,
  topP: 1,
  maxTokens: 1024
};
const completion: PlaygroundCompletion = {
  relayId: 'relay/1',
  relayName: '对话线路',
  requestedModel: 'gpt-test',
  reportedModel: 'gpt-test-reported',
  protocol: 'chat',
  finishReason: 'stop',
  usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
  durationMs: 120
};

function streamResponse(chunks: Uint8Array[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(chunk));
      controller.close();
    }
  }), { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  http.defaults.baseURL = originalBaseUrl;
  if (originalExtensionToken === undefined) delete http.defaults.headers.common[extensionAccessTokenHeader];
  else http.defaults.headers.common[extensionAccessTokenHeader] = originalExtensionToken;
});

describe('streamPlaygroundReply', () => {
  it('delivers deltas before resolving the completion metadata', async () => {
    const extensionToken = 'a'.repeat(43);
    setHttpApiBaseUrl('http://127.0.0.1:3100/api/', extensionToken);
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const fetchMock = vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      }
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const onDelta = vi.fn();
    let resolved = false;
    const pending = streamPlaygroundReply('relay/1', input, onDelta).finally(() => {
      resolved = true;
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    streamController.enqueue(encoder.encode(`${JSON.stringify({ type: 'delta', data: { text: '实时' } })}\n`));
    await vi.waitFor(() => expect(onDelta).toHaveBeenCalledWith('实时'));
    expect(resolved).toBe(false);
    streamController.enqueue(encoder.encode(`${JSON.stringify({ type: 'done', data: completion })}\n`));
    streamController.close();

    await expect(pending).resolves.toEqual(completion);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:3100/api/relays/relay%2F1/playground/stream', {
      method: 'POST',
      headers: {
        Accept: 'application/x-ndjson',
        'Content-Type': 'application/json',
        [extensionAccessTokenHeader]: extensionToken
      },
      body: JSON.stringify(input),
      signal: undefined
    });
  });

  it('reassembles arbitrary byte chunks including multibyte text', async () => {
    const body = [
      JSON.stringify({ type: 'delta', data: { text: '你好' } }),
      JSON.stringify({ type: 'done', data: completion })
    ].join('\n');
    const bytes = encoder.encode(body);
    const boundary = bytes.indexOf(0xe4) + 1;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse([
      bytes.slice(0, boundary),
      bytes.slice(boundary, boundary + 2),
      bytes.slice(boundary + 2)
    ])));
    const onDelta = vi.fn();

    await expect(streamPlaygroundReply('relay-1', input, onDelta)).resolves.toEqual(completion);
    expect(onDelta).toHaveBeenCalledWith('你好');
  });

  it.each([
    [new Response(JSON.stringify({ success: false, data: null, message: '线路已停用' }), { status: 409 }), '线路已停用'],
    [new Response('upstream unavailable', { status: 502 }), 'upstream unavailable'],
    [new Response(null, { status: 503 }), '游乐场请求失败（HTTP 503）']
  ])('reports non-2xx failures', async (response, message) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(streamPlaygroundReply('relay-1', input)).rejects.toThrow(message);
  });

  it('normalizes stream failures and cancellation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse([
      encoder.encode(`${JSON.stringify({ type: 'error', data: { code: 'generation_failed', message: '上游失败' } })}\n`)
    ])));
    await expect(streamPlaygroundReply('relay-1', input)).rejects.toThrow('上游失败');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse([
      encoder.encode(`${JSON.stringify({ type: 'error', data: { code: 'cancelled', message: '已停止' } })}\n`)
    ])));
    await expect(streamPlaygroundReply('relay-1', input)).rejects.toMatchObject({ name: 'AbortError', message: '已停止' });
  });

  it('rejects malformed or incomplete streams', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse([encoder.encode('not-json\n')])));
    await expect(streamPlaygroundReply('relay-1', input)).rejects.toThrow('不是有效 JSON');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse([
      encoder.encode(`${JSON.stringify({ type: 'delta', data: { text: '未完成' } })}\n`)
    ])));
    await expect(streamPlaygroundReply('relay-1', input)).rejects.toThrow('完成前已结束');
  });

  it('does not issue a request after cancellation', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();

    await expect(streamPlaygroundReply('relay-1', input, undefined, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
