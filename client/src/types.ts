export type RelayProtocol = 'auto' | 'responses' | 'chat';
export type RelayPlatform = 'openai' | 'anthropic';
export type TestProtocol = Exclude<RelayProtocol, 'auto'> | 'anthropic';
export type TestStatus = 'success' | 'failed' | 'untested';
export type ThemeMode = 'light' | 'dark';
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

export type PlaygroundMessageRole = 'user' | 'assistant';

export interface PlaygroundMessage {
  role: PlaygroundMessageRole;
  content: string;
}

export interface PlaygroundInput {
  model: string;
  messages: PlaygroundMessage[];
  systemPrompt: string;
  temperature: number;
  topP: number;
  maxTokens: number;
}

export interface PlaygroundUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface PlaygroundCompletion {
  relayId: string;
  relayName: string;
  requestedModel: string;
  reportedModel: string | null;
  protocol: TestProtocol;
  finishReason: string | null;
  usage: PlaygroundUsage;
  durationMs: number;
}

export type PlaygroundStreamEvent =
  | { type: 'delta'; data: { text: string } }
  | { type: 'done'; data: PlaygroundCompletion }
  | { type: 'error'; data: { code: 'cancelled' | 'generation_failed'; message: string } };

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

export interface RelayImportResult {
  imported: Relay[];
}

export type ImageAspectRatio = '1:1' | '16:9' | '9:16' | '4:3' | '3:4';
export type ImageSize = '1024x1024' | '1536x1024' | '1024x1536' | '1792x1024' | '1024x1792';
export type ImageGenerationSource = 'saved' | 'custom';
export type ImageOutputFormat = 'jpg' | 'png' | 'webp';

export interface ImageReferenceInput {
  dataUrl: string;
  name?: string;
  mimeType?: string;
}

export interface ImageGenerationInput {
  source?: ImageGenerationSource;
  relayId?: string;
  baseUrl?: string;
  apiKey?: string;
  model: string;
  prompt: string;
  aspectRatio: ImageAspectRatio;
  size: ImageSize;
  count?: number;
  format?: ImageOutputFormat;
  referenceImage?: ImageReferenceInput | null;
}

export interface ImageGenerationResultImage {
  index: number;
  dataUrl?: string;
  url?: string;
  mimeType: string;
  revisedPrompt?: string;
}

export interface ImageGenerationResult {
  relayId: string;
  relayName: string;
  source: ImageGenerationSource;
  model: string;
  prompt: string;
  finalPrompt: string;
  aspectRatio: ImageAspectRatio;
  size: ImageSize;
  count: number;
  format: ImageOutputFormat;
  images: ImageGenerationResultImage[];
  image: ImageGenerationResultImage;
  revisedPrompt?: string;
  upstreamEndpoint: '/v1/images/generations' | '/v1/images/edits';
  durationMs: number;
  createdAt: string;
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
  modelMap: Record<string, string[]>;
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

export type CodexAccountStatus = 'active' | 'expired' | 'error' | 'untested';
export type CodexRoutingStrategy = 'round-robin' | 'random';

export interface CodexAccount {
  id: string;
  accountIdMasked: string;
  email: string;
  name: string;
  planType: string;
  enabled: boolean;
  status: CodexAccountStatus;
  expiresAt: string | null;
  models: string[];
  modelCount: number;
  usageSnapshot: CodexAccountUsageSnapshot | null;
  lastModelSyncAt: string | null;
  lastError: string;
  createdAt: string;
  updatedAt: string;
}

export interface CodexUsageWindow {
  usedPercent: number;
  resetAfterSeconds: number;
  resetAt: string | null;
  windowMinutes: number;
}

export interface CodexAccountUsageSnapshot {
  planType: string;
  activeLimit: string;
  creditsBalance: string | null;
  creditsHasCredits: boolean | null;
  creditsUnlimited: boolean | null;
  primary: CodexUsageWindow | null;
  secondary: CodexUsageWindow | null;
  updatedAt: string;
}

export interface CodexAccountImportResult {
  accounts: CodexAccount[];
  createdCount: number;
  updatedCount: number;
}

export interface CodexAccountModelsResult {
  account: CodexAccount;
  models: string[];
}

export interface CodexAccountUsageResult {
  account: CodexAccount;
  usage: CodexAccountUsageSnapshot;
}

export interface CodexProxyStatus {
  active: boolean;
  host: string;
  port: number | null;
  baseUrl: string | null;
  apiKey: string;
  startedAt: string | null;
  routingStrategy: CodexRoutingStrategy;
  accountIds: string[];
  availableAccountCount: number;
  models: string[];
}

export interface CodexUsageRecord {
  id: string;
  createdAt: string;
  accountId: string | null;
  accountLabel: string;
  endpoint: '/v1/responses';
  model: string;
  status: 'success' | 'failed';
  statusCode: number | null;
  attempts: number;
  firstByteMs: number | null;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  totalTokens: number | null;
  errorCode: string;
  errorMessage: string;
}

export interface CodexUsageQuery {
  from?: string;
  to?: string;
  model?: string;
  accountId?: string;
  status?: 'success' | 'failed';
  limit?: number;
  offset?: number;
}

export interface CodexUsageReport {
  records: CodexUsageRecord[];
  total: number;
  summary: PoolUsageSummary;
  byModel: PoolUsageBreakdown[];
  byAccount: PoolUsageBreakdown[];
  filterOptions: {
    models: PoolUsageFilterOption[];
    accounts: PoolUsageFilterOption[];
  };
}

export type BatchItemStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled';
export interface BatchItem {
  relay: Relay;
  status: BatchItemStatus;
  result?: TestResult;
}

export type PurityTestMode = 'quick' | 'standard' | 'gpt56';
export type PurityVerdict =
  | 'high_confidence_normal'
  | 'likely_normal'
  | 'suspicious'
  | 'abnormal'
  | 'inconclusive'
  | 'gpt56_compatible'
  | 'gpt56_auxiliary'
  | 'gpt56_inconsistent';
export type PurityConfidence = 'low' | 'medium' | 'high';
export type PurityCheckStatus = 'pass' | 'warning' | 'fail' | 'skipped';

/** Trusted endpoint credentials are kept only in page memory and are never persisted by the API. */
export interface Gpt56TrustedReference {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface Gpt56TestConfig {
  trials?: number;
  trustedReference?: Gpt56TrustedReference;
}

export type Gpt56ProgressStage =
  | 'preflight'
  | 'trusted_seed'
  | 'encrypted_controls'
  | 'juice_fingerprint'
  | 'literal_control'
  | 'finalizing';
export type Gpt56EncryptedStatus =
  | 'not_run'
  | 'running'
  | 'preliminary_compatible'
  | 'compatible'
  | 'not_compatible'
  | 'suspicious'
  | 'invalid'
  | 'inconclusive';
export type Gpt56JuiceStatus = 'not_run' | 'running' | 'fingerprint' | 'preliminary' | 'mixed' | 'insufficient';
export type Gpt56LiteralStatus = 'not_run' | 'running' | 'passed' | 'output_rewrite_suspected' | 'inconclusive';
export type Gpt56NetworkStatus = 'smooth' | 'intermittent' | 'unstable';
export type Gpt56Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface Gpt56JuiceObservation {
  effort: Gpt56Effort;
  status: 'number' | 'refusal' | 'other' | 'error';
  normalizedValue: string | null;
  matchedModels: string[];
  durationMs: number | null;
  retryCount: number;
}

export interface Gpt56JuiceEffortSummary {
  effort: Gpt56Effort;
  requested: number;
  completed: number;
  numericSamples: number;
  matchedSamples: number;
}

export interface Gpt56EncryptedStateSummary {
  enabled: boolean;
  status: Gpt56EncryptedStatus;
  attempts: number;
  targetAttempts: number;
  requiredMatches: number;
  trustedRejected: number;
  fullExact: number;
  withoutIdsExact: number;
  messageOnlyExact: number;
  corruptedCiphertextExact: number;
  plaintextLeaks: number;
  candidateErrors: number;
  summary: string;
}

export interface Gpt56JuiceSummary {
  status: Gpt56JuiceStatus;
  likelyModel: string | null;
  confidence: 'none' | 'preliminary' | 'medium' | 'high';
  mixed: boolean;
  observations: Gpt56JuiceObservation[];
  efforts: Gpt56JuiceEffortSummary[];
  summary: string;
}

export interface Gpt56LiteralControlSummary {
  status: Gpt56LiteralStatus;
  completed: number;
  exact: number;
  nonExact: number;
  errors: number;
  summary: string;
}

export interface Gpt56NetworkSummary {
  status: Gpt56NetworkStatus;
  requestCount: number;
  successfulRequests: number;
  retryCount: number;
  errorCount: number;
  summary: string;
}

export interface Gpt56DetectionSummary {
  stage: Gpt56ProgressStage;
  encrypted: Gpt56EncryptedStateSummary;
  juice: Gpt56JuiceSummary;
  literalControl: Gpt56LiteralControlSummary;
  network: Gpt56NetworkSummary;
}

export interface PurityTestInput {
  model?: string;
  mode?: PurityTestMode;
  gpt56?: Gpt56TestConfig;
}

/** Credentials stay in component memory and are sent only to the local API. */
export interface CustomPurityTestInput extends PurityTestInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  platform?: RelayPlatform;
  protocol?: RelayProtocol;
  timeout?: number;
}

export interface PurityCheckResult {
  id: string;
  name: string;
  status: PurityCheckStatus;
  score: number | null;
  weight: number;
  summary: string;
  evidence: string[];
  requestCount: number;
  durationMs: number;
}

export interface PurityUsageSummary {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface PurityTestResult {
  id: string;
  relayId: string;
  relayName: string;
  platform: RelayPlatform;
  protocol: TestProtocol;
  mode: PurityTestMode;
  requestedModel: string;
  reportedModels: string[];
  score: number | null;
  verdict: PurityVerdict;
  confidence: PurityConfidence;
  summary: string;
  checks: PurityCheckResult[];
  anomalies: string[];
  requestCount: number;
  successfulRequests: number;
  usage: PurityUsageSummary;
  totalDuration: number;
  testedAt: string;
  disclaimer: string;
  gpt56?: Gpt56DetectionSummary;
}

export type PurityProgressStage = 'integrity' | 'token_accounting' | 'repeat_stability' | 'capability_checks' | Gpt56ProgressStage;

export interface PurityTestProgress {
  stage: PurityProgressStage;
  message: string;
  checks: PurityCheckResult[];
  requestCount: number;
  successfulRequests: number;
  usage: PurityUsageSummary;
  reportedModels: string[];
  completedChecks: number;
  totalChecks: number;
  elapsedMs: number;
  gpt56?: Gpt56DetectionSummary;
}

export interface PurityProgressEvent {
  type: 'progress';
  data: PurityTestProgress;
}

export interface PurityResultEvent {
  type: 'result';
  data: PurityTestResult;
}

export type PurityStreamErrorCode = 'cancelled' | 'test_failed';

export interface PurityErrorEvent {
  type: 'error';
  data: {
    code: PurityStreamErrorCode;
    message: string;
  };
}

export type PurityStreamEvent = PurityProgressEvent | PurityResultEvent | PurityErrorEvent;
