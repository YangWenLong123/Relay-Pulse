# Relay Pulse 监控中心具体实现方案

> 文档状态：待实施  
> 编写日期：2026-08-10  
> 目标菜单：监控中心  
> 目标路由：/monitoring  
> 本文仅描述实现方案，不包含功能代码。

## 1. 方案结论

监控中心应作为 Relay Pulse 的核心一级菜单，负责对已保存中转站进行服务端定时探测，并集中展示当前健康状态、可用率、延迟趋势和故障事件。

建议采用以下默认决策：

- 监控功能默认关闭，只有用户显式启用后才产生上游请求和 Token 消耗。
- 首版仅监控“中转站管理”中已保存、已启用且已勾选监控的线路。
- 定时探测运行在 Node.js 后端，关闭浏览器页面后仍可继续执行。
- 复用现有 RelayTester 完成真实推理探测，但不经过 TestCoordinator。
- 监控结果独立保存，不写入手动测试历史，也不覆盖线路的 lastTestStatus。
- 默认间隔 15 分钟，并发数 4，连续失败 3 次判定故障，连续成功 2 次判定恢复。
- 首版只记录状态和脱敏错误，不保存探测提示词、模型回复、API Key 或原始响应。
- 首版不自动停用线路、不修改号池成员、不自动切换路由。
- Standalone 浏览器扩展模式隐藏该菜单，因为该模式没有持续运行的本机后端。

## 2. 背景与目标

### 2.1 当前能力

项目目前已经覆盖：

- 中转站配置、模型探测、单测、批测和手动测试历史。
- 余额查询与定时余额刷新。
- 本机号池、失败回退和调用统计。
- GPT/Codex 账号管理与本机代理。
- 游乐场、绘图和中转站掺水检测。

当前缺口是：线路故障只有在用户主动测试或真实调用失败后才能发现，缺少持续健康检查、长期趋势和故障生命周期记录。

### 2.2 建设目标

- 自动发现线路不可用、鉴权失败、限流、超时和高延迟。
- 展示每条线路的当前健康状态和最近一次检测结果。
- 提供 24 小时、7 天和 30 天的可用率及延迟趋势。
- 将连续失败合并为一次故障事件，恢复后自动闭环。
- 支持立即检测全部或指定线路。
- 为后续 Webhook、余额预警和自动路由提供稳定的数据基础。

### 2.3 首版非目标

- 不建设 Prometheus、Grafana 或完整日志平台。
- 不记录用户请求正文和模型回复。
- 不将纯度检测纳入定时任务。
- 不监控任意外部 URL，只监控 Relay Pulse 已保存的中转站。
- 不根据监控结果自动修改线路、号池或 GPT 账号状态。
- 不在首版提供 Telegram、企业微信等专用通知适配器。

## 3. 功能范围

### 3.1 MVP

- 全局监控启停。
- 线路级监控启停及模型、协议、检测间隔覆盖。
- 服务端定时探测。
- 手动立即检测。
- 当前状态：待检测、健康、波动、故障、未监控。
- 连续失败和恢复状态机。
- 24 小时、7 天、30 天统计。
- 可用率、平均延迟、P95 延迟和错误分布。
- 故障事件列表与详情。
- 运行状态、加载状态、空状态和错误状态。
- 原始记录保留上限和数据清理。

### 3.2 第二阶段

- 浏览器通知。
- 通用 Webhook 通知。
- 告警静默时段、去重和重试。
- 线路余额阈值告警。
- GPT/Codex 额度告警。
- 故障事件确认和备注。

### 3.3 第三阶段

- 自动暂停故障线路。
- 恢复后自动重新启用。
- 根据健康状态调整号池权重。
- SLA 报表和 CSV 导出。
- 更长期的小时、日级聚合存储。

## 4. 菜单与页面设计

### 4.1 导航

在 **client/src/router.ts** 增加：

- path：/monitoring
- name：monitoring-center
- component：MonitoringWorkspaceView

在 **client/src/components/AppLayout.vue** 中将“监控中心”放在“中转站管理”之后，使用 Activity 或 LineChart 图标。

由于当前顶部已经存在多个菜单，建议同时调整为：

- 中转站管理
- 监控中心
- 我的号池
- GPT 账号
- 工具

“工具”子菜单收纳：

- 游乐场
- 中转站掺水检测
- 绘图

Standalone 扩展模式不展示“监控中心”和“工具”中的后端能力。

### 4.2 页面结构

页面采用运维工作台布局，不使用营销式大标题或多层嵌套卡片。

顶部操作区：

- 页面标题和调度器状态。
- 时间范围分段控件：24 小时、7 天、30 天。
- 刷新按钮。
- “立即检测”按钮。
- 设置图标按钮。

概览指标：

- 已监控线路数。
- 健康线路数。
- 波动线路数。
- 故障线路数。
- 当前可用率。
- 未恢复事件数。

趋势区：

- 可用率趋势。
- 平均延迟与 P95 延迟趋势。
- 错误类型分布。

事件区：

- 当前未恢复事件优先。
- 展示开始时间、持续时间、线路、错误类型和最近错误。
- 点击打开事件详情抽屉。

线路表格：

- 线路名称。
- 当前状态。
- 最近检测时间。
- 最近延迟。
- 时间范围内可用率。
- 平均延迟。
- P95 延迟。
- 连续失败次数。
- 最近错误。
- 监控开关与操作菜单。

### 4.3 响应式行为

- 桌面端趋势和事件区域使用双栏布局。
- 900px 以下改为单栏。
- 表格在窄屏改为线路列表，每条记录保持固定操作区。
- 560px 以下菜单仅显示图标，所有图标提供 Tooltip 和 aria-label。
- 长线路名称、模型和错误信息必须截断并可通过 Tooltip 查看完整内容。

## 5. 核心业务规则

### 5.1 可监控条件

一条线路只有同时满足以下条件才进入调度：

- 中转站记录仍然存在。
- relay.enabled 为 true。
- 全局 monitoringEnabled 为 true。
- 对应 RelayMonitorRule.enabled 为 true。
- 当前没有该线路的监控请求正在执行。

线路被停用时暂停监控，但保留历史记录和规则。线路被删除时删除规则和当前状态，历史样本与事件保留名称快照。

### 5.2 探测方式

MVP 使用现有 RelayTester.test：

- 默认使用线路保存的 model 和 protocol。
- 线路规则可覆盖 model、protocol 和 intervalMinutes。
- 使用固定最小提示词 “Reply only OK.”。
- 使用线路自身 timeout。
- RelayTester 继续负责协议回退、超时、错误分类和密钥脱敏。

MonitoringService 直接调用 RelayTester，不调用 TestCoordinator，原因是 TestCoordinator 会更新线路手测状态并写入 test-history.json。

监控服务只从 TestResult 提取状态码、协议、模型、总耗时、首字节耗时和脱敏错误。responseText 必须在持久化前丢弃。

### 5.3 状态定义

| 状态 | 判定 |
| --- | --- |
| unmonitored | 线路或规则未启用 |
| pending | 已启用监控但尚无有效样本 |
| healthy | 最近请求成功，延迟未超过阈值 |
| degraded | 最近成功但延迟过高，或失败次数尚未达到故障阈值 |
| down | 连续失败次数达到阈值 |

额外返回 stale 字段：

- 当最近检测时间超过 max(2 × 检测间隔, 30 分钟) 时为 true。
- stale 不直接改写最后健康状态，但界面显示“数据过期”。

### 5.4 状态转换

默认阈值：

- failureThreshold：3
- recoveryThreshold：2
- latencyWarningMs：5000

失败时：

1. consecutiveSuccesses 清零。
2. consecutiveFailures 加一。
3. 未达到 failureThreshold 时进入 degraded。
4. 达到 failureThreshold 时进入 down。
5. 只在首次进入 down 时创建故障事件。
6. 事件 startedAt 使用连续失败序列中的第一次失败时间。

成功时：

1. consecutiveFailures 清零。
2. consecutiveSuccesses 加一。
3. 普通状态下，根据延迟进入 healthy 或 degraded。
4. 从 down 恢复时，在达到 recoveryThreshold 前保持 degraded。
5. 达到 recoveryThreshold 后关闭当前故障事件。
6. 如果恢复样本仍然高延迟，则关闭不可用事件但保持 degraded。

因进程关闭或用户取消产生的 cancelled 结果不计入成功率，不改变状态，也不创建事件。

### 5.5 指标计算

- 可用率 = 成功样本数 / 已完成且非取消样本数。
- 平均延迟只统计成功样本。
- P95 使用成功样本总耗时按 nearest-rank 方法计算。
- 没有样本时返回 null，不显示为 0% 或 0ms。
- 高延迟成功仍计入可用率，但当前状态可为 degraded。
- 手动“立即检测”产生的监控样本计入趋势。
- 中转站管理页的手动单测和批测不计入监控趋势。

## 6. 总体技术架构

~~~mermaid
flowchart LR
    UI["MonitoringWorkspaceView"] --> API["/api/monitoring"]
    API --> Service["MonitoringService"]
    Scheduler["MonitoringScheduler"] --> Service
    Service --> Relays["RelayRepository"]
    Service --> Tester["RelayTester"]
    Service --> Repository["MonitoringRepository"]
    Repository --> Config["monitoring-config.json"]
    Repository --> Samples["monitoring-samples.json"]
    Repository --> State["monitoring-state.json"]
    Repository --> Incidents["monitoring-incidents.json"]
~~~

职责边界：

- MonitoringScheduler：管理定时器、立即执行、并发和取消。
- MonitoringService：筛选线路、执行探测、推进状态机和生成事件。
- MonitoringRepository：串行化持久化、裁剪记录和统计查询。
- MonitoringReporter：计算概览、趋势、线路指标和错误分布。
- RelayTester：执行真实上游请求并返回统一 TestResult。
- 前端 Store：加载报告、保存设置、轮询运行状态和防止旧响应覆盖新状态。

## 7. 数据设计

### 7.1 MonitoringSettings

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| enabled | boolean | false | 全局调度开关 |
| intervalMinutes | number | 15 | 默认检测间隔，范围 5 到 1440 |
| concurrency | number | 4 | 并发数，范围 1 到 10 |
| failureThreshold | number | 3 | 连续失败阈值，范围 1 到 10 |
| recoveryThreshold | number | 2 | 连续成功恢复阈值，范围 1 到 10 |
| latencyWarningMs | number | 5000 | 高延迟阈值 |
| updatedAt | ISO string | 当前时间 | 最近更新时间 |

### 7.2 RelayMonitorRule

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| relayId | UUID | 关联中转站 |
| enabled | boolean | 是否监控 |
| intervalMinutes | number 或 null | null 表示继承全局设置 |
| model | string 或 null | null 表示使用线路默认模型 |
| protocol | auto、responses、chat 或 null | null 表示使用线路默认协议 |
| latencyWarningMs | number 或 null | null 表示继承全局阈值 |
| updatedAt | ISO string | 更新时间 |

### 7.3 MonitorSample

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | UUID | 样本 ID |
| cycleId | UUID | 所属检测批次 |
| relayId | UUID | 线路 ID |
| relayName | string | 名称快照 |
| source | scheduled 或 manual | 触发来源 |
| success | boolean | 是否成功 |
| model | string | 实际请求模型 |
| protocol | TestProtocol | 实际协议 |
| statusCode | number 或 null | HTTP 状态码 |
| durationMs | number | 总耗时 |
| firstByteMs | number 或 null | 首字节耗时 |
| errorType | TestErrorType | 统一错误类型 |
| errorMessage | string | 脱敏后错误，最长 500 字符 |
| checkedAt | ISO string | 检测时间 |

禁止写入 MonitorSample：

- API Key。
- Base URL 中的查询凭证。
- 请求提示词。
- responseText。
- 完整上游响应。

### 7.4 RelayMonitorState

保存当前状态、连续成功和失败次数、首次失败时间、最后成功时间、最后失败时间、最近样本摘要、当前事件 ID 和下次计划时间。

### 7.5 MonitorIncident

事件字段包括：

- id、relayId、relayName。
- status：open 或 resolved。
- startedAt、lastSeenAt、resolvedAt。
- triggerErrorType、statusCode、message。
- failedProbeCount。
- resolution：recovered、monitoring_disabled、relay_disabled、relay_deleted 或 manual_reset。

### 7.6 持久化文件

新增：

- data/monitoring-config.json
- data/monitoring-samples.json
- data/monitoring-state.json
- data/monitoring-incidents.json

继续使用现有 JsonStore，保证串行写入、临时文件替换和 0600 文件权限。

建议新增环境变量：

- MONITOR_SAMPLE_LIMIT，默认 20000，最大 100000。
- MONITOR_INCIDENT_LIMIT，默认 2000，最大 10000。

样本按 checkedAt 裁剪，事件优先保留未恢复记录，再裁剪最旧的已恢复记录。报告响应增加 coverageStartAt，避免记录被裁剪后仍把不完整区间展示成完整 30 天。

MonitoringRepository 提供 recordCycle 方法，一次写入一个批次的全部结果，避免每条线路分别重写 JSON 文件。跨文件更新无法完全事务化，因此服务启动时需要根据最新样本和未恢复事件执行一次状态校验。

## 8. 调度器设计

MonitoringScheduler 使用递归 setTimeout，不使用固定 setInterval：

1. 启动时读取设置。
2. 全局关闭时只保留轻量定时检查，不发起上游请求。
3. 到期后创建 cycleId 和 AbortController。
4. 快照当前可监控线路和规则。
5. 使用固定并发执行探测。
6. 批量提交结果。
7. 完成后根据最新设置安排下一次执行。

约束：

- 同一时刻只允许一个监控批次运行。
- 同一线路不允许重叠监控请求。
- 调度批次运行期间点击“立即检测”返回当前运行状态，不再创建重复批次。
- 设置变更后调用 reschedule，不需要重启服务。
- 定时器调用 unref，避免阻止 Node.js 正常退出。
- close 方法清理定时器、取消请求并等待当前批次结束。
- 关闭服务造成的取消不记录为故障。

为复用固定并发逻辑，可将现有 test-coordinator.ts 中的 runConcurrent 移到 server/src/lib/concurrency.ts，再由手动批测和监控共同使用。

## 9. API 设计

所有输入继续使用 Zod 校验，并使用现有 ApiResponse 包装。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | /api/monitoring/overview | 概览、趋势、线路状态和事件预览 |
| GET | /api/monitoring/settings | 获取全局设置和线路规则 |
| PUT | /api/monitoring/settings | 更新全局设置 |
| PUT | /api/monitoring/relays/:id | 更新线路监控规则 |
| POST | /api/monitoring/runs | 启动全部或指定线路检测 |
| GET | /api/monitoring/runs/:id | 查询异步批次进度 |
| DELETE | /api/monitoring/runs/:id | 取消手动批次 |
| GET | /api/monitoring/incidents | 分页查询事件 |
| GET | /api/monitoring/incidents/:id | 查询事件详情 |
| DELETE | /api/monitoring/data | 清空样本和事件，保留设置 |

### 9.1 概览查询

查询参数：

- range：24h、7d 或 30d，默认 24h。
- relayId：可选。
- status：可选。
- granularity：hour 或 day，由 range 提供默认值。

响应主要字段：

- scheduler：enabled、running、currentCycle、nextRunAt。
- summary：各状态数量、可用率、平均延迟、P95、事件数。
- trend：按时间桶聚合。
- relays：最多 200 条线路当前状态与区间指标。
- incidents：最近 10 条未恢复或最近恢复事件。
- runtime：号池和 Codex 代理当前运行状态。
- coverageStartAt：当前持久化数据的最早时间。

### 9.2 更新设置

PUT 应采用完整设置对象，避免 PATCH 中继承逻辑不透明。成功后：

1. 持久化设置。
2. 重新计算 nextRunAt。
3. 调用 scheduler.reschedule。
4. 返回最新公开设置和调度器状态。

### 9.3 手动运行

POST /api/monitoring/runs 请求体：

- relayIds：可选 UUID 数组；空数组表示所有已启用规则。

接口立即返回 202：

- runId。
- acceptedRelayCount。
- startedAt。
- status：running。

前端每 1 秒查询运行进度，完成后重新加载概览。页面离开时停止轮询，但后端任务继续。

## 10. 后端改动清单

### 新增文件

- server/src/repositories/monitoring-repository.ts
- server/src/services/monitoring-service.ts
- server/src/services/monitoring-scheduler.ts
- server/src/services/monitoring-reporter.ts
- server/src/lib/concurrency.ts
- server/tests/monitoring-repository.test.ts
- server/tests/monitoring-service.test.ts
- server/tests/monitoring-scheduler.test.ts
- server/tests/monitoring-api.test.ts

### 修改文件

- server/src/types.ts：增加监控领域类型。
- server/src/config.ts：增加样本和事件上限。
- server/src/validation.ts：增加设置、规则、查询和运行校验。
- server/src/app.ts：初始化依赖、注册 API、暴露调度器。
- server/src/server.ts：关闭时等待 MonitoringScheduler.close。
- server/src/services/test-coordinator.ts：改用公共并发工具。
- README.md：补充菜单、数据文件、环境变量和 API。

### createApp 依赖注入

AppDependencies 增加：

- monitoringRepository。
- monitoringService。
- monitoringScheduler。
- startMonitoringScheduler。

测试环境统一传入 startMonitoringScheduler: false，避免后台定时器影响测试进程和产生真实网络请求。

## 11. 前端改动清单

### 新增文件

- client/src/views/MonitoringWorkspaceView.vue
- client/src/api/monitoring.ts
- client/src/stores/monitoring.ts
- client/src/components/MonitoringSummary.vue
- client/src/components/MonitoringTrend.vue
- client/src/components/MonitoringRelayTable.vue
- client/src/components/MonitoringIncidentDrawer.vue
- client/src/components/MonitoringSettingsDrawer.vue
- client/src/utils/monitoring.ts
- client/tests/monitoring.test.ts

### 修改文件

- client/src/router.ts：增加路由。
- client/src/components/AppLayout.vue：增加菜单并处理工具子菜单。
- client/src/types.ts：增加公开响应类型。
- client/src/main.ts：仅在使用新的 Ant Design 组件时补充注册。
- client/src/styles.css：只增加真正跨页面复用的样式。

### Store 行为

Monitoring Store 管理：

- settings、summary、trend、relayStates 和 incidents。
- loading、saving、running 和 error。
- 当前时间范围。
- 概览请求 AbortController。
- 手动运行轮询。

防止竞态：

- 时间范围切换时取消上一个请求。
- 保存设置后使用服务端返回值替换本地状态。
- 使用 requestId 防止慢响应覆盖新范围数据。
- 页面隐藏时暂停概览轮询，重新显示后立即刷新。

默认每 30 秒刷新概览。调度器是否运行不依赖前端轮询。

### 图表策略

项目当前没有独立图表库。首版优先沿用 PoolUsageDashboard 的轻量 CSS 图表模式，并抽取纯函数负责时间桶和尺寸计算，不为两张趋势图引入大型图表依赖。

图表必须：

- 空数据时显示明确空状态。
- Tooltip 展示精确值。
- 可用率使用 0 到 100 的固定纵轴。
- 延迟图不因单个极端值导致其他数据不可读。
- 提供 aria-label 概述当前趋势。

## 12. 通知方案

通知放在第二阶段，避免阻塞核心监控闭环。

### 浏览器通知

- 只有页面或扩展运行时才能触发。
- 用户主动点击开关后再申请 Notification 权限。
- 前端根据新出现的 incidentId 去重。
- 权限拒绝后不反复弹窗。

### 通用 Webhook

- 服务端发送，不依赖页面打开。
- 仅接受 HTTP 或 HTTPS URL。
- 请求超时 10 秒，不跟随重定向。
- 发送 incident.opened 和 incident.resolved。
- 使用 eventId 去重。
- 最多重试 3 次，建议间隔 1 分钟、5 分钟、15 分钟。
- Payload 不包含 API Key、Base URL 查询参数、提示词或模型回复。

Webhook URL 和可选令牌应复用 key-cipher.ts 加密能力，公开 API 只返回 configured 和脱敏摘要。

## 13. 安全与成本控制

- 新版本升级后监控默认关闭，禁止无提示地产生费用。
- 启用时明确显示检测间隔和大致每日请求数。
- 固定短提示词，不保存回复。
- 所有错误继续通过 RelayTester 脱敏。
- API Key 只从 RelayRepository 内部读取，不返回监控前端。
- 数据文件权限保持 0600。
- 清空监控数据不删除线路配置或监控规则。
- Webhook 不携带凭证，并限制响应体读取长度。
- 监控接口继续受现有本机监听和 Origin 策略保护。

## 14. 异常与边界处理

- 线路在批次中被删除：完成请求后丢弃当前状态更新，历史样本保留名称快照。
- 线路在批次中被停用：记录样本，但最终状态设置为 unmonitored。
- 规则在批次中被关闭：不再安排下一次检测。
- 服务重启：恢复设置和状态，不把停机时间视为故障。
- 数据文件损坏：沿用 JsonStore 的明确报错，不自动覆盖原文件。
- 系统时间倒退：nextRunAt 重新基于当前时间计算。
- 单条线路超时：不阻塞其他并发槽位之外的线路。
- 所有线路均未启用：批次不创建空事件，页面展示空状态。
- 上游返回 429：作为 rate_limit 失败参与连续失败计算。
- 高延迟但成功：可用率仍算成功，状态显示 degraded。
- 30 天数据被样本上限裁剪：通过 coverageStartAt 标记统计区间不完整。

## 15. 测试与验证

### 服务端单元测试

- 状态从 pending 到 healthy。
- 一次失败进入 degraded。
- 三次连续失败只创建一个事件。
- 两次连续成功关闭事件。
- 高延迟成功进入 degraded，但可用率仍为成功。
- cancelled 不修改状态。
- 规则覆盖模型、协议和间隔。
- 记录裁剪和未恢复事件优先保留。
- 重启后状态校验。
- 调度器不重入、可取消并能重新调度。
- 并发数不超过配置上限。

### API 测试

- 默认设置关闭且不会启动探测。
- 设置和规则校验返回正确的 400。
- 不存在的线路返回 404。
- 已停用线路不会进入批次。
- 手动运行返回 202，进度可查询和取消。
- 概览时间范围和状态筛选正确。
- 清空数据保留设置。
- 响应中不存在 API Key 和 responseText。

### 前端测试

- 状态、可用率、时长和 P95 格式化。
- 无样本时显示 null 对应状态而非 0。
- 快速切换范围不会被旧请求覆盖。
- 手动运行结束后刷新概览。
- Standalone 模式隐藏菜单。
- 长名称、长模型和错误文本不撑破布局。

### 完整验证命令

- npm run typecheck
- npm run lint
- npm test
- npm run build
- npm run build:extension

视觉验证至少覆盖：

- 1440 × 900
- 1024 × 768
- 390 × 844

并检查浅色、深色、加载、空数据、部分故障和全部故障状态。

## 16. 实施顺序

### 阶段 A：领域模型与持久化

1. 增加类型和 Zod Schema。
2. 实现 MonitoringRepository。
3. 完成状态机和统计单元测试。

完成标准：可以用伪造样本稳定生成状态、趋势和事件。

### 阶段 B：探测与调度

1. 实现 MonitoringService。
2. 实现 MonitoringScheduler。
3. 接入 RelayRepository 和 RelayTester。
4. 完成并发、取消、重启和不重入测试。

完成标准：浏览器关闭后，后端仍按规则产生监控样本。

### 阶段 C：API

1. 注入 createApp 依赖。
2. 注册设置、规则、概览、事件和运行接口。
3. 接入 server.ts 关闭流程。
4. 完成 Supertest 覆盖。

完成标准：前端所需数据可以通过稳定 API 获取。

### 阶段 D：前端

1. 增加路由和菜单。
2. 实现 API、Store 和页面骨架。
3. 完成概览、趋势、事件和线路表格。
4. 完成设置与事件抽屉。
5. 完成响应式和主题验证。

完成标准：用户可以在一个页面完成查看、配置和立即检测。

### 阶段 E：文档与回归

1. 更新 README、环境变量和 API 列表。
2. 运行完整检查。
3. 验证网页和扩展后端模式。
4. 确认 Standalone 模式无不可用入口。

## 17. MVP 验收标准

- 升级后不会自动发起任何监控请求。
- 用户可以选择线路并启用服务端定时监控。
- 页面关闭后监控仍继续，后端停止后不再产生任务。
- 连续三次失败只产生一个未恢复事件。
- 连续两次成功后事件自动恢复。
- 定时监控不会污染手动测试历史和线路手测状态。
- 24 小时、7 天和 30 天统计口径一致。
- 所有展示数据都能追溯到持久化样本。
- 重启后设置、状态、事件和趋势仍存在。
- 任何监控响应和数据文件都不包含完整密钥或模型回复。
- 桌面和移动端不存在菜单、表格或文本重叠。
- 全部 typecheck、lint、test 和 build 通过。

## 18. 主要风险与处理

| 风险 | 影响 | 处理 |
| --- | --- | --- |
| 定时推理产生费用 | 用户不知情消耗余额 | 默认关闭、明确请求频率、允许选择低成本模型 |
| 探测本身触发限流 | 误判线路故障 | 默认 15 分钟、固定并发、连续失败阈值 |
| JSON 样本持续增长 | 写入变慢、磁盘占用 | 批量写入、记录上限、coverageStartAt |
| 服务重启造成误报 | 产生虚假故障事件 | 停机不算失败，启动后重新调度 |
| 监控与手动测试互相污染 | 状态含义不清 | 独立 Repository，不使用 TestCoordinator |
| 自动处置误伤线路 | 业务中断 | MVP 不自动停用或修改号池 |
| 浏览器通知不可靠 | 页面关闭后无法提醒 | 第二阶段提供服务端 Webhook |

## 19. 后续扩展方向

核心监控稳定后，再基于事件流增加：

- 余额低于线路阈值时通知。
- GPT 账号短周期或长周期额度不足时通知。
- 故障线路自动从号池候选中排除。
- 线路恢复后自动加入号池。
- 按可用率、延迟和余额计算动态路由权重。
- 周报、月报和 SLA 导出。

这些能力必须建立在可解释、可回滚的规则上，并默认关闭自动处置。
