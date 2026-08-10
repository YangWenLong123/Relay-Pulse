import { afterEach, describe, expect, it, vi } from 'vitest';
import { PurityTester } from '../src/services/purity-tester.js';
import type { PurityTestProgress, Relay } from '../src/types.js';

const relay: Relay = {
  id: '7e1c2490-c9ac-4ec7-8630-f02d8f910dab',
  name: '纯度测试线路',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-purity-secret',
  model: 'gpt-4o',
  platform: 'openai',
  protocol: 'chat',
  enabled: true,
  timeout: 1000,
  remark: '',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  lastTestAt: null,
  lastTestStatus: 'untested',
  lastLatency: null
};

function requestBody(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function promptFrom(body: Record<string, unknown>): string {
  if (typeof body.input === 'string') return body.input;
  const messages = body.messages;
  if (!Array.isArray(messages)) return '';
  const first = messages[0];
  return typeof first === 'object' && first !== null && 'content' in first ? String(first.content) : '';
}

function marker(prompt: string, prefix: string): string {
  return prompt.match(new RegExp(`${prefix}[a-f0-9]+`))?.[0] ?? '';
}

function chatPayload(
  content: string,
  id: string,
  usage: Record<string, unknown>,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    object: 'chat.completion',
    model: 'gpt-4o',
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage,
    ...extra
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('PurityTester', () => {
  it('scores a clean OpenAI standard run from independent probes', async () => {
    let call = 0;
    const progress: PurityTestProgress[] = [];
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      call += 1;
      const body = requestBody(init);
      const prompt = promptFrom(body);
      expect(init?.redirect).toBe('manual');
      if (body.tools) {
        const nonce = prompt.match(/nonce "([a-f0-9]+)"/)?.[1] ?? '';
        return new Response(
          JSON.stringify({
            id: `chatcmpl-${call}`,
            object: 'chat.completion',
            model: 'gpt-4o',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    { id: 'call-1', type: 'function', function: { name: 'relay_probe', arguments: JSON.stringify({ nonce, value: 7 }) } }
                  ]
                },
                finish_reason: 'tool_calls'
              }
            ],
            usage: { prompt_tokens: 28, completion_tokens: 8, total_tokens: 36 }
          })
        );
      }
      const isLong = prompt.includes('Token accounting probe');
      const content = isLong
        ? marker(prompt, 'RP_LONG_')
        : prompt.includes('Deterministic relay probe')
          ? marker(prompt, 'RP_STABLE_')
          : marker(prompt, 'RP_OK_');
      const input = isLong ? 104 : prompt.includes('Deterministic relay probe') ? 18 : 12;
      return new Response(JSON.stringify(chatPayload(content, `chatcmpl-${call}`, {
        prompt_tokens: input,
        completion_tokens: 5,
        total_tokens: input + 5
      })));
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new PurityTester().test(relay, {
      mode: 'standard',
      onProgress: (snapshot) => progress.push(snapshot)
    });

    expect(result.requestCount).toBe(5);
    expect(result.successfulRequests).toBe(5);
    expect(result.score).toBe(100);
    expect(result.verdict).toBe('likely_normal');
    expect(result.confidence).toBe('medium');
    expect(progress.map((snapshot) => snapshot.stage)).toEqual([
      'integrity',
      'token_accounting',
      'repeat_stability',
      'capability_checks'
    ]);
    expect(progress.at(-1)).toMatchObject({
      requestCount: 5,
      successfulRequests: 5,
      completedChecks: 6,
      totalChecks: 6,
      usage: result.usage,
      reportedModels: result.reportedModels
    });
    expect(result.checks.filter((check) => check.status === 'pass')).toHaveLength(6);
    expect(result.checks.find((check) => check.id === 'anthropic_thinking_shape')?.status).toBe('skipped');
  });

  it('hard-downgrades an explicit model mismatch and foreign usage fingerprint', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const prompt = promptFrom(requestBody(init));
      const content = prompt.includes('Token accounting probe') ? marker(prompt, 'RP_LONG_') : marker(prompt, 'RP_OK_');
      return new Response(
        JSON.stringify(
          chatPayload(
            content,
            `claude_msg_${fetchMock.mock.calls.length}`,
            { prompt_tokens: prompt.includes('Token accounting probe') ? 100 : 10, completion_tokens: 4, total_tokens: prompt.includes('Token accounting probe') ? 104 : 14, usage_source: `anthropic-${relay.apiKey}` },
            { model: 'claude_3_5_sonnet', [`claude_${relay.apiKey}`]: true }
          )
        )
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new PurityTester().test(relay, { mode: 'quick' });

    expect(result.verdict).toBe('abnormal');
    expect(result.confidence).toBe('low');
    expect(result.checks.find((check) => check.id === 'model_consistency')?.status).toBe('fail');
    expect(result.checks.find((check) => check.id === 'protocol_shape')?.status).toBe('fail');
    expect(result.anomalies.join(' ')).toContain('跨提供商');
    expect(JSON.stringify(result)).not.toContain(relay.apiKey);
  });

  it('redacts credentials echoed in finish reasons and tool names', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = requestBody(init);
      const prompt = promptFrom(body);
      const isLong = prompt.includes('Token accounting probe');
      if (body.tools) {
        return new Response(
          JSON.stringify(
            chatPayload('', `chatcmpl-secret-${fetchMock.mock.calls.length}`, {
              prompt_tokens: 20,
              completion_tokens: 4,
              total_tokens: 24
            }, {
              choices: [{
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [{ function: { name: relay.apiKey, arguments: '{}' } }]
                },
                finish_reason: relay.apiKey
              }]
            })
          )
        );
      }
      return new Response(
        JSON.stringify(
          chatPayload(
            isLong ? marker(prompt, 'RP_LONG_') : marker(prompt, 'RP_OK_'),
            `chatcmpl-secret-${fetchMock.mock.calls.length}`,
            { prompt_tokens: isLong ? 100 : 10, completion_tokens: 4, total_tokens: isLong ? 104 : 14 },
            { choices: [{ message: { role: 'assistant', content: isLong ? marker(prompt, 'RP_LONG_') : marker(prompt, 'RP_OK_') }, finish_reason: relay.apiKey }] }
          )
        )
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new PurityTester().test(relay, { mode: 'standard' });

    expect(JSON.stringify(result)).not.toContain(relay.apiKey);
  });

  it.each([
    ['Claude', 'claude-3-5-sonnet', 'claude_3_5_sonnet', 'anthropic', 'claude_cache_hint'],
    ['Gemini', 'gemini-2-5-pro', 'gemini_2_5_pro', 'google', 'gemini_cache_hint']
  ])('does not flag same-family %s metadata on an OpenAI-compatible wire protocol', async (_name, requested, reported, source, hintField) => {
    const compatibleRelay: Relay = { ...relay, model: requested };
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const prompt = promptFrom(requestBody(init));
      const isLong = prompt.includes('Token accounting probe');
      const input = isLong ? 100 : 10;
      return new Response(
        JSON.stringify(
          chatPayload(
            isLong ? marker(prompt, 'RP_LONG_') : marker(prompt, 'RP_OK_'),
            `${reported}_msg_${fetchMock.mock.calls.length}`,
            { prompt_tokens: input, completion_tokens: 4, total_tokens: input + 4, usage_source: source },
            { model: reported, [hintField]: true }
          )
        )
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new PurityTester().test(compatibleRelay);

    expect(result.score).not.toBeNull();
    expect(result.checks.find((check) => check.id === 'protocol_shape')?.summary).not.toContain('其他提供商');
    expect(result.anomalies.join(' ')).not.toContain('跨提供商');
  });

  it('uses modern Chat token limits without temperature for GPT-5 dot releases', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = requestBody(init);
      const prompt = promptFrom(body);
      expect(body.temperature).toBeUndefined();
      expect(body.max_tokens).toBeUndefined();
      expect(body.max_completion_tokens).toBe(512);
      expect(body.reasoning_effort).toBe('low');
      const isLong = prompt.includes('Token accounting probe');
      const input = isLong ? 100 : 10;
      return new Response(
        JSON.stringify({
          ...chatPayload(isLong ? marker(prompt, 'RP_LONG_') : marker(prompt, 'RP_OK_'), `chatcmpl-${fetchMock.mock.calls.length}`, {
            prompt_tokens: input,
            completion_tokens: 4,
            total_tokens: input + 4
          }),
          model: 'gpt-5.6'
        })
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new PurityTester().test({ ...relay, model: 'gpt-5.6' });

    expect(result.verdict).toBe('likely_normal');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses a larger low-effort budget for modern Responses probes', async () => {
    const responsesRelay: Relay = { ...relay, protocol: 'responses', model: 'gpt-5' };
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = requestBody(init);
      const prompt = promptFrom(body);
      expect(body.max_output_tokens).toBe(512);
      expect(body.reasoning).toEqual({ effort: 'low' });
      const isLong = prompt.includes('Token accounting probe');
      const input = isLong ? 100 : 10;
      const content = isLong ? marker(prompt, 'RP_LONG_') : marker(prompt, 'RP_OK_');
      return new Response(
        JSON.stringify({
          id: `resp_${fetchMock.mock.calls.length}`,
          object: 'response',
          status: 'completed',
          model: 'gpt-5',
          output: [{ type: 'message', content: [{ type: 'output_text', text: content }] }],
          usage: { input_tokens: input, output_tokens: 4, total_tokens: input + 4 }
        })
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new PurityTester().test(responsesRelay);

    expect(result.verdict).toBe('likely_normal');
    expect(result.successfulRequests).toBe(2);
  });

  it('caps the verdict when a small probe reports an implausible absolute token count', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const prompt = promptFrom(requestBody(init));
      const isLong = prompt.includes('Token accounting probe');
      const content = isLong ? marker(prompt, 'RP_LONG_') : marker(prompt, 'RP_OK_');
      return new Response(
        JSON.stringify(chatPayload(content, `chatcmpl-${fetchMock.mock.calls.length}`, {
          prompt_tokens: isLong ? 1_000_090 : 1_000_000,
          completion_tokens: 4,
          total_tokens: isLong ? 1_000_094 : 1_000_004
        }))
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new PurityTester().test(relay, { mode: 'quick' });

    expect(['suspicious', 'abnormal']).toContain(result.verdict);
    expect(result.checks.find((check) => check.id === 'token_accounting')?.status).toBe('fail');
    expect(result.anomalies.join(' ')).toContain('严重异常');
  });

  it('does not pass a 50k-token claim for a small controlled probe', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const prompt = promptFrom(requestBody(init));
      const isLong = prompt.includes('Token accounting probe');
      const input = isLong ? 50_090 : 50_000;
      return new Response(
        JSON.stringify(chatPayload(isLong ? marker(prompt, 'RP_LONG_') : marker(prompt, 'RP_OK_'), `chatcmpl-${fetchMock.mock.calls.length}`, {
          prompt_tokens: input,
          completion_tokens: 4,
          total_tokens: input + 4
        }))
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new PurityTester().test(relay);

    expect(result.checks.find((check) => check.id === 'token_accounting')?.status).toBe('fail');
    expect(['suspicious', 'abnormal']).toContain(result.verdict);
  });

  it('returns inconclusive when quick mode completes fewer than both required probes', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        call += 1;
        if (call === 2) return new Response('upstream unavailable', { status: 503 });
        const prompt = promptFrom(requestBody(init));
        return new Response(
          JSON.stringify(chatPayload(marker(prompt, 'RP_OK_'), 'chatcmpl-coverage-1', {
            prompt_tokens: 10,
            completion_tokens: 4,
            total_tokens: 14
          }))
        );
      })
    );

    const result = await new PurityTester().test(relay);

    expect(result.score).toBeNull();
    expect(result.verdict).toBe('inconclusive');
    expect(result.successfulRequests).toBe(1);
    expect(result.checks.length).toBeGreaterThan(0);
  });

  it('requires at least three successful standard probes but tolerates one optional failure', async () => {
    const runWithSuccessfulCalls = async (successfulCalls: number) => {
      let call = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string | URL, init?: RequestInit) => {
          call += 1;
          if (call > successfulCalls) return new Response('upstream unavailable', { status: 503 });
          const prompt = promptFrom(requestBody(init));
          const isLong = prompt.includes('Token accounting probe');
          const content = isLong
            ? marker(prompt, 'RP_LONG_')
            : prompt.includes('Deterministic relay probe')
              ? marker(prompt, 'RP_STABLE_')
              : marker(prompt, 'RP_OK_');
          const input = isLong ? 100 : 10;
          return new Response(
            JSON.stringify(chatPayload(content, `chatcmpl-coverage-${call}`, {
              prompt_tokens: input,
              completion_tokens: 4,
              total_tokens: input + 4
            }))
          );
        })
      );
      return new PurityTester().test(relay, { mode: 'standard' });
    };

    const insufficient = await runWithSuccessfulCalls(2);
    expect(insufficient.score).toBeNull();
    expect(insufficient.verdict).toBe('inconclusive');

    const oneOptionalFailure = await runWithSuccessfulCalls(4);
    expect(oneOptionalFailure.score).not.toBeNull();
    expect(oneOptionalFailure.verdict).not.toBe('inconclusive');
    expect(oneOptionalFailure.checks.find((check) => check.id === 'tool_passthrough')?.status).toBe('warning');
  });

  it('treats output-budget exhaustion as insufficient evidence', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        const prompt = promptFrom(requestBody(init));
        return new Response(
          JSON.stringify({
            ...chatPayload(marker(prompt, 'RP_OK_'), 'chatcmpl-short', {
              prompt_tokens: 10,
              completion_tokens: 512,
              total_tokens: 522
            }),
            choices: [{ message: { role: 'assistant', content: marker(prompt, 'RP_OK_') }, finish_reason: 'length' }]
          })
        );
      })
    );

    const result = await new PurityTester().test({ ...relay, model: 'gpt-5' });

    expect(result.score).toBeNull();
    expect(result.verdict).toBe('inconclusive');
    expect(result.summary).toContain('证据不足');
    expect(result.successfulRequests).toBe(0);
  });

  it('flags text-bearing chat payloads that omit core protocol metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        const prompt = promptFrom(requestBody(init));
        const content = prompt.includes('Token accounting probe') ? marker(prompt, 'RP_LONG_') : marker(prompt, 'RP_OK_');
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
      })
    );

    const result = await new PurityTester().test(relay);

    expect(result.checks.find((check) => check.id === 'protocol_shape')?.status).toBe('fail');
    expect(result.verdict).toBe('suspicious');
  });

  it('returns an inconclusive null score for an initial upstream limit failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: `quota exhausted ${relay.apiKey}` } }), { status: 429 }))
    );

    const result = await new PurityTester().test(relay, { mode: 'standard' });

    expect(result.score).toBeNull();
    expect(result.verdict).toBe('inconclusive');
    expect(result.requestCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain(relay.apiKey);
  });

  it('reports Anthropic thinking signatures as a shape signal only', async () => {
    let call = 0;
    const anthropicRelay: Relay = {
      ...relay,
      platform: 'anthropic',
      protocol: 'auto',
      model: 'claude-sonnet-4-20250514'
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        call += 1;
        const body = requestBody(init);
        const prompt = promptFrom(body);
        const usage = { input_tokens: prompt.includes('Token accounting probe') ? 105 : 14, output_tokens: 5 };
        let content: unknown[];
        if (body.tools) {
          const nonce = prompt.match(/nonce "([a-f0-9]+)"/)?.[1] ?? '';
          content = [{ type: 'tool_use', id: 'toolu-1', name: 'relay_probe', input: { nonce, value: 7 } }];
        } else if (body.thinking) {
          content = [
            { type: 'thinking', thinking: 'A short internal step.', signature: 'signed-shape-value-1234567890-abcdefghijklmnopqrstuvwxyz-ABCDE' },
            { type: 'text', text: marker(prompt, 'RP_THINK_') }
          ];
        } else {
          const text = prompt.includes('Token accounting probe')
            ? marker(prompt, 'RP_LONG_')
            : prompt.includes('Deterministic relay probe')
              ? marker(prompt, 'RP_STABLE_')
              : marker(prompt, 'RP_OK_');
          content = [{ type: 'text', text }];
        }
        return new Response(
          JSON.stringify({
            id: `msg_${call}`,
            type: 'message',
            role: 'assistant',
            model: anthropicRelay.model,
            content,
            stop_reason: body.tools ? 'tool_use' : 'end_turn',
            usage
          })
        );
      })
    );

    const result = await new PurityTester().test(anthropicRelay, { mode: 'standard' });
    const thinking = result.checks.find((check) => check.id === 'anthropic_thinking_shape');

    expect(result.requestCount).toBe(6);
    expect(result.confidence).toBe('high');
    expect(result.verdict).toBe('high_confidence_normal');
    expect(result.usage.totalTokens).toBe((14 + 5) * 5 + (105 + 5));
    expect(thinking?.status).toBe('pass');
    expect(thinking?.evidence.join(' ')).toContain('不验证签名真伪');
  });

  it('never grants high confidence when Anthropic tool and thinking probes time out', async () => {
    let call = 0;
    const anthropicRelay: Relay = {
      ...relay,
      platform: 'anthropic',
      protocol: 'auto',
      model: 'claude-sonnet-4-20250514',
      timeout: 10
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        call += 1;
        const body = requestBody(init);
        if (body.tools || body.thinking) {
          return new Promise<Response>((_resolve, reject) => {
            const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            if (init?.signal?.aborted) abort();
            else init?.signal?.addEventListener('abort', abort, { once: true });
          });
        }
        const prompt = promptFrom(body);
        const isLong = prompt.includes('Token accounting probe');
        const text = isLong
          ? marker(prompt, 'RP_LONG_')
          : prompt.includes('Deterministic relay probe')
            ? marker(prompt, 'RP_STABLE_')
            : marker(prompt, 'RP_OK_');
        const input = isLong ? 105 : 14;
        return new Response(
          JSON.stringify({
            id: `msg_timeout_${call}`,
            type: 'message',
            role: 'assistant',
            model: anthropicRelay.model,
            content: [{ type: 'text', text }],
            stop_reason: 'end_turn',
            usage: { input_tokens: input, output_tokens: 5 }
          })
        );
      })
    );

    const result = await new PurityTester().test(anthropicRelay, { mode: 'standard' });

    expect(result.successfulRequests).toBe(4);
    expect(result.score).not.toBeNull();
    expect(result.confidence).toBe('medium');
    expect(result.verdict).not.toBe('high_confidence_normal');
    expect(result.checks.find((check) => check.id === 'tool_passthrough')?.status).toBe('warning');
    expect(result.checks.find((check) => check.id === 'anthropic_thinking_shape')?.status).toBe('warning');
  });
});
