export type RelayProtocol = 'auto' | 'responses' | 'chat';
export type RelayPlatform = 'openai' | 'anthropic';
export type TestProtocol = Exclude<RelayProtocol, 'auto'> | 'anthropic';
export type TestStatus = 'success' | 'failed' | 'untested';
export type ThemeMode = 'light' | 'dark' | 'system';
export type BalanceTemplate = 'generic' | 'newapi';

export interface BalanceConfig {
  template: BalanceTemplate;
  requestUrl: string;
  userId: string;
  timeout: number;
  intervalMinutes: number;
  enabled: boolean;
  apiKeyConfigured: boolean;
  accessTokenConfigured: boolean;
}

export interface BalanceConfigFormValue {
  template: BalanceTemplate;
  requestUrl: string;
  apiKey?: string;
  accessToken?: string;
  userId: string;
  timeout: number;
  intervalMinutes: number;
  enabled: boolean;
}

export interface BalanceSnapshot {
  success: boolean;
  remaining: number | null;
  total: number | null;
  used: number | null;
  unit: string;
  planName: string;
  errorMessage: string;
  queriedAt: string;
  dailyUsageDate?: string;
  dailyConsumed?: number;
}

export interface Relay {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyMasked: string;
  model: string;
  platform: RelayPlatform;
  protocol: RelayProtocol;
  enabled: boolean;
  timeout: number;
  remark: string;
  createdAt: string;
  updatedAt: string;
  lastTestAt: string | null;
  lastTestStatus: TestStatus;
  lastLatency: number | null;
  balanceConfig?: BalanceConfig;
  balance?: BalanceSnapshot;
}

export interface RelayFormValue {
  name: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  platform: RelayPlatform;
  protocol: RelayProtocol;
  enabled: boolean;
  timeout: number;
  remark: string;
  balanceConfig?: BalanceConfigFormValue;
}

export type TestErrorType =
  | 'auth'
  | 'rate_limit'
  | 'model_not_found'
  | 'not_found'
  | 'server'
  | 'timeout'
  | 'cancelled'
  | 'dns'
  | 'connection'
  | 'tls'
  | 'network'
  | 'invalid_response'
  | 'http_error'
  | null;

export interface TestResult {
  id: string;
  success: boolean;
  relayId: string;
  relayName: string;
  model: string;
  protocol: TestProtocol;
  statusCode: number | null;
  responseText: string;
  totalDuration: number;
  dnsDuration: number | null;
  tcpDuration: number | null;
  tlsDuration: number | null;
  firstByteDuration: number | null;
  errorType: TestErrorType;
  errorMessage: string;
  testedAt: string;
}

export interface ApiEnvelope<T> {
  success: boolean;
  data: T;
  message: string;
}

export interface CcSwitchImportCandidate {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyMasked: string;
  model: string;
  platform: RelayPlatform;
  protocol: RelayProtocol;
  source: 'codex' | 'claude';
  isCurrent: boolean;
  alreadyExists: boolean;
}

export interface CcSwitchImportPreview {
  candidates: CcSwitchImportCandidate[];
  unsupportedCount: number;
  invalidCount: number;
}

export interface CcSwitchImportResult {
  imported: Relay[];
  duplicateCount: number;
}

export type PoolEndpoint = '/v1/chat/completions' | '/v1/responses' | '/v1/messages';
export type PoolRoutingStrategy = 'round-robin' | 'random';
export type PoolUsageStatus = 'success' | 'failed';
export type PoolUsageGranularity = 'hour' | 'day';

export interface PoolBalanceSummary {
  unit: string;
  currentBalance: number;
  consumedBalance: number;
}

export interface PoolRelayBalanceUsage {
  relayId: string;
  relayName: string;
  unit: string;
  initialBalance: number | null;
  currentBalance: number | null;
  consumedBalance: number | null;
}

export interface PoolStatus {
  active: boolean;
  host: string;
  port: number | null;
  baseUrl: string | null;
  startedAt: string | null;
  eligibleRelayCount: number;
  cooldownRelayCount: number;
  routingStrategy: PoolRoutingStrategy;
  relayIds: string[];
  platform: RelayPlatform | null;
  apiKey: string;
  balanceSummary: PoolBalanceSummary[];
  balanceDetails: PoolRelayBalanceUsage[];
}

export interface PoolStartResult extends PoolStatus {
  apiKey: string;
}

export interface PoolUsageRecord {
  id: string;
  createdAt: string;
  relayId: string | null;
  relayName: string;
  endpoint: PoolEndpoint;
  model: string;
  status: PoolUsageStatus;
  statusCode: number | null;
  attempts: number;
  firstByteMs: number | null;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  totalTokens: number | null;
  cost: number | null;
  errorCode: string;
  errorMessage: string;
}

export interface PoolUsageQuery {
  from?: string;
  to?: string;
  model?: string;
  relayId?: string;
  endpoint?: PoolEndpoint;
  status?: PoolUsageStatus;
  limit?: number;
  offset?: number;
  granularity?: PoolUsageGranularity;
}

export interface PoolUsageSummary {
  requestCount: number;
  successCount: number;
  failureCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  averageDurationMs: number;
}

export interface PoolUsageBreakdown {
  key: string;
  label: string;
  requestCount: number;
  successCount: number;
  failureCount: number;
  totalTokens: number;
  averageDurationMs: number;
}

export interface PoolUsageTrendPoint {
  bucket: string;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
}

export interface PoolUsageFilterOption {
  value: string;
  label: string;
}

export interface PoolUsageFilterOptions {
  models: PoolUsageFilterOption[];
  relays: PoolUsageFilterOption[];
}

export interface PoolUsageReport {
  records: PoolUsageRecord[];
  total: number;
  summary: PoolUsageSummary;
  byModel: PoolUsageBreakdown[];
  byRelay: PoolUsageBreakdown[];
  byEndpoint: PoolUsageBreakdown[];
  trend: PoolUsageTrendPoint[];
  filterOptions: PoolUsageFilterOptions;
}

export type BatchItemStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled';
export interface BatchItem {
  relay: Relay;
  status: BatchItemStatus;
  result?: TestResult;
}
