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

const isLoopbackHostname = (hostname: string): boolean => {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return value === 'localhost' || value === '::1' || /^127(?:\.\d{1,3}){3}$/.test(value);
};

const credentialUrl = httpUrl.refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}, '公网 HTTP 会明文传输 API Key，请使用 HTTPS；本机回环地址可使用 HTTP');

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

const playgroundMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1, '对话消息不能为空').max(20_000, '单条消息不能超过 20000 个字符')
});

export const playgroundSchema = z.object({
  model: z.string().trim().min(1, '请选择模型').max(160),
  messages: z.array(playgroundMessageSchema).min(1, '请至少输入一条消息').max(100, '单次最多携带 100 条消息'),
  systemPrompt: z.string().trim().max(20_000, '系统提示词不能超过 20000 个字符').default(''),
  temperature: z.number().min(0).max(2).default(1),
  topP: z.number().min(0).max(1).default(1),
  maxTokens: z.number().int().min(1).max(32_768).default(4096)
}).superRefine((input, ctx) => {
  const totalLength = input.messages.reduce((sum, item) => sum + item.content.length, input.systemPrompt.length);
  if (totalLength > 100_000) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['messages'], message: '对话上下文不能超过 100000 个字符' });
  }
});

const gpt56TrustedReferenceSchema = z.object({
  baseUrl: credentialUrl,
  apiKey: createApiKey,
  model: z.string().trim().min(1, '请输入可信参考模型').max(160)
});

const gpt56ConfigSchema = z.object({
  trials: z.number().int().min(3, '深度检测至少需要 3 轮').max(20, '深度检测最多支持 20 轮').default(5),
  trustedReference: gpt56TrustedReferenceSchema.optional()
}).optional();

export const purityTestSchema = z.object({
  model: z.string().trim().min(1).max(160).optional(),
  mode: z.enum(['quick', 'standard', 'gpt56']).default('standard'),
  gpt56: gpt56ConfigSchema
});

export const customPurityTestSchema = z.object({
  baseUrl: credentialUrl,
  apiKey: createApiKey,
  model: z.string().trim().min(1, '请输入检测模型').max(160),
  platform: platform.default('openai'),
  protocol: protocol.default('auto'),
  timeout: z.number().int().min(1000).max(120000).default(30000),
  mode: z.enum(['quick', 'standard', 'gpt56']).default('standard'),
  gpt56: gpt56ConfigSchema
}).superRefine((input, ctx) => {
  if (input.mode !== 'gpt56') return;
  if (input.platform !== 'openai') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['platform'], message: 'GPT-5.6 深度检测仅支持 OpenAI Responses' });
  }
  if (input.protocol === 'chat') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['protocol'], message: 'GPT-5.6 深度检测请使用 Responses 或自动协议' });
  }
});

export type CustomPurityTestInput = z.infer<typeof customPurityTestSchema>;

const imageAspectRatio = z.enum(['1:1', '16:9', '9:16', '4:3', '3:4']);
const imageSize = z.enum(['1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792']);
const imageOutputFormat = z.enum(['jpg', 'png', 'webp']);
const imageReferenceSchema = z.object({
  dataUrl: z.string().trim().min(1, '参考图数据不能为空').max(12_000_000, '参考图不能超过 8MB'),
  name: z.string().trim().max(160).optional(),
  mimeType: z.string().trim().max(80).optional()
});

export const imageGenerationSchema = z.object({
  source: z.enum(['saved', 'custom']).default('saved'),
  relayId: z.string().uuid('请选择中转站').optional(),
  baseUrl: credentialUrl.optional(),
  apiKey: createApiKey.optional(),
  model: z.string().trim().min(1, '请输入绘图模型').max(160),
  prompt: z.string().trim().min(1, '请输入描述内容').max(8000),
  aspectRatio: imageAspectRatio.default('1:1'),
  size: imageSize.default('1024x1024'),
  count: z.number().int().min(1, '至少生成 1 张').max(4, '单次最多生成 4 张').default(1),
  format: imageOutputFormat.default('jpg'),
  referenceImage: imageReferenceSchema.nullish()
}).superRefine((input, ctx) => {
  if (input.source === 'saved' && !input.relayId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['relayId'], message: '请选择中转站' });
  }
  if (input.source === 'custom') {
    if (!input.baseUrl) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['baseUrl'], message: '请输入 Base URL' });
    if (!input.apiKey) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['apiKey'], message: '请输入 API Key' });
  }
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
  baseUrl: credentialUrl,
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

export const poolStartSchema = z
  .object({
    port: z.number().int().min(0).max(65535).default(0),
    relayIds: z.array(z.string().uuid()).min(1, '请先向号池添加至少一个中转站').max(200)
      .refine((ids) => new Set(ids).size === ids.length, '号池中转站不能重复'),
    routingStrategy: z.enum(['round-robin', 'random']).default('round-robin'),
    modelMap: z
      .record(
        z.string().uuid(),
        z.array(z.string().trim().min(1).max(160)).max(500)
          .refine((models) => new Set(models).size === models.length, '模型子集不能包含重复项')
      )
      .default({})
  })
  .refine((value) => Object.keys(value.modelMap).every((relayId) => value.relayIds.includes(relayId)), {
    message: '模型映射只能包含号池成员中转站',
    path: ['modelMap']
  });

export const poolAddRelaysSchema = z
  .object({
    relayIds: z.array(z.string().uuid()).min(1, '请至少选择一个要添加的中转站').max(200)
      .refine((ids) => new Set(ids).size === ids.length, '新增中转站不能重复'),
    modelMap: z
      .record(
        z.string().uuid(),
        z.array(z.string().trim().min(1).max(160)).max(500)
          .refine((models) => new Set(models).size === models.length, '模型子集不能包含重复项')
      )
      .default({})
  })
  .refine((value) => Object.keys(value.modelMap).every((relayId) => value.relayIds.includes(relayId)), {
    message: '模型映射只能包含本次添加的中转站',
    path: ['modelMap']
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

const codexToken = z.string().trim().min(1, 'session 文件缺少 access_token').max(300_000, 'session 字段过大');
const codexOptionalToken = z.string().max(300_000, 'session 字段过大').optional();
const codexSessionSchema = z.object({
  type: z.string().trim().max(40).optional(),
  account_id: z.string().trim().max(240).optional(),
  chatgpt_account_id: z.string().trim().max(240).optional(),
  email: z.string().trim().email('email 格式不正确').max(320).optional(),
  name: z.string().trim().max(320).optional(),
  plan_type: z.string().trim().max(80).optional(),
  chatgpt_plan_type: z.string().trim().max(80).optional(),
  id_token: codexOptionalToken,
  access_token: codexToken,
  refresh_token: codexOptionalToken,
  session_token: codexOptionalToken,
  client_id: z.string().trim().max(320).optional(),
  workspace_id: z.string().trim().max(240).optional(),
  organization_id: z.string().trim().max(240).optional(),
  last_refresh: z.string().trim().max(80).optional(),
  expired: z.string().trim().max(80).optional(),
  expires_at: z.union([z.string().trim().max(80), z.number().positive()]).optional()
}).passthrough();

export const codexAccountImportSchema = z.object({
  sessions: z.array(codexSessionSchema).min(1, '请至少选择一个 session 文件').max(200, '单次最多导入 200 个账号')
});

export const codexAccountPatchSchema = z.object({
  enabled: z.boolean().optional(),
  name: z.string().trim().min(1, '名称不能为空').max(320).optional()
}).refine((value) => value.enabled !== undefined || value.name !== undefined, '请至少提供一个更新字段');

export const codexModelSyncSchema = z.object({
  accountIds: z.array(z.string().uuid()).max(200).refine((ids) => new Set(ids).size === ids.length, '账号 ID 不能重复').default([])
});

export const codexProxyStartSchema = z.object({
  port: z.number().int().min(0).max(65535).default(0),
  accountIds: z.array(z.string().uuid()).max(200).refine((ids) => new Set(ids).size === ids.length, '账号 ID 不能重复').default([]),
  routingStrategy: z.enum(['round-robin', 'random']).default('round-robin')
});

export const codexUsageQuerySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  model: z.string().trim().min(1).max(160).optional(),
  accountId: z.string().uuid().optional(),
  status: z.enum(['success', 'failed']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100000).default(0)
});
