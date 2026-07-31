import cors from 'cors';
import express from 'express';
import { ZodError } from 'zod';
import { config } from './config.js';
import { HttpError } from './lib/http-error.js';
import { isAllowedClientOrigin } from './lib/origin-policy.js';
import { publicRelay } from './lib/relay-utils.js';
import { HistoryRepository } from './repositories/history-repository.js';
import { PoolUsageRepository } from './repositories/pool-usage-repository.js';
import { RelayRepository } from './repositories/relay-repository.js';
import { RelayTester } from './services/relay-tester.js';
import { TestCoordinator } from './services/test-coordinator.js';
import { BalanceService } from './services/balance-service.js';
import { BalanceScheduler } from './services/balance-scheduler.js';
import { CcSwitchImportService } from './services/cc-switch-import-service.js';
import { PoolProxyService } from './services/pool-proxy-service.js';
import { batchTestSchema, batchUpdateSchema, ccSwitchImportSchema, discoverSchema, historyQuerySchema, poolStartSchema, poolStrategySchema, poolUsageQuerySchema, relayOrderSchema, relayCreateSchema, relayUpdateSchema, testSchema } from './validation.js';
const asyncHandler = (handler) => (req, res, next) => {
    void handler(req, res, next).catch(next);
};
const send = (res, data, message = '') => {
    res.json({ success: true, data, message });
};
const pathParam = (req, name) => {
    const value = req.params[name];
    if (!value)
        throw new HttpError(400, '缺少路径参数');
    return value;
};
const csvCell = (value) => {
    const text = value === null || value === undefined ? '' : String(value);
    const escaped = /^[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${escaped.replaceAll('"', '""')}"`;
};
const runPoolAction = async (action) => {
    try {
        return await action();
    }
    catch (error) {
        if (error instanceof HttpError)
            throw error;
        const nodeError = error;
        if (nodeError.code === 'EADDRINUSE')
            throw new HttpError(409, '指定端口已被占用');
        if (typeof nodeError.message === 'string') {
            if (nodeError.message === '号池服务已启动或正在启动' || nodeError.message === '号池服务未启动') {
                throw new HttpError(409, nodeError.message);
            }
            if (nodeError.message.includes('端口'))
                throw new HttpError(400, nodeError.message);
            if (nodeError.message.includes('号池') || nodeError.message.includes('中转站'))
                throw new HttpError(400, nodeError.message);
        }
        throw error;
    }
};
export async function createApp(dependencies = {}) {
    const relays = dependencies.relays ?? new RelayRepository();
    const history = dependencies.history ?? new HistoryRepository();
    const tester = dependencies.tester ?? new RelayTester();
    const coordinator = new TestCoordinator(relays, history, tester);
    const balance = dependencies.balance ?? new BalanceService(relays);
    const ccSwitch = dependencies.ccSwitch ?? new CcSwitchImportService(relays);
    const poolUsage = dependencies.poolUsage ?? new PoolUsageRepository();
    const pool = dependencies.pool ?? new PoolProxyService({
        listRelays: () => relays.list(),
        refreshBalance: (relay, signal) => balance.query(relay.id, signal),
        recordUsage: (record) => poolUsage.add(record)
    });
    await Promise.all([relays.initialize(), history.initialize(), poolUsage.initialize()]);
    if (dependencies.startBalanceScheduler !== false)
        new BalanceScheduler(relays, balance).start();
    const app = express();
    app.locals.pool = pool;
    app.disable('x-powered-by');
    app.use(cors({
        origin(origin, callback) {
            if (isAllowedClientOrigin(origin, config.clientOrigins, config.allowExtensionOrigins)) {
                callback(null, true);
                return;
            }
            callback(new HttpError(403, '请求来源不被允许'));
        }
    }));
    app.use(express.json({ limit: '64kb' }));
    app.get('/api/health', (_req, res) => send(res, { status: 'ok' }));
    app.get('/api/pool', (_req, res) => send(res, pool.status()));
    app.post('/api/pool/start', asyncHandler(async (req, res) => {
        const input = poolStartSchema.parse(req.body ?? {});
        const result = await runPoolAction(() => pool.start(input));
        await poolUsage.clear();
        send(res, result, '号池服务已启动');
    }));
    app.post('/api/pool/stop', asyncHandler(async (_req, res) => {
        const result = await runPoolAction(() => pool.stop());
        await poolUsage.clear();
        send(res, result, '号池服务已停止');
    }));
    app.post('/api/pool/refresh', asyncHandler(async (_req, res) => {
        const controller = new AbortController();
        res.on('close', () => {
            if (!res.writableEnded)
                controller.abort();
        });
        send(res, await runPoolAction(() => pool.refreshBalances(controller.signal)), '号池余额已刷新');
    }));
    app.post('/api/pool/strategy', asyncHandler(async (req, res) => {
        const input = poolStrategySchema.parse(req.body ?? {});
        const result = await runPoolAction(async () => pool.setRoutingStrategy(input.routingStrategy));
        send(res, result, '号池轮询规则已更新');
    }));
    app.post('/api/pool/key/rotate', asyncHandler(async (_req, res) => send(res, await runPoolAction(() => pool.rotateKey()), '号池 API Key 已轮换')));
    app.post('/api/pool/cc-switch', asyncHandler(async (_req, res) => {
        const status = pool.status();
        if (!status.active || !status.baseUrl || !status.apiKey || !status.platform) {
            throw new HttpError(409, '请先启动号池服务');
        }
        const relayById = new Map((await relays.list()).map((relay) => [relay.id, relay]));
        const model = status.relayIds.map((id) => relayById.get(id)?.model).find(Boolean);
        if (!model)
            throw new HttpError(409, '号池中没有可导出的模型');
        const result = await ccSwitch.exportPool({
            baseUrl: status.baseUrl,
            apiKey: status.apiKey,
            model,
            platform: status.platform
        });
        send(res, result, result.created ? '已导入 CC Switch' : 'CC Switch 中已存在该号池');
    }));
    app.get('/api/pool/usage', asyncHandler(async (req, res) => {
        const query = poolUsageQuerySchema.parse(req.query);
        send(res, await poolUsage.report(query));
    }));
    app.get('/api/pool/usage/export', asyncHandler(async (req, res) => {
        const query = poolUsageQuerySchema.parse(req.query);
        const report = await poolUsage.report({ ...query, limit: config.poolUsageLimit, offset: 0 });
        const rows = [
            ['时间', '中转站', '模型', '端点', '结果', '状态码', '尝试次数', '输入 Token', '输出 Token', '缓存 Token', '总 Token', '耗时（ms）', '错误代码', '错误信息'],
            ...report.records.map((record) => [
                record.createdAt,
                record.relayName,
                record.model,
                record.endpoint,
                record.status,
                record.statusCode,
                record.attempts,
                record.inputTokens,
                record.outputTokens,
                record.cachedTokens,
                record.totalTokens,
                record.durationMs,
                record.errorCode,
                record.errorMessage
            ])
        ];
        const body = `\ufeff${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
        res
            .status(200)
            .set('Content-Type', 'text/csv; charset=utf-8')
            .set('Content-Disposition', 'attachment; filename="relay-pulse-usage.csv"')
            .send(body);
    }));
    app.get('/api/import/cc-switch', asyncHandler(async (_req, res) => send(res, await ccSwitch.preview())));
    app.post('/api/import/cc-switch', asyncHandler(async (req, res) => {
        const input = ccSwitchImportSchema.parse(req.body);
        const result = await ccSwitch.import(input.candidateIds);
        const message = result.imported.length
            ? '已从 CC Switch 导入 ' + result.imported.length + ' 个中转站'
            : '没有需要导入的新中转站';
        send(res, result, message);
    }));
    app.get('/api/relays', asyncHandler(async (_req, res) => send(res, await relays.listPublic())));
    app.post('/api/relays', asyncHandler(async (req, res) => {
        const relay = await relays.create(relayCreateSchema.parse(req.body));
        res.status(201);
        send(res, publicRelay(relay), '中转站已添加');
    }));
    app.patch('/api/relays/batch', asyncHandler(async (req, res) => {
        const input = batchUpdateSchema.parse(req.body);
        const updated = await relays.batchUpdateEnabled(input.relayIds, input.enabled);
        send(res, updated, input.enabled ? '已批量启用' : '已批量停用');
    }));
    app.patch('/api/relays/order', asyncHandler(async (req, res) => {
        const input = relayOrderSchema.parse(req.body);
        send(res, await relays.reorder(input.relayIds), '中转站顺序已更新');
    }));
    app.post('/api/relays/batch-test', asyncHandler(async (req, res) => {
        const input = batchTestSchema.parse(req.body);
        const controller = new AbortController();
        res.on('close', () => {
            if (!res.writableEnded)
                controller.abort();
        });
        send(res, await coordinator.batchTest(input.relayIds, { message: input.message, signal: controller.signal }), '批量测试完成');
    }));
    app.get('/api/relays/:id/api-key', asyncHandler(async (req, res) => send(res, { apiKey: (await relays.find(pathParam(req, 'id'))).apiKey })));
    app.get('/api/relays/:id/balance-access-token', asyncHandler(async (req, res) => {
        const balanceConfig = (await relays.find(pathParam(req, 'id'))).balanceConfig;
        send(res, { apiKey: balanceConfig?.apiKey ?? '', accessToken: balanceConfig?.accessToken ?? '' });
    }));
    app.get('/api/relays/:id', asyncHandler(async (req, res) => send(res, await relays.findPublic(pathParam(req, 'id')))));
    app.put('/api/relays/:id', asyncHandler(async (req, res) => {
        const relay = await relays.update(pathParam(req, 'id'), relayUpdateSchema.parse(req.body));
        send(res, publicRelay(relay), '中转站已更新');
    }));
    app.delete('/api/relays/:id', asyncHandler(async (req, res) => {
        await coordinator.cancelRelay(pathParam(req, 'id'));
        await relays.remove(pathParam(req, 'id'));
        send(res, null, '中转站已删除');
    }));
    app.post('/api/relays/:id/duplicate', asyncHandler(async (req, res) => {
        const relay = await relays.duplicate(pathParam(req, 'id'));
        res.status(201);
        send(res, publicRelay(relay), '配置已复制');
    }));
    app.get('/api/relays/:id/models', asyncHandler(async (req, res) => {
        const relay = await relays.find(pathParam(req, 'id'));
        send(res, await tester.discoverModels(relay), '模型探测完成');
    }));
    app.post('/api/models/discover', asyncHandler(async (req, res) => {
        const input = discoverSchema.parse(req.body);
        send(res, await tester.discoverModels(input), '模型探测完成');
    }));
    app.post('/api/relays/:id/test', asyncHandler(async (req, res) => {
        const input = testSchema.parse(req.body ?? {});
        const controller = new AbortController();
        res.on('close', () => {
            if (!res.writableEnded)
                controller.abort();
        });
        const result = await coordinator.testRelay(pathParam(req, 'id'), { ...input, signal: controller.signal });
        send(res, result, result.success ? '连接测试成功' : '连接测试失败');
    }));
    app.post('/api/relays/:id/balance', asyncHandler(async (req, res) => {
        const controller = new AbortController();
        res.on('close', () => {
            if (!res.writableEnded)
                controller.abort();
        });
        send(res, await balance.query(pathParam(req, 'id'), controller.signal), '余额查询完成');
    }));
    app.delete('/api/relays/:id/test', asyncHandler(async (req, res) => {
        await coordinator.cancelRelay(pathParam(req, 'id'));
        send(res, null, '测试请求已取消');
    }));
    app.get('/api/test-history', asyncHandler(async (req, res) => {
        const query = historyQuerySchema.parse(req.query);
        send(res, await history.list({
            relayId: query.relayId,
            success: query.success,
            from: query.from,
            to: query.to
        }));
    }));
    app.delete('/api/test-history/:id', asyncHandler(async (req, res) => {
        await history.remove(pathParam(req, 'id'));
        send(res, null, '历史记录已删除');
    }));
    app.delete('/api/test-history', asyncHandler(async (_req, res) => {
        await history.clear();
        send(res, null, '测试历史已清空');
    }));
    app.use((_req, res) => res.status(404).json({ success: false, data: null, message: '接口不存在' }));
    app.use((error, _req, res, _next) => {
        if (error instanceof ZodError) {
            res.status(400).json({ success: false, data: null, message: error.issues[0]?.message ?? '请求参数错误' });
            return;
        }
        const relayError = error;
        const expressError = error;
        const isRelayError = typeof relayError.errorType === 'string' && error instanceof Error;
        const status = error instanceof HttpError
            ? error.status
            : isRelayError
                ? relayError.errorType === 'timeout'
                    ? 504
                    : relayError.errorType === 'cancelled'
                        ? 499
                        : typeof relayError.statusCode === 'number'
                            ? relayError.statusCode
                            : 502
                : typeof expressError.status === 'number' && expressError.status >= 400 && expressError.status < 600
                    ? expressError.status
                    : 500;
        const message = error instanceof HttpError || isRelayError
            ? error.message
            : expressError.type === 'entity.too.large'
                ? '请求体过大'
                : expressError.type === 'entity.parse.failed'
                    ? '请求体 JSON 格式错误'
                    : '服务器内部错误';
        res.status(status).json({ success: false, data: null, message });
    });
    return app;
}
