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

export type BatchItemStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled';
export interface BatchItem {
  relay: Relay;
  status: BatchItemStatus;
  result?: TestResult;
}
