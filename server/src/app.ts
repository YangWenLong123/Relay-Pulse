import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { ZodError } from 'zod';
import { config } from './config.js';
import { HttpError } from './lib/http-error.js';
import { createCodexUpstreamFetch } from './lib/codex-upstream-fetch.js';
import { isAllowedClientOrigin } from './lib/origin-policy.js';
import { normalizeBaseUrl, publicRelay } from './lib/relay-utils.js';
import { HistoryRepository } from './repositories/history-repository.js';
import { CodexAccountRepository } from './repositories/codex-account-repository.js';
import { CodexUsageRepository } from './repositories/codex-usage-repository.js';
import { PoolUsageRepository } from './repositories/pool-usage-repository.js';
import { RelayRepository } from './repositories/relay-repository.js';
import { RelayTester } from './services/relay-tester.js';
import { TestCoordinator } from './services/test-coordinator.js';
import { BalanceService } from './services/balance-service.js';
import { BalanceScheduler } from './services/balance-scheduler.js';
import { CcSwitchImportService } from './services/cc-switch-import-service.js';
import { CodexAccountService } from './services/codex-account-service.js';
import { CodexProxyService } from './services/codex-proxy-service.js';
import { ImageGenerationService } from './services/image-generation-service.js';
import { PlaygroundService } from './services/playground-service.js';
import { PoolProxyService } from './services/pool-proxy-service.js';
import { PurityTester } from './services/purity-tester.js';
import { exportRelays, importRelays as importRelaysFromSpreadsheet } from './services/relay-spreadsheet-service.js';
import type { PlaygroundStreamEvent, PurityStreamEvent, Relay } from './types.js';
import {
  batchTestSchema,
  batchUpdateSchema,
  ccSwitchImportSchema,
  codexAccountImportSchema,
  codexAccountPatchSchema,
  codexModelSyncSchema,
  codexProxyStartSchema,
  codexUsageQuerySchema,
  customPurityTestSchema,
  discoverSchema,
  historyQuerySchema,
  imageGenerationSchema,
  poolAddRelaysSchema,
  poolStartSchema,
  poolStrategySchema,
  poolUsageQuerySchema,
  playgroundSchema,
  purityTestSchema,
  relayOrderSchema,
  relayCreateSchema,
  relayUpdateSchema,
  testSchema
} from './validation.js';
import type { CustomPurityTestInput } from './validation.js';

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;
const asyncHandler = (handler: AsyncHandler) => (req: Request, res: Response, next: NextFunction) => {
  void handler(req, res, next).catch(next);
};

const send = <T>(res: Response, data: T, message = ''): void => {
  res.json({ success: true, data, message });
};

const writePurityStreamEvent = (res: Response, event: PurityStreamEvent): void => {
  if (res.destroyed || res.writableEnded) return;
  res.write(`${JSON.stringify(event)}\n`);
};

const customPurityRelay = (input: CustomPurityTestInput): Relay => {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    name: '自定义检测端点',
    baseUrl: normalizeBaseUrl(input.baseUrl),
    apiKey: input.apiKey,
    model: input.model,
    platform: input.platform,
    // Anthropic always uses its Messages wire protocol; OpenAI-compatible
    // endpoints can select Responses, Chat Completions, or automatic fallback.
    protocol: input.platform === 'anthropic' ? 'auto' : input.protocol,
    enabled: true,
    timeout: input.timeout,
    remark: '',
    createdAt: now,
    updatedAt: now,
    lastTestAt: null,
    lastTestStatus: 'untested',
    lastLatency: null
  };
};

const customImageRelay = (input: { baseUrl: string; apiKey: string; model: string }): Relay => {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    name: '自定义绘图端点',
    baseUrl: normalizeBaseUrl(input.baseUrl),
    apiKey: input.apiKey,
    model: input.model,
    platform: 'openai',
    protocol: 'auto',
    enabled: true,
    timeout: 180_000,
    remark: '',
    createdAt: now,
    updatedAt: now,
    lastTestAt: null,
    lastTestStatus: 'untested',
    lastLatency: null
  };
};

const pathParam = (req: Request, name: string): string => {
  const value = req.params[name];
  if (!value) throw new HttpError(400, '缺少路径参数');
  return value;
};

const csvCell = (value: unknown): string => {
  const text = value === null || value === undefined ? '' : String(value);
  const escaped = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${escaped.replaceAll('"', '""')}"`;
};

const runPoolAction = async <T>(action: () => Promise<T>): Promise<T> => {
  try {
    return await action();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const nodeError = error as { code?: unknown; message?: unknown };
    if (nodeError.code === 'EADDRINUSE') throw new HttpError(409, '指定端口已被占用');
    if (typeof nodeError.message === 'string') {
      if (nodeError.message === '号池服务已启动或正在启动' || nodeError.message === '号池服务未启动') {
        throw new HttpError(409, nodeError.message);
      }
      if (nodeError.message.includes('端口')) throw new HttpError(400, nodeError.message);
      if (nodeError.message.includes('号池') || nodeError.message.includes('中转站')) throw new HttpError(400, nodeError.message);
    }
    throw error;
  }
};

const runCodexAction = async <T>(action: () => Promise<T> | T): Promise<T> => {
  try {
    return await action();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const nodeError = error as { code?: unknown; message?: unknown };
    if (nodeError.code === 'EADDRINUSE') throw new HttpError(409, '指定端口已被占用');
    if (typeof nodeError.message === 'string') {
      if (nodeError.message.includes('已启动') || nodeError.message.includes('未启动')) throw new HttpError(409, nodeError.message);
      if (nodeError.message.includes('端口') || nodeError.message.includes('账号')) throw new HttpError(400, nodeError.message);
    }
    throw error;
  }
};

export interface AppDependencies {
  relays?: RelayRepository;
  history?: HistoryRepository;
  codexAccounts?: CodexAccountRepository;
  codexUsage?: CodexUsageRepository;
  tester?: RelayTester;
  purityTester?: PurityTester;
  balance?: BalanceService;
  ccSwitch?: CcSwitchImportService;
  imageGeneration?: ImageGenerationService;
  playground?: PlaygroundService;
  poolUsage?: PoolUsageRepository;
  pool?: PoolProxyService;
  codexAccountService?: CodexAccountService;
  codexProxy?: CodexProxyService;
  startBalanceScheduler?: boolean;
}

export async function createApp(dependencies: AppDependencies = {}): Promise<express.Express> {
  const relays = dependencies.relays ?? new RelayRepository();
  const history = dependencies.history ?? new HistoryRepository();
  const codexAccounts = dependencies.codexAccounts ?? new CodexAccountRepository();
  const codexUsage = dependencies.codexUsage ?? new CodexUsageRepository();
  const tester = dependencies.tester ?? new RelayTester();
  const purityTester = dependencies.purityTester ?? new PurityTester();
  const coordinator = new TestCoordinator(relays, history, tester);
  const balance = dependencies.balance ?? new BalanceService(relays);
  const ccSwitch = dependencies.ccSwitch ?? new CcSwitchImportService(relays);
  const imageGeneration = dependencies.imageGeneration ?? new ImageGenerationService();
  const playground = dependencies.playground ?? new PlaygroundService();
  const poolUsage = dependencies.poolUsage ?? new PoolUsageRepository();
  const pool = dependencies.pool ?? new PoolProxyService({
    listRelays: () => relays.list(),
    refreshBalance: (relay, signal) => balance.query(relay.id, signal),
    recordUsage: (record) => poolUsage.add(record)
  });
  const codexUpstreamFetch = createCodexUpstreamFetch(config.codexUpstreamProxyUrl);
  const codexAccountService = dependencies.codexAccountService ?? new CodexAccountService(codexAccounts, {
    upstreamBaseUrl: config.codexUpstreamBaseUrl,
    clientVersion: config.codexClientVersion,
    fetch: codexUpstreamFetch
  });
  const codexProxy = dependencies.codexProxy ?? new CodexProxyService({
    listAccounts: () => codexAccounts.list(),
    recordUsage: (record) => codexUsage.add(record),
    setAccountError: async (id, message) => { await codexAccounts.setError(id, message); },
    upstreamBaseUrl: config.codexUpstreamBaseUrl,
    fetch: codexUpstreamFetch
  });
  const purityControllers = new Map<string, Set<AbortController>>();
  const registerPurityController = (relayId: string, controller: AbortController): void => {
    const controllers = purityControllers.get(relayId) ?? new Set<AbortController>();
    controllers.add(controller);
    purityControllers.set(relayId, controllers);
  };
  const unregisterPurityController = (relayId: string, controller: AbortController): void => {
    const controllers = purityControllers.get(relayId);
    if (!controllers) return;
    controllers.delete(controller);
    if (!controllers.size) purityControllers.delete(relayId);
  };
  const cancelPurityTests = (relayId: string): void => {
    purityControllers.get(relayId)?.forEach((controller) => controller.abort());
  };
  await Promise.all([
    relays.initialize(),
    history.initialize(),
    poolUsage.initialize(),
    codexAccounts.initialize(),
    codexUsage.initialize()
  ]);
  if (dependencies.startBalanceScheduler !== false) new BalanceScheduler(relays, balance).start();

  const app = express();
  app.locals.pool = pool;
  app.locals.codexProxy = codexProxy;
  app.disable('x-powered-by');
  app.use(
    cors({
      origin(origin, callback) {
        if (isAllowedClientOrigin(origin, config.clientOrigins, config.allowExtensionOrigins)) {
          callback(null, true);
          return;
        }
        callback(new HttpError(403, '请求来源不被允许'));
      }
    })
  );

  app.post(
    '/api/images/generate',
    express.json({ limit: '12mb' }),
    asyncHandler(async (req, res) => {
      const input = imageGenerationSchema.parse(req.body ?? {});
      let relay: Relay;
      if (input.source === 'custom') {
        if (!input.baseUrl || !input.apiKey) throw new HttpError(400, '请输入自定义绘图端点和 API Key');
        relay = customImageRelay({ baseUrl: input.baseUrl, apiKey: input.apiKey, model: input.model });
      } else {
        if (!input.relayId) throw new HttpError(400, '请选择中转站');
        relay = await relays.find(input.relayId);
      }
      const controller = new AbortController();
      const onClose = (): void => {
        if (!res.writableEnded) controller.abort();
      };
      res.on('close', onClose);
      try {
        send(res, await imageGeneration.generate(relay, input, controller.signal), '图片生成完成');
      } finally {
        res.off('close', onClose);
      }
    })
  );

  app.post(
    '/api/relays/:id/playground/stream',
    express.json({ limit: '512kb' }),
    asyncHandler(async (req, res) => {
      const input = playgroundSchema.parse(req.body ?? {});
      const relay = await relays.find(pathParam(req, 'id'));
      if (!relay.enabled) throw new HttpError(409, '已停用的中转站不能用于游乐场');
      const controller = new AbortController();
      const onClose = (): void => {
        if (!res.writableEnded) controller.abort();
      };
      res.on('close', onClose);
      const writeEvent = (event: PlaygroundStreamEvent): void => {
        if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
      };
      try {
        res.status(200);
        res.set({
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no'
        });
        res.flushHeaders();
        const result = await playground.generate(relay, input, {
          signal: controller.signal,
          onDelta: (text) => writeEvent({ type: 'delta', data: { text } })
        });
        writeEvent({ type: 'done', data: result });
      } catch (error) {
        const cancelled = controller.signal.aborted || (error instanceof HttpError && error.status === 499);
        writeEvent({
          type: 'error',
          data: {
            code: cancelled ? 'cancelled' : 'generation_failed',
            message: cancelled
              ? '模型回复已取消'
              : error instanceof HttpError
                ? error.message
                : '模型生成失败，请稍后重试'
          }
        });
      } finally {
        res.off('close', onClose);
        if (!res.destroyed && !res.writableEnded) res.end();
      }
    })
  );

  app.post(
    '/api/codex-accounts/import',
    express.json({ limit: '2mb' }),
    asyncHandler(async (req, res) => {
      const result = await codexAccounts.importMany(codexAccountImportSchema.parse(req.body ?? {}).sessions);
      send(res, result, `已导入 ${result.createdCount} 个 GPT 账号${result.updatedCount ? `，更新 ${result.updatedCount} 个已有账号` : ''}`);
    })
  );

  app.use(express.json({ limit: '64kb' }));

  app.get('/api/health', (_req, res) => send(res, { status: 'ok' }));

  app.get(
    '/api/codex-accounts',
    asyncHandler(async (_req, res) => send(res, await codexAccounts.listPublic()))
  );

  app.patch(
    '/api/codex-accounts/:id',
    asyncHandler(async (req, res) => send(res, await codexAccounts.update(pathParam(req, 'id'), codexAccountPatchSchema.parse(req.body ?? {})), 'GPT 账号已更新'))
  );

  app.delete(
    '/api/codex-accounts/:id',
    asyncHandler(async (req, res) => {
      const id = pathParam(req, 'id');
      if (codexProxy.status().active && codexProxy.status().accountIds.includes(id)) {
        throw new HttpError(409, '该账号正在被 GPT 账号服务使用，请先停止服务');
      }
      await codexAccounts.remove(id);
      send(res, null, 'GPT 账号已删除');
    })
  );

  app.post(
    '/api/codex-accounts/:id/models',
    asyncHandler(async (req, res) => {
      const controller = new AbortController();
      const onClose = (): void => { if (!res.writableEnded) controller.abort(); };
      res.on('close', onClose);
      try {
        const result = await codexAccountService.discoverModels(pathParam(req, 'id'), controller.signal);
        await codexProxy.refreshAccountMetadata();
        send(res, result, `已同步 ${result.models.length} 个模型`);
      } finally {
        res.off('close', onClose);
      }
    })
  );

  app.post(
    '/api/codex-accounts/:id/usage',
    asyncHandler(async (req, res) => {
      const controller = new AbortController();
      const onClose = (): void => { if (!res.writableEnded) controller.abort(); };
      res.on('close', onClose);
      try {
        const result = await codexAccountService.refreshUsage(pathParam(req, 'id'), controller.signal);
        await codexProxy.refreshAccountMetadata();
        send(res, result, '账号额度已刷新');
      } finally {
        res.off('close', onClose);
      }
    })
  );

  app.post(
    '/api/codex-accounts/models',
    asyncHandler(async (req, res) => {
      const input = codexModelSyncSchema.parse(req.body ?? {});
      const all = await codexAccounts.list();
      const accountIds = input.accountIds.length ? input.accountIds : all.map((account) => account.id);
      const controller = new AbortController();
      const onClose = (): void => { if (!res.writableEnded) controller.abort(); };
      res.on('close', onClose);
      try {
        const result = await codexAccountService.discoverMany(accountIds, controller.signal);
        await codexProxy.refreshAccountMetadata();
        send(res, result, result.failed.length ? `已同步 ${result.accounts.length} 个账号，${result.failed.length} 个失败` : `已同步 ${result.accounts.length} 个账号`);
      } finally {
        res.off('close', onClose);
      }
    })
  );

  app.get('/api/codex-proxy', (_req, res) => send(res, codexProxy.status()));

  app.post(
    '/api/codex-proxy/start',
    asyncHandler(async (req, res) => {
      const result = await runCodexAction(() => codexProxy.start(codexProxyStartSchema.parse(req.body ?? {})));
      send(res, result, 'GPT 账号服务已启动');
    })
  );

  app.post(
    '/api/codex-proxy/stop',
    asyncHandler(async (_req, res) => send(res, await runCodexAction(() => codexProxy.stop()), 'GPT 账号服务已停止'))
  );

  app.post(
    '/api/codex-proxy/key/rotate',
    asyncHandler(async (_req, res) => send(res, await runCodexAction(() => codexProxy.rotateKey()), 'GPT 账号服务 API Key 已轮换'))
  );

  app.get(
    '/api/codex-proxy/usage',
    asyncHandler(async (req, res) => send(res, await codexUsage.report(codexUsageQuerySchema.parse(req.query))))
  );

  app.delete(
    '/api/codex-proxy/usage',
    asyncHandler(async (_req, res) => {
      await codexUsage.clear();
      send(res, null, 'GPT 账号调用明细已清空');
    })
  );

  app.get('/api/pool', (_req, res) => send(res, pool.status()));

  app.post(
    '/api/pool/start',
    asyncHandler(async (req, res) => {
      const input = poolStartSchema.parse(req.body ?? {});
      const result = await runPoolAction(() => pool.start(input));
      await poolUsage.clear();
      send(res, result, '号池服务已启动');
    })
  );

  app.post(
    '/api/pool/stop',
    asyncHandler(async (_req, res) => {
      const result = await runPoolAction(() => pool.stop());
      await poolUsage.clear();
      send(res, result, '号池服务已停止');
    })
  );

  app.post(
    '/api/pool/relays',
    asyncHandler(async (req, res) => {
      const input = poolAddRelaysSchema.parse(req.body ?? {});
      const controller = new AbortController();
      const onClose = (): void => {
        if (!res.writableEnded) controller.abort();
      };
      res.on('close', onClose);
      try {
        const result = await runPoolAction(() => pool.addRelays(input.relayIds, input.modelMap, controller.signal));
        send(res, result, '中转站已加入号池');
      } finally {
        res.off('close', onClose);
      }
    })
  );

  app.post(
    '/api/pool/refresh',
    asyncHandler(async (_req, res) => {
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });
      send(res, await runPoolAction(() => pool.refreshBalances(controller.signal)), '号池余额已刷新');
    })
  );

  app.post(
    '/api/pool/strategy',
    asyncHandler(async (req, res) => {
      const input = poolStrategySchema.parse(req.body ?? {});
      const result = await runPoolAction(async () => pool.setRoutingStrategy(input.routingStrategy));
      send(res, result, '号池轮询规则已更新');
    })
  );

  app.post(
    '/api/pool/key/rotate',
    asyncHandler(async (_req, res) => send(res, await runPoolAction(() => pool.rotateKey()), '号池 API Key 已轮换'))
  );

  app.post(
    '/api/pool/cc-switch',
    asyncHandler(async (_req, res) => {
      const status = pool.status();
      if (!status.active || !status.baseUrl || !status.apiKey || !status.platform) {
        throw new HttpError(409, '请先启动号池服务');
      }
      const relayById = new Map((await relays.list()).map((relay) => [relay.id, relay]));
      const model = status.relayIds.map((id) => relayById.get(id)?.model).find(Boolean);
      if (!model) throw new HttpError(409, '号池中没有可导出的模型');
      const result = await ccSwitch.exportPool({
        baseUrl: status.baseUrl,
        apiKey: status.apiKey,
        model,
        platform: status.platform
      });
      send(res, result, result.created ? '已导入 CC Switch' : 'CC Switch 中已存在该号池');
    })
  );

  app.get(
    '/api/pool/usage',
    asyncHandler(async (req, res) => {
      const query = poolUsageQuerySchema.parse(req.query);
      send(res, await poolUsage.report(query));
    })
  );

  app.get(
    '/api/pool/usage/export',
    asyncHandler(async (req, res) => {
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
    })
  );

  app.get(
    '/api/import/cc-switch',
    asyncHandler(async (_req, res) => send(res, await ccSwitch.preview()))
  );

  app.post(
    '/api/import/cc-switch',
    asyncHandler(async (req, res) => {
      const input = ccSwitchImportSchema.parse(req.body);
      const result = await ccSwitch.import(input.candidateIds);
      const message = result.imported.length
        ? '已从 CC Switch 导入 ' + result.imported.length + ' 个中转站'
        : '没有需要导入的新中转站';
      send(res, result, message);
    })
  );

  app.get(
    '/api/relays',
    asyncHandler(async (_req, res) => send(res, await relays.listPublic()))
  );

  app.get(
    '/api/relays/export',
    asyncHandler(async (_req, res) => {
      const file = exportRelays(await relays.list());
      res
        .status(200)
        .set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .set('Content-Disposition', 'attachment; filename="relay-pulse-relays.xlsx"')
        .send(file);
    })
  );

  app.post(
    '/api/relays/import',
    express.raw({
      type: [
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-excel',
        'application/octet-stream'
      ],
      limit: '10mb'
    }),
    asyncHandler(async (req, res) => {
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, '请上传 Excel 文件');
      const inputs = importRelaysFromSpreadsheet(req.body).map((input) => ({ ...input, enabled: false }));
      const imported = await relays.createMany(inputs);
      send(res, { imported: imported.map(publicRelay) }, `已导入 ${imported.length} 个中转站，全部默认为停用`);
    })
  );

  app.post(
    '/api/relays',
    asyncHandler(async (req, res) => {
      const relay = await relays.create(relayCreateSchema.parse(req.body));
      res.status(201);
      send(res, publicRelay(relay), '中转站已添加');
    })
  );

  app.patch(
    '/api/relays/batch',
    asyncHandler(async (req, res) => {
      const input = batchUpdateSchema.parse(req.body);
      const updated = await relays.batchUpdateEnabled(input.relayIds, input.enabled);
      send(res, updated, input.enabled ? '已批量启用' : '已批量停用');
    })
  );

  app.patch(
    '/api/relays/order',
    asyncHandler(async (req, res) => {
      const input = relayOrderSchema.parse(req.body);
      send(res, await relays.reorder(input.relayIds), '中转站顺序已更新');
    })
  );

  app.post(
    '/api/relays/batch-test',
    asyncHandler(async (req, res) => {
      const input = batchTestSchema.parse(req.body);
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });
      send(
        res,
        await coordinator.batchTest(input.relayIds, { message: input.message, signal: controller.signal }),
        '批量测试完成'
      );
    })
  );

  app.get(
    '/api/relays/:id/api-key',
    asyncHandler(async (req, res) => send(res, { apiKey: (await relays.find(pathParam(req, 'id'))).apiKey }))
  );

  app.get(
    '/api/relays/:id/balance-access-token',
    asyncHandler(async (req, res) => {
      const balanceConfig = (await relays.find(pathParam(req, 'id'))).balanceConfig;
      send(res, { apiKey: balanceConfig?.apiKey ?? '', accessToken: balanceConfig?.accessToken ?? '' });
    })
  );

  app.get(
    '/api/relays/:id',
    asyncHandler(async (req, res) => send(res, await relays.findPublic(pathParam(req, 'id'))))
  );

  app.put(
    '/api/relays/:id',
    asyncHandler(async (req, res) => {
      const relay = await relays.update(pathParam(req, 'id'), relayUpdateSchema.parse(req.body));
      send(res, publicRelay(relay), '中转站已更新');
    })
  );

  app.delete(
    '/api/relays/:id',
    asyncHandler(async (req, res) => {
      const relayId = pathParam(req, 'id');
      cancelPurityTests(relayId);
      await coordinator.cancelRelay(relayId);
      await relays.remove(relayId);
      send(res, null, '中转站已删除');
    })
  );

  app.post(
    '/api/relays/:id/duplicate',
    asyncHandler(async (req, res) => {
      const relay = await relays.duplicate(pathParam(req, 'id'));
      res.status(201);
      send(res, publicRelay(relay), '配置已复制');
    })
  );

  app.get(
    '/api/relays/:id/models',
    asyncHandler(async (req, res) => {
      const relay = await relays.find(pathParam(req, 'id'));
      const controller = new AbortController();
      const onClose = (): void => {
        if (!res.writableEnded) controller.abort();
      };
      res.on('close', onClose);
      try {
        send(res, await tester.discoverModels(relay, controller.signal), '模型探测完成');
      } finally {
        res.off('close', onClose);
      }
    })
  );

  app.post(
    '/api/models/discover',
    asyncHandler(async (req, res) => {
      const input = discoverSchema.parse(req.body);
      const controller = new AbortController();
      const onClose = (): void => {
        if (!res.writableEnded) controller.abort();
      };
      res.on('close', onClose);
      try {
        send(res, await tester.discoverModels(input, controller.signal), '模型探测完成');
      } finally {
        res.off('close', onClose);
      }
    })
  );

  app.post(
    '/api/relays/:id/test',
    asyncHandler(async (req, res) => {
      const input = testSchema.parse(req.body ?? {});
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });
      const result = await coordinator.testRelay(pathParam(req, 'id'), { ...input, signal: controller.signal });
      send(res, result, result.success ? '连接测试成功' : '连接测试失败');
    })
  );

  app.post(
    '/api/purity-test',
    asyncHandler(async (req, res) => {
      const input = customPurityTestSchema.parse(req.body ?? {});
      const relay = customPurityRelay(input);
      const controller = new AbortController();
      const onClose = (): void => {
        if (!res.writableEnded) controller.abort();
      };
      res.on('close', onClose);
      try {
        send(
          res,
          await purityTester.test(relay, {
            model: input.model,
            mode: input.mode,
            gpt56: input.gpt56,
            signal: controller.signal
          }),
          '自定义纯度检测完成'
        );
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new HttpError(499, '纯度检测已取消');
        }
        throw error;
      } finally {
        res.off('close', onClose);
      }
    })
  );

  app.post(
    '/api/purity-test/stream',
    asyncHandler(async (req, res) => {
      const input = customPurityTestSchema.parse(req.body ?? {});
      const relay = customPurityRelay(input);
      const controller = new AbortController();
      const onClose = (): void => {
        if (!res.writableEnded) controller.abort();
      };
      res.on('close', onClose);

      try {
        res.status(200);
        res.set({
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no'
        });
        res.flushHeaders();
        const result = await purityTester.test(relay, {
          model: input.model,
          mode: input.mode,
          gpt56: input.gpt56,
          signal: controller.signal,
          onProgress: (progress) => {
            writePurityStreamEvent(res, { type: 'progress', data: progress });
          }
        });
        writePurityStreamEvent(res, { type: 'result', data: result });
      } catch (error) {
        const cancelled = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
        writePurityStreamEvent(res, {
          type: 'error',
          data: {
            code: cancelled ? 'cancelled' : 'test_failed',
            message: cancelled ? '纯度检测已取消' : '纯度检测失败，请稍后重试'
          }
        });
      } finally {
        res.off('close', onClose);
        if (!res.destroyed && !res.writableEnded) res.end();
      }
    })
  );

  app.post(
    '/api/relays/:id/purity-test',
    asyncHandler(async (req, res) => {
      const input = purityTestSchema.parse(req.body ?? {});
      const relayId = pathParam(req, 'id');
      const relay = await relays.find(relayId);
      if (!relay.enabled) throw new HttpError(409, '已停用的中转站不能执行纯度检测');
      const controller = new AbortController();
      const onClose = (): void => {
        if (!res.writableEnded) controller.abort();
      };
      res.on('close', onClose);
      registerPurityController(relayId, controller);
      try {
        send(
          res,
          await purityTester.test(relay, { ...input, signal: controller.signal }),
          '纯度检测完成'
        );
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new HttpError(499, '纯度检测已取消');
        }
        throw error;
      } finally {
        res.off('close', onClose);
        unregisterPurityController(relayId, controller);
      }
    })
  );

  app.post(
    '/api/relays/:id/purity-test/stream',
    asyncHandler(async (req, res) => {
      const input = purityTestSchema.parse(req.body ?? {});
      const relayId = pathParam(req, 'id');
      const relay = await relays.find(relayId);
      if (!relay.enabled) throw new HttpError(409, '已停用的中转站不能执行纯度检测');

      const controller = new AbortController();
      const onClose = (): void => {
        if (!res.writableEnded) controller.abort();
      };
      res.on('close', onClose);
      registerPurityController(relayId, controller);

      try {
        res.status(200);
        res.set({
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no'
        });
        res.flushHeaders();
        const result = await purityTester.test(relay, {
          ...input,
          signal: controller.signal,
          onProgress: (progress) => {
            writePurityStreamEvent(res, { type: 'progress', data: progress });
          }
        });
        writePurityStreamEvent(res, { type: 'result', data: result });
      } catch (error) {
        const cancelled = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
        writePurityStreamEvent(res, {
          type: 'error',
          data: {
            code: cancelled ? 'cancelled' : 'test_failed',
            message: cancelled ? '纯度检测已取消' : '纯度检测失败，请稍后重试'
          }
        });
      } finally {
        res.off('close', onClose);
        unregisterPurityController(relayId, controller);
        if (!res.destroyed && !res.writableEnded) res.end();
      }
    })
  );

  app.post(
    '/api/relays/:id/balance',
    asyncHandler(async (req, res) => {
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });
      const relay = await balance.query(pathParam(req, 'id'), controller.signal);
      send(res, publicRelay(relay), '余额查询完成');
    })
  );

  app.delete(
    '/api/relays/:id/test',
    asyncHandler(async (req, res) => {
      const relayId = pathParam(req, 'id');
      cancelPurityTests(relayId);
      await coordinator.cancelRelay(relayId);
      send(res, null, '测试请求已取消');
    })
  );

  app.get(
    '/api/test-history',
    asyncHandler(async (req, res) => {
      const query = historyQuerySchema.parse(req.query);
      send(
        res,
        await history.list({
          relayId: query.relayId,
          success: query.success,
          from: query.from,
          to: query.to
        })
      );
    })
  );

  app.delete(
    '/api/test-history/:id',
    asyncHandler(async (req, res) => {
      await history.remove(pathParam(req, 'id'));
      send(res, null, '历史记录已删除');
    })
  );

  app.delete(
    '/api/test-history',
    asyncHandler(async (_req, res) => {
      await history.clear();
      send(res, null, '测试历史已清空');
    })
  );

  app.use((_req, res) => res.status(404).json({ success: false, data: null, message: '接口不存在' }));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ZodError) {
      res.status(400).json({ success: false, data: null, message: error.issues[0]?.message ?? '请求参数错误' });
      return;
    }
    const relayError = error as { errorType?: unknown; statusCode?: unknown };
    const expressError = error as { status?: unknown; type?: unknown };
    const isRelayError = typeof relayError.errorType === 'string' && error instanceof Error;
    const status =
      error instanceof HttpError
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
    const message =
      error instanceof HttpError || isRelayError
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
