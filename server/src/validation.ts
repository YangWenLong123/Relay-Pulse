import { z } from 'zod';

const protocol = z.enum(['auto', 'responses', 'chat']);
const platform = z.enum(['openai', 'anthropic']);
const httpUrl = z
  .string()
  .trim()
  .url('请输入有效 URL')
  .max(500)
  .refine((value) => {
    try {
      return ['http:', 'https:'].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, 'URL 仅支持 http 或 https 协议')
  .refine((value) => {
    try {
      const url = new URL(value);
      return !url.username && !url.password;
    } catch {
      return false;
    }
  }, 'URL 不能包含用户名或密码');

const createApiKey = z
  .string()
  .trim()
  .min(1, '请输入 API Key')
  .max(500)
  .refine((value) => !/[\r\n]/.test(value), 'API Key 不能包含换行符');
const updateApiKey = z
  .string()
  .trim()
  .max(500)
  .refine((value) => !/[\r\n]/.test(value), 'API Key 不能包含换行符')
  .optional();

const balanceTemplate = z.enum(['generic', 'newapi']);
const balanceConfigSchema = z.object({
  template: balanceTemplate.default('generic'),
  requestUrl: z.union([httpUrl, z.literal('')]).default(''),
  apiKey: updateApiKey,
  accessToken: updateApiKey,
  userId: z.string().trim().max(160).default(''),
  timeout: z.number().int().min(1000).max(120000).default(10000),
  intervalMinutes: z.number().int().min(0).max(1440).default(1),
  enabled: z.boolean().default(true)
});

export const relayCreateSchema = z.object({
  name: z.string().trim().min(1, '请输入名称').max(80),
  baseUrl: httpUrl,
  apiKey: createApiKey,
  model: z.string().trim().min(1, '请输入模型').max(160),
  platform: platform.default('openai'),
  protocol: protocol.default('auto'),
  enabled: z.boolean().default(true),
  timeout: z.number().int().min(1000).max(120000).default(30000),
  remark: z.string().trim().max(500).default(''),
  balanceConfig: balanceConfigSchema.optional()
});

export const relayUpdateSchema = relayCreateSchema.partial().extend({ apiKey: updateApiKey });

export const testSchema = z.object({
  model: z.string().trim().max(160).optional(),
  message: z.string().trim().min(1).max(4000).default('hi'),
  protocol: protocol.optional()
});

export const batchTestSchema = z.object({
  relayIds: z.array(z.string().uuid()).min(1).max(200).refine((ids) => new Set(ids).size === ids.length, '中转站 ID 不能重复'),
  message: z.string().trim().min(1).max(4000).default('hi')
});

export const batchUpdateSchema = z.object({
  relayIds: z.array(z.string().uuid()).min(1).max(200).refine((ids) => new Set(ids).size === ids.length, '中转站 ID 不能重复'),
  enabled: z.boolean()
});

export const relayOrderSchema = z.object({
  relayIds: z.array(z.string().uuid()).min(1).max(200).refine((ids) => new Set(ids).size === ids.length, '中转站 ID 不能重复')
});

export const ccSwitchImportSchema = z.object({
  candidateIds: z.array(z.string().trim().min(1).max(240)).min(1).max(500)
    .refine((ids) => new Set(ids).size === ids.length, '导入项不能重复')
});

export const discoverSchema = z.object({
  baseUrl: httpUrl,
  apiKey: createApiKey,
  platform: platform.default('openai'),
  timeout: z.number().int().min(1000).max(120000).default(30000)
});

export const historyQuerySchema = z.object({
  relayId: z.string().uuid().optional(),
  success: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional()
});

export const poolStartSchema = z.object({
  port: z.number().int().min(0).max(65535).default(0),
  relayIds: z.array(z.string().uuid()).min(1, '请先向号池添加至少一个中转站').max(200)
    .refine((ids) => new Set(ids).size === ids.length, '号池中转站不能重复'),
  routingStrategy: z.enum(['round-robin', 'random']).default('round-robin')
});

export const poolStrategySchema = z.object({
  routingStrategy: z.enum(['round-robin', 'random'])
});

export const poolUsageQuerySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  model: z.string().trim().min(1).max(160).optional(),
  relayId: z.string().uuid().optional(),
  endpoint: z.enum(['/v1/chat/completions', '/v1/responses', '/v1/messages']).optional(),
  status: z.enum(['success', 'failed']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
  granularity: z.enum(['hour', 'day']).default('hour')
});
