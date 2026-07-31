import { randomUUID } from 'node:crypto';
import { endpointUrl } from '../lib/relay-utils.js';
export const ANTHROPIC_MODEL_FALLBACKS = [
    'claude-opus-4-1-20250805',
    'claude-opus-4-20250514',
    'claude-sonnet-4-20250514',
    'claude-3-7-sonnet-20250219',
    'claude-3-5-haiku-20241022'
];
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function makeFailure(message, errorType, statusCode = null) {
    return Object.assign(new Error(message), { statusCode, errorType });
}
function sanitizeSecret(value, secret) {
    return (secret ? value.replaceAll(secret, '***') : value).replace(/Bearer\s+[^\s"']+/gi, 'Bearer ***').slice(0, 500);
}
function compactErrorPayload(payload, apiKey) {
    const sanitized = sanitizeSecret(payload, apiKey).replace(/\s+/g, ' ').trim();
    try {
        const parsed = JSON.parse(sanitized);
        if (isRecord(parsed)) {
            const error = isRecord(parsed.error) ? parsed.error : parsed;
            const message = error.message;
            if (typeof message === 'string')
                return message.slice(0, 500);
        }
    }
    catch {
        // Non-JSON upstream responses are returned as a compact, sanitized excerpt.
    }
    return sanitized.slice(0, 500);
}
function statusError(status, payload, apiKey) {
    const compact = compactErrorPayload(payload, apiKey);
    if (status === 401 || status === 403)
        return makeFailure('API Key 无效或没有访问权限', 'auth', status);
    if (status === 429)
        return makeFailure('请求频率受限或额度不足', 'rate_limit', status);
    if (/model.{0,80}(not found|does not exist|invalid|unsupported|not available|不存在|无效)/i.test(compact)) {
        return makeFailure('请求的模型不存在或不可用', 'model_not_found', status);
    }
    if (status === 404)
        return makeFailure('接口地址不存在，请检查 Base URL', 'not_found', status);
    if (status >= 500)
        return makeFailure(`中转站服务异常${compact ? `：${compact}` : ''}`, 'server', status);
    return makeFailure(`请求失败（HTTP ${status}）${compact ? `：${compact}` : ''}`, 'http_error', status);
}
function errorCode(error) {
    let current = error;
    for (let depth = 0; depth < 4 && isRecord(current); depth += 1) {
        if (typeof current.code === 'string')
            return current.code.toUpperCase();
        current = current.cause;
    }
    return '';
}
function classifyNetworkError(error) {
    const code = errorCode(error);
    if (['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'ENODATA'].includes(code))
        return 'dns';
    if (code.includes('CERT') || code.includes('TLS') || code.includes('SSL'))
        return 'tls';
    if (['ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT'].includes(code) ||
        code.startsWith('UND_ERR_CONNECT')) {
        return 'connection';
    }
    return 'network';
}
function contentText(value) {
    if (typeof value === 'string')
        return value;
    if (!Array.isArray(value))
        return '';
    return value
        .map((part) => {
        if (typeof part === 'string')
            return part;
        if (!isRecord(part))
            return '';
        if (typeof part.text === 'string')
            return part.text;
        if (typeof part.output_text === 'string')
            return part.output_text;
        return '';
    })
        .join('');
}
export function extractResponseText(payload) {
    if (!isRecord(payload))
        return '';
    if (typeof payload.output_text === 'string')
        return payload.output_text.trim();
    if (Array.isArray(payload.choices)) {
        const choice = payload.choices.find(isRecord);
        if (choice) {
            const message = isRecord(choice.message) ? choice.message : undefined;
            const text = contentText(message?.content) || contentText(choice.text);
            if (text.trim())
                return text.trim();
        }
    }
    if (Array.isArray(payload.output)) {
        const text = payload.output
            .map((item) => {
            if (!isRecord(item))
                return '';
            return contentText(item.content) || contentText(item.text) || contentText(item.output_text);
        })
            .join('');
        if (text.trim())
            return text.trim();
    }
    const direct = contentText(payload.content) || contentText(payload.response);
    return direct.trim();
}
export function extractModelIds(payload) {
    const candidates = Array.isArray(payload)
        ? payload
        : isRecord(payload) && Array.isArray(payload.data)
            ? payload.data
            : isRecord(payload) && Array.isArray(payload.models)
                ? payload.models
                : [];
    const ids = candidates.flatMap((item) => {
        if (typeof item === 'string')
            return [item];
        if (!isRecord(item))
            return [];
        const id = typeof item.id === 'string' ? item.id : typeof item.name === 'string' ? item.name : '';
        return id ? [id] : [];
    });
    return [...new Set(ids)].sort();
}
function shouldAutoFallback(error) {
    const type = error.errorType;
    return type === 'not_found' || type === 'http_error' || type === 'invalid_response';
}
export class RelayTester {
    async test(relay, options = {}) {
        const model = options.model?.trim() || relay.model;
        const message = options.message?.trim() || 'hi';
        const requestedProtocol = options.protocol ?? relay.protocol;
        const startedAt = performance.now();
        let usedProtocol = requestedProtocol === 'chat' ? 'chat' : 'responses';
        try {
            let attempt;
            if (relay.platform === 'anthropic') {
                usedProtocol = 'anthropic';
                attempt = await this.attemptAnthropic(relay, model, message, options.signal);
            }
            else if (requestedProtocol === 'auto') {
                try {
                    attempt = await this.attempt(relay, model, message, 'responses', options.signal);
                }
                catch (error) {
                    if (!shouldAutoFallback(error))
                        throw error;
                    usedProtocol = 'chat';
                    attempt = await this.attempt(relay, model, message, 'chat', options.signal);
                }
            }
            else {
                usedProtocol = requestedProtocol;
                attempt = await this.attempt(relay, model, message, requestedProtocol, options.signal);
            }
            return this.result(relay, model, usedProtocol, startedAt, {
                success: true,
                statusCode: attempt.statusCode,
                responseText: attempt.responseText,
                firstByteDuration: attempt.firstByteDuration,
                errorType: null,
                errorMessage: ''
            });
        }
        catch (error) {
            const failure = error;
            return this.result(relay, model, usedProtocol, startedAt, {
                success: false,
                statusCode: failure.statusCode ?? null,
                responseText: '',
                firstByteDuration: null,
                errorType: failure.errorType ?? classifyNetworkError(error),
                errorMessage: sanitizeSecret(failure.message || '无法连接到中转站', relay.apiKey)
            });
        }
    }
    async discoverModels(relay, signal) {
        const platform = relay.platform ?? 'openai';
        const controller = new AbortController();
        let timedOut = false;
        const timeout = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, relay.timeout);
        const abort = () => controller.abort();
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted)
            controller.abort();
        try {
            const response = await fetch(endpointUrl(relay.baseUrl, '/v1/models'), {
                headers: platform === 'anthropic'
                    ? { 'x-api-key': relay.apiKey, 'anthropic-version': '2023-06-01', Accept: 'application/json' }
                    : { Authorization: `Bearer ${relay.apiKey}`, Accept: 'application/json' },
                signal: controller.signal
            });
            const body = await response.text();
            if (!response.ok)
                throw statusError(response.status, body, relay.apiKey);
            let payload;
            try {
                payload = JSON.parse(body);
            }
            catch {
                throw makeFailure('模型列表返回了无法解析的内容', 'invalid_response', response.status);
            }
            const models = extractModelIds(payload);
            return platform === 'anthropic' && !models.length ? ANTHROPIC_MODEL_FALLBACKS : models;
        }
        catch (error) {
            const failure = error;
            if (platform === 'anthropic' && ['not_found', 'http_error', 'invalid_response'].includes(failure.errorType ?? '')) {
                return ANTHROPIC_MODEL_FALLBACKS;
            }
            if (failure.errorType)
                throw error;
            if (controller.signal.aborted) {
                throw makeFailure(timedOut ? '模型探测超时' : '模型探测已取消', timedOut ? 'timeout' : 'cancelled');
            }
            throw makeFailure(sanitizeSecret(error.message || '模型探测失败', relay.apiKey), classifyNetworkError(error));
        }
        finally {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', abort);
        }
    }
    async attempt(relay, model, message, protocol, signal) {
        const controller = new AbortController();
        let timedOut = false;
        const startedAt = performance.now();
        const timeout = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, relay.timeout);
        const abort = () => controller.abort();
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted)
            controller.abort();
        try {
            const body = protocol === 'responses'
                ? { model, input: message, stream: false }
                : { model, messages: [{ role: 'user', content: message }], stream: false };
            const response = await fetch(endpointUrl(relay.baseUrl, protocol === 'responses' ? '/v1/responses' : '/v1/chat/completions'), {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${relay.apiKey}`,
                    'Content-Type': 'application/json',
                    Accept: 'application/json'
                },
                body: JSON.stringify(body),
                signal: controller.signal
            });
            const firstByteDuration = Math.round(performance.now() - startedAt);
            const raw = await response.text();
            if (!response.ok)
                throw statusError(response.status, raw, relay.apiKey);
            let payload;
            try {
                payload = JSON.parse(raw);
            }
            catch {
                throw makeFailure('接口返回了非 JSON 内容', 'invalid_response', response.status);
            }
            const responseText = extractResponseText(payload);
            if (!responseText)
                throw makeFailure('接口返回成功，但模型回复为空', 'invalid_response', response.status);
            return { responseText, statusCode: response.status, firstByteDuration };
        }
        catch (error) {
            if (error.errorType)
                throw error;
            if (controller.signal.aborted) {
                throw makeFailure(timedOut ? '连接测试超时' : '连接测试已取消', timedOut ? 'timeout' : 'cancelled');
            }
            throw makeFailure(sanitizeSecret(error.message || '网络连接失败', relay.apiKey), classifyNetworkError(error));
        }
        finally {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', abort);
        }
    }
    async attemptAnthropic(relay, model, message, signal) {
        const controller = new AbortController();
        let timedOut = false;
        const startedAt = performance.now();
        const timeout = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, relay.timeout);
        const abort = () => controller.abort();
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted)
            controller.abort();
        try {
            const response = await fetch(endpointUrl(relay.baseUrl, '/v1/messages'), {
                method: 'POST',
                headers: {
                    'x-api-key': relay.apiKey,
                    'anthropic-version': '2023-06-01',
                    'Content-Type': 'application/json',
                    Accept: 'application/json'
                },
                body: JSON.stringify({ model, max_tokens: 64, messages: [{ role: 'user', content: message }], stream: false }),
                signal: controller.signal
            });
            const firstByteDuration = Math.round(performance.now() - startedAt);
            const raw = await response.text();
            if (!response.ok)
                throw statusError(response.status, raw, relay.apiKey);
            let payload;
            try {
                payload = JSON.parse(raw);
            }
            catch {
                throw makeFailure('接口返回了非 JSON 内容', 'invalid_response', response.status);
            }
            const responseText = extractResponseText(payload);
            if (!responseText)
                throw makeFailure('接口返回成功，但模型回复为空', 'invalid_response', response.status);
            return { responseText, statusCode: response.status, firstByteDuration };
        }
        catch (error) {
            if (error.errorType)
                throw error;
            if (controller.signal.aborted) {
                throw makeFailure(timedOut ? '连接测试超时' : '连接测试已取消', timedOut ? 'timeout' : 'cancelled');
            }
            throw makeFailure(sanitizeSecret(error.message || '网络连接失败', relay.apiKey), classifyNetworkError(error));
        }
        finally {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', abort);
        }
    }
    result(relay, model, protocol, startedAt, result) {
        return {
            id: randomUUID(),
            relayId: relay.id,
            relayName: relay.name,
            model,
            protocol,
            totalDuration: Math.round(performance.now() - startedAt),
            dnsDuration: null,
            tcpDuration: null,
            tlsDuration: null,
            testedAt: new Date().toISOString(),
            ...result
        };
    }
}
