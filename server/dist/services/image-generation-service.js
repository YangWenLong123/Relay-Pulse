import { HttpError } from '../lib/http-error.js';
import { endpointUrl } from '../lib/relay-utils.js';
const DEFAULT_IMAGE_GENERATION_TIMEOUT_MS = 180_000;
const MAX_REFERENCE_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_REFERENCE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MIME_EXTENSIONS = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp'
};
const OUTPUT_FORMAT_MIME_TYPES = {
    jpg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp'
};
const ASPECT_RATIO_LABELS = {
    '1:1': '正方形 1:1',
    '16:9': '横向宽屏 16:9',
    '9:16': '竖向海报 9:16',
    '4:3': '横向标准 4:3',
    '3:4': '竖向标准 3:4'
};
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function sanitizeFilename(value, mimeType) {
    const base = value?.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
    const extension = MIME_EXTENSIONS[mimeType] ?? 'png';
    if (base && /\.[a-z0-9]+$/i.test(base))
        return base;
    return `${base || 'reference'}.${extension}`;
}
function decodeReferenceImage(reference) {
    const match = /^data:([^;,]+);base64,(.+)$/i.exec(reference.dataUrl.trim());
    if (!match)
        throw new HttpError(400, '参考图格式无效，请上传 PNG、JPG 或 WebP 图片');
    const mimeType = (reference.mimeType || match[1] || '').toLowerCase();
    if (!ALLOWED_REFERENCE_MIME_TYPES.has(mimeType))
        throw new HttpError(400, '参考图仅支持 PNG、JPG 或 WebP');
    const buffer = Buffer.from(match[2], 'base64');
    if (!buffer.length)
        throw new HttpError(400, '参考图数据为空');
    if (buffer.length > MAX_REFERENCE_IMAGE_BYTES)
        throw new HttpError(413, '参考图不能超过 8MB');
    return { buffer, mimeType, filename: sanitizeFilename(reference.name, mimeType) };
}
function compactUpstreamError(raw, relay) {
    let message = raw;
    try {
        const parsed = JSON.parse(raw);
        if (isRecord(parsed)) {
            const error = parsed.error;
            if (isRecord(error) && typeof error.message === 'string')
                message = error.message;
            else if (typeof parsed.message === 'string')
                message = parsed.message;
        }
    }
    catch {
        // Non-JSON upstream errors are still useful after compaction.
    }
    return message
        .replaceAll(relay.apiKey, '***')
        .replace(/Bearer\s+[^\s"']+/gi, 'Bearer ***')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500);
}
function nextImageRequestOptions(status, raw, options) {
    if (status !== 400 || !/response_format|output_format|unknown parameter|unsupported parameter|unrecognized|invalid.*parameter/i.test(raw))
        return null;
    const mentionsResponseFormat = /response_format/i.test(raw);
    const mentionsOutputFormat = /output_format/i.test(raw);
    if (options.includeResponseFormat && (mentionsResponseFormat || !mentionsOutputFormat)) {
        return { ...options, includeResponseFormat: false };
    }
    if (options.includeOutputFormat)
        return { ...options, includeOutputFormat: false };
    return null;
}
function mimeTypeFromBase64(value, fallback) {
    const buffer = Buffer.from(value.slice(0, 64), 'base64');
    if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47)
        return 'image/png';
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
        return 'image/jpeg';
    if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP')
        return 'image/webp';
    return fallback;
}
function parseImagePayload(payload, format) {
    if (!isRecord(payload) || !Array.isArray(payload.data) || !payload.data.length) {
        throw new HttpError(502, '上游绘图接口返回格式无效');
    }
    const fallbackMimeType = OUTPUT_FORMAT_MIME_TYPES[format];
    const images = [];
    for (const item of payload.data.filter(isRecord)) {
        const b64Json = typeof item.b64_json === 'string' ? item.b64_json.trim() : '';
        const url = typeof item.url === 'string' ? item.url.trim() : '';
        const revisedPrompt = typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined;
        if (b64Json) {
            const mimeType = mimeTypeFromBase64(b64Json, fallbackMimeType);
            const image = { dataUrl: `data:${mimeType};base64,${b64Json}`, mimeType };
            if (revisedPrompt)
                image.revisedPrompt = revisedPrompt;
            images.push(image);
            continue;
        }
        if (url) {
            const image = { url, mimeType: fallbackMimeType };
            if (revisedPrompt)
                image.revisedPrompt = revisedPrompt;
            images.push(image);
        }
    }
    if (images.length)
        return images;
    throw new HttpError(502, '上游绘图接口未返回可用图片');
}
function buildFinalPrompt(input) {
    return [
        `画幅比例：${ASPECT_RATIO_LABELS[input.aspectRatio]}。`,
        `输出尺寸：${input.size}。`,
        input.referenceImage ? '参考图要求：保留参考图的主体、构图、配色或风格特征，并以文字描述作为最终创作方向。' : '',
        `描述内容：${input.prompt.trim()}`
    ].filter(Boolean).join('\n');
}
function imageEndpoint(hasReference) {
    return hasReference ? '/v1/images/edits' : '/v1/images/generations';
}
export class ImageGenerationService {
    fetcher;
    timeoutMs;
    constructor(options = {}) {
        this.fetcher = options.fetch ?? fetch;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_IMAGE_GENERATION_TIMEOUT_MS;
        if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0)
            throw new Error('timeoutMs 必须是正整数');
    }
    async generate(relay, input, signal) {
        if (!relay.enabled)
            throw new HttpError(400, '请选择已启用的中转站');
        if (relay.platform !== 'openai')
            throw new HttpError(400, '绘图功能暂仅支持 OpenAI 兼容中转站');
        const started = performance.now();
        const createdAt = new Date().toISOString();
        const finalPrompt = buildFinalPrompt(input);
        const reference = input.referenceImage ? decodeReferenceImage(input.referenceImage) : undefined;
        const endpoint = imageEndpoint(Boolean(reference));
        const requestedCount = input.count ?? 1;
        const format = input.format ?? 'jpg';
        const images = [];
        for (let batchIndex = 0; images.length < requestedCount; batchIndex += 1) {
            const payload = await this.requestImage(relay, endpoint, input.model.trim(), input.size, finalPrompt, format, reference, signal);
            const parsedImages = parseImagePayload(payload, format);
            for (const parsedImage of parsedImages) {
                if (images.length >= requestedCount)
                    break;
                images.push({ index: images.length + 1, ...parsedImage });
            }
            if (batchIndex >= requestedCount - 1 && images.length < requestedCount) {
                throw new HttpError(502, '上游绘图接口返回图片数量不足');
            }
        }
        const firstImage = images[0];
        if (!firstImage)
            throw new HttpError(502, '上游绘图接口未返回可用图片');
        return {
            relayId: relay.id,
            relayName: relay.name,
            source: input.source ?? 'saved',
            model: input.model.trim(),
            prompt: input.prompt.trim(),
            finalPrompt,
            aspectRatio: input.aspectRatio,
            size: input.size,
            count: requestedCount,
            format,
            images,
            image: firstImage,
            revisedPrompt: firstImage.revisedPrompt,
            upstreamEndpoint: endpoint,
            durationMs: Math.round(performance.now() - started),
            createdAt
        };
    }
    async requestImage(relay, endpoint, model, size, prompt, format, reference, signal) {
        let firstRaw = '';
        let options = { includeResponseFormat: true, includeOutputFormat: true };
        let response = await this.fetchUpstream(relay, endpoint, model, size, prompt, format, reference, options, signal);
        if (!response.ok) {
            firstRaw = await response.text();
            let nextOptions = nextImageRequestOptions(response.status, firstRaw, options);
            while (nextOptions) {
                options = nextOptions;
                response = await this.fetchUpstream(relay, endpoint, model, size, prompt, format, reference, options, signal);
                firstRaw = '';
                if (response.ok)
                    break;
                firstRaw = await response.text();
                nextOptions = nextImageRequestOptions(response.status, firstRaw, options);
            }
        }
        if (!response.ok) {
            const raw = firstRaw || await response.text();
            throw new HttpError(response.status >= 400 && response.status < 600 ? response.status : 502, compactUpstreamError(raw, relay) || `上游绘图请求失败（HTTP ${response.status}）`);
        }
        try {
            return await response.json();
        }
        catch {
            throw new HttpError(502, '上游绘图接口返回了无法解析的 JSON');
        }
    }
    async fetchUpstream(relay, endpoint, model, size, prompt, format, reference, options, signal) {
        const controller = new AbortController();
        const abort = () => controller.abort();
        let timedOut = false;
        const timeout = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, this.timeoutMs);
        timeout.unref();
        signal?.addEventListener('abort', abort, { once: true });
        try {
            return await this.fetcher(endpointUrl(relay.baseUrl, endpoint), {
                method: 'POST',
                headers: reference ? { Authorization: `Bearer ${relay.apiKey}`, Accept: 'application/json' } : {
                    Authorization: `Bearer ${relay.apiKey}`,
                    'Content-Type': 'application/json',
                    Accept: 'application/json'
                },
                body: reference
                    ? this.editFormData(model, size, prompt, format, reference, options)
                    : JSON.stringify(this.generationBody(model, size, prompt, format, options)),
                signal: controller.signal
            });
        }
        catch (error) {
            if (controller.signal.aborted) {
                if (timedOut)
                    throw new HttpError(504, '绘图请求超时，请稍后重试或更换中转站');
                throw new HttpError(499, '绘图请求已取消');
            }
            throw error;
        }
        finally {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', abort);
        }
    }
    generationBody(model, size, prompt, format, options) {
        return {
            model,
            prompt,
            size,
            n: 1,
            ...(options.includeResponseFormat ? { response_format: 'b64_json' } : {}),
            ...(options.includeOutputFormat ? { output_format: format } : {})
        };
    }
    editFormData(model, size, prompt, format, reference, options) {
        const form = new FormData();
        form.set('model', model);
        form.set('prompt', prompt);
        form.set('size', size);
        form.set('n', '1');
        if (options.includeResponseFormat)
            form.set('response_format', 'b64_json');
        if (options.includeOutputFormat)
            form.set('output_format', format);
        form.set('image', new Blob([new Uint8Array(reference.buffer)], { type: reference.mimeType }), reference.filename);
        return form;
    }
}
