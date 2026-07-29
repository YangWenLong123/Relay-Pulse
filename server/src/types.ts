export type RelayProtocol = 'auto' | 'responses' | 'chat';
export type TestStatus = 'success' | 'failed' | 'untested';
export type BalanceTemplate = 'generic' | 'newapi';

export interface BalanceConfig {
  template: BalanceTemplate;
  requestUrl: string;
  apiKey?: string;
  accessToken?: string;
  userId: string;
  timeout: number;
  intervalMinutes: number;
  enabled: boolean;
}

export interface PublicBalanceConfig extends Omit<BalanceConfig, 'apiKey' | 'accessToken'> {
  apiKeyConfigured: boolean;
  accessTokenConfigured: boolean;
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
}

export interface Relay {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
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

export type PublicRelay = Omit<Relay, 'apiKey' | 'balanceConfig'> & {
  apiKeyMasked: string;
  balanceConfig?: PublicBalanceConfig;
};

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
  protocol: Exclude<RelayProtocol, 'auto'>;
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

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  message: string;
}

export interface RelayInput {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  protocol: RelayProtocol;
  enabled: boolean;
  timeout: number;
  remark: string;
  balanceConfig?: BalanceConfig;
}
