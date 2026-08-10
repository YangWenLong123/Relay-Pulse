import { HttpError } from '../lib/http-error.js';
import { endpointUrl } from '../lib/relay-utils.js';
const MAX_UPSTREAM_ERROR_LENGTH = 500;
const MAX_STREAM_EVENT_LENGTH = 2 * 1024 * 1024;
const MAX_OUTPUT_CHARACTERS = 1_000_000;
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
function textContent(value) {
    if (typeof value === 'string')
        return value;
    if (!Array.isArray(value))
        return '';
    return value.map((part) => {
        if (typeof part === 'string')
            return part;
        if (!isRecord(part))
            return '';
        return typeof part.text === 'string'
            ? part.text
            : typeof part.output_text === 'string'
                ? part.output_text
                : '';
    }).join('');
}
function responseText(payload) {
    if (!isRecord(payload))
        return '';
    if (typeof payload.output_text === 'string')
        return payload.output_text;
    if (Array.isArray(payload.choices)) {
        const choice = payload.choices.find(isRecord);
        const message = choice && isRecord(choice.message) ? choice.message : undefined;
        const text = textContent(message?.content) || textContent(choice?.text);
        if (text)
            return text;
    }
    if (Array.isArray(payload.output)) {
        const text = payload.output.map((item) => {
            if (!isRecord(item))
                return '';
            return textContent(item.content) || textContent(item.text) || textContent(item.output_text);
        }).join('');
        if (text)
            return text;
    }
    return textContent(payload.content);
}
function usageFrom(payload) {
    if (!isRecord(payload))
        return { inputTokens: null, outputTokens: null, totalTokens: null };
    const nested = isRecord(payload.response)
        ? payload.response
        : isRecord(payload.message)
            ? payload.message
            : payload;
    const usage = isRecord(nested.usage) ? nested.usage : isRecord(payload.usage) ? payload.usage : undefined;
    if (!usage)
        return { inputTokens: null, outputTokens: null, totalTokens: null };
    const inputTokens = finiteNumber(usage.input_tokens) ?? finiteNumber(usage.prompt_tokens);
    const outputTokens = finiteNumber(usage.output_tokens) ?? finiteNumber(usage.completion_tokens);
    const totalTokens = finiteNumber(usage.total_tokens)
        ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
    return { inputTokens, outputTokens, totalTokens };
}
function mergeUsage(current, next) {
    const inputTokens = next.inputTokens ?? current.inputTokens;
    const outputTokens = next.outputTokens ?? current.outputTokens;
    return {
        inputTokens,
        outputTokens,
        totalTokens: next.totalTokens
            ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : current.totalTokens)
    };
}
function compactUpstreamError(raw, relay) {
    let message = raw;
    try {
        const payload = JSON.parse(raw);
        if (isRecord(payload)) {
            const error = isRecord(payload.error) ? payload.error : undefined;
            if (typeof error?.message === 'string')
                message = error.message;
            else if (typeof payload.message === 'string')
                message = payload.message;
        }
    }
    catch {
        // Plain-text upstream errors remain useful after redaction and compaction.
    }
    return message
        .replaceAll(relay.apiKey, '***')
        .replace(/Bearer\s+[^\s"']+/gi, 'Bearer ***')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_UPSTREAM_ERROR_LENGTH);
}
function providerError(payload) {
    const error = isRecord(payload.error)
        ? payload.error
        : isRecord(payload.response) && isRecord(payload.response.error)
            ? payload.response.error
            : undefined;
    if (typeof error?.message === 'string' && error.message.trim())
        return error.message.trim();
    if (payload.type === 'error' && typeof payload.message === 'string')
        return payload.message.trim();
    if (payload.type === 'response.failed')
        return '上游模型生成失败';
    return null;
}
function reportedModel(payload) {
    if (typeof payload.model === 'string')
        return payload.model;
    if (isRecord(payload.response) && typeof payload.response.model === 'string')
        return payload.response.model;
    if (isRecord(payload.message) && typeof payload.message.model === 'string')
        return payload.message.model;
    return null;
}
function finishReason(payload) {
    if (Array.isArray(payload.choices)) {
        const choice = payload.choices.find(isRecord);
        if (typeof choice?.finish_reason === 'string')
            return choice.finish_reason;
    }
    if (isRecord(payload.delta) && typeof payload.delta.stop_reason === 'string')
        return payload.delta.stop_reason;
    if (isRecord(payload.response)) {
        if (typeof payload.response.status === 'string' && payload.response.status !== 'in_progress')
            return payload.response.status;
        const incomplete = isRecord(payload.response.incomplete_details) ? payload.response.incomplete_details : undefined;
        if (typeof incomplete?.reason === 'string')
            return incomplete.reason;
    }
    return null;
}
function deltaText(payload, protocol) {
    if (protocol === 'chat') {
        const choice = Array.isArray(payload.choices) ? payload.choices.find(isRecord) : undefined;
        const delta = choice && isRecord(choice.delta) ? choice.delta : undefined;
        return textContent(delta?.content);
    }
    if (protocol === 'anthropic') {
        const delta = isRecord(payload.delta) ? payload.delta : undefined;
        return payload.type === 'content_block_delta' ? textContent(delta?.text) : '';
    }
    return payload.type === 'response.output_text.delta' && typeof payload.delta === 'string' ? payload.delta : '';
}
function requestBody(input, protocol) {
    const sampling = {
        ...(input.temperature !== 1 ? { temperature: input.temperature } : {}),
        ...(input.topP !== 1 ? { top_p: input.topP } : {})
    };
    if (protocol === 'responses') {
        return {
            model: input.model,
            input: input.messages,
            ...(input.systemPrompt ? { instructions: input.systemPrompt } : {}),
            max_output_tokens: input.maxTokens,
            ...sampling,
            stream: true
        };
    }
    if (protocol === 'anthropic') {
        return {
            model: input.model,
            messages: input.messages,
            ...(input.systemPrompt ? { system: input.systemPrompt } : {}),
            max_tokens: input.maxTokens,
            ...sampling,
            stream: true
        };
    }
    return {
        model: input.model,
        messages: input.systemPrompt
            ? [{ role: 'system', content: input.systemPrompt }, ...input.messages]
            : input.messages,
        max_tokens: input.maxTokens,
        ...sampling,
        stream: true
    };
}
function protocolEndpoint(protocol) {
    if (protocol === 'responses')
        return '/v1/responses';
    if (protocol === 'anthropic')
        return '/v1/messages';
    return '/v1/chat/completions';
}
function protocolHeaders(relay, protocol) {
    if (protocol === 'anthropic') {
        return {
            'x-api-key': relay.apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
            Accept: 'text/event-stream, application/json'
        };
    }
    return {
        Authorization: `Bearer ${relay.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream, application/json'
    };
}
export class PlaygroundService {
    fetcher;
    constructor(options = {}) {
        this.fetcher = options.fetch ?? fetch;
    }
    async generate(relay, input, options = {}) {
        if (!relay.enabled)
            throw new HttpError(409, '已停用的中转站不能用于游乐场');
        const protocols = relay.platform === 'anthropic'
            ? ['anthropic']
            : relay.protocol === 'auto'
                ? ['responses', 'chat']
                : [relay.protocol];
        let fallbackError;
        for (const [index, protocol] of protocols.entries()) {
            try {
                return await this.attempt(relay, input, protocol, options);
            }
            catch (error) {
                const canFallback = index < protocols.length - 1
                    && error instanceof HttpError
                    && [400, 404, 405, 422].includes(error.status);
                if (!canFallback)
                    throw error;
                fallbackError = error;
            }
        }
        throw fallbackError ?? new HttpError(502, '中转站未返回可用协议');
    }
    async attempt(relay, input, protocol, options) {
        const startedAt = performance.now();
        const controller = new AbortController();
        let timedOut = false;
        const abort = () => controller.abort();
        const timeout = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, relay.timeout);
        timeout.unref();
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted)
            controller.abort();
        try {
            const response = await this.fetcher(endpointUrl(relay.baseUrl, protocolEndpoint(protocol)), {
                method: 'POST',
                headers: protocolHeaders(relay, protocol),
                body: JSON.stringify(requestBody(input, protocol)),
                signal: controller.signal,
                redirect: 'manual'
            });
            if (!response.ok) {
                const raw = await response.text();
                throw new HttpError(response.status, compactUpstreamError(raw, relay) || `上游请求失败（HTTP ${response.status}）`);
            }
            const state = {
                reportedModel: null,
                finishReason: null,
                usage: { inputTokens: null, outputTokens: null, totalTokens: null },
                outputCharacters: 0
            };
            if (response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
                await this.consumeEventStream(response, protocol, state, options.onDelta);
            }
            else {
                await this.consumeJsonResponse(response, state, options.onDelta);
            }
            if (!state.outputCharacters)
                throw new HttpError(502, '上游返回成功，但模型回复为空');
            return {
                relayId: relay.id,
                relayName: relay.name,
                requestedModel: input.model,
                reportedModel: state.reportedModel,
                protocol,
                finishReason: state.finishReason,
                usage: state.usage,
                durationMs: Math.round(performance.now() - startedAt)
            };
        }
        catch (error) {
            if (error instanceof HttpError)
                throw error;
            if (controller.signal.aborted) {
                throw new HttpError(timedOut ? 504 : 499, timedOut ? '模型回复超时' : '模型回复已取消');
            }
            const message = compactUpstreamError(error.message || '连接上游失败', relay);
            throw new HttpError(502, message || '连接上游失败');
        }
        finally {
            clearTimeout(timeout);
            options.signal?.removeEventListener('abort', abort);
        }
    }
    emitDelta(state, text, onDelta) {
        if (!text)
            return;
        state.outputCharacters += text.length;
        if (state.outputCharacters > MAX_OUTPUT_CHARACTERS)
            throw new HttpError(502, '模型回复超过游乐场长度限制');
        onDelta?.(text);
    }
    applyPayload(payload, protocol, state, onDelta) {
        const error = providerError(payload);
        if (error)
            throw new HttpError(502, error.slice(0, MAX_UPSTREAM_ERROR_LENGTH));
        this.emitDelta(state, deltaText(payload, protocol), onDelta);
        state.reportedModel = reportedModel(payload) ?? state.reportedModel;
        state.finishReason = finishReason(payload) ?? state.finishReason;
        state.usage = mergeUsage(state.usage, usageFrom(payload));
    }
    async consumeEventStream(response, protocol, state, onDelta) {
        if (!response.body)
            throw new HttpError(502, '上游流式响应没有可读取内容');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = '';
        const processBlock = (block) => {
            const data = block.split('\n')
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trimStart())
                .join('\n')
                .trim();
            if (!data || data === '[DONE]')
                return;
            if (data.length > MAX_STREAM_EVENT_LENGTH)
                throw new HttpError(502, '上游流式事件过大');
            let payload;
            try {
                payload = JSON.parse(data);
            }
            catch {
                throw new HttpError(502, '上游返回了无法解析的流式事件');
            }
            if (!isRecord(payload))
                throw new HttpError(502, '上游流式事件格式无效');
            this.applyPayload(payload, protocol, state, onDelta);
        };
        try {
            for (;;) {
                const next = await reader.read();
                if (next.done)
                    break;
                pending += decoder.decode(next.value, { stream: true }).replaceAll('\r\n', '\n');
                let boundary = pending.indexOf('\n\n');
                while (boundary >= 0) {
                    processBlock(pending.slice(0, boundary));
                    pending = pending.slice(boundary + 2);
                    boundary = pending.indexOf('\n\n');
                }
                if (pending.length > MAX_STREAM_EVENT_LENGTH)
                    throw new HttpError(502, '上游流式事件过大');
            }
            pending += decoder.decode();
            if (pending.trim())
                processBlock(pending);
        }
        catch (error) {
            await reader.cancel().catch(() => undefined);
            throw error;
        }
        finally {
            reader.releaseLock();
        }
    }
    async consumeJsonResponse(response, state, onDelta) {
        let payload;
        try {
            payload = await response.json();
        }
        catch {
            throw new HttpError(502, '上游返回了无法解析的 JSON');
        }
        if (!isRecord(payload))
            throw new HttpError(502, '上游响应格式无效');
        const error = providerError(payload);
        if (error)
            throw new HttpError(502, error.slice(0, MAX_UPSTREAM_ERROR_LENGTH));
        this.emitDelta(state, responseText(payload), onDelta);
        state.reportedModel = reportedModel(payload);
        state.finishReason = finishReason(payload);
        state.usage = usageFrom(payload);
    }
}
