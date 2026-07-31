import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { HttpError } from '../lib/http-error.js';
import { maskApiKey, normalizeBaseUrl, publicRelay } from '../lib/relay-utils.js';
import { relayCreateSchema } from '../validation.js';
const execFileAsync = promisify(execFile);
const providerQuery = [
    'SELECT id, app_type, name, settings_config, sort_index, is_current, notes',
    'FROM providers',
    "ORDER BY CASE app_type WHEN 'codex' THEN 0 WHEN 'claude' THEN 1 ELSE 2 END,",
    'COALESCE(sort_index, 2147483647), name'
].join(' ');
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function stringValue(record, key) {
    const value = record[key];
    return typeof value === 'string' ? value.trim() : '';
}
function tomlString(configText, key) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = configText.match(new RegExp('^\\s*' + escapedKey + '\\s*=\\s*("(?:\\\\.|[^"])*")', 'mi'));
    if (!match?.[1])
        return '';
    const quoted = match[1];
    try {
        return JSON.parse(quoted);
    }
    catch {
        return quoted.slice(1, -1).trim();
    }
}
function parseSettings(value) {
    try {
        const parsed = JSON.parse(value);
        return isRecord(parsed) ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
function parseCodex(row, settings) {
    const auth = isRecord(settings.auth) ? settings.auth : {};
    const configText = stringValue(settings, 'config');
    const apiKey = stringValue(auth, 'OPENAI_API_KEY');
    const baseUrl = tomlString(configText, 'base_url');
    const model = tomlString(configText, 'model');
    if (!apiKey || !baseUrl || !model)
        return undefined;
    const wireApi = tomlString(configText, 'wire_api').toLowerCase();
    const protocol = wireApi.includes('chat') ? 'chat' : wireApi.includes('response') ? 'responses' : 'auto';
    const note = row.notes?.trim();
    return {
        id: 'codex:' + row.id,
        input: {
            name: row.name.trim(),
            baseUrl: normalizeBaseUrl(baseUrl),
            apiKey,
            model,
            platform: 'openai',
            protocol,
            enabled: true,
            timeout: 120000,
            remark: ('从 CC Switch 导入 · Codex' + (note ? ' · ' + note : '')).slice(0, 500)
        },
        source: 'codex',
        isCurrent: Boolean(row.is_current)
    };
}
function parseClaude(row, settings) {
    const env = isRecord(settings.env) ? settings.env : {};
    const apiKey = stringValue(env, 'ANTHROPIC_AUTH_TOKEN') || stringValue(env, 'ANTHROPIC_API_KEY');
    const baseUrl = stringValue(env, 'ANTHROPIC_BASE_URL');
    const model = stringValue(env, 'ANTHROPIC_MODEL') ||
        stringValue(env, 'ANTHROPIC_DEFAULT_SONNET_MODEL') ||
        stringValue(env, 'ANTHROPIC_DEFAULT_OPUS_MODEL') ||
        stringValue(env, 'ANTHROPIC_DEFAULT_HAIKU_MODEL');
    if (!apiKey || !baseUrl || !model)
        return undefined;
    const note = row.notes?.trim();
    return {
        id: 'claude:' + row.id,
        input: {
            name: row.name.trim(),
            baseUrl: normalizeBaseUrl(baseUrl),
            apiKey,
            model,
            platform: 'anthropic',
            protocol: 'auto',
            enabled: true,
            timeout: 120000,
            remark: ('从 CC Switch 导入 · Claude' + (note ? ' · ' + note : '')).slice(0, 500)
        },
        source: 'claude',
        isCurrent: Boolean(row.is_current)
    };
}
export function parseCcSwitchProvider(row) {
    const settings = parseSettings(row.settings_config);
    if (!settings || !row.id || !row.name.trim())
        return undefined;
    try {
        const candidate = row.app_type === 'codex' ? parseCodex(row, settings) : row.app_type === 'claude' ? parseClaude(row, settings) : undefined;
        if (!candidate)
            return undefined;
        const validated = relayCreateSchema.safeParse(candidate.input);
        return validated.success ? { ...candidate, input: validated.data } : undefined;
    }
    catch {
        return undefined;
    }
}
async function readProviderRows(databasePath) {
    try {
        await access(databasePath);
    }
    catch {
        throw new HttpError(404, '未找到 CC Switch 数据库：' + databasePath);
    }
    try {
        const { stdout } = await execFileAsync('sqlite3', ['-json', databasePath, providerQuery], {
            encoding: 'utf8',
            maxBuffer: 10 * 1024 * 1024
        });
        const parsed = stdout.trim() ? JSON.parse(stdout) : [];
        if (!Array.isArray(parsed))
            throw new Error('查询结果不是数组');
        return parsed;
    }
    catch (error) {
        if (error instanceof HttpError)
            throw error;
        const code = error.code;
        if (code === 'ENOENT')
            throw new HttpError(503, '系统未安装 sqlite3，无法读取 CC Switch 数据库');
        throw new HttpError(500, '读取 CC Switch 数据库失败');
    }
}
function sqlString(value) {
    return `'${value.replaceAll("'", "''")}'`;
}
async function insertProviderRow(databasePath, provider) {
    try {
        await access(databasePath);
    }
    catch {
        throw new HttpError(404, '未找到 CC Switch 数据库：' + databasePath);
    }
    const sql = [
        'BEGIN IMMEDIATE;',
        'INSERT INTO providers (id, app_type, name, settings_config, created_at, sort_index, notes)',
        `VALUES (${sqlString(provider.id)}, ${sqlString(provider.appType)}, ${sqlString(provider.name)},`,
        `${sqlString(provider.settingsConfig)}, ${Date.now()}, ${provider.sortIndex}, ${sqlString(provider.notes)});`,
        'COMMIT;'
    ].join(' ');
    try {
        await execFileAsync('sqlite3', [databasePath, sql], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    }
    catch (error) {
        const code = error.code;
        if (code === 'ENOENT')
            throw new HttpError(503, '系统未安装 sqlite3，无法写入 CC Switch 数据库');
        throw new HttpError(500, '写入 CC Switch 数据库失败');
    }
}
function poolProvider(input, sortIndex) {
    const appType = input.platform === 'anthropic' ? 'claude' : 'codex';
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const targetBaseUrl = appType === 'codex' && !baseUrl.toLowerCase().endsWith('/v1') ? `${baseUrl}/v1` : baseUrl;
    const name = `Relay Pulse ${input.platform === 'anthropic' ? 'Anthropic' : 'OpenAI'} 号池`;
    const settings = appType === 'codex'
        ? {
            auth: { OPENAI_API_KEY: input.apiKey },
            config: [`model = ${JSON.stringify(input.model)}`, `base_url = ${JSON.stringify(targetBaseUrl)}`, 'wire_api = "responses"'].join('\n')
        }
        : {
            env: {
                ANTHROPIC_AUTH_TOKEN: input.apiKey,
                ANTHROPIC_BASE_URL: targetBaseUrl,
                ANTHROPIC_MODEL: input.model,
                ANTHROPIC_DEFAULT_SONNET_MODEL: input.model,
                ANTHROPIC_DEFAULT_OPUS_MODEL: input.model,
                ANTHROPIC_DEFAULT_HAIKU_MODEL: input.model
            }
        };
    return {
        id: `relay-pulse-${randomUUID()}`,
        appType,
        name,
        settingsConfig: JSON.stringify(settings),
        sortIndex,
        notes: '由 Relay Pulse 号池服务导入'
    };
}
function fingerprint(baseUrl, apiKey) {
    return normalizeBaseUrl(baseUrl).toLowerCase() + '\n' + apiKey;
}
export class CcSwitchImportService {
    relays;
    databasePath;
    loadRows;
    insertProvider;
    importLock = Promise.resolve();
    constructor(relays, options = {}) {
        this.relays = relays;
        this.databasePath = options.databasePath ?? config.ccSwitchDbPath;
        this.loadRows = options.loadRows ?? (() => readProviderRows(this.databasePath));
        this.insertProvider = options.insertProvider ?? ((provider) => insertProviderRow(this.databasePath, provider));
    }
    async preview() {
        const rows = await this.loadRows();
        const parsed = rows.map(parseCcSwitchProvider);
        const candidates = parsed.filter((candidate) => candidate !== undefined);
        const existing = new Set((await this.relays.list()).map((relay) => fingerprint(relay.baseUrl, relay.apiKey)));
        return {
            candidates: candidates.map((candidate) => ({
                id: candidate.id,
                name: candidate.input.name,
                baseUrl: candidate.input.baseUrl,
                apiKeyMasked: maskApiKey(candidate.input.apiKey),
                model: candidate.input.model,
                platform: candidate.input.platform,
                protocol: candidate.input.protocol,
                source: candidate.source,
                isCurrent: candidate.isCurrent,
                alreadyExists: existing.has(fingerprint(candidate.input.baseUrl, candidate.input.apiKey))
            })),
            unsupportedCount: rows.filter((row) => !['codex', 'claude'].includes(row.app_type)).length,
            invalidCount: parsed.filter((candidate, index) => candidate === undefined && ['codex', 'claude'].includes(rows[index].app_type)).length
        };
    }
    async import(candidateIds) {
        return this.withImportLock(() => this.importSelected(candidateIds));
    }
    async exportPool(input) {
        if (!input.apiKey.trim() || !input.model.trim())
            throw new HttpError(409, '号池服务缺少可导出的 API Key 或模型');
        const rows = await this.loadRows();
        const provider = poolProvider(input, Math.max(-1, ...rows.filter((row) => row.app_type === (input.platform === 'anthropic' ? 'claude' : 'codex'))
            .map((row) => row.sort_index ?? -1)) + 1);
        const duplicate = rows
            .map(parseCcSwitchProvider)
            .find((candidate) => candidate && fingerprint(candidate.input.baseUrl, candidate.input.apiKey) === fingerprint(input.platform === 'openai' ? `${normalizeBaseUrl(input.baseUrl)}/v1` : input.baseUrl, input.apiKey));
        if (duplicate) {
            return { id: duplicate.id.split(':').slice(1).join(':'), appType: provider.appType, name: duplicate.input.name, created: false };
        }
        await this.insertProvider(provider);
        return { id: provider.id, appType: provider.appType, name: provider.name, created: true };
    }
    async importSelected(candidateIds) {
        const rows = await this.loadRows();
        const byId = new Map(rows
            .map(parseCcSwitchProvider)
            .filter((candidate) => candidate !== undefined)
            .map((candidate) => [candidate.id, candidate]));
        const missing = candidateIds.find((id) => !byId.has(id));
        if (missing)
            throw new HttpError(400, 'CC Switch 导入项不存在或已失效：' + missing);
        const existing = new Set((await this.relays.list()).map((relay) => fingerprint(relay.baseUrl, relay.apiKey)));
        const inputs = [];
        let duplicateCount = 0;
        for (const id of candidateIds) {
            const candidate = byId.get(id);
            const key = fingerprint(candidate.input.baseUrl, candidate.input.apiKey);
            if (existing.has(key)) {
                duplicateCount += 1;
                continue;
            }
            existing.add(key);
            inputs.push(candidate.input);
        }
        const imported = inputs.length ? await this.relays.createMany(inputs) : [];
        return { imported: imported.map(publicRelay), duplicateCount };
    }
    async withImportLock(action) {
        const previous = this.importLock;
        let release = () => undefined;
        this.importLock = new Promise((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await action();
        }
        finally {
            release();
        }
    }
}
