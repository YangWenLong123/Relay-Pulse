import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCustomPurityTestStream, runPurityTestStream } from '../src/api/purity';
import { http } from '../src/api/http';
import type { PurityTestProgress, PurityTestResult } from '../src/types';

const originalBaseUrl = http.defaults.baseURL;
const encoder = new TextEncoder();

const progress: PurityTestProgress = {
  stage: 'integrity',
  message: '完整性探针完成',
  checks: [],
  requestCount: 1,
  successfulRequests: 1,
  usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
  reportedModels: ['gpt-test'],
  completedChecks: 1,
  totalChecks: 4,
  elapsedMs: 120
};

const result: PurityTestResult = {
  id: 'purity-1',
  relayId: 'relay/1',
  relayName: '测试线路',
  platform: 'openai',
  protocol: 'responses',
  mode: 'quick',
  requestedModel: 'gpt-test',
  reportedModels: ['gpt-test'],
  score: 95,
  verdict: 'high_confidence_normal',
  confidence: 'high',
  summary: '未发现异常',
  checks: [],
  anomalies: [],
  requestCount: 4,
  successfulRequests: 4,
  usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
  totalDuration: 500,
  testedAt: '2026-08-05T00:00:00.000Z',
  disclaimer: '仅供参考'
};

function streamResponse(chunks: Uint8Array[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(chunk));
        controller.close();
      }
    }),
    { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } }
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  http.defaults.baseURL = originalBaseUrl;
});

describe('runPurityTestStream', () => {
  it('delivers progress before resolving the authoritative final result', async () => {
    http.defaults.baseURL = 'http://127.0.0.1:3100/api/';
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(value) {
            controller = value;
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    const onProgress = vi.fn();
    const signal = new AbortController().signal;
    let resolved = false;
    const pending = runPurityTestStream('relay/1', { model: 'gpt-test', mode: 'quick' }, onProgress, signal)
      .finally(() => {
        resolved = true;
      });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.enqueue(encoder.encode(`${JSON.stringify({ type: 'progress', data: progress })}\n`));
    await vi.waitFor(() => expect(onProgress).toHaveBeenCalledWith(progress));
    expect(resolved).toBe(false);

    controller.enqueue(encoder.encode(`${JSON.stringify({ type: 'result', data: result })}\n`));
    controller.close();
    await expect(pending).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3100/api/relays/relay%2F1/purity-test/stream',
      {
        method: 'POST',
        headers: { Accept: 'application/x-ndjson', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-test', mode: 'quick' }),
        signal
      }
    );
  });

  it('reassembles arbitrary byte chunks, including split multibyte text and a final line without newline', async () => {
    const body = [
      JSON.stringify({ type: 'progress', data: progress }),
      JSON.stringify({ type: 'result', data: result })
    ].join('\n');
    const bytes = encoder.encode(body);
    const firstBoundary = bytes.indexOf(0xe5) + 1;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse([
      bytes.slice(0, firstBoundary),
      bytes.slice(firstBoundary, firstBoundary + 2),
      bytes.slice(firstBoundary + 2, bytes.length - 5),
      bytes.slice(bytes.length - 5)
    ])));
    const onProgress = vi.fn();

    await expect(runPurityTestStream('relay-1', { mode: 'quick' }, onProgress)).resolves.toEqual(result);
    expect(onProgress).toHaveBeenCalledOnce();
    expect(onProgress).toHaveBeenCalledWith(progress);
  });

  it.each([
    [new Response(JSON.stringify({ success: false, data: null, message: '线路已停用' }), { status: 409 }), '线路已停用'],
    [new Response('upstream unavailable', { status: 502 }), 'upstream unavailable'],
    [new Response(null, { status: 503 }), '纯度检测请求失败（HTTP 503）']
  ])('reports non-2xx response errors', async (response, message) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(runPurityTestStream('relay-1', {})).rejects.toThrow(message);
  });

  it('reports stream error events and normalizes cancellation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse([
      encoder.encode(`${JSON.stringify({ type: 'error', data: { code: 'test_failed', message: '探针失败' } })}\n`)
    ])));
    await expect(runPurityTestStream('relay-1', {})).rejects.toThrow('探针失败');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse([
      encoder.encode(`${JSON.stringify({ type: 'error', data: { code: 'cancelled', message: '用户取消' } })}\n`)
    ])));
    await expect(runPurityTestStream('relay-1', {})).rejects.toMatchObject({ name: 'AbortError', message: '用户取消' });
  });

  it.each([
    ['not-json\n', '不是有效 JSON'],
    [`${JSON.stringify({ type: 'mystery', data: {} })}\n`, '包含未知事件'],
    [`${JSON.stringify({ type: 'progress' })}\n`, '缺少事件数据']
  ])('rejects malformed stream events', async (body, message) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse([encoder.encode(body)])));
    await expect(runPurityTestStream('relay-1', {})).rejects.toThrow(message);
  });

  it('rejects a missing body or a stream that ends without a result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
    await expect(runPurityTestStream('relay-1', {})).rejects.toThrow('不包含可读取的数据流');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse([
      encoder.encode(`${JSON.stringify({ type: 'progress', data: progress })}\n`)
    ])));
    await expect(runPurityTestStream('relay-1', {})).rejects.toThrow('返回最终结果前已结束');
  });

  it('bounds an unterminated line and honors an already-aborted signal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse([encoder.encode('x'.repeat(1_048_577))])));
    await expect(runPurityTestStream('relay-1', {})).rejects.toThrow('单行数据过大');

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();
    await expect(runPurityTestStream('relay-1', {}, undefined, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('runCustomPurityTestStream', () => {
  it('posts custom credentials in the request body and reuses the NDJSON stream contract', async () => {
    http.defaults.baseURL = 'http://127.0.0.1:3100/api/';
    const value = {
      baseUrl: 'https://custom-relay.example.com/v1',
      apiKey: 'sk-custom-secret',
      model: 'gpt-custom',
      platform: 'openai' as const,
      protocol: 'auto' as const,
      timeout: 45000,
      mode: 'standard' as const
    };
    const onProgress = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(streamResponse([
      encoder.encode(`${JSON.stringify({ type: 'progress', data: progress })}\n`),
      encoder.encode(`${JSON.stringify({ type: 'result', data: result })}\n`)
    ]));
    vi.stubGlobal('fetch', fetchMock);

    await expect(runCustomPurityTestStream(value, onProgress)).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3100/api/purity-test/stream',
      {
        method: 'POST',
        headers: { Accept: 'application/x-ndjson', 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
        signal: undefined
      }
    );
    expect(onProgress).toHaveBeenCalledWith(progress);
    expect(fetchMock.mock.calls[0]?.[0]).not.toContain(value.apiKey);
  });

  it('does not issue a request when the custom test is already aborted', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();

    await expect(runCustomPurityTestStream({
      baseUrl: 'https://custom-relay.example.com',
      apiKey: 'sk-custom-secret',
      model: 'gpt-custom'
    }, undefined, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
