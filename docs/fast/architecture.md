# Fast 架构

## 1. Package 与 code layout

第一阶段使用单一 npm package，不建立 monorepo。Production code 按 owner Module 分布：

```text
application/
runtime/
model/
session/
tools/
tui/
composition/
```

Interface 与 canonical types 跟随 owner Module。禁止建立 `shared/`、`common/` 等万能目录。`composition/` 是唯一认识全部 production Adapter 的位置。

基础依赖为 OpenAI-first：官方 `openai` SDK 是首选 production path；`@anthropic-ai/sdk` 只服务次级 native Adapter；TUI 使用 Ink；schema 使用 TypeBox + Ajv；测试使用 Vitest；静态检查使用 Biome；web 使用 `undici`、`cheerio`、`html-to-text`。精确版本由 M0 lockfile 固定。

## 2. Deep Modules、依赖方向与状态所有权

### 2.1 五个逻辑 Modules

| Module | 外部 Interface | Canonical 职责 |
| --- | --- | --- |
| `FastApplication` | `FastController`、`FastSession`、`ActiveRun` | Session 用例、Run 启动预检、active Run 控制、应用事件与 RunReport 收尾 |
| `SessionLedger` | `SessionLedger`，内部产生 `RunLease` | Session tree、Conversation Branch、Transcript、Run record、队列与 persistence invariant |
| `AgentRuntime` | `AgentRuntime.run()`；由其拥有 `RuntimeHost`、`ToolPort` | 一次完整 Run 的多轮 model ↔ tool loop、Tool-call Batch、safe point 与 termination |
| `ModelProtocol` | `ModelPort`/`ModelAdapter` | canonical message、stream event、tool-call 与 provider error protocol |
| `CodingToolHost` | 实现 Runtime 拥有的 `ToolPort` | coding tools、validation、Hard Guard、permission、timeout、cancel、output cap 与平台 Adapter |

这些是逻辑职责与依赖规则，不是五个 npm packages。

### 2.2 依赖方向

```text
TUI Adapter
    → FastApplication
        → AgentRuntime
        → SessionLedger

AgentRuntime
    → ModelProtocol Interface
    → RuntimeHost Interface
    → ToolPort Interface

Provider Adapters
    → ModelProtocol Interface

CodingToolHost
    → AgentRuntime 拥有的 ToolPort Interface

SessionStorage Adapters
    → SessionLedger Interface

OS / Git / HTTP Adapters
    → CodingToolHost 内部 Interface

composition root
    → 所有具体 Adapter
```

每个 port 由使用方拥有。禁止 TUI 直连 Runtime/provider/tool/storage；禁止 Ledger 依赖 Runtime types 或保存 raw Runtime events；禁止 Runtime 依赖 TUI、Session、provider payload、filesystem/process/Git/HTTP 或具体工具名；禁止 provider Adapter 执行工具或修改 Transcript；禁止 tool Adapter 修改 Session、Run 或 TUI 状态。

Internal queue helper、context builder、event projector 与只有单一实现策略的 helper 不升级为 public Interface。Interface 是 owner Module 的稳定 seam 和 test surface，不是对内部函数的逐层包装。

### 2.3 唯一状态 owner

| 状态 | 唯一 owner | 生命周期 |
| --- | --- | --- |
| Session tree、Conversation Branch、Transcript | `SessionLedger` | 跨进程持久 |
| Run record、active-run lock、RunReport | `SessionLedger` | 跨进程持久 |
| Steering/Follow-up queued、delivered、draft state | `SessionLedger` | Session / active Run |
| active execution handle、abort routing、pending permission correlation | `FastApplication` | active Run |
| phase、working Model Context、Tool-call Batch、terminal guard | `AgentRuntime.run()` | 单次 Run |
| timeout、process handle、output buffer、cleanup | 单次 tool execution | 单次 ToolCall |
| provider parser 与 partial response | Model Adapter | 单次 model exchange |
| focus、scroll、collapse、input draft | TUI Adapter | presentation lifecycle |

Run 建立后创建 run-scoped `ModelPort` 与 `ToolPort`，固定 workspace、provider、model、Permission Mode、budgets、`ApprovalPort` 与 `AbortSignal`；底层 filesystem/process/Git/HTTP Adapters 可以跨 Runs 复用。`SessionLedger` 选择当前 branch ancestry，Runtime 负责每次 Model Attempt 的 Model Context projection；第一阶段不公开独立 `ContextPolicy` Interface。

## 3. Application 与 TUI Interface

TUI 只通过下列三句柄驱动 Session 与 Run：

```ts
interface FastController {
  listSessions(filter?: SessionFilter): Promise<readonly SessionSummary[]>;
  openSession(input: OpenSessionInput): Promise<FastSession>;
}

interface FastSession {
  inspect(): Promise<SessionView>;
  forkConversation(input: ForkConversationInput): Promise<ConversationBranchRef>;
  startRun(input: StartRunInput): Promise<ActiveRun>;
}

interface ActiveRun {
  readonly id: RunId;
  readonly events: AsyncIterable<FastEvent>;
  dispatch(command: RunCommand): Promise<CommandAck>;
  readonly finished: Promise<RunReport>;
}
```

`RunCommand` 统一承载 Steering、Follow-up、permission decision 与 abort，使用 `commandId` 和 typed acknowledgement 处理幂等、stale permission 与 terminal race。TUI 只拥有 presentation state；用户功能清单由 [overview.md §5](overview.md#5-用户交互与输出契约) 定义。

对任何已经建立的 Run，`ActiveRun.finished` 始终 resolve `RunReport`；model error、policy limit、abort、persistence error 与 ToolHost infrastructure error 都通过 typed terminal reason 表达。只有无法在 Module boundary 内归一化的内部 invariant violation 才能越过 Interface。

`FastApplication` 将 Runtime 的 provider-neutral semantic events 补充为带 `sessionId`、`runId` 和严格递增 `sequence` 的 `FastEvent`，并加入 queue、permission、Session 与 RunReport events；不得复制一套同义 Runtime event protocol。`ActiveRun.events` 是支持创建后短暂缓冲的单消费者 hot stream，公开 `sequence` 从 1 严格递增，恰好一个 terminal event。历史恢复通过 `SessionLedger` 查询，不建设 replay system。完整 semantic fact 先持久化再发布；progress delta 可合并或丢弃，不能阻塞或改变 Runtime transition。

网页式 prototype 路线已经停止，不再迭代；后续 TUI/Runtime 协议采用直接陈述、逐项确认和文档化。Prototype 中的 provisional layout/interface 与 multi-frontend attachment seam 均不是正式决策。唯一保留的 permission 交互见 [safety.md §4](safety.md#4-permission-与-approval)。

## 4. Canonical model protocol

### 4.1 Adapter boundary

Runtime 只依赖窄接口：

```ts
interface ModelAdapter {
  stream(
    request: ModelRequest,
    options: { signal: AbortSignal },
  ): AsyncIterable<ModelEvent>;
}
```

Adapter 在 Run 创建时绑定 provider profile 与 model。Credential 由 Adapter factory 从环境或未入库配置解析，不进入 Session、canonical message 或 `ModelRequest`。

`ModelRequest` 将 instructions 与 messages 分开，并携带 Tool definitions 与受 capability 约束的 tool choice。Message 是 `UserMessage | AssistantMessage | ToolResultMessage` 的 role-specific union。第一阶段 content parts 仅支持 text、reasoning、tool call 与 tool result；不加入 image、audio、file 或 hosted tools。

第一阶段不提供任意 provider parameter passthrough，也不建设大型 compatibility matrix。只有 Runtime 必须感知的 capability 进入 canonical protocol；其余 wire options 固定在 provider profile 内。

### 4.2 Streaming、归约与 capability

`ModelEvent` 为增量事件：`turn_started`、`part_started`、`text_delta`、`reasoning_delta`、`tool_call_delta`、`part_completed`，以及唯一 terminal event `turn_completed | turn_failed`。事件不携带可变完整 partial message；Runtime 使用独立 `ModelTurnAccumulator` 归并。

可预期的 network、rate limit、auth 与 provider protocol failure 成为 `turn_failed`；iterator 意外抛错归一化为 `adapter_bug`；abort 归一化为不可重试 cancellation。

Reasoning part 保存可展示文本和可选 opaque `replayToken`，只有对应 Adapter 可以解释或回放。`ProviderCapabilities` 只暴露 Runtime 必须判断的 tool choice、reasoning、reasoning replay 与 multiple tool calls 能力。Provider wire quirks 留在私有 profile；能力不支持时发送前明确失败，不静默降级。

OpenAI、DeepSeek、GLM 共享 OpenAI-compatible Adapter 的独立 profiles；Anthropic 使用独立 Messages Adapter；`ScriptedModelAdapter` 与 production Adapter 共用此接口。

### 4.3 Tool call pairing、finish 与 failure

- Tool arguments 在 part 完成时才严格解析，不修补或猜测不完整 JSON。
- invalid/truncated tool call 只作为 Transcript evidence，不生成可执行 canonical `ToolCall`，也不进入后续 Model Context；同 batch 存在此类 call 时整批不执行。
- 每个已接受执行的 `ToolCall` 恰有一个 `ToolResult`；error、permission deny 与未开始取消也必须配对。
- Model-facing result 固定为 `{ callId, content: string, isError: boolean }`。Tool name、结构化执行详情与 Artifact path 留在 Runtime Transcript。
- 第一阶段 Runtime 严格按 source order 串行执行 batch，结果按原 ToolCall 顺序进入 Model Context；Adapter 编码前校验 `callId` 一一对应。
- Canonical finish reason 为 `stop | tool_calls | length | content_filter | refusal | other`。
- Failure 至少包含 `category`、`retryable`、可选 `retryAfterMs`、`httpStatus`、`requestId` 与 redacted message。
- Adapter 不执行 retry。`ModelUsage` 只记录 token；provider 未返回的值为 unknown，不伪造为 0，也不在 Adapter 内计算 cost。

Provider request ID 进入 turn diagnostics，不进入 canonical message。Provider-specific transforms 不得回写 canonical state。

## 5. Generic Agent Runtime

### 5.1 Run boundary 与 Runtime ports

Run 启动顺序固定为：校验 Session、workspace baseline、provider profile、model、credential；失败时返回 typed `RunStartFault` 且不创建 Run；随后 `SessionLedger.beginRun()` 原子提交 `RunStarted + initial user message` 并取得 `RunLease`；从此 Run 已建立，必须恰好产生一个 `RunReport`；`FastController` 恰好调用一次 `AgentRuntime.run()`。

`RunLease` 只在 `FastApplication ↔ SessionLedger` 之间使用，负责 active-run lock、Transcript commit、queue transition 与 terminal commit，不暴露给 Runtime 或 TUI。

```ts
interface AgentRuntime {
  run(input: RuntimeInput, host: RuntimeHost): RuntimeExecution;
}

interface RuntimeExecution {
  readonly events: AsyncIterable<RuntimeEvent>;
  readonly completion: Promise<RuntimeOutcome>;
}

interface RuntimeHost {
  record(event: RuntimeSemanticEvent): Promise<void>;
  drainSteering(): Promise<readonly Steering[]>;
  takeFollowUp(): Promise<FollowUp | undefined>;
}
```

`RuntimeHost.record()` 必须 awaited；完整 semantic event 提交成功后 Runtime 才能继续。Runtime 不认识 Session 或物理持久化格式。

### 5.2 顶层状态机

```text
starting
  → preparing_turn
  → model_streaming
  → assistant_committing
  ├─ tool calls → tool_batch → safe_point
  └─ no tools  → safe_point → completion_candidate

safe_point
  → RunStopPolicy
  ├─ stop               → terminal
  ├─ Steering available → preparing_turn
  └─ no Steering        → completion_candidate

completion_candidate
  ├─ one Follow-up → preparing_turn
  └─ none          → terminal(completed/no_tool_calls)
```

Permission/running/failed/denied/timed_out/cancelled 是单个 ToolCall 子状态，不扩张顶层 `RunPhase`。

### 5.3 计数、stop、retry 与异常 output

Runtime 不定义综合 `step`，也不内置 `maxSteps`。它记录 `modelTurnCount`、`modelAttemptCount`、`toolCallCount`、`completedToolCallCount`。一个 Model Turn 是一次逻辑模型交互、assistant response 归约及可选完整 Tool-call Batch；transport retry 只增加 Model Attempt。

`RunStopPolicy` 与 `ModelRetryPolicy` 在 Run 启动时注入并固定。Stop policy 在完整 turn 提交后、消费 Steering/Follow-up 前执行，并返回包含 typed `status` 与 `reason` 的 decision。network reset、429 与部分 5xx 可以有界 retry；auth、invalid model、malformed stream 与 context overflow 不做普通 retry。Adapter 不隐藏 retry；canonical model failure 保留 retryability、retry delay、redacted summary 与 provider evidence reference。

- 完整 assistant message 验证并提交后才可执行 ToolCall。
- token limit 截断且包含 ToolCall：整批不执行，为各 call 形成 `truncated_tool_call` model-visible result，允许下一轮重发。
- 纯文本 truncation：保存 partial diagnostic Artifact，以 `failed/output_truncated` 结束。
- transport stream 异常中断：`failed/stream_truncated`。
- 可归属某 ToolCall 的 invalid output：形成 model-visible error result。
- 无法形成完整 assistant message 或维持 pairing：`failed/invalid_output`。
- 单 ToolCall 的 unknown tool、invalid arguments、deny、failure、timeout、cancel、command non-zero 默认作为 model-visible `ToolOutcome`，不终止 Run；无法维持 pairing/cleanup/execution contract 才是 `tool_host_failure`。

### 5.4 Steering、Follow-up 与 abort

每个完整 turn 固定按以下顺序：

```text
turn committed
→ RunStopPolicy
→ drain 全部 Steering（FIFO）
→ 若无 Steering，进入 completion_candidate
→ take 一个 Follow-up（FIFO）
→ 若仍无消息，正常完成
```

Abort 设置高优先级 `abortRequested`，禁止启动新 Model Attempt/ToolCall，向当前 provider、tool 与 process tree 传播 `AbortSignal`；当前 call 结算为 cancelled，未启动 planned calls 生成 synthetic cancelled results。等待 cleanup 或 cancellation deadline 后，以 `aborted/user_abort` terminal。abort 后不再调用模型或消费队列，不回滚事实或 workspace effects。

`RunStopPolicy` 决定停止或用户 abort 后都不再消费 Steering/Follow-up；未交付 queue items 转为 Session drafts。

### 5.5 Event 与 terminal taxonomy

`SemanticEvent` 包括 Run/turn lifecycle、完整 message、ToolCall/Result、queue delivery、retry、policy stop 与 terminal；它必须按序持久化且不可丢失。`ProgressEvent` 包括 text/reasoning/tool output delta，只服务实时 UI，可合并，不进入 Transcript。Persistence failure 归一化为 `failed/persistence_error`。

Run status 固定为 `completed | aborted | failed | limited`。典型 reason 包括 `no_tool_calls`、`user_abort`、`policy_limit`、`model_error`、`output_truncated`、`stream_truncated`、`invalid_output`、`tool_host_failure`、`persistence_error`、`runtime_invariant`。`RunReport` 字段由 [overview.md §5](overview.md#5-用户交互与输出契约) 定义。

## 6. Transcript、Model Context 与 Artifact

### 6.1 Canonical Ledger 与 ordering

Transcript 是 append-only Conversation Tree。每个 immutable `SemanticEntry` 具有 `entryId`、`parentId` 和 Session-wide monotonic `ledgerSeq`。Branching 只移动 leaf pointer，后续 append 形成新的 ancestry；已有 entries 不重写。`ledgerSeq` 与 per-Run UI event sequence 不同。

一个 ordered Ledger 保存三类 record：

- `SemanticEntry`：user/assistant messages、Tool Outcomes、Steering/Follow-up delivery、Compaction Checkpoints、Artifact references；
- `OperationRecord`：Run lifecycle、Model Attempt/retry、tool planned/started/settled、terminal、recovery；
- `PointerMutation`：branch leaf movement 与 fork metadata。

只有 `SemanticEntry` 进入 Conversation Tree 和 Model Context projection。Provider wire messages 与 transient Runtime events 不是 canonical Transcript。

Assistant entry 必须在 tool execution 前提交。ToolCall identity 由 `assistantEntryId + toolIndex + toolCallId + toolName` 构成；每个 call 按 source order获得一个 durable outcome。Open batch 只能存在于 active Run，永不投影给模型；recovery 将 unresolved calls 标为 cancelled 或 `unknown_effect`，Adapter 不得伪造 pairing。

### 6.2 Artifact Store

大型、binary、diagnostic 或 restricted content 进入 durable Artifact Store。Transcript 只保存 bounded preview、durable `ArtifactRef` 与 provenance。Metadata 至少包括 identity、content digest、media type、byte length、storage key、preview、creator、sensitivity、retention 与 truncation state；bytes 完成写入并校验 digest 后才能提交 reference。

Workspace file 与 OS temporary path 不是 Artifact。超过 hard cap 时记录原始 digest/length，按 deterministic policy 只保留 head/tail 等 subset，并记录 original/stored digest、length、truncation 与 policy。Artifact 第一阶段跟随 Session 生命周期；不自动 retention pruning，未引用 orphan bytes 可以 GC。

### 6.3 Model Context、Manifest 与 compaction

每个 Model Attempt 都从 canonical state 构造新的 provider-specific Model Context，不修改 Transcript。Durable `ContextManifest` 记录 branch leaf、included entry IDs、checkpoint、Artifact refs、projection/redaction versions、token provenance，以及被排除项和理由；它不复制 prompt 正文。

Projection 在 provider request 前验证 ancestry、ordering、完整 tool pairing 与 checkpoint applicability。可用 input budget 等于 model context window 减 output reserve 和 safety margin。选择优先级是：

1. system/tool definitions；
2. 当前 task 与最新 queues；
3. 完整未消费 Tool-call Batch；
4. recent complete turns；
5. latest applicable checkpoint；
6. optional older derived context。

Provider-reported usage 是 accounting anchor；否则记录 versioned estimator。Required content 与 pairing 不得静默删除；minimum valid projection 无法容纳时以 `failed/context_overflow` 结束。

Minimal compaction 属于 Fast 第一阶段，只在下一请求无法满足 budget/reserve 时触发。它生成 branch-specific、provenance-complete、explicitly lossy `CompactionCheckpoint`，不覆盖、更正或删除 Transcript。Cut 只发生在完整 Model Turn boundary；使用 latest applicable checkpoint + retained tail。Checkpoint source range 必须全部属于当前 branch ancestry，不能跨 abandoned branch 复用。

Compaction generation 是 `ContextDerivation`，不是 Model Turn/Attempt；使用 active Run 固定的 provider/model，并单独记录 count、usage、identity、failure、source range/leaf、retained-tail start、prior checkpoint、version、token provenance 与 digest。Derivation failure 不修改 Transcript；仍无法构造合法 context 时 fail closed。

### 6.4 Sensitive projection、continuity 与 recovery

Credential、authorization header、environment secret 与敏感 Tool argument 在 Ledger persistence 前移除或替换为 safe handle；redaction record 只保存 type/count/reason。Model、summary、TUI、export 是独立 projections。Provider-required opaque reasoning/signature 可作为 restricted Artifact，只投影给兼容 provider；不要求回放的 raw reasoning 保持 transient。

Semantic ancestry 跨 Runs 连续。每个 terminal Run 向后续 Model Context 提供 compact `RunBoundary`，引用 status/reason、final result、changed files、unfinished work 与 evidence；完整 RunReport、retry、permission 与 diagnostics 留在 Ledger/TUI，不默认进入 Model Context。Failed Run 不伪造 assistant error message；后续显式 Run 可以通过 durable reference 取回所需 Artifact。

Recovery 只恢复 durable prefix，不自动恢复 mid-Run 或 replay ToolCall。Orphan active Run 生成 interrupted/failed RunReport；unstarted calls 为 cancelled，started calls 若 effects 不明为 `unknown_effect`；pending queues 回到 drafts。Mid-log corruption、sequence gap、parent/pairing contradiction 或 integrity failure 不跳过、不猜测，Session 进入 read-only degraded mode。缺失或 digest mismatch 的当前 branch Artifact 阻塞新 Run；仅影响其它 branch 时告警。

## 7. Physical persistence

Production `SessionLedger` 使用 `better-sqlite3` 嵌入式 SQLite；用户无需安装独立 database service。Node 24 的 `node:sqlite` 不作为 capability-freeze dependency。

单个 app-data `state.sqlite3` 保存 Session、Run、append-only Ledger records、Conversation Branch pointers、queues、Context Manifest、RunReport 与 Artifact metadata；大型 Artifact bytes 保存在独立 content-addressed directory，数据库只保存 digest、storage key 与 provenance。

SQLite 配置固定为 `WAL`、`foreign_keys=ON`、`synchronous=FULL` 与有限 `busy_timeout`。短事务、`BEGIN IMMEDIATE` 与 constraints 保证 RunLease、single active Run、`ledgerSeq` 和 terminal exactly-once。Schema 使用显式 migrations 与 `PRAGMA user_version`。Database 只允许本机 app-data path，不支持 network filesystem。

Memory 与 SQLite Adapters 运行相同 conformance suite。JSONL 只用于 auditable export/evidence，不是 production source of truth。SQLite 负责 atomic commit/crash recovery；应用负责 orphan active Run、unsettled ToolCall、integrity failure 和 read-only degraded mode。

## 8. Architecture invariants

1. 一个 Session 同一时刻最多一个 active Run。
2. 一次成功 `startRun()` 恰好调用一次 `AgentRuntime.run()`。
3. 一个 Run 可以包含多个 model exchanges，但只有一个 terminal transition、一个 terminal event 和一个 RunReport。
4. active Run 的 workspace、provider、model、Permission Mode、budgets 与 search profile 固定。
5. 完整 assistant message 提交成功后才能执行其 ToolCalls。
6. 一个 accepted batch 的 calls/results 数量相同且按 `callId` 配对；第一阶段 source-order 串行执行。
7. Batch 完成后才交付全部 queued Steering；只有正常 completion candidate 才取一个 Follow-up。
8. `completed` 不等于 external verifier 通过。
9. Abort 传播到 model/tool/process；不回滚 Transcript 或 workspace。
10. Conversation Branch 只改变 Transcript ancestry。
11. Provider payload、HTTP response、process object 与 TUI widget 不进入持久领域模型。
12. Tool safety 与 permission 只由 [safety.md](safety.md) 定义，不在 Runtime、TUI 或 provider Adapter 中复制。
