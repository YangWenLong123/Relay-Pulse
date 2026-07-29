import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { ZodError } from 'zod';
import { config } from './config.js';
import { HttpError } from './lib/http-error.js';
import { isAllowedClientOrigin } from './lib/origin-policy.js';
import { publicRelay } from './lib/relay-utils.js';
import { HistoryRepository } from './repositories/history-repository.js';
import { RelayRepository } from './repositories/relay-repository.js';
import { RelayTester } from './services/relay-tester.js';
import { TestCoordinator } from './services/test-coordinator.js';
import { BalanceService } from './services/balance-service.js';
import { BalanceScheduler } from './services/balance-scheduler.js';
import {
  batchTestSchema,
  batchUpdateSchema,
  discoverSchema,
  historyQuerySchema,
  relayCreateSchema,
  relayUpdateSchema,
  testSchema
} from './validation.js';

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;
const asyncHandler = (handler: AsyncHandler) => (req: Request, res: Response, next: NextFunction) => {
  void handler(req, res, next).catch(next);
};

const send = <T>(res: Response, data: T, message = ''): void => {
  res.json({ success: true, data, message });
};

const pathParam = (req: Request, name: string): string => {
  const value = req.params[name];
  if (!value) throw new HttpError(400, '缺少路径参数');
  return value;
};

export interface AppDependencies {
  relays?: RelayRepository;
  history?: HistoryRepository;
  tester?: RelayTester;
  balance?: BalanceService;
  startBalanceScheduler?: boolean;
}

export async function createApp(dependencies: AppDependencies = {}): Promise<express.Express> {
  const relays = dependencies.relays ?? new RelayRepository();
  const history = dependencies.history ?? new HistoryRepository();
  const tester = dependencies.tester ?? new RelayTester();
  const coordinator = new TestCoordinator(relays, history, tester);
  const balance = dependencies.balance ?? new BalanceService(relays);
  await Promise.all([relays.initialize(), history.initialize()]);
  if (dependencies.startBalanceScheduler !== false) new BalanceScheduler(relays, balance).start();

  const app = express();
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
  app.use(express.json({ limit: '64kb' }));

  app.get('/api/health', (_req, res) => send(res, { status: 'ok' }));

  app.get(
    '/api/relays',
    asyncHandler(async (_req, res) => send(res, await relays.listPublic()))
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
      await coordinator.cancelRelay(pathParam(req, 'id'));
      await relays.remove(pathParam(req, 'id'));
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
      send(res, await tester.discoverModels(relay), '模型探测完成');
    })
  );

  app.post(
    '/api/models/discover',
    asyncHandler(async (req, res) => {
      const input = discoverSchema.parse(req.body);
      send(res, await tester.discoverModels(input), '模型探测完成');
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
    '/api/relays/:id/balance',
    asyncHandler(async (req, res) => {
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });
      send(res, await balance.query(pathParam(req, 'id'), controller.signal), '余额查询完成');
    })
  );

  app.delete(
    '/api/relays/:id/test',
    asyncHandler(async (req, res) => {
      await coordinator.cancelRelay(pathParam(req, 'id'));
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
