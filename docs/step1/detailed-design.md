# Coding Agent 详细设计

> 上位文档：[architecture-design.md](architecture-design.md)  
> 范围：定义 `model`、`agent`、`coding`、`sqlite` 四个 packages 的 public API、内部 Module、状态机、错误、持久化、安全、扩展与测试契约。本文不要求文件与类型一一对应。

## 1. 设计基线

### 1.1 第一版交付原则

第一版需要快速形成完整 coding-agent 闭环，但不能使用临时架构替代正式设计。下列能力必须进入真实 production path：

- provider registry、auth 和至少两类 model protocol adapters；
- streaming model output 解析和严格 tool-call validation；
- multi-turn Agent loop、retry、abort、stop policy 和 terminal state；
- production `AgentHarness`、持久 Session、Conversation Branch 与 RunReport；
- Model Context budget、基础 compaction 和 provenance；
- 文件、命令、Git 和 web tools 的本地执行与安全管线；
- CLI、interactive TUI 和 non-interactive print mode；
- skills 与 trusted local extension/plugin system；
- SQLite persistence、migration、writer lease、recovery 和 conformance tests。

第一版可以少实现 provider、auth scheme、backend 和 interaction mode 的实例，但不能删除其稳定 registry/contract。高级 memory、Task/Subagent、分层 compaction 和远程 frontend 延后实现，不进入当前 package 命名，也不需要未来推翻 Agent loop。

### 1.2 Package names

```text
@coding-agent/model
@coding-agent/agent
@coding-agent/coding
@coding-agent/sqlite
```

最终 npm scope 可以随产品名调整；folder names 和职责不因此改变。workspace root 为 private package，不 export runtime API。

### 1.3 通用约定

- public IDs 使用不透明 string branded types；不让数据库 row ID 或 provider ID 语义泄漏。
- public collections 默认 `readonly`。
- 所有长时异步操作接受 `AbortSignal`。
- 可预期失败使用 typed error/result；programmer invariant violation 才允许直接抛出内部异常。
- 时间、ID、随机数、filesystem、process 和 network 在需要确定性测试的 Module 中通过依赖注入获得。
- canonical events 和 persisted records 使用显式 `version`。
- secret value 不进入 event、Session、log、Artifact metadata 或 error message。
- public `index.ts` 只 export 有意维护的 API；内部文件不能被跨 package 深路径 import。

## 2. `model` Package

### 2.1 责任与公开表面

建议 exports：

```json
{
  ".": "./dist/index.js",
  "./providers/openai-compatible": "./dist/providers/openai-compatible/index.js",
  "./providers/anthropic": "./dist/providers/anthropic/index.js",
  "./auth": "./dist/auth/index.js",
  "./testing": "./dist/testing/index.js"
}
```

根出口提供 canonical API 和 registry；provider/auth/testing 使用显式 subpath，避免根出口加载所有 SDK 或 test code。

主要 public types：

```ts
export interface Model {
  readonly descriptor: ModelDescriptor;
  readonly capabilities: ModelCapabilities;

  stream(
    request: ModelRequest,
    options: ModelCallOptions,
  ): AsyncIterable<ModelEvent>;
}

export interface ModelProvider {
  readonly id: ProviderId;
  listModels(options?: { signal?: AbortSignal }): Promise<readonly ModelDescriptor[]>;
  createModel(input: CreateModelInput): Promise<Model>;
}

export interface ModelRegistry {
  registerProvider(provider: ModelProvider): Registration;
  unregisterProvider(id: ProviderId): boolean;
  listProviders(): readonly ProviderSummary[];
  listModels(query?: ModelQuery): Promise<readonly ModelDescriptor[]>;
  resolve(ref: ModelRef): Promise<Model>;
}
```

`Model` 在创建时绑定 provider profile 和 model；一次 active Run 内不会改变。`ModelRegistry` 负责注册和解析，不负责 Agent retry 或跨 provider fallback。

### 2.2 Canonical model protocol

#### 2.2.1 Request

```ts
export interface ModelRequest {
  readonly version: 1;
  readonly instructions: readonly InstructionPart[];
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelToolDefinition[];
  readonly toolChoice?: ToolChoice;
  readonly output: ModelOutputPolicy;
  readonly metadata?: Readonly<Record<string, string>>;
}

export type ModelMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage;

export interface UserMessage {
  readonly role: "user";
  readonly content: readonly UserContentPart[];
}

export interface AssistantMessage {
  readonly role: "assistant";
  readonly content: readonly AssistantContentPart[];
  readonly finishReason: ModelFinishReason;
  readonly usage?: ModelUsage;
}

export interface ToolResultMessage {
  readonly role: "tool";
  readonly callId: string;
  readonly content: string;
  readonly isError: boolean;
}
```

第一版 content parts：

- user text；
- assistant text；
- assistant reasoning；
- assistant tool call；
- tool result text。

Image/audio/file 和 provider-hosted tools 不进入第一版 canonical protocol。后续增加 content part 时通过 union version 演进，不能在现有 text 字段中塞 provider object。

#### 2.2.2 Streaming events

```ts
export type ModelEvent =
  | { type: "turn_started"; attemptId: string }
  | { type: "part_started"; index: number; part: PartHeader }
  | { type: "text_delta"; index: number; delta: string }
  | { type: "reasoning_delta"; index: number; delta: string }
  | { type: "tool_call_delta"; index: number; delta: ToolCallDelta }
  | { type: "part_completed"; index: number }
  | { type: "turn_completed"; response: ModelResponse }
  | { type: "turn_failed"; failure: ModelFailure };
```

不允许 event 每次携带可变的完整 partial response。`ModelTurnAccumulator` 验证事件顺序并归约完整 `ModelResponse`：

1. `turn_started` 恰好一次；
2. part index 不重复且生命周期合法；
3. delta 只能进入已开始、未完成的 part；
4. terminal event 恰好一个；
5. tool arguments 仅在 part 完成后严格解析；
6. truncated/invalid JSON 不修补、不猜测；
7. iterator 意外抛错转换为 `adapter_bug` failure。

#### 2.2.3 Capabilities

```ts
export interface ModelCapabilities {
  readonly toolCalls: "none" | "single" | "multiple";
  readonly toolChoice: readonly ToolChoiceKind[];
  readonly reasoning: boolean;
  readonly reasoningReplay: boolean;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
}
```

Runtime 只依据 capability 做必要判断。provider quirks、beta headers、wire field names 和 SDK options 留在 adapter profile 内。请求无法满足时在发网前返回 typed failure，不静默降级。

### 2.3 Provider registry 与 profiles

#### 2.3.1 OpenAI-compatible

一个 adapter 支持多个经过验证的 profiles。Profile 只能配置真实 wire 差异：

```ts
export interface OpenAiCompatibleProfile {
  readonly id: ProviderId;
  readonly baseUrl: URL;
  readonly auth: CredentialRequest;
  readonly requestDialect: OpenAiRequestDialect;
  readonly responseDialect: OpenAiResponseDialect;
  readonly capabilityOverrides?: Partial<ModelCapabilities>;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
}
```

第一版内置 OpenAI、DeepSeek、GLM profiles。未知自定义 endpoint 可以通过 extension 注册新 profile，但必须显式选择，不继承未经证明的 capability。

#### 2.3.2 Anthropic

Anthropic adapter 单独实现 native Messages mapping、stream events、tool calls、usage、reasoning replay 和 error normalization。它不能复用 OpenAI-compatible parser 后仅修改字段名。

#### 2.3.3 Model catalog

`ModelDescriptor` 至少包含 provider/model ID、display name、capabilities、context/output limits、availability source 和 catalog revision。Catalog 可以来自 built-in metadata、provider discovery 或 extension；冲突按显式 precedence 处理并保留 provenance。

### 2.4 Auth

```ts
export interface CredentialSource {
  readonly id: string;
  resolve(
    request: CredentialRequest,
    options?: { signal?: AbortSignal },
  ): Promise<CredentialResolution>;
}

export type Credential =
  | { kind: "api_key"; value: SecretString }
  | { kind: "bearer"; value: SecretString; expiresAt?: number };

export type CredentialResolution =
  | { status: "found"; credential: Credential; sourceId: string }
  | { status: "missing" }
  | { status: "failed"; failure: AuthFailure };
```

第一版实现：

- `EnvironmentCredentialSource`；
- ignored local config credential source；
- ordered `CredentialResolver` chain。

Session 只保存 `CredentialRef` 或 provider profile，不保存 secret。Adapter 在每次调用前解析 credential，以支持 token rotation。未来 OAuth/refresh token 通过新增 `CredentialSource` 实现，Agent 和 Session API 不改变。

### 2.5 Failure 与 retry boundary

```ts
export interface ModelFailure {
  readonly category:
    | "not_configured"
    | "authentication"
    | "permission"
    | "rate_limit"
    | "quota"
    | "timeout"
    | "network"
    | "invalid_request"
    | "invalid_response"
    | "content_filter"
    | "provider_unavailable"
    | "cancelled"
    | "adapter_bug";
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly httpStatus?: number;
  readonly requestId?: string;
  readonly message: string;
}
```

Provider adapter 不执行隐藏 retry。`agent` 的 `ModelRetryPolicy` 根据 failure、Attempt 是否产生语义 output、预算和 abort 决定是否新建 Model Attempt。

### 2.6 `model` 测试

- canonical event grammar 和 accumulator property/fixture tests；
- OpenAI-compatible 与 Anthropic raw wire fixtures；
- tool-call JSON fragmentation、multiple calls、truncation、malformed stream；
- capability rejection、usage unknown、reasoning replay；
- auth missing/expired/failure/redaction；
- abort before request、mid-stream abort、iterator error；
- `ScriptedModel` 与 production adapters 共用 `Model` contract。

真实 endpoint 只做显式 opt-in smoke，不作为普通测试门禁。

## 3. `agent` Package

### 3.1 Public API 分层

`agent` 提供两个层次：

1. `Agent`：单次 Run 的通用执行引擎；
2. `AgentHarness`：把 Agent 接入 Session、context、model、tools 和 durable lifecycle 的 production harness。

应用通常使用 `AgentHarness`。需要嵌入临时、无持久化 Agent 的高级调用者可以直接使用 `Agent`，但必须自行满足 `AgentHost` contract。

建议 exports：

```json
{
  ".": "./dist/index.js",
  "./session": "./dist/session/index.js",
  "./context": "./dist/context/index.js",
  "./testing": "./dist/testing/index.js"
}
```

### 3.2 Agent Core

```ts
export interface Agent {
  run(input: AgentRunInput, host: AgentHost): AgentExecution;
}

export interface AgentRunInput {
  readonly runId: RunId;
  readonly model: Model;
  readonly tools: ToolExecutor;
  readonly stopPolicy: RunStopPolicy;
  readonly retryPolicy: ModelRetryPolicy;
  readonly budgets: RunBudgets;
  readonly signal: AbortSignal;
}

export interface AgentHost {
  prepareContext(input: ContextPrepareRequest): Promise<PreparedContext>;
  commit(event: AgentSemanticEvent): Promise<void>;
  drainSteering(): Promise<readonly QueuedMessage[]>;
  takeFollowUp(): Promise<QueuedMessage | undefined>;
  reportProgress(event: AgentProgressEvent): void;
}

export interface AgentExecution {
  readonly events: AsyncIterable<AgentEvent>;
  readonly result: Promise<AgentRunResult>;
}
```

`AgentHost.commit()` 是 durability barrier：assistant message 提交成功后才能执行其中的 ToolCall；ToolOutcome 提交成功后才能开始下一次 model request。

#### 3.2.1 Run phases

```text
created
  → preparing_context
  → model_streaming
  → assistant_committing
  ├─ valid tool calls → tool_batch
  │                       → safe_point
  └─ no tool calls ───────→ completion_candidate

safe_point
  → stop policy
  ├─ stop                 → finalizing
  ├─ Steering available   → preparing_context
  └─ none                 → completion_candidate

completion_candidate
  ├─ one Follow-up        → preparing_context
  └─ none                 → finalizing

finalizing → terminal
```

ToolCall 的 waiting_permission/running/failed/denied/timed_out/cancelled 是 Tool execution 内部状态，不扩大顶层 Run phase。

#### 3.2.2 Counters

- `modelTurnCount`：逻辑 model interaction 数；
- `modelAttemptCount`：实际 provider requests 数；
- `contextDerivationCount`：compaction 等内部 model interactions；
- `toolCallCount`：接受的 ToolCalls 数；
- `settledToolCallCount`：已有 ToolOutcome 的调用数。

transport retry 只增加 Attempt，不增加 Turn。Context Derivation 不冒充 Agent 工作轨迹中的 Turn/Attempt。

#### 3.2.3 Tool-call Batch

第一版按 assistant source order 串行执行。核心不变量：

1. 完整 assistant message 先 durable commit；
2. 每个被接受 ToolCall 恰好一个 ToolOutcome；
3. results 按原 source order 投影给模型；
4. invalid/truncated call 不执行；
5. 同 batch 中存在无法形成完整 call 的结构错误时，整批不开始；
6. 普通 denied/failed/timeout/non-zero 作为模型可见 result，不自动终止 Run；
7. pairing、cleanup 或 executor infrastructure 无法维持时才 terminal failed。

#### 3.2.4 Stop、retry、abort

```ts
export interface RunStopPolicy {
  evaluate(input: StopPolicyInput): Promise<StopDecision>;
}

export interface ModelRetryPolicy {
  decide(input: RetryPolicyInput): Promise<RetryDecision>;
}
```

第一版实现固定上限策略，但 `Agent` 不硬编码 `maxSteps`。Policies 在 Run 启动时冻结。

Abort 顺序：

1. 原子标记 abort requested；
2. 禁止启动新 Model Attempt/ToolCall；
3. 传播 signal 到当前 model/tool/process；
4. 结算当前与未启动 calls；
5. 等待 bounded cleanup；
6. 不再消费 queues；
7. 只进入一次 `terminal(aborted)`。

已持久化 Transcript 和已发生 workspace effects 不回滚。

### 3.3 AgentHarness

`AgentHarness` 是 production Module。它不是 test harness，也不是 `Agent.run()` 的同名转发器。

```ts
export interface AgentHarness {
  startRun(input: HarnessRunInput): Promise<HarnessRunHandle>;
  recoverSession(input: RecoverSessionInput): Promise<RecoveryResult>;
}

export interface HarnessRunInput {
  readonly session: SessionHandle;
  readonly branchId: BranchId;
  readonly initialMessages: readonly AgentInputMessage[];
  readonly model: Model;
  readonly tools: ToolExecutor;
  readonly context: ContextManager;
  readonly policies: RunPolicies;
  readonly metadata: RunMetadata;
}

export interface HarnessRunHandle {
  readonly runId: RunId;
  events(): AsyncIterable<HarnessEvent>;
  dispatch(command: HarnessCommand): Promise<CommandAck>;
  readonly finished: Promise<RunReport>;
}
```

Harness 隐藏：

- pre-run durable creation 与 private `RunLease`；
- Run-scoped dependency snapshot；
- Session entries 与 Agent events 的 mapping；
- semantic event commit barrier；
- Steering/Follow-up queue transitions；
- Context Manifest 与 Compaction Checkpoint commit；
- progress backpressure/coalescing；
- exactly-one terminal + RunReport；
- crash recovery 和 orphan Run settlement；
- hooks/telemetry invocation 与 listener isolation。

`startRun()` 在 durable Run 建立前失败时返回 typed `RunStartError`，不产生 Run。成功返回 handle 后，无论 model/tool/persistence/abort 怎样结束，`finished` 都 resolve 一个 `RunReport`；只有无法表达的 programmer invariant 才 reject。

### 3.4 Session domain

#### 3.4.1 Repository

```ts
export interface SessionRepository extends AsyncDisposable {
  create(input: CreateSessionInput): Promise<SessionHandle>;
  open(ref: SessionRef, options?: OpenSessionOptions): Promise<SessionHandle>;
  list(query?: SessionQuery): Promise<readonly SessionSummary[]>;
  fork(input: ForkSessionInput): Promise<SessionHandle>;
  delete(ref: SessionRef): Promise<void>;
}

export interface SessionHandle extends AsyncDisposable {
  readonly ref: SessionRef;
  inspect(): Promise<SessionSnapshot>;
  readBranch(input: ReadBranchInput): Promise<SessionBranchView>;
  selectBranch(branchId: BranchId, expectedRevision: number): Promise<SessionSnapshot>;
  forkBranch(input: ForkBranchInput): Promise<BranchRef>;
  enqueue(input: QueueInput): Promise<QueueItem>;
  updateQueue(input: QueueUpdate): Promise<QueueItem>;
  beginRun(input: BeginRunInput): Promise<RunLease>;
}
```

`RunLease` 是 Harness 使用的窄写入能力，不暴露给 UI 或 extensions：

```ts
export interface RunLease extends AsyncDisposable {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly branchId: BranchId;

  append(entries: readonly NewLedgerRecord[]): Promise<CommitReceipt>;
  drainSteering(): Promise<readonly QueueItem[]>;
  takeFollowUp(): Promise<QueueItem | undefined>;
  commitContext(manifest: ContextManifest, checkpoint?: CompactionCheckpoint): Promise<void>;
  finish(report: RunReport): Promise<TerminalCommit>;
}

export interface ArtifactStore {
  put(input: ArtifactWriteInput, options?: { signal?: AbortSignal }): Promise<ArtifactRef>;
  stat(ref: ArtifactRef): Promise<ArtifactMetadata>;
  read(ref: ArtifactRef, options?: ArtifactReadOptions): AsyncIterable<Uint8Array>;
  verify(ref: ArtifactRef): Promise<ArtifactIntegrity>;
}
```

所有 mutating calls 使用 revision/lease fencing，防止第二个进程用 stale handle 修改同一 Session。

#### 3.4.2 Transcript and tree

Transcript 是 append-only Conversation Tree。每个 durable record 有：

- `recordId`；
- Session-wide monotonic `ledgerSeq`；
- `runId`；
- optional `parentEntryId`；
- `kind` + versioned payload；
- created/provenance metadata。

Record families：

- semantic entries：user、assistant、ToolOutcome、Run Boundary、Compaction Checkpoint、ArtifactRef；
- operation records：Run/model/tool/retry/recovery lifecycle；
- pointer mutations：branch head/fork/select；
- context records：Context Manifest 和 derivation metadata。

只有经过 projection policy 选择的 semantic entries 进入 Model Context。Progress events、provider raw payload 和 UI state 不进入 Transcript。

#### 3.4.3 RunReport

```ts
export interface RunReport {
  readonly version: 1;
  readonly runId: RunId;
  readonly status: "completed" | "aborted" | "failed" | "limited";
  readonly terminationReason: TerminationReason;
  readonly finalAnswer?: string;
  readonly partialArtifact?: ArtifactRef;
  readonly counts: RunCounts;
  readonly usage: UsageSummary;
  readonly tools: ToolSummary;
  readonly permissions: PermissionSummary;
  readonly changedFiles: readonly ChangedFileEvidence[];
  readonly commands: readonly CommandEvidence[];
  readonly unfinishedWork: readonly string[];
  readonly error?: RedactedErrorSummary;
  readonly lastPhase: RunPhase;
}
```

`completed` 表示 Agent 正常到达 no-tool/no-follow-up 终止，不等于 external verifier 通过。

### 3.5 Context Management

#### 3.5.1 General pipeline

```ts
export interface ContextSource {
  readonly id: string;
  collect(input: ContextSourceInput): Promise<readonly ContextContribution[]>;
}

export interface ContextManager {
  prepare(input: ContextPrepareInput): Promise<PreparedContext>;
}

export interface PreparedContext {
  readonly request: ModelRequest;
  readonly manifest: ContextManifest;
  readonly measurement: TokenMeasurement;
  readonly checkpoint?: CompactionCheckpoint;
}
```

第一版真实 sources：

- system/tool definitions；
- current task and queued messages；
- current branch Transcript；
- latest Run Boundary；
- project instruction files；
- selected skills；
- latest applicable Compaction Checkpoint；
- bounded Artifact previews。

每个 contribution 包含 source ID、priority、required/optional、ordering group、estimated tokens、provenance 和 sensitivity。Selection 不能拆散 assistant ToolCalls 与对应 ToolResults。

#### 3.5.2 Budget

```text
usable input budget
= model context window
- requested output reserve
- protocol/tool schema reserve
- safety margin
```

Selection priority：

1. system instructions 与 tool definitions；
2. current task、latest Steering/Follow-up；
3. 未完成的完整 tool pairing；
4. recent complete Model Turns；
5. latest applicable checkpoint；
6. optional older derived contributions。

最低合法 projection 无法放入时返回 `context_overflow`，不静默删除 required content。

#### 3.5.3 Compaction

```ts
export interface CompactionStrategy {
  shouldCompact(input: CompactionCheckInput): Promise<boolean>;
  compact(input: CompactionInput): Promise<CompactionResult>;
}
```

第一版 `SummaryCompactionStrategy`：

- 只在完整 Model Turn 边界切割；
- 使用 active Run 固定的 model；
- 生成显式 lossy summary；
- 记录 source range、branch leaf、retained tail、prior checkpoint、strategy version、token provenance 和 digest；
- 先生成并验证，再作为一个 atomic checkpoint commit；
- derivation 失败不修改 Transcript；
- checkpoint 只适用于包含其完整 source ancestry 的 branch。

未来四层压缩、retrieval memory 或 workspace index 通过新的 `CompactionStrategy`/`ContextSource` 接入。Agent state machine 只依赖 `ContextManager.prepare()`。

#### 3.5.4 基础 memory 语义

第一版把以下内容视为基础、可审计的记忆来源：

- Session Transcript；
- Run Boundaries；
- Compaction Checkpoints；
- project/user instructions；
- selected skills。

不建立空 `MemoryStore`。当长期事实抽取、检索、遗忘、冲突解决具有明确行为后，可以实现 `MemoryContextSource` 和对应 persistence contract；它不会直接修改 Transcript，也不能跳过 Context Manifest。

### 3.6 Generic tool protocol

```ts
export interface ToolExecutor {
  definitions(): readonly ToolDefinition[];
  execute(call: ToolCall, context: ToolExecutionContext): ToolExecution;
}

export interface ToolExecution {
  readonly updates: AsyncIterable<ToolUpdate>;
  readonly outcome: Promise<ToolOutcome>;
}

export interface ToolOutcome {
  readonly callId: string;
  readonly status:
    | "succeeded"
    | "rejected"
    | "denied"
    | "failed"
    | "timed_out"
    | "output_limit"
    | "cancelled"
    | "conflict";
  readonly isError: boolean;
  readonly modelContent: string;
  readonly effectState: "none" | "committed" | "partial" | "unknown";
  readonly abortObserved: boolean;
  readonly artifacts: readonly ArtifactRef[];
  readonly evidence?: ToolEvidence;
}
```

`agent` 定义 protocol 和 batch semantics；`coding` 实现 ToolHost。`agent` 不认识 tool name、filesystem path 或 shell command。

### 3.7 Events、hooks 与 observability

Events 分两类：

- `SemanticEvent`：完整 message、tool settlement、retry、queue delivery、terminal；必须有序、不可丢失；
- `ProgressEvent`：text/reasoning/tool output delta；可合并、限流或丢弃旧值。

Public hook contract：

```ts
export interface AgentHook {
  readonly id: string;
  onEvent?(event: Readonly<AgentSemanticEvent>, context: HookContext): Promise<void> | void;
  beforeContext?(input: Readonly<ContextPrepareInput>): Promise<readonly ContextContribution[]>;
  afterRun?(report: Readonly<RunReport>): Promise<void> | void;
}
```

Hooks 默认 observation-only；context contribution 经过同一 validation/budget/provenance pipeline。Listener failure 被隔离并记录，不反向改变已提交的 Agent transition。Tool execution、stop/permission decision 不通过 unrestricted hook 覆盖。

### 3.8 `agent` 测试

- Run phase transition table；
- multi-turn/no-tool/tool-batch paths；
- call/result pairing、invalid/truncated model output；
- retry counts、policy limit、abort in every phase；
- semantic commit failure 和 exactly-one terminal；
- Steering/Follow-up FIFO 与 safe point；
- Session tree/fork/cross-Run continuity；
- Context budget、pairing、checkpoint applicability、derivation failure；
- in-memory/SQLite repository conformance；
- teardown：无 pending timer、promise、lease、process/tool execution。

## 4. `coding` Package

### 4.1 Application facade

```ts
export interface CodingAgent {
  listSessions(query?: SessionQuery): Promise<readonly CodingSessionSummary[]>;
  createSession(input: CreateCodingSessionInput): Promise<CodingSession>;
  openSession(ref: SessionRef): Promise<CodingSession>;
  listModels(query?: ModelQuery): Promise<readonly ModelDescriptor[]>;
  listModes(): readonly ModeDescriptor[];
  diagnostics(): Promise<CodingDiagnostics>;
}

export interface CodingSession {
  readonly ref: SessionRef;
  inspect(): Promise<CodingSessionView>;
  fork(input: ForkConversationInput): Promise<BranchRef>;
  selectBranch(input: SelectBranchInput): Promise<CodingSessionView>;
  startRun(input: StartCodingRunInput): Promise<CodingRunHandle>;
}

export interface CodingRunHandle {
  readonly runId: RunId;
  events(): AsyncIterable<CodingEvent>;
  dispatch(command: CodingRunCommand): Promise<CommandAck>;
  readonly finished: Promise<RunReport>;
}

export type CodingRunCommand =
  | { commandId: string; type: "steer"; text: string }
  | { commandId: string; type: "follow_up"; text: string }
  | {
      commandId: string;
      type: "respond_permission";
      approvalId: string;
      decision: "allow_once" | "deny";
      planFingerprint: string;
    }
  | { commandId: string; type: "abort"; reason?: string };
```

`CodingAgent` 是 CLI、TUI、print mode、extensions 和未来 frontends 的共同 seam。它负责 product preflight：

- workspace 是可用 Git repository；
- 新 Session baseline 是否 clean；
- current workspace fingerprint 是否与 Session 一致；
- provider/model/profile 是否可解析；
- credential 是否存在；
- Permission Mode、budgets、tools、extensions、skills snapshot 是否合法；
- persistence 是否可写且没有冲突 lease。

Preflight 失败不创建 Run，返回 `CodingStartError`。Run 已建立后所有终止都通过 `RunReport` 表达。

### 4.2 CLI

CLI executable 只做：

1. parse argv/env/config；
2. 构建 production composition；
3. 选择 command 和 mode；
4. 映射 typed result 到 stdout/stderr/exit code；
5. 在退出前等待 cleanup。

第一版 commands：

```text
coding-agent                         # 当前目录启动 interactive mode
coding-agent --print "task"         # non-interactive print mode
coding-agent session list
coding-agent session open <id>
coding-agent session fork <id>
coding-agent models list
coding-agent extensions list
coding-agent skills list
coding-agent doctor
```

命令名可以在正式品牌确定后调整，行为契约不依赖 bin 名。

Exit code 建议：

- `0`：command 成功；Run completed；
- `1`：Run failed/limited 或普通 product failure；
- `2`：CLI/config/input error；
- `3`：credential/provider unavailable；
- `4`：permission/workspace preflight refused；
- `130`：user abort/interrupted。

### 4.3 Interaction Modes

```ts
export interface InteractionMode {
  readonly descriptor: ModeDescriptor;
  run(context: ModeContext): Promise<ModeExit>;
}

export interface ModeRegistry {
  register(mode: InteractionMode): Registration;
  resolve(id: string): InteractionMode;
  list(): readonly ModeDescriptor[];
}
```

`ModeContext` 只提供 `CodingAgent` facade、validated config、I/O capabilities 和 top-level AbortSignal。

#### 4.3.1 Interactive mode

位置：`coding/src/modes/interactive/`，使用 Ink。

内部结构：

- `App`：screen composition；
- `ViewState` + pure reducer：把 `CodingEvent` 映射成 UI state；
- input controller：将键盘/commands 映射为 facade calls；
- components：Session/model selector、transcript、tool view、permission、queues、status、RunReport；
- render throttling：progress delta 合并，semantic event 不丢失；
- terminal lifecycle：raw mode、resize、Ctrl+C/abort、clean restore 由 Ink/adapter 管理。

TUI 禁止：

- import provider adapters；
- 读取 SQLite；
- 修改 Agent state；
- 自行判断 tool risk；
- 把 local view state 持久化为 Transcript；
- 用 component callback 绕过 `CodingRunHandle.dispatch()`。

#### 4.3.2 Print mode

Print mode 支持一次 task、structured progress policy、stdout final answer、stderr diagnostics 和 deterministic exit code。它使用相同 `CodingAgent`/Harness/ToolHost/SQLite production path，不是隐藏 demo flow。

后续 JSON/RPC/IDE mode 只需实现 `InteractionMode`。第一版不创建独立 `tui` package。

### 4.4 CodingToolHost

#### 4.4.1 Execution pipeline

固定顺序：

```text
lookup
→ strict schema validation
→ immutable ToolPlan
→ Hard Guard
→ effects/risk classification
→ Permission Mode evaluation
→ ApprovalPort if required
→ volatile precondition revalidation
→ timeout/cancel/output budgets
→ concrete adapter
→ cleanup
→ ToolOutcome
```

```ts
export interface ToolPlan {
  readonly callId: string;
  readonly toolName: string;
  readonly normalizedArguments: JsonValue;
  readonly resources: readonly ToolResource[];
  readonly effects: readonly ToolEffect[];
  readonly risks: readonly RiskReason[];
  readonly preconditions: readonly ToolPrecondition[];
  readonly policyVersion: string;
  readonly fingerprint: string;
}
```

批准与 `fingerprint` 绑定。批准后任何会改变 effects/resources/preconditions 的变化都要求新 plan，旧批准 stale。

#### 4.4.2 Built-in tools

第一版：

- `list_files`
- `read_file`
- `search_text`
- `create_file`
- `apply_patch`
- `replace_file`
- `delete_file`
- `run_command`
- `git_status`
- `git_diff`
- `web_search`
- `web_fetch`

Schema 使用 `additionalProperties: false`，禁止 coercion、猜测、隐式参数修复。没有万能 recursive delete、arbitrary filesystem、raw HTTP、background daemon 或任意 env map tool。

#### 4.4.3 Permission

```ts
export interface ApprovalPort {
  request(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>;
}

export type ApprovalDecision = "allow_once" | "deny";
```

- Safe Mode 自动允许 workspace read/Git evidence；mutate/process/network 按 policy 请求批准。
- Autonomous Mode 不逐次询问，但仍执行全部 Hard Guards。
- deny 不启动 tool，生成 `denied + effectState:none` ToolOutcome，默认继续 Agent loop。
- abort 取消 pending approval。
- duplicate/stale/wrong fingerprint response 不得启动 tool。
- 第一版没有永久授权或 approval 自动超时。

#### 4.4.4 Filesystem

- 模型路径必须 workspace-relative；拒绝 absolute、UNC/device、NUL、traversal。
- Run snapshot 固定 workspace root realpath。
- read 可跟随最终仍在 workspace 内的 symlink；recursive enumeration 不跟随 symlink directory。
- mutation 拒绝目标或祖先 symlink/junction；批准后提交前重新校验。
- `.git/**` 不允许 direct file mutation。
- 第一版处理 UTF-8 text；binary/invalid UTF-8 受控拒绝。
- patch/replace/delete 使用 content hash/precondition 检测冲突。
- mutation 使用同目录 temp file、flush、atomic replace 和 cleanup；不宣称断电级全文件系统事务。

#### 4.4.5 Process

- Windows：无 profile、non-interactive PowerShell；
- Linux：无 profile、non-interactive Bash；
- model 不能选择 shell、TTY、background、stdin、proxy 或任意 env；
- command 在 workspace-relative cwd 中运行；
- environment 删除 provider credentials 和 registered secrets；
- timeout/abort 必须终止 process tree；cleanup 无法确认时升级为 infrastructure failure；
- stdout/stderr 分开捕获、限流、截断和脱敏；
- command non-zero 是 ToolOutcome，不是 Host crash。

#### 4.4.6 Web

`web_search` 使用窄 `WebSearchProvider`，第一版可配置境内、全球和显式 self-hosted profiles；一次 Run 固定 provider，不静默 fallback。

`web_fetch`：

- 只接受 absolute HTTP/HTTPS URL 和 GET；
- 禁止 userinfo、credential headers、cookies、body、arbitrary headers、non-default port；
- 初始 URL 与每个 redirect 逐跳 URL/DNS/IP validation；
- 拒绝 private/reserved/local addresses 和 HTTPS downgrade；
- DNS validation 后 pin address，防止 rebinding；
- bounded redirects、connect/header/body/total timeout、header/body/text size；
- 只提取 text/HTML/JSON，不执行 JavaScript、不加载子资源。

### 4.5 Workspace and evidence

`WorkspaceService` 负责：

- repository root discovery；
- clean baseline validation；
- HEAD、tree、changed/untracked files；
- stable workspace fingerprint；
- branch switch warning；
- Run 前后 evidence snapshot。

Conversation Branch 只改变 Transcript ancestry，不执行 Git checkout/reset。新 Session 要求 clean workspace；同 Session 后续 Runs 可继续处理前一 Run 的 dirty workspace。外部变化导致 fingerprint mismatch 时必须由 frontend 显式确认新 baseline。

### 4.6 Extension/plugin system

#### 4.6.1 Manifest

```ts
export interface ExtensionManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly apiVersion: string;
  readonly entry: string;
  readonly displayName?: string;
  readonly capabilities: readonly ExtensionCapability[];
}
```

来源：built-in、user config directory、project directory、explicit package/path。用户必须显式启用第三方 extension。Load order 固定且可诊断；duplicate ID、incompatible API、invalid manifest 或 load failure 返回 typed diagnostic，不静默覆盖。

#### 4.6.2 Extension API

```ts
export interface ExtensionApi {
  registerTool(tool: CodingToolContribution): Registration;
  registerCommand(command: CommandContribution): Registration;
  registerMode(mode: InteractionMode): Registration;
  registerSkillSource(source: SkillSource): Registration;
  registerContextSource(source: ContextSource): Registration;
  registerModelProvider(provider: ModelProvider): Registration;
  registerCredentialSource(source: CredentialSource): Registration;
  observe(hook: CodingObservationHook): Registration;
}
```

注册发生在 composition freeze 前；active Run 使用 immutable registry snapshot。Registration 支持 dispose，供开发期 reload，但不允许 active Run 中途更换 tools/provider/policies。

边界：

- extension tool 必须通过 ToolHost validation/plan/guard/approval/outcome；
- extension 不能直接 append Session records；
- extension 不能返回伪 terminal event/RunReport；
- observation hook failure 被隔离；
- context source output 带 provenance、budget 和 sensitivity；
- dynamic code 与宿主同权限，属于 trusted code，不宣称 sandbox。

#### 4.6.3 Plugin API compatibility

- manifest `apiVersion` 使用 major compatibility；
- public contribution shapes 只引用 package public types；
- removed/changed capability 通过 major bump；
- loader 报告 extension ID、version、source、requested/accepted capabilities；
- extension exceptions 使用 redacted diagnostic，不能包含 credential。

### 4.7 Skills

```ts
export interface SkillSource {
  readonly id: string;
  discover(context: SkillDiscoveryContext): Promise<readonly SkillDescriptor[]>;
  load(ref: SkillRef): Promise<SkillContent>;
}

export interface SkillRegistry {
  list(query?: SkillQuery): readonly SkillDescriptor[];
  resolve(id: string): SkillDescriptor;
  select(input: SkillSelectionInput): readonly SkillRef[];
}
```

Skill 包含 metadata、instructions、optional resources、provenance 和 content digest。第一版：

- built-in/user/project/extension sources；
- strict metadata validation；
- deterministic precedence 与 conflict diagnostic；
- explicit user selection/command invocation；
- selected skill 通过 `ContextSource` 注入；
- Context Manifest 记录 skill ID/version/digest；
- skill content 不获得绕过 tool safety 的执行能力。

### 4.8 Configuration

配置分层：

```text
built-in defaults
→ user config
→ project config
→ session defaults
→ CLI/run overrides
```

合并后生成 immutable `RunConfigSnapshot`，至少包含 model ref、Permission Mode、budgets、tool enablement、search profile、extension/skill selections、policy versions。Credential values 不进入 snapshot；只保存 credential request/ref。

配置 schema 必须拒绝 unknown security-sensitive fields。`doctor` 命令显示来源和问题，但对 secret 只显示 present/missing/source，不显示值。

### 4.9 Composition

`createCodingAgent(options)` 默认组装 SQLite production persistence，同时允许 embedding caller 显式注入满足 `SessionRepository`/`ArtifactStore` 的其他 Adapter。只有 `composition` 目录直接 import `sqlite`；`app`、modes 和 tools 仍只依赖 `agent` contract。

建立顺序：

1. validate base config；
2. initialize credential sources；
3. build `ModelRegistry` and built-in providers；
4. open SQLite persistence and run migrations；
5. create context sources and compaction strategy；
6. build coding ToolHost and OS/web adapters；
7. load/validate enabled extensions；
8. freeze model/tool/mode/skill/context registries；
9. construct Agent + AgentHarness；
10. return `CodingAgent` facade。

任一步失败都执行 reverse-order cleanup，不留下半初始化 global singleton。

### 4.10 `coding` 测试

- application facade preflight/start/terminal contract；
- CLI argument/config/exit codes；
- TUI reducer、permission、abort、late progress、queue edits；
- print mode production path；
- ToolHost decision table；
- filesystem path/symlink/hash/atomicity；
- Windows/Linux process spawn/timeout/abort/output/cleanup；
- web DNS/redirect/SSRF/size/encoding using disabled real network；
- extension manifest/load order/conflict/fault/isolation；
- extension tool still passes Hard Guard；
- skill precedence/digest/context provenance；
- composition failure cleanup and no production fake imports。

## 5. `sqlite` Package

### 5.1 Public constructors

```ts
export interface SqlitePersistenceOptions {
  readonly databasePath: string;
  readonly artifactDirectory: string;
  readonly busyTimeoutMs?: number;
  readonly lease: SqliteLeaseOptions;
  readonly clock?: Clock;
  readonly idFactory?: IdFactory;
}

export interface SqlitePersistence extends AsyncDisposable {
  readonly sessions: SessionRepository;
  readonly artifacts: ArtifactStore;
  checkIntegrity(options?: IntegrityOptions): Promise<IntegrityReport>;
  recover(options?: RecoveryOptions): Promise<RecoveryReport>;
}

export function createSqlitePersistence(
  options: SqlitePersistenceOptions,
): Promise<SqlitePersistence>;
```

只 export agent contract adapters 和 diagnostics，不 export SQL helpers、row types 或 raw database connection。

### 5.2 Database configuration

本地 database：

- `journal_mode=WAL`；
- `foreign_keys=ON`；
- `synchronous=FULL`；
- bounded `busy_timeout`；
- short explicit transactions；
- write paths 使用 `BEGIN IMMEDIATE`；
- 不支持 network filesystem；
- database 和 artifact directory 位于 application data root。

### 5.3 Logical schema

| Table | Responsibility | Key constraints |
| --- | --- | --- |
| `sessions` | workspace binding、defaults、revision、current branch、active run | unique Session ID；active run nullable |
| `branches` | Conversation Branch metadata | FK session；stable branch ID |
| `branch_heads` | branch leaf pointer | one head per branch；entry belongs to same Session |
| `ledger_records` | append-only semantic/operation/pointer/context records | unique `(session_id, ledger_seq)`；immutable payload |
| `runs` | Run snapshot、status、terminal summary | one active Run per Session；one terminal report |
| `tool_calls` | durable planned/started/settled relation | unique `(run_id, call_id)`；one outcome |
| `queue_items` | Steering/Follow-up queued/draft/delivered | revisioned state transition；FIFO ordinal |
| `context_manifests` | projection provenance | FK Run/Attempt；digest/version |
| `compaction_checkpoints` | branch-local summary metadata | source ancestry/range/digest |
| `artifacts` | content metadata and committed storage key | unique digest/storage key；state pending/committed |
| `session_leases` | multi-process writer fencing | unique Session；owner/token/epoch/expiry |
| `migration_history` | applied migration checksum | monotonic version；immutable checksum |

Payload JSON 只存 versioned domain values；索引列用于保证关键约束和查询。不能把所有事实塞进一个无法约束的大 JSON blob。

### 5.4 Transaction boundaries

#### 5.4.1 Create Session

一个 transaction 写入 Session、default branch/head 和 initial metadata。workspace baseline 在 transaction 前完成验证；失败不产生半 Session。

#### 5.4.2 Begin Run

一个 `BEGIN IMMEDIATE` transaction：

1. 验证 Session revision 和 branch；
2. 验证无 active Run；
3. 获取/更新 session writer lease fencing epoch；
4. 插入 Run 和 initial user entry；
5. 设置 `sessions.active_run_id`；
6. 增加 revision；
7. commit 后返回 `RunLease`。

这保证同一 Session 跨进程最多一个 active Run。不同 Session 可并发准备，写事务保持短小。

#### 5.4.3 Append semantic records

每次 append：

- 验证 lease token/epoch 未过期；
- 分配连续 `ledgerSeq`；
- 验证 parent/branch/tool pairing；
- 插入 records；
- 更新 branch head、run counters、queue state；
- 同 transaction commit。

#### 5.4.4 Finish Run

一个 transaction 验证：

- Run 仍 active 且 lease 有效；
- 尚无 terminal report；
- accepted ToolCalls 全部有 outcome 或 recovery settlement；
- report counts 与 durable facts 一致。

然后插入 terminal operation + Run Boundary、保存 RunReport、清除 active run 和 lease、递增 Session revision。Unique constraint/CAS 使 duplicate finish 返回 idempotent existing terminal 或 typed conflict，不产生第二个 terminal。

### 5.5 Writer lease

Lease 字段：`sessionId`、`ownerId`、opaque token、monotonic epoch、acquiredAt、heartbeatAt、expiresAt。

- 所有 Run writes 验证 token + epoch；
- heartbeat 只延长当前 owner；
- stale owner 的 late write 被 fencing epoch 拒绝；
- process crash 后 lease 到期，下一次 open 先执行 recovery；
- 用户打开多个终端不是错误；只有它们竞争同一 Session 的 write lease 时返回明确占用信息；
- read-only Session browsing 不需要 writer lease。

### 5.6 Migrations

- migrations 按整数版本排序且已发布后不可修改；
- `PRAGMA user_version` 是当前版本，`migration_history` 保存 checksum/时间/tool version；
- 启动时在 exclusive migration lock 下逐个 transaction 执行；
- migration 失败 rollback，数据库保持旧版本；
- 新版本不能由旧 binary 安全读取时 fail closed；
- test 从空库和每个已发布 fixture version 升级并比较 schema/invariants。

### 5.7 Artifact store

大型、binary、diagnostic 或 restricted bytes 使用 content-addressed files：

1. 在 artifact directory 内创建受限权限 temp file；
2. streaming write，同时计算 digest、size、truncation metadata；
3. flush/fsync、校验 digest；
4. atomic rename 到 digest-derived storage key；
5. SQLite transaction 把 pending metadata 转为 committed 并写 durable reference。

Reference commit 前 bytes 必须存在且 digest 正确。Crash 可能留下 unreferenced bytes，可以 GC；不得留下引用不存在 bytes 的 committed record。Artifact path 永远不进入 Model Context，只暴露 `ArtifactRef` 和 bounded preview。

### 5.8 Recovery and integrity

打开 Session 时检查：

- stale lease/orphan active Run；
- Run terminal uniqueness；
- ledger sequence gaps；
- parent/branch ancestry；
- tool call/outcome pairing；
- Context Manifest references；
- Artifact existence/digest；
- migration/schema version。

Recovery 不自动恢复 mid-Run model/tool execution，也不 replay tool call：

- orphan active Run → terminal `failed/interrupted`；
- unstarted calls → cancelled；
- started but unsettled calls → `unknown_effect`；
- queued undelivered Steering/Follow-up → drafts；
- durable Transcript/workspace effects 保留；
- unrelated branch artifact damage产生 warning；当前 branch 需要的事实损坏则 read-only degraded/fail closed。

### 5.9 `sqlite` 测试

- repository conformance shared with in-memory adapter；
- transaction rollback and idempotency；
- two processes/handles competing same Session lease；
- stale lease fencing；
- every migration path；
- crash between artifact phases；
- orphan Run and unknown-effect recovery；
- corruption/gap/foreign-key/digest failure；
- reopen does not replay tool or duplicate queue/terminal；
- bounded busy timeout and clean disposal。

## 6. Cross-package Contracts

### 6.1 Run creation boundary

```text
CodingSession.startRun
→ product preflight
→ resolve Model + credentials
→ freeze config/tool/extension/skill snapshots
→ AgentHarness.startRun
→ SessionHandle.beginRun atomic commit
→ Run officially exists
→ Agent.run exactly once
```

`beginRun` 之前的失败是 `CodingStartError`；之后的失败必须形成 terminal `RunReport`。

### 6.2 Commit-before-effect

```text
complete assistant response
→ validate tool batch
→ durable assistant commit
→ start first ToolCall
```

如果 durable commit 失败，不得执行 tool。这个 barrier 由 Harness 维护，ToolHost 和 UI 不得绕过。

### 6.3 Event projection

```text
ModelEvent / ToolUpdate
→ Agent ProgressEvent
→ Harness/Coding progress projection
→ Mode

Agent SemanticEvent
→ Session durable commit
→ Harness/Coding semantic event with sequence
→ Mode
```

Progress 可以 coalesce；Semantic 不可丢。terminal 后到达的 progress 被丢弃并记录 diagnostic，不能复活 UI active state。

### 6.4 Permission round trip

```text
ToolHost creates immutable plan
→ ToolHost asks ApprovalPort
→ Coding application emits PermissionRequested
→ Mode dispatches RespondToPermission
→ application validates run/call/approval/fingerprint/one-shot
→ ToolHost receives allow_once or deny
```

TUI 只是 decision input adapter，不拥有 permission policy。

### 6.5 Session and context separation

- Session 保存 canonical Transcript 和 provenance，不保存 provider-ready prompt 副本。
- ContextManager 每个 Model Attempt 从 Session 事实重新构建 `ModelRequest`。
- Model adapter 只做 canonical-to-wire transform，不决定保留哪些历史。
- Compaction 追加派生 checkpoint，不覆盖 Transcript。

## 7. Error Taxonomy

### 7.1 Boundary errors

| Boundary | Typed failures |
| --- | --- |
| model | config/auth/rate/network/timeout/protocol/cancel/adapter bug |
| agent start | invalid input/session conflict/context unavailable/policy invalid |
| agent terminal | completed/aborted/failed/limited + reason |
| session | not found/conflict/lease lost/corrupt/read-only/storage |
| tool | rejected/denied/failed/timed out/output limit/cancelled/conflict |
| coding start | workspace/config/model/credential/extension/persistence preflight |
| extension | manifest/incompatible/duplicate/load/registration/hook failure |
| CLI/mode | usage/input/output/terminal unavailable/interrupted |

Typed errors 必须含 stable code、redacted message、optional cause for local diagnostics。Provider raw response、absolute secret path、SQL text with values 和 command environment 不进入用户/模型消息。

### 7.2 Infrastructure invariant failure

以下情况升级为 terminal infrastructure failure：

- 无法保证 ToolCall/ToolResult pairing；
- process tree cleanup 无法确认；
- Session lease 丢失且不能安全提交；
- terminal transaction 失败且 recovery 也不能确定状态；
- corrupted current branch ancestry；
- internal state transition impossible。

即使失败，也应尽最大可能保存 redacted diagnostics 和 partial evidence，且不能伪装为 `completed`。

## 8. Concurrency and Cancellation

- 一个 Session 跨进程最多一个 active Run，由 SQLite lease/fencing 保证。
- 不使用 application-global “only one Run” singleton；不同 Sessions 可以在资源 policy 允许时并发。
- 一个 Run 的 Tool-call Batch 第一版串行；未来并发实现必须保持 source-order result projection 和完整 settlement。
- model/tool/context derivation 各使用 child AbortSignal，与 Run signal 链接。
- mode 退出前请求 abort 并等待 bounded cleanup；强制进程退出必须标记 recovery need。
- event listeners 不得阻塞 core transition；semantic durability 不等于等待所有 UI listeners。

## 9. Testing and Verification

### 9.1 Stable seams

第一版主要测试 seams：

1. `CodingAgent`：最高层 product behavior；
2. `AgentHarness`：完整 generic Agent behavior；
3. `Model`：provider contract；
4. `SessionRepository`：persistence contract；
5. `ToolExecutor`：tool/safety contract；
6. `InteractionMode` reducer/input contract；
7. Extension/Skill registration contract。

低层 parser、path resolver、SQL helpers 可以单测，但不成为跨 package public seams。

### 9.2 Deterministic scenario harness

`ScenarioHarness` 从真实 `CodingAgent` 或 `AgentHarness` 入口运行，只替换 true external dependencies：

- `ScriptedModel`；
- Manual clock/ID；
- temp workspace/database；
- scripted approval/DNS/search/HTTP；
- controlled process adapter when real OS behavior不相关。

它不得直接写 Transcript、改 Run phase 或伪造 RunReport。Script 严格 FIFO/request-aware；少调用、多调用、未消费 step、未释放 gate 都使测试失败。

### 9.3 Must-pass paths

- no-tool completed；
- multi-turn read→edit→verify→final；
- model failure/retry exhausted；
- invalid/truncated tool call；
- permission deny then continue；
- abort during model/tool/approval；
- timeout/non-zero/output limit；
- context pressure and compaction；
- Session fork/continuous Runs/workspace mismatch；
- SQLite reopen/orphan recovery/no replay；
- extension tool safety；
- TUI/print late-event and exit behavior。

### 9.4 System and acceptance

- Windows PowerShell 与 Linux Bash real subprocess tests；
- real filesystem symlink/junction/path containment tests；
- SQLite crash/migration/integrity tests；
- interactive TUI smoke；
- 至少一个 production provider + production TUI 的真实小型 coding task；
- external verifier 独立于 agent writable workspace；
- RunReport、diff、commands、artifacts 和 verifier evidence 可交叉核验。

Live provider tests 显式 opt-in、预算受控、失败记录保留，不用随机重跑掩盖缺陷。

## 10. Evolution Without Rewrite

| Future capability | Existing seam | Expected change | Must not change |
| --- | --- | --- | --- |
| multi-level compaction | `CompactionStrategy` + Context Manifest | new strategy/checkpoint metadata | Agent loop、Transcript immutability |
| long-term memory | `ContextSource` + new persistence contract | memory extraction/retrieval lifecycle | Session facts、context auditability |
| Task/Subagent | `AgentHarness` + tool/extension/application APIs | child Run ownership、budgets、parent relation | per-Run isolation、terminal semantics |
| new provider | `ModelProvider`/`Model` registry | adapter/profile/auth source | canonical Model protocol |
| OAuth | `CredentialSource` | refresh/cache implementation | Session secret prohibition |
| alternate storage | `SessionRepository` conformance | new package/adapter | Session domain contract |
| JSON/RPC/IDE UI | `InteractionMode` + `CodingAgent` | new mode/transport | Agent/SQLite internals |
| independent TUI framework | interactive mode extraction | renderer/components package | coding-specific view contracts |
| richer plugins | `ExtensionApi` versioning | capabilities/distribution/isolation | safety and Session ownership |

未来功能只有在出现真实行为和独立复杂性时才新建 package。保持 Seam 不等于现在创建空 implementation。

## 11. 第一版 Definition of Done

### 11.1 `model`

- registry/auth/catalog 可以列出并解析可用 model；
- OpenAI-compatible 和 Anthropic adapters 通过 raw-wire contract；
- streaming/tool-call/failure/usage/abort 归一化完整；
- provider SDK types 不泄漏。

### 11.2 `agent`

- Agent 与 production Harness 均为真实 implementation；
- multi-turn、batch、retry、queues、abort、terminal 不变量通过 deterministic tests；
- Session/conversation/context/compaction/RunReport 可持久和恢复；
- 没有 production stub、hardcoded happy path 或 test-only state mutation。

### 11.3 `coding`

- CLI、interactive 和 print modes 可运行；
- tool set 走统一 safety pipeline；
- Windows/Linux 核心 process path 有 system evidence；
- skill registry 与 trusted extension loader 可用；
- extension tool 无法绕过 ToolHost；
- TUI 不直连 core/storage。

### 11.4 `sqlite`

- fresh database、migration、transaction、lease、reopen、recovery 和 artifact paths 通过；
- 与 in-memory repository 共用 conformance；
- 多终端竞争同一 Session 得到明确 conflict，不破坏 durable state；
- crash 不导致 tool replay、queue duplicate 或第二个 terminal。

### 11.5 End-to-end

- fresh checkout 可 install/build/typecheck/test/启动 CLI；
- production TUI 完成一个真实 coding task；
- permission deny、abort、model error、tool failure、context pressure 和 recovery 有可观察证据；
- credential 不入库、不进入 Transcript/Artifact/export；
- 每个已建立 Run 恰好一个 terminal state/event/RunReport；
- 设计者可以从 package boundary、state owner、failure semantics 和测试证据解释并辩护主要决策。

## 12. Implementation Order

实现仍采用 vertical slices，而不是先把四个 packages 各写成空壳：

1. Workspace scaffold + canonical `model` API + scripted model；
2. `Agent` no-tool Run + in-memory Session + Harness terminal contract；
3. OpenAI-compatible provider + minimal coding tools + print mode vertical slice；
4. Tool safety、permission、Windows process + deterministic coding scenario；
5. SQLite Session/Artifact/recovery，替换 production memory adapter；
6. context pipeline + basic compaction + skills；
7. Anthropic/provider profiles + web tools + Linux adapters；
8. extension loader/API + interactive TUI；
9. system/acceptance evidence and hardening。

每一步必须维持相同 public contracts。Memory adapter、scripted model 和 print mode 是同一 production architecture 的早期 Adapter/Mode，不得发展成第二套临时应用流程。
