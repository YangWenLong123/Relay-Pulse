import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '../src/lib/http-error.js';
import { PlaygroundService, type PlaygroundFetch } from '../src/services/playground-service.js';
import type { PlaygroundInput, Relay } from '../src/types.js';

const relay = (overrides: Partial<Relay> = {}): Relay => ({
  id: '11111111-1111-4111-8111-111111111111',
  name: '游乐场线路',
  baseUrl: 'https://relay.example.com/v1',
  apiKey: 'sk-private-playground-key',
  model: 'gpt-test',
  platform: 'openai',
  protocol: 'chat',
  enabled: true,
  timeout: 30_000,
  remark: '',
  createdAt: '2026-08-07T00:00:00.000Z',
  updatedAt: '2026-08-07T00:00:00.000Z',
  lastTestAt: null,
  lastTestStatus: 'untested',
  lastLatency: null,
  ...overrides
});

const input: PlaygroundInput = {
  model: 'gpt-test',
  messages: [{ role: 'user', content: '你好' }],
  systemPrompt: '简洁回答',
  temperature: 1,
  topP: 1,
  maxTokens: 1024
};

function sse(events: unknown[]): Response {
  const body = events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}

describe('PlaygroundService', () => {
  it('streams OpenAI Chat Completions deltas and usage', async () => {
    const fetchMock = vi.fn(async (_request: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: `Bearer ${relay().apiKey}` });
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: 'gpt-test',
        messages: [
          { role: 'system', content: '简洁回答' },
          { role: 'user', content: '你好' }
        ],
        stream: true
      });
      return sse([
        { model: 'gpt-test-2026', choices: [{ delta: { content: '你' }, finish_reason: null }] },
        { choices: [{ delta: { content: '好' }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } },
        '[DONE]'
      ]);
    }) as unknown as PlaygroundFetch;
    const service = new PlaygroundService({ fetch: fetchMock });
    const deltas: string[] = [];

    const result = await service.generate(relay(), input, { onDelta: (text) => deltas.push(text) });

    expect(deltas).toEqual(['你', '好']);
    expect(result).toMatchObject({
      protocol: 'chat',
      reportedModel: 'gpt-test-2026',
      finishReason: 'stop',
      usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 }
    });
    expect(fetchMock).toHaveBeenCalledWith('https://relay.example.com/v1/chat/completions', expect.any(Object));
  });

  it('falls back from Responses to Chat for auto protocol', async () => {
    const fetchMock = vi.fn(async (request: string | URL | Request) => {
      if (String(request).endsWith('/responses')) {
        return new Response(JSON.stringify({ error: { message: 'unsupported endpoint' } }), { status: 404 });
      }
      return new Response(JSON.stringify({
        model: 'fallback-model',
        choices: [{ message: { content: '回退成功' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as PlaygroundFetch;
    const service = new PlaygroundService({ fetch: fetchMock });
    const deltas: string[] = [];

    const result = await service.generate(relay({ protocol: 'auto' }), input, { onDelta: (text) => deltas.push(text) });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(deltas).toEqual(['回退成功']);
    expect(result).toMatchObject({ protocol: 'chat', reportedModel: 'fallback-model' });
  });

  it('normalizes Responses and Anthropic stream events', async () => {
    const responsesService = new PlaygroundService({
      fetch: vi.fn(async () => sse([
        { type: 'response.output_text.delta', delta: 'Responses 回复' },
        { type: 'response.completed', response: { model: 'gpt-response', status: 'completed', usage: { input_tokens: 6, output_tokens: 4, total_tokens: 10 } } }
      ])) as unknown as PlaygroundFetch
    });
    const responseDeltas: string[] = [];
    const responseResult = await responsesService.generate(relay({ protocol: 'responses' }), input, {
      onDelta: (text) => responseDeltas.push(text)
    });
    expect(responseDeltas).toEqual(['Responses 回复']);
    expect(responseResult).toMatchObject({ protocol: 'responses', reportedModel: 'gpt-response', finishReason: 'completed' });

    const anthropicService = new PlaygroundService({
      fetch: vi.fn(async (_request: string | URL | Request, init?: RequestInit) => {
        expect(init?.headers).toMatchObject({ 'x-api-key': relay().apiKey, 'anthropic-version': '2023-06-01' });
        return sse([
          { type: 'message_start', message: { model: 'claude-test', usage: { input_tokens: 5 } } },
          { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Claude 回复' } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }
        ]);
      }) as unknown as PlaygroundFetch
    });
    const anthropicDeltas: string[] = [];
    const anthropicResult = await anthropicService.generate(relay({ platform: 'anthropic', protocol: 'auto' }), input, {
      onDelta: (text) => anthropicDeltas.push(text)
    });
    expect(anthropicDeltas).toEqual(['Claude 回复']);
    expect(anthropicResult).toMatchObject({
      protocol: 'anthropic',
      reportedModel: 'claude-test',
      finishReason: 'end_turn',
      usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 }
    });
  });

  it('redacts saved credentials from upstream failures', async () => {
    const target = relay();
    const service = new PlaygroundService({
      fetch: vi.fn(async () => new Response(JSON.stringify({
        error: { message: `bad authorization Bearer ${target.apiKey}` }
      }), { status: 401 })) as unknown as PlaygroundFetch
    });

    await expect(service.generate(target, input)).rejects.toMatchObject({ status: 401 });
    await expect(service.generate(target, input)).rejects.not.toThrow(target.apiKey);
  });

  it('stops an upstream request when the caller aborts', async () => {
    const service = new PlaygroundService({
      fetch: vi.fn(async (_request: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      })) as unknown as PlaygroundFetch
    });
    const controller = new AbortController();
    const pending = service.generate(relay(), input, { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toEqual(expect.objectContaining<HttpError>({ status: 499, message: '模型回复已取消' }));
  });
});
