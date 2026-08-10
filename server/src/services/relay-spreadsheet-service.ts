import { HttpError } from '../lib/http-error.js';
import { buildXlsx, parseXlsxRows, type SpreadsheetValue } from '../lib/xlsx.js';
import type { BalanceConfig, Relay, RelayInput } from '../types.js';

interface Column {
  key: string;
  label: string;
}

const columns: Column[] = [
  { key: 'id', label: 'ID' },
  { key: 'name', label: '名称' },
  { key: 'baseUrl', label: 'Base URL' },
  { key: 'apiKey', label: 'API Key' },
  { key: 'model', label: '默认模型' },
  { key: 'platform', label: '平台类型' },
  { key: 'protocol', label: '请求协议' },
  { key: 'enabled', label: '启用' },
  { key: 'timeout', label: '请求超时（毫秒）' },
  { key: 'remark', label: '备注' },
  { key: 'createdAt', label: '创建时间' },
  { key: 'updatedAt', label: '更新时间' },
  { key: 'lastTestAt', label: '最近测试时间' },
  { key: 'lastTestStatus', label: '最近测试状态' },
  { key: 'lastLatency', label: '最近延迟（毫秒）' },
  { key: 'balanceConfig.template', label: '余额配置模板' },
  { key: 'balanceConfig.requestUrl', label: '余额请求地址' },
  { key: 'balanceConfig.apiKey', label: '余额 API Key' },
  { key: 'balanceConfig.accessToken', label: '余额访问令牌' },
  { key: 'balanceConfig.userId', label: '余额用户 ID' },
  { key: 'balanceConfig.timeout', label: '余额请求超时（毫秒）' },
  { key: 'balanceConfig.intervalMinutes', label: '余额刷新间隔（分钟）' },
  { key: 'balanceConfig.enabled', label: '余额查询启用' },
  { key: 'balance.remaining', label: '余额剩余' },
  { key: 'balance.total', label: '余额总额' },
  { key: 'balance.used', label: '余额已用' },
  { key: 'balance.unit', label: '余额单位' },
  { key: 'balance.planName', label: '余额套餐' },
  { key: 'balance.success', label: '余额查询成功' },
  { key: 'balance.errorMessage', label: '余额错误信息' },
  { key: 'balance.queriedAt', label: '余额查询时间' },
  { key: 'balance.dailyUsageDate', label: '今日消耗日期' },
  { key: 'balance.dailyConsumed', label: '今日消耗' }
];

const columnAliases = new Map<string, string>();
columns.forEach((column) => {
  columnAliases.set(column.label, column.key);
  columnAliases.set(column.key, column.key);
});
columnAliases.set('中转站名称', 'name');
columnAliases.set('URL', 'baseUrl');
columnAliases.set('密钥', 'apiKey');
columnAliases.set('模型', 'model');

function valueAt(relay: Relay, key: string): SpreadsheetValue {
  const [scope, field] = key.split('.', 2);
  if (!field) return relay[scope as keyof Relay] as SpreadsheetValue;
  const source = relay[scope as 'balanceConfig' | 'balance'] as Record<string, unknown> | undefined;
  return source?.[field] as SpreadsheetValue;
}

function text(value: SpreadsheetValue): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function booleanValue(value: SpreadsheetValue, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  const normalized = text(value).toLowerCase();
  if (['true', '1', 'yes', 'y', '是', '启用', '成功'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', '否', '停用', '失败'].includes(normalized)) return false;
  return fallback;
}

function numberValue(value: SpreadsheetValue, fallback: number | null = null): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(text(value));
  return Number.isFinite(parsed) && text(value) ? parsed : fallback;
}

function rowValue(row: SpreadsheetValue[], indexes: Map<string, number>, key: string): SpreadsheetValue {
  const index = indexes.get(key);
  return index === undefined ? '' : row[index];
}

function balanceConfigFromRow(row: SpreadsheetValue[], indexes: Map<string, number>): BalanceConfig | undefined {
  const keys = ['balanceConfig.template', 'balanceConfig.requestUrl', 'balanceConfig.apiKey', 'balanceConfig.accessToken', 'balanceConfig.userId'];
  if (!keys.some((key) => text(rowValue(row, indexes, key)))) return undefined;
  const template = text(rowValue(row, indexes, 'balanceConfig.template'));
  return {
    template: template === 'newapi' ? 'newapi' : 'generic',
    requestUrl: text(rowValue(row, indexes, 'balanceConfig.requestUrl')),
    apiKey: text(rowValue(row, indexes, 'balanceConfig.apiKey')) || undefined,
    accessToken: text(rowValue(row, indexes, 'balanceConfig.accessToken')) || undefined,
    userId: text(rowValue(row, indexes, 'balanceConfig.userId')),
    timeout: numberValue(rowValue(row, indexes, 'balanceConfig.timeout'), 10000) ?? 10000,
    intervalMinutes: numberValue(rowValue(row, indexes, 'balanceConfig.intervalMinutes'), 1) ?? 1,
    enabled: booleanValue(rowValue(row, indexes, 'balanceConfig.enabled'), true)
  };
}

export function exportRelays(relays: Relay[]): Buffer {
  const header = columns.map((column) => column.label);
  const rows = relays.map((relay) => columns.map((column) => valueAt(relay, column.key)));
  return buildXlsx([header, ...rows]);
}

export function importRelays(buffer: Buffer): RelayInput[] {
  let rows: SpreadsheetValue[][];
  try {
    rows = parseXlsxRows(buffer);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : 'Excel 文件解析失败');
  }
  const headerIndexes = new Map<string, number>();
  rows[0]?.forEach((value, index) => {
    const key = columnAliases.get(text(value));
    if (key) headerIndexes.set(key, index);
  });
  for (const required of ['name', 'baseUrl', 'apiKey', 'model']) {
    if (!headerIndexes.has(required)) throw new HttpError(400, `Excel 缺少必要列：${columns.find((column) => column.key === required)?.label ?? required}`);
  }
  const inputs: RelayInput[] = [];
  rows.slice(1).forEach((row, index) => {
    if (!row.some((value) => text(value))) return;
    const rowNumber = index + 2;
    const name = text(rowValue(row, headerIndexes, 'name'));
    const baseUrl = text(rowValue(row, headerIndexes, 'baseUrl'));
    const apiKey = text(rowValue(row, headerIndexes, 'apiKey'));
    const model = text(rowValue(row, headerIndexes, 'model'));
    if (!name || !baseUrl || !apiKey || !model) throw new HttpError(400, `第 ${rowNumber} 行缺少名称、Base URL、API Key 或模型`);
    const platform = text(rowValue(row, headerIndexes, 'platform')) === 'anthropic' ? 'anthropic' : 'openai';
    const protocol = ['auto', 'responses', 'chat'].includes(text(rowValue(row, headerIndexes, 'protocol')))
      ? text(rowValue(row, headerIndexes, 'protocol')) as RelayInput['protocol']
      : 'auto';
    inputs.push({
      name,
      baseUrl,
      apiKey,
      model,
      platform,
      protocol,
      enabled: false,
      timeout: numberValue(rowValue(row, headerIndexes, 'timeout'), 30000) ?? 30000,
      remark: text(rowValue(row, headerIndexes, 'remark')),
      balanceConfig: balanceConfigFromRow(row, headerIndexes)
    });
  });
  if (!inputs.length) throw new HttpError(400, 'Excel 中没有可导入的中转站');
  if (inputs.length > 500) throw new HttpError(400, '一次最多导入 500 个中转站');
  return inputs;
}
