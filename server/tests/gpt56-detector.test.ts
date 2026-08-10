import { afterEach, describe, expect, it, vi } from 'vitest';
import { PurityTester } from '../src/services/purity-tester.js';
import type { PurityTestProgress, Relay } from '../src/types.js';

const candidateRelay: Relay = {
  id: '84a50393-152a-4f2f-bb5a-81a068b08ee9',
  name: 'GPT-5.6 candidate',
  baseUrl: 'https://candidate.example.com/v1',
  apiKey: 'sk-candidate-deep-secret',
  model: 'gpt-5.6',
  platform: 'openai',
  protocol: 'responses',
  enabled: true,
  timeout: 1_000,
  remark: '',
  createdAt: '2026-08-07T00:00:00.000Z',
  updatedAt: '2026-08-07T00:00:00.000Z',
  lastTestAt: null,
  lastTestStatus: 'untested',
  lastLatency: null
};

type CandidateVariant = 'full' | 'without_ids' | 'message_only' | 'corrupted_ciphertext';
type JuiceEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

interface MockOptions {
  negativeControlHit?: boolean;
  positiveSuccesses?: Partial<Record<Extract<CandidateVariant, 'full' | 'without_ids'>, number>>;
  rejectFirstTrustedSeed?: boolean;
  literalNetworkError?: boolean;
  literalRewrite?: boolean;
  unsupportedCandidateResponses?: boolean;
  juiceAnswers?: Partial<Record<JuiceEffort, string[]>>;
}

interface SourceMetrics {
  requestCount: number;
  successfulRequests: number;
  totalTokens: number;
}

interface MockTracker {
  candidate: SourceMetrics;
  trusted: SourceMetrics;
}

interface ResponseUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

function requestBody(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function inputItems(body: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(body.input)
    ? body.input.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item))
    : [];
}

function inputText(body: Record<string, unknown>): string {
  return inputItems(body)
    .map((item) => typeof item.content === 'string' ? item.content : '')
    .filter(Boolean)
    .join('\n');
}

function outputPayload(
  text: string,
  output: Record<string, unknown>[],
  model = 'gpt-5.6',
  usage: ResponseUsage = { input_tokens: 12, output_tokens: 4, total_tokens: 16 }
): Response {
  return new Response(JSON.stringify({
    id: 'resp_mock',
    object: 'response',
    status: 'completed',
    model,
    output_text: text,
    output,
    usage
  }));
}

function transformExpected(prompt: string): string {
  const value = prompt.match(/\b\d{10}\b/)?.[0] ?? '1234567891';
  if (prompt.includes('reversing')) return value.split('').reverse().join('');
  if (prompt.includes('moving its first three')) return `${value.slice(3)}${value.slice(0, 3)}`;
  return value.split('').map((digit) => `${9 - Number(digit)}`).join('');
}

function installResponsesMock(options: MockOptions = {}): MockTracker {
  const states = new Map<string, string>();
  const candidateVariantAttempts: Partial<Record<CandidateVariant, number>> = {};
  const juiceAnswerIndexes: Partial<Record<JuiceEffort, number>> = {};
  const tracker: MockTracker = {
    candidate: { requestCount: 0, successfulRequests: 0, totalTokens: 0 },
    trusted: { requestCount: 0, successfulRequests: 0, totalTokens: 0 }
  };
  let seedCounter = 0;
  let latestExpected = '';
  let literalResponses = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    const body = requestBody(init);
    const text = inputText(body);
    const isTrusted = String(url).includes('trusted.example.com');
    const source = isTrusted ? tracker.trusted : tracker.candidate;
    const usage: ResponseUsage = isTrusted
      ? { input_tokens: 100, output_tokens: 25, total_tokens: 125 }
      : { input_tokens: 7, output_tokens: 3, total_tokens: 10 };
    const model = isTrusted ? 'trusted-observed-model' : 'candidate-observed-model';
    const successfulResponse = (answer: string, output: Record<string, unknown>[]): Response => {
      source.successfulRequests += 1;
      source.totalTokens += usage.total_tokens;
      return outputPayload(answer, output, model, usage);
    };

    source.requestCount += 1;
    if (!isTrusted && options.unsupportedCandidateResponses) {
      return new Response(JSON.stringify({ error: { message: 'Responses endpoint unsupported' } }), { status: 404 });
    }

    const isRecall = text.includes('Return the exact ten-digit value B');

    if (isRecall) {
      const items = inputItems(body);
      const reasoning = items.find((item) => item.type === 'reasoning');
      const encrypted = typeof reasoning?.encrypted_content === 'string' ? reasoning.encrypted_content : '';
      const expected = states.get(encrypted) ?? latestExpected;
      const isMessageOnly = !reasoning;
      const variant: CandidateVariant = isMessageOnly
        ? 'message_only'
        : encrypted && states.has(encrypted)
          ? typeof reasoning?.id === 'string' ? 'full' : 'without_ids'
          : 'corrupted_ciphertext';
      const allowedPositiveSuccesses = options.positiveSuccesses?.[variant as 'full' | 'without_ids'];
      const attempt = (candidateVariantAttempts[variant] ?? 0) + 1;
      candidateVariantAttempts[variant] = attempt;
      const positive = isTrusted
        || (variant === 'message_only' && options.negativeControlHit)
        || ((variant === 'full' || variant === 'without_ids')
          && (allowedPositiveSuccesses === undefined || attempt <= allowedPositiveSuccesses));
      const answer = positive ? expected : 'UNKNOWN';
      return successfulResponse(answer, [{ type: 'message', content: [{ type: 'output_text', text: answer }] }]);
    }

    const reasoning = body.reasoning as Record<string, unknown> | undefined;
    if (text.includes('In hidden reasoning')) {
      const expected = transformExpected(text);
      latestExpected = expected;
      seedCounter += 1;
      if (options.rejectFirstTrustedSeed && seedCounter === 1) {
        return successfulResponse('READY', [{ id: 'msg_rejected', type: 'message', content: [{ type: 'output_text', text: 'READY' }] }]);
      }
      const encrypted = `ciphertext-${seedCounter}`;
      states.set(encrypted, expected);
      return successfulResponse('READY', [
        { id: `rs_${seedCounter}`, type: 'reasoning', encrypted_content: encrypted },
        { id: `msg_${seedCounter}`, type: 'message', content: [{ type: 'output_text', text: 'READY' }] }
      ]);
    }
    const isLiteralControl = (reasoning?.effort === 'high' && text.includes('Output integrity check')) || text.includes('For control') || text.includes('"control"');
    if (isLiteralControl) {
      if (options.literalNetworkError) {
        return new Response(JSON.stringify({ error: { message: 'temporary upstream outage' } }), { status: 503 });
      }
      const expected = text.match(/(?:digits |value as the entire response: |Return only )(32|48)/)?.[1] ?? '32';
      const answer = options.literalRewrite && literalResponses++ === 0 ? `${expected} rewritten` : expected;
      return successfulResponse(answer, [{ type: 'message', content: [{ type: 'output_text', text: answer }] }]);
    }
    const isJuiceRequest = text.includes('Juice') || text.includes('Valid Channels');
    if (isJuiceRequest && reasoning && ['low', 'medium', 'high', 'xhigh', 'max'].includes(String(reasoning.effort))) {
      const effort = String(reasoning.effort) as JuiceEffort;
      const configured = options.juiceAnswers?.[effort];
      const index = juiceAnswerIndexes[effort] ?? 0;
      juiceAnswerIndexes[effort] = index + 1;
      const values: Record<JuiceEffort, string> = { low: '8', medium: '16', high: '40', xhigh: '128', max: '960' };
      const answer = configured?.[index] ?? configured?.at(-1) ?? values[effort];
      return successfulResponse(answer, [{ type: 'message', content: [{ type: 'output_text', text: answer }] }]);
    }

    return successfulResponse('READY', [{ type: 'message', content: [{ type: 'output_text', text: 'READY' }] }]);
  }));
  return tracker;
}

afterEach(() => vi.unstubAllGlobals());

describe('GPT-5.6 deep detector', () => {
  it('streams redacted encrypted controls and classifies a consistent auxiliary fingerprint', async () => {
    installResponsesMock();
    const progress: PurityTestProgress[] = [];

    const result = await new PurityTester().test(candidateRelay, {
      mode: 'gpt56',
      gpt56: {
        trials: 3,
        trustedReference: {
          baseUrl: 'https://trusted.example.com/v1',
          apiKey: 'sk-trusted-deep-secret',
          model: 'gpt-5.6'
        }
      },
      onProgress: (snapshot) => progress.push(snapshot)
    });

    expect(result.mode).toBe('gpt56');
    expect(result.verdict).toBe('gpt56_auxiliary');
    expect(result.gpt56).toMatchObject({
      encrypted: {
        status: 'preliminary_compatible',
        attempts: 3,
        fullExact: 3,
        withoutIdsExact: 3,
        messageOnlyExact: 0,
        corruptedCiphertextExact: 0
      },
      juice: { status: 'fingerprint', likelyModel: 'gpt_5_6_sol' },
      literalControl: { status: 'passed', exact: 2 },
      network: { errorCount: 0 }
    });
    expect(progress.some((snapshot) => snapshot.stage === 'encrypted_controls')).toBe(true);
    expect(progress.some((snapshot) => snapshot.stage === 'juice_fingerprint')).toBe(true);
    expect(progress.at(-1)?.stage).toBe('finalizing');
    expect(progress.at(-1)?.gpt56?.encrypted.fullExact).toBe(3);

    const exposed = JSON.stringify({ result, progress });
    expect(exposed).not.toContain(candidateRelay.apiKey);
    expect(exposed).not.toContain('sk-trusted-deep-secret');
    expect(exposed).not.toContain('ciphertext-');
  });

  it('rejects an encrypted-state result when a negative control returns the hidden answer', async () => {
    installResponsesMock({ negativeControlHit: true });

    const result = await new PurityTester().test(candidateRelay, {
      mode: 'gpt56',
      gpt56: {
        trials: 3,
        trustedReference: {
          baseUrl: 'https://trusted.example.com/v1',
          apiKey: 'sk-trusted-deep-secret',
          model: 'gpt-5.6'
        }
      }
    });

    expect(result.verdict).toBe('gpt56_inconsistent');
    expect(result.gpt56?.encrypted.status).toBe('suspicious');
    expect(result.gpt56?.encrypted.messageOnlyExact).toBeGreaterThan(0);
  });

  it('keeps juice-only mode explicitly auxiliary and rejects Chat Completions targets', async () => {
    installResponsesMock();
    const juiceOnly = await new PurityTester().test(candidateRelay, { mode: 'gpt56', gpt56: { trials: 3 } });
    expect(juiceOnly.verdict).toBe('gpt56_auxiliary');
    expect(juiceOnly.gpt56?.encrypted.status).toBe('not_run');

    const unsupported = await new PurityTester().test({ ...candidateRelay, protocol: 'chat' }, { mode: 'gpt56' });
    expect(unsupported.verdict).toBe('inconclusive');
    expect(unsupported.requestCount).toBe(0);
    expect(unsupported.checks[0]?.id).toBe('gpt56_responses_requirement');
  });

  it('replenishes discarded trusted seeds and marks a declared model variant mismatch as inconsistent', async () => {
    installResponsesMock({ rejectFirstTrustedSeed: true });
    const replenished = await new PurityTester().test(candidateRelay, {
      mode: 'gpt56',
      gpt56: {
        trials: 3,
        trustedReference: {
          baseUrl: 'https://trusted.example.com/v1',
          apiKey: 'sk-trusted-deep-secret',
          model: 'gpt-5.6'
        }
      }
    });
    expect(replenished.gpt56?.encrypted).toMatchObject({ attempts: 3, trustedRejected: 1, status: 'preliminary_compatible' });

    installResponsesMock();
    const mismatch = await new PurityTester().test({ ...candidateRelay, model: 'gpt-5.6-luna' }, { mode: 'gpt56', gpt56: { trials: 3 } });
    expect(mismatch.verdict).toBe('gpt56_inconsistent');
    expect(mismatch.anomalies.join(' ')).toContain('型号分支');
  });

  it('keeps literal controls inconclusive when their requests fail on the network', async () => {
    installResponsesMock({ literalNetworkError: true });

    const result = await new PurityTester().test(candidateRelay, {
      mode: 'gpt56',
      gpt56: { trials: 3 }
    });

    expect(result.gpt56?.literalControl).toMatchObject({
      status: 'inconclusive',
      completed: 2,
      exact: 0,
      errors: 2
    });
    expect(result.checks.find((item) => item.id === 'gpt56_literal_control')?.status).toBe('warning');
  });

  it('does not treat a preliminary Juice hint as a model-branch mismatch', async () => {
    installResponsesMock({
      juiceAnswers: {
        low: ['999'],
        medium: ['999'],
        high: ['40', '999', '999'],
        xhigh: ['999'],
        max: ['999']
      }
    });

    const result = await new PurityTester().test(
      { ...candidateRelay, model: 'gpt-5.6-luna' },
      { mode: 'gpt56', gpt56: { trials: 3 } }
    );

    expect(result.gpt56?.juice).toMatchObject({
      status: 'preliminary',
      likelyModel: 'gpt_5_6_sol',
      confidence: 'preliminary'
    });
    expect(result.verdict).not.toBe('gpt56_inconsistent');
    expect(result.anomalies.join(' ')).not.toContain('型号分支');
  });

  it('reports only candidate endpoint metrics when a trusted reference is used', async () => {
    const tracker = installResponsesMock();

    const result = await new PurityTester().test(candidateRelay, {
      mode: 'gpt56',
      gpt56: {
        trials: 3,
        trustedReference: {
          baseUrl: 'https://trusted.example.com/v1',
          apiKey: 'sk-trusted-deep-secret',
          model: 'gpt-5.6'
        }
      }
    });

    expect(result.requestCount).toBe(tracker.candidate.requestCount);
    expect(result.successfulRequests).toBe(tracker.candidate.successfulRequests);
    expect(result.usage.totalTokens).toBe(tracker.candidate.totalTokens);
    expect(result.reportedModels).toEqual(['candidate-observed-model']);
    expect(result.reportedModels).not.toContain('trusted-observed-model');
    expect(result.gpt56?.network).toMatchObject({
      requestCount: tracker.candidate.requestCount,
      successfulRequests: tracker.candidate.successfulRequests,
      errorCount: 0
    });
  });

  it('stops after a Responses preflight failure instead of running downstream probes', async () => {
    const tracker = installResponsesMock({ unsupportedCandidateResponses: true });

    const result = await new PurityTester().test(candidateRelay, {
      mode: 'gpt56',
      gpt56: { trials: 3 }
    });

    expect(tracker.candidate.requestCount).toBe(1);
    expect(result).toMatchObject({
      verdict: 'inconclusive',
      requestCount: 1,
      successfulRequests: 0
    });
    expect(result.summary).toMatch(/Responses/i);
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'gpt56_responses_preflight', status: 'fail' })
    ]));
    expect(result.gpt56?.juice.observations).toHaveLength(0);
    expect(result.gpt56?.literalControl).toMatchObject({ status: 'not_run', completed: 0 });
  });

  it('keeps partial encrypted positive evidence inconclusive instead of rejecting compatibility', async () => {
    installResponsesMock({ positiveSuccesses: { full: 1, without_ids: 1 } });

    const result = await new PurityTester().test(candidateRelay, {
      mode: 'gpt56',
      gpt56: {
        trials: 3,
        trustedReference: {
          baseUrl: 'https://trusted.example.com/v1',
          apiKey: 'sk-trusted-deep-secret',
          model: 'gpt-5.6'
        }
      }
    });

    expect(result.gpt56?.encrypted).toMatchObject({
      status: 'inconclusive'
    });
    expect((result.gpt56?.encrypted.fullExact ?? 0) + (result.gpt56?.encrypted.withoutIdsExact ?? 0)).toBeGreaterThan(0);
    expect(result.gpt56?.encrypted.status).not.toBe('not_compatible');
  });

  it('does not let a literal rewrite overturn strong encrypted compatibility', async () => {
    installResponsesMock({ literalRewrite: true });

    const result = await new PurityTester().test(candidateRelay, {
      mode: 'gpt56',
      gpt56: {
        trials: 20,
        trustedReference: {
          baseUrl: 'https://trusted.example.com/v1',
          apiKey: 'sk-trusted-deep-secret',
          model: 'gpt-5.6'
        }
      }
    });

    expect(result.gpt56?.encrypted.status).toBe('compatible');
    expect(result.gpt56?.literalControl.status).toBe('output_rewrite_suspected');
    expect(result.verdict).toBe('gpt56_compatible');
  });
});
