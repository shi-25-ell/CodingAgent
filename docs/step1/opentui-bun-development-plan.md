# Bun/OpenTUI M5.1–M5.5 补充开发计划

> 依据：[architecture-design.md](./architecture-design.md)、[detailed-design.md](./detailed-design.md) 与 [development-plan.md](./development-plan.md)

## 1. 计划结论

本计划用于 `opentui-bun-m6` 分支，覆盖从当前 M5 后端完成状态到原开发计划 M6 完整退出门槛的全部工作。分支采用：

```text
Bun runtime / package manager / test runner / build orchestrator
  + OpenTUI Core
  + OpenTUI Solid renderer
  + OpenTUI Keymap
```

原设计文档中与 terminal framework 和 JavaScript runtime 绑定的具体实现选择由本计划替代；四包 ownership、`CodingAgent` application seam、Session/Run/ToolHost 不变量、安全要求、extension/plugin 范围和原 M6 产品完整性继续有效。若两者发生冲突：

1. 架构不变量、公开 Interface 和产品行为以原设计基线为准；
2. Bun/OpenTUI 的 runtime、toolchain、renderer 和 terminal implementation 选择以本计划为准；
3. 当前源码只能作为迁移起点，不能降低原 M6 的完成标准。

本计划不是先做临时 TUI、以后重写的安排。M5.1–M5.5 全部工作都进入最终生产架构；M5.5 完成即代表达到原开发计划的 M6 标准，而不是只得到一个可演示的 interactive mode。

## 2. 当前基线与实际缺口

### 2.1 当前真实调用链

当前生产路径为：

```text
Node CLI
  -> production composition
  -> CodingAgent / CodingSession
  -> AgentHarness
  -> Agent
  -> Model + ContextManager + ToolHost
  -> SessionRepository / SQLite
  -> CodingEvent
  -> print mode
```

相关实现位置：

- root [package.json](../../package.json) 使用 npm workspaces、Node scripts、Vitest 和 `node` CLI/runtime；
- [packages/coding/src/cli/entry.ts](../../packages/coding/src/cli/entry.ts) 是唯一 production CLI entry，目前 shebang 为 Node，且只分发 `print` 路径；
- [packages/coding/src/app/coding-agent.ts](../../packages/coding/src/app/coding-agent.ts) 已形成 `CodingAgent`、`CodingSession`、`CodingRunHandle` application seam；
- [packages/agent/src/harness/agent-harness.ts](../../packages/agent/src/harness/agent-harness.ts) 持有 active Run、command dispatch、terminal arbitration 和 `RunReport`；
- [packages/agent/src/session/contracts.ts](../../packages/agent/src/session/contracts.ts) 已定义 durable branch、ledger、queue、context 和 Run report 查询能力；
- [packages/sqlite/src/connection/database.ts](../../packages/sqlite/src/connection/database.ts) 当前通过 `better-sqlite3` 提供 SQLite connection、transaction、WAL 和 migration。

TUI 的正确接入位置是：

```text
Agent / Session durable truth
  -> versioned CodingEvent + application queries
  -> pure projection reducer
  -> immutable TuiViewModel
  -> OpenTUI renderer

OpenTUI input
  -> UiIntent
  -> interactive controller
  -> CodingSession / CodingRunHandle commands
```

Renderer 只能依赖 `TuiViewModel` 和 `UiIntent` callback，不能直接依赖 SQLite、provider transport、ToolHost/tool adapter、`Agent` 或 `AgentHarness`。

### 2.2 Runtime 和 toolchain 缺口

当前项目还不是 Bun 项目：

- root scripts 以 `node`、`npm run` 和 `vitest run` 为入口；
- repository truth 是 `package-lock.json`，尚无固定的 Bun version 和 `bun.lock`；
- CLI、fixture child process、coverage、production scan、package audit 和 release command 都隐含 Node/npm；
- TypeScript 全局类型只面向 Node，尚未审计 Node/Bun API 差异；
- SQLite production/test fixtures 直接 import `better-sqlite3`，存在 Node native binding 与 Bun runtime 的双重兼容面；
- 尚无 Bun clean-install、Windows/Linux runtime、compiled artifact 和 native OpenTUI artifact 证据；
- Bun 自动读取 `.env` 的默认行为可能改变现有 credential/config precedence，必须显式关闭或纳入统一 config loader，不能静默改变安全语义。

完整迁移意味着 Bun 成为唯一受支持的 JavaScript runtime、package manager、script runner、test runner 和 release build host。`tsc -b` 仍可作为 TypeScript compiler 和 declaration/project-reference engine，由 Bun scripts 调用；保留 `tsc` 不等于保留 Node runtime。

### 2.3 Frontend application seam 缺口

当前 `CodingAgent` seam 已经方向正确，但只足以支撑 print mode：

- `CodingEvent` 目前只是 `HarnessEvent | permission_requested`；
- `HarnessEvent` 只公开 `run_started`、笼统 `progress`、`assistant_committed`、`model_failure_committed` 和 `terminal`；
- `Agent` 已产生 `tool_started`、`tool_outcome` 和 `tool_update`，但 Harness 没有把完整 tool lifecycle 作为 frontend semantic events 公开；
- Model stream 在 `collectModelTurn()` 内聚合后才提交完整 assistant message，前端拿不到正文/reasoning 增量；
- `CodingSessionView.timeline` 只投影 user text、assistant text 和 terminal status，丢弃 tool、permission、queue、context/compaction、recovery、diff/evidence 与详细 `RunReport`；
- `SessionHandle` 已有 queue、context manifest/derivation 和 branch 能力，但 `CodingSession` 未提供满足 interactive mode 的受控查询与修改 Interface；
- `ModeDescriptor.id` 目前硬编码为 `print`，尚无真正的 `InteractionMode`/`ModeRegistry`；
- `listModels()` 只返回 composition 中单个 model，缺少 catalog、availability、当前选择和 per-Run immutable config snapshot；
- `CodingEventStream` 为无界 replay array，尚未实现 semantic 不丢失、progress 有界合并、慢消费者和 unsubscribe 生命周期策略；
- approval 只公开 request，缺少 resolved/stale/withdrawn 后的完整 projection 收敛事件；
- recovering 和 compacting 只能从底层 records/phase 间接推断，无法稳定映射到 UI 状态。

因此 M6 前还缺少一个有深度的 frontend projection Module。它负责把 durable state、active Run events 和 transient presentation state 组合成单一 view-model，但不成为第二套 domain state source of truth。

### 2.4 原 M6 仍需完整交付的范围

本计划不会以已有 backend 或 OpenTUI 控件为理由削减以下能力：

- 完整 CLI command、flag、config precedence、diagnostic 和 exit code；
- `print` mode 的 non-interactive/structured result 行为；
- Session/model selector、Transcript、composer、streaming text；
- tool planned/running/settled、approval、queue、diff；
- steering/follow-up、abort、resume、branch；
- context/compaction、recovery、terminal summary/`RunReport`；
- resize、scroll、overlay、完整 keyboard/focus、低颜色和窄终端降级；
- `idle`、`streaming`、`tool planned/running/settled`、`awaiting approval`、`compacting`、`recovering`、`failed`、`aborted`、`limited`、`completed` 全状态；
- trusted local extension/plugin discovery、manifest、registration、冲突/兼容/故障隔离和 sample extension；
- Windows/Linux、慢 renderer、快速输入、provider 断流、terminal restore 和真实 coding task 验收。

## 3. 实施原则

### 3.1 先建立 runtime parity，再移除旧路径

Bun 迁移采用 replacement gate，不长期维护 Node/Bun 双生产路径。每一项旧能力只有在 Bun 路径通过等价 contract/system evidence 后才移除；迁移完成后，Node/npm/Vitest/`better-sqlite3` 不再是 production 或 CI 的隐含 fallback。

### 3.2 Projection 是 frontend 的唯一数据入口

Frontend 数据流固定为：

```text
versioned CodingEvent + CodingSessionSnapshot
  -> reduceProjection(previous, input)
  -> CodingProjection
  -> selectTuiViewModel(projection, localUiState)
  -> OpenTUI
```

其中：

- `CodingProjection` 表达 product/domain 可见事实，可由 durable snapshot + ordered semantic events 重建；
- `localUiState` 只保存 focus、scroll、展开/折叠、overlay、composer buffer 等 presentation state；
- `TuiViewModel` 是 renderer 输入，不向 renderer 暴露 mutable domain objects；
- 所有用户动作先映射为 versioned `UiIntent`，再由 controller 调用 `CodingAgent` seam；
- projection 不执行工具、不决定 permission policy、不持久化 Transcript、不伪造 terminal。

### 3.3 Semantic 与 progress 分流

必须区分：

- semantic events：影响可恢复含义，严格有序、不可丢失、可按 sequence 去重；
- progress events：高频、可替换，只允许按稳定 key 合并最新值；
- local presentation events：只影响当前 terminal，不进入 Session truth。

慢 renderer 可以降低刷新频率，但不能改变 semantic event 的投影结果。terminal 到达后，late progress 不得把 UI 从终态重新推回 running。

### 3.4 使用 OpenTUI 的深能力，不复制 terminal engine

OpenTUI Core 负责 terminal buffer、input、textarea、scrollbox、markdown/code/diff renderables、resize 和 test renderer；OpenTUI Solid 负责声明式 component lifecycle；OpenTUI Keymap 负责 binding 解析和上下文键位。项目自己实现 coding-product orchestration、projection、状态映射、多文件 diff navigation、overlay stack、focus policy、visual tokens 和可测试的 interaction controller。

不在项目内重写通用 terminal renderer、ANSI diff engine 或 textarea editor；也不把 OpenTUI renderable 实例泄漏到 application seam。

### 3.5 测试和 review 成本优先

代码生成速度不作为削减测试的理由。计划优先减少难以 review 的自研 terminal primitives，并把验证拆为：

- 纯 reducer/selector/keymap tests；
- OpenTUI in-memory renderer frame/cursor/style tests；
- pseudo-terminal lifecycle/system tests；
- scripted full-product acceptance；
- 人工 visual/interaction checkpoint。

像素式 snapshot 不能替代语义断言；人工视觉验收也不能替代 terminal restore、race、focus 和 command dispatch 的自动化测试。

### 3.6 人工视觉决策必须显式停靠

Vibe coding 过程中，涉及产品信息层级、主要操作路径或大面积视觉返工的选择不能由实现者静默决定。到达本计划定义的人工决策点时，应：

1. 基于同一 projection fixture 提供 2–3 个可比较候选，优先给出真实 OpenTUI frame/可运行交互，无法运行时才使用等宽 wireframe；
2. 对每个候选说明信息密度、窄终端行为、键盘成本、实现复杂度和后续可扩展性；
3. 给出明确推荐，但由项目 owner 选择；
4. 把选择、被放弃方案和理由记录进 TUI design baseline；
5. 更新对应 visual fixture、keyboard map 和 acceptance scenario 后再继续依赖该决定的实现。

只有会改变整体布局、导航、状态辨识或核心操作习惯的选择需要停靠。单个颜色值、间距微调、边框字符和不会改变语义的局部 polish 可以在已确认的 token system 内持续调整，并在下一个人工 checkpoint 集中 review。

### 3.7 产品命名是独立的人工决策点

项目目前没有正式产品名。文档中的 “Fast”/“Coding Agent”、CLI 的 `coding-agent`、package scope `@coding-agent/*` 和 `FAST_*` environment prefix 都只是工作标识。它们不能在视觉或 command implementation 中被默认为最终品牌。

当实现第一次需要以下任一内容时，vibe coding agent 必须主动提醒项目 owner，并触发 N1 命名决策：

- TUI title、logo/wordmark、welcome screen、help/about、terminal window title；
- CLI executable、shell completion、usage examples 和 command prefix；
- package scope、config filename/directory、application data directory、database default path；
- environment variable prefix、extension manifest namespace、diagnostic/log prefix；
- release artifact name、README 标题或对外截图。

N1 至少确认 display name 和 CLI executable，并明确 package/config/env/extension namespace 是同步采用产品名、保持技术标识，还是分阶段迁移。命名确定前可以继续实现与名称无关的 projection、layout、components 和 tests；必须使用集中式 working-name token/fixture，不能把工作标识散落到 renderer 和 command handlers。命名确认后进行一次可审查的原子替换，并为已有 config/data path 定义兼容或迁移策略。

## 4. 依赖与执行顺序

```text
M5.1 Bun runtime、toolchain 与 SQLite 迁移
  -> M5.2 frontend events、projection 与 application seam 完整化
      -> M5.3 TUI design baseline 与 OpenTUI production foundation
          -> M5.4 完整 CLI、interactive TUI 与 extension/plugin
              -> M5.5 M6 收敛、跨平台加固与验收
```

M5.2 的纯 contracts/reducer 工作可在 M5.1 后半段开始，但不能让 Bun 和 Node 形成两套 product composition。M5.3 的设计活动可以与 M5.2 的事件实现交错，但 design baseline 必须基于已经确认的 event/projection contract。M5.4 只有在 M5.2、M5.3 gate 通过后才进入完整 screen implementation。M5.5 负责证明原 M6 全部成立，不提前吸收原开发计划 M7 的跨语言 acceptance、release freeze 或交付包装范围。

## 5. 里程碑

### M5.1：Bun runtime、toolchain 与 SQLite 完整迁移

**目标**：在不改变 Agent/Session/ToolHost 语义的前提下，把 repository 的唯一受支持 runtime、依赖管理、测试执行、CLI 启动和 SQLite driver 迁移到 Bun，并建立跨平台可重复证据。

**实施内容**：

#### Runtime 与依赖管理

- 固定受支持 Bun version，写入 repository/toolchain metadata，并在 CLI startup diagnostic 中报告实际 version；
- 在 CLI executable、package metadata、config/env prefix 或 release artifact name 首次需要固化前触发 N1；命名未决时只使用集中式 working identifiers；
- 以 `bun.lock` 作为唯一 lockfile，保留 workspace package topology 和 package exports；
- 将 root/package scripts、clean、build、typecheck、lint、coverage、boundary check、production scan、dependency audit、fixture runner 和 deterministic CLI runner 全部改为 `bun run`/Bun API；
- 将 production CLI shebang、spawn command、process detection 和安装后 executable 行为改为 Bun；
- 保留 `tsc -b` 负责 project references、declaration emit 和类型检查，避免把 runtime 迁移与 compiler semantics 迁移混为一谈；
- 明确 Bun `.env` 策略：默认不自动导入任意 workspace `.env`，credential 只通过已有 credential/config source 进入；config precedence 与 redaction 继续由 product composition 控制；
- 审计 `process`、`fs`、`path`、`child_process`、Web APIs、signal、timer、ESM resolution 和 package condition，建立 Node API 到 Bun API 的兼容清单；
- 更新 `engines`、`packageManager`、developer commands、CI cache key 和 clean-clone instructions，不保留假装受支持但未测试的 Node fallback。

#### Test runner 与 coverage

- 将 Vitest suites 迁移到 `bun:test`，保留现有 unit/contract/integration/system/acceptance 分层、test name 和 fixture 意图；
- 为 fake timers、module mocking、coverage exclude、serial/native-resource tests 和 child process fixtures 建立明确 Bun 等价实现；
- 迁移过程中旧 runner 只作为 parity oracle，所有测试在 Bun 下通过、数量/分类/coverage gate 对齐后再删除旧配置和依赖；
- 继续要求新增 production code line coverage 不低于 85%、branch coverage 不低于 80%，并保留 malformed input、race、abort、crash、recovery 等行为证据；
- 禁止通过删除、跳过、放宽 assertion 或把 native/system tests 降为 mock 来取得 runner parity。

#### SQLite driver

- 在 `sqlite` package 内建立窄且私有的 `SqliteConnection`/statement Adapter，覆盖真正需要的 prepare/run/get/all/exec/transaction/pragma/close 能力，不把 driver type 暴露到 `SessionRepository`；
- 先以当前 driver 和 `bun:sqlite` driver 运行同一套低层 connection/migration tests，确认 parameter binding、integer/JSON/blob、error code、transaction nesting、busy behavior 和 close semantics；
- 将 production 切换到 `bun:sqlite`，保持 WAL、`foreign_keys=ON`、`synchronous=FULL`、bounded busy timeout、`BEGIN IMMEDIATE`/`BEGIN EXCLUSIVE`、user version migration 和 rollback 行为；
- 改写所有直接 import `better-sqlite3` 的 integration/system fixture，使测试仍能制造 write lock、未来 schema version、损坏/迁移和 crash 场景；
- 重跑 SessionRepository conformance、lease fencing、artifact atomicity、reopen 和 recovery suites；只有全部 parity 后才删除 `better-sqlite3` 及其 types；
- driver Adapter 只留在 `sqlite` package 内。若迁移完成后只有一个真实 driver，继续保留它必须能显著隐藏 Bun driver 的复杂 API；否则合并回 connection Module，避免永久浅包装。

#### Build 与 distribution

- 建立 source execution 与 release artifact 两条受支持路径，两者必须经过相同 production composition；
- 为 OpenTUI 后续 native artifact 预留明确的 target matrix，但 M5.1 不提前引入空 TUI package；
- 验证 Bun executable、bundle/external policy、source map、license 和 dynamic extension loading 的相互约束；extension 若要求运行时加载源码/包，不得被 single-file compile 静默破坏；
- Windows 和 Linux 分别从 clean checkout 执行 install、build、typecheck、test、CLI deterministic smoke 和 SQLite recovery smoke。

**退出门槛**：

- repository 只需 Bun 即可 clean install、build、typecheck、lint、执行全部现有 tests 和启动 production CLI；
- `bun.lock` 是唯一 dependency truth，CI 和本地不会同时维护两个 lockfile；
- production/source/test scripts 不再调用 `node`、`npm` 或 Vitest；
- `bun:sqlite` 通过与原实现等价的 repository、migration、lease、artifact 和 recovery evidence；
- credential/config precedence 未因 `.env` 自动加载发生变化，secret scan 无新增暴露；
- Windows/Linux 的 Bun 版本、native architecture、失败诊断和 clean-clone 结果可复现；
- M0–M5 已有行为没有因 runtime 迁移退化，所有 established Run 仍恰有一个 terminal event 和一份一致 `RunReport`。

### M5.2：Frontend events、projection 与 application seam 完整化

**目标**：把现有 backend durable truth 转换为完整、稳定、可重放且与 renderer 无关的 frontend contract，使 print、interactive 和未来 mode 共享同一条 application path。

**实施内容**：

#### Versioned frontend event protocol

- 定义有明确 `runId`、stable sequence/correlation key 和 version 的 `CodingSemanticEvent`、`CodingProgressEvent`；
- semantic event 至少覆盖 Run started、user accepted、assistant part committed、tool planned/started/settled、permission requested/resolved、queue changed/delivered、context prepared、compaction completed/failed、recovery observed、terminal committed；
- progress event 至少覆盖 phase、model attempt、assistant text/reasoning delta、tool update、compaction progress；
- tool planned event 必须携带经过 validation/redaction 后可展示的 immutable plan summary，不能把 ToolHost mutable plan 或 secret-bearing raw arguments 暴露给 UI；
- approval event 必须包含 stable approval ID、关联 Run/tool、risk/plan fingerprint、可用 decision 和 resolved/stale 状态，renderer 不拥有 permission policy；
- assistant delta 由 Model accumulator/Agent execution path 以 provider-neutral 类型公开，同时保留“只有完整 Model Turn 才能 durable commit”的不变量；delta 是 progress，committed assistant message 是 semantic truth；
- Harness 在 durable commit barrier 后发布 tool/assistant semantic events；tool progress 可以高频发布，但 settlement 只能来自 canonical `ToolOutcome`；
- compacting/recovering 必须由 owning Module 的真实状态/record 产生，禁止 frontend 用 timer 或文字内容猜测。

#### Stream delivery policy

- semantic events 使用 per-Run monotonic sequence，支持重复订阅、去重和 reconnect/replay；
- 为 progress events 定义稳定 coalescing key，例如 assistant stream part、tool call、compaction operation；
- 实现有界 pending progress、非丢失 semantic queue、consumer disposal 和 terminal close；
- 定义 snapshot + live event 的接合规则，避免 inspect 完成到 subscribe 建立之间丢事件；
- 定义 terminal arbitration：terminal semantic event 一旦投影，所有 late progress 被忽略或只进入 diagnostic，不改变终态；
- 慢消费者测试不依赖 sleep，使用 controllable stream/barrier 验证内存上限和最终投影一致性。

#### Projection Module

- 在 `coding` 内建立 framework-independent projection Module，不引入 OpenTUI import；
- 定义 `CodingProjection`，包含 Session/branch/run identity、Transcript blocks、assistant stream、tool groups、approval、queues、context/compaction、recovery、usage/evidence、terminal report 和 diagnostic；
- 定义纯 `reduceProjection()`，同时接受 initial durable snapshot 与 ordered events；
- 建立 selector，把 domain projection 转为稳定 `TuiViewModel`，但不包含 renderer object、ANSI string 或 terminal dimensions；
- tool、permission、queue 和 terminal 使用 stable IDs，支持多 tool activity、展开状态和事件去重，不以 array index 作为 identity；
- 重新打开 Session 时，从 branch records、RunReport、queue/context metadata 重建与 live run 最终一致的 projection；transient delta 在 committed message 到达后被 canonical content 替换；
- diff view 只消费 workspace/tool evidence 提供的 redacted diff model；renderer 不能直接运行 Git 或读取文件；
- context view 展示 budget、selected/omitted sources、compaction checkpoint/provenance 和失败/降级摘要，不展示 raw credential 或内部 model transport。

#### Application queries、commands 与 modes

- 深化 `CodingSession`，提供 session/branch snapshot、run history/report、queue list/update/cancel、context manifest/derivation、diff/evidence 和 recovery diagnostic 的受控查询；
- 提供 select/fork/resume、start run、steer/follow-up、abort、permission response、queue edit 等 application command；所有 command 带 command ID/revision 并返回 typed ack/conflict；
- 完成 model catalog/availability/selection 和 immutable `RunConfigSnapshot`，Run 开始后 model、permission mode、budgets、tools、extensions、skills 和 policy version 不受 UI 临时变化影响；
- 实现真正的 `InteractionMode` 与 `ModeRegistry`，`print` 和 `interactive` 只接收同一个 `ModeContext`/`CodingAgent`，CLI 负责解析与分发；
- 强化 print mode 使其也消费 projection/terminal report，而不是绕过新 event path；
- 只在 domain/application capability 确实缺失时深化 owning Module 的 Interface，不为布局、颜色、focus 或 widget 便利修改 `Agent`、`AgentHarness`、Session contract。

**测试内容**：

- reducer table tests 覆盖所有合法状态、重复/迟到/乱序进度、semantic sequence gap 和 terminal races；
- snapshot + replay 与 live projection 的结构化结果完全一致；
- concurrent tool calls、approval 与 abort 竞态、queue revision conflict、compaction failure 和 recovery 均有 deterministic tests；
- mode contract 确认 print/interactive 共享 Session、RunReport、error mapping 和 lifecycle；
- package boundary tests 禁止 projection import SQLite、provider transport、ToolHost implementation 或 OpenTUI。

**退出门槛**：

- 一个 scripted frontend 只用 `CodingAgent`/`CodingSession`/`CodingRunHandle` 和 projection public API 即可完成原 M6 所有信息读取与 command dispatch；
- `CodingEvent -> projection -> TuiViewModel` 为单向、可重放、framework-independent 数据流；
- tool、queue、context/compaction、approval、recovery、streaming 和 terminal 均有完整事件与 projection 表达；
- semantic event 不丢失，progress 合并有界，慢 consumer 最终状态与快 consumer 一致；
- renderer 所需信息不要求直连 SQLite/provider/ToolHost，也不复制 Agent/Session state machine；
- print mode 在新 seam 上保持原有行为，并能输出稳定 structured terminal result。

### M5.3：TUI design baseline 与 OpenTUI production foundation

**目标**：先确认最终 M6 的信息架构和交互规则，再把 OpenTUI 接到 production projection；本阶段产物直接作为最终 TUI foundation，不建立 throwaway renderer。

**实施内容**：

#### Design baseline

- 完成 information architecture，明确 session/model context、Transcript、tool activity、approval、queue、composer、status、diff 和 `RunReport` 的层级；
- 为纯对话、coding task、tool approval、查看/切换 diff、steering、follow-up、abort、resume 和 branch selection 绘制 end-to-end interaction flow；
- 建立完整状态矩阵，定义每个状态的主信息、可用 command、focus target、status token、恢复/终止条件；
- 建立三档 responsive layout：窄终端、常规终端、宽终端；覆盖低高度、长 Transcript、大 tool output、多 tool activity、长路径和 resize；
- 固定 visual tokens：spacing、border、foreground/background、muted、accent、success/warning/error、streaming/running、focus、disabled、selection 和 diff palette；
- 固定 keyboard map、command scope、focus order、overlay priority、Escape/abort 的防误触规则、screen reader/低颜色/无 Unicode 降级；
- 建立 semantic event -> projection field -> visual region -> interaction affordance 的可追踪 mapping；
- 形成经人工确认的 design baseline。后续改变核心导航、密度、keymap 或状态表达必须更新 baseline 和验收用例。

#### 人工视觉决策点

以下决策是 M5.3/M5.4 内部的 blocking checkpoints，不增加新的开发阶段，也不要求按日历安排。Vibe coding agent 到点后应主动展示候选并等待项目 owner 选择：

| ID | 决策主题 | 必须比较的内容 | 决策产物 | 最迟确认点 |
| --- | --- | --- | --- | --- |
| N1 | 产品、CLI 与 namespace 命名 | display name、binary、package/config/env/extension namespace 的一致或分离方案；已有工作标识的迁移范围 | naming record + centralized identifiers + migration decision | 首次固化 CLI identity 或 visual wordmark 前 |
| V1 | 整体信息架构与密度 | Transcript-first、固定 side panel、按需 contextual panel；三档宽度的降级 | layout wireframes + region priority | root layout 实现前 |
| V2 | 视觉方向与 tokens | 明暗背景继承、边框强度、状态色、选中/focus、低颜色 fallback | token sheet + 关键状态 frames | component theme 固定前 |
| V3 | tool activity 呈现 | inline cards、聚合 activity region、混合模式；并行 tool、长输出和 evidence 展开 | tool state frames + expand rules | tool components 批量实现前 |
| V4 | composer、queue 与 steering | 单一 composer mode、显式 queue mode、快捷动作；运行中/approval/terminal 的输入行为 | composer flow + queue interaction demo | editor/controller key behavior 固定前 |
| V5 | approval 与危险操作 | modal/inline blocking、风险信息密度、默认 focus、allow/deny/abort 防误触 | approval flow + key/focus spec | approval controller 实现前 |
| V6 | diff 导航 | unified/split 自动选择、文件树/文件列表、hunk navigation、窄终端 fallback | 多文件 diff demo + width matrix | diff viewer 完整实现前 |
| V7 | keyboard 与可发现性 | chord/leader/direct bindings、help/which-key、overlay priority、与 textarea 冲突 | executable keymap + conflict report | keymap freeze 前 |
| V8 | 完整任务的视觉收口 | idle 到 terminal 全 journey、resize、失败/recovery、长 session | recorded/manual review notes + baseline revisions | M5.5 final gate 前 |

如果项目 owner 正在持续跟进，可以连续呈现多个彼此独立的候选；但存在依赖关系的决定仍按 N1（首次出现 naming dependency 时）以及 V1 -> V2 -> V3/V4/V5 -> V6/V7 -> V8 收敛。未经确认不得以“先实现再说”为由固化会造成结构性返工的方案。

#### OpenTUI foundation

- 在 `packages/coding/src/modes/interactive/` 建立最终 interactive mode，配置 OpenTUI Solid JSX transform/preload 和 exact dependency locking；
- 以 OpenTUI Core renderer 管理 alternate screen、raw mode、cursor、mouse/paste、terminal capabilities、resize、startup/shutdown；
- 建立 `InteractiveController`，负责订阅 projection、处理 `UiIntent`、协调 overlay/focus/local state；controller 不拥有 durable agent state；
- 建立 root layout、theme/token resolver、focus manager、overlay stack、command/keymap registry、toast/diagnostic region 和 error surface；
- 使用 OpenTUI textarea/input 作为 composer 基础，定义 multi-line edit、submit、newline、history、paste、IME/Unicode、large paste 和 disabled behavior；
- 使用 scrollbox 建立 Transcript viewport，定义 follow-tail、用户滚动锁定、新内容提示、跳转当前 activity 和 resize 后 anchor 保持；
- 建立 markdown/code/diff Adapter，把 projection 的结构化 content 转给 OpenTUI renderables；多文件 diff、文件树/切换、折叠、选择和 evidence 关联由 product component 负责；
- 建立 fatal error/normal exit/SIGINT/SIGTERM/uncaught exception 的 terminal restore 路径，恢复失败也必须输出最小可读 diagnostic。

#### Test foundation

- 使用 OpenTUI in-memory test renderer 验证 frame text、styles、cursor、focus、selection、scroll position 和 resize；
- component tests 固定 terminal width/height、clock 和 input events，不从真实数据库或 provider 构造 UI；
- 建立 golden fixtures，但只对稳定 visual regions 使用 snapshot；command dispatch、focus/state 使用显式 semantic assertion；
- 建立 pseudo-terminal harness，覆盖 raw mode、alternate screen、Ctrl-C、process signal、异常退出、redirected stdin/stdout 和 terminal restore；
- 将 OpenTUI native artifact 的 OS/architecture load 纳入 smoke，而不是到 release 才发现 packaging 缺失。

**退出门槛**：

- design baseline 覆盖原 M6 全部功能和全部状态，并已人工确认；
- N1 和 V1–V7 的选择与理由已经记录，未决视觉问题只允许是 token 级 polish，不得影响命名体系、信息架构或 interaction flow；
- production interactive mode 能从真实 `CodingSession` projection 渲染 session、Transcript、composer 和 active Run skeleton；
- renderer 只接收 `TuiViewModel`，所有用户输入只发出 `UiIntent`；
- resize、focus、scroll、composer 和 terminal restore 的 foundation tests 通过；
- OpenTUI import 只存在于 interactive presentation Module，不泄漏进 agent/model/sqlite 或 projection；
- 后续 screen/component 可以在该 foundation 上增量完成，不需要替换 state ownership、event protocol 或 renderer lifecycle。

### M5.4：完整 CLI、interactive TUI 与 extension/plugin system

**目标**：在 M5.1–M5.3 的最终 runtime、projection 和 interaction foundation 上，实现原 M6 的全部产品交互与 trusted local extension/plugin 能力。

**实施内容**：

#### CLI 与 mode composition

- 完成架构文档规定的 CLI commands、flags、help、version、diagnostics、config precedence 和 exit codes；
- 无参数启动 interactive mode，`--print` 启动 non-interactive mode，Session/model/permission/budget/tool/extension/skill overrides 进入统一 validated `RunConfigSnapshot`；
- 完成 Session list/new/resume/branch、models list、skills list、extensions list/diagnose 等 command surface；
- TTY、redirected stdin/stdout、unsupported terminal 和 non-interactive environment 有明确 mode selection/typed failure，不挂起等待输入；
- print mode 支持 stable human output 与 versioned structured result，stdout/stderr/exit code 可供脚本可靠使用。

#### Interactive TUI 完整功能

- Session/model selector：显示 availability/provenance、当前 Session/workspace/branch/model，支持新建、打开、resume、branch select/fork；
- Transcript：渲染 user/assistant/markdown/code、streaming text/reasoning indicator、tool group、permission、compaction/recovery 和 terminal records；
- Composer：完整 multi-line editor、submit/history/paste、steering/follow-up mode、queue 状态、disabled/recovering/terminal behavior；
- Tool activity：展示 planned、running、progress、settled、elapsed、risk、outcome、artifact/evidence，支持多个 tool calls 和长输出折叠；
- Approval overlay：展示 action、risk、redacted plan、effect scope 与 fingerprint，支持 allow once/deny、stale response 和 abort；overlay 打开时 key scope/focus 不泄漏到底层 composer；
- Queue：展示 steering/follow-up queued/draft/delivered/cancelled，支持 revision-aware edit/cancel 和 conflict feedback；
- Diff：支持多文件列表、created/modified/deleted、unified/split capability-aware rendering、hunk navigation、长行/宽字符、折叠和 tool/Run evidence 关联；
- Context/compaction：展示 token budget、selected/omitted sources、checkpoint、compacting/retry/failure/recovery，不暴露 raw context secrets；
- Run control：steer、follow-up、abort、resume、branch、view previous `RunReport`；abort 与 Escape/close dialog 分离，避免误触；
- Status/terminal summary：展示 phase、model/attempt、usage、tool/permission counts、changed files、commands、unfinished work、error 和 completed/failed/aborted/limited；
- Responsive layout：窄终端使用可切换单 pane，常规终端以 Transcript/composer 为主并使用 overlays，宽终端增加 contextual side panel；resize 不丢 composer、focus、scroll anchor 或 active approval；
- Keyboard/focus：实现全局/route/overlay/composer 分层 binding、which-key/help、冲突诊断、tab order、mouse optional behavior 和低颜色/ASCII fallback；
- Streaming/render scheduling：批量处理同一 frame 的 progress，semantic event 立即进入 reducer，renderer frame rate 有上限但 terminal state 不延迟丢失。

#### Extension/plugin system

- 实现 versioned manifest、API compatibility、显式 enable、built-in/user/project/explicit source 和 deterministic load order；
- 实现 discovery、schema validation、registration transaction、startup immutable snapshot、disable/unload 后无残留注册和 redacted diagnostic；
- 支持注册 tool、slash/CLI command、interaction mode、skill source、context source、model provider/profile、credential source 和 observation hook；
- 对 duplicate ID、command/key conflict、version/capability mismatch、load failure、hook timeout/exception 给出 typed diagnostic，不静默覆盖；
- extension tool 无条件进入相同 ToolRegistry/ToolHost validation、hard guard、approval、execution、settlement 和 evidence path；
- extension 不能直接 append Session records、发布 terminal event、构造 `RunReport`、读取 UI local state 或取得 SQLite/provider transport mutable handle；
- mode/UI extension 只使用明确 registration/slot contract；第一版仍为 trusted local code，不宣称 sandbox；
- 提供至少一个独立 sample extension，同时贡献一个 tool 和一个 skill source，无需修改 agent/provider/TUI internals 即可加载、禁用和诊断。

**自动化测试**：

- 每个 view state 都有 projection fixture + renderer assertion；
- keymap 覆盖 global/route/overlay/composer precedence、冲突和 focus order；
- approval、queue edit、abort、session resume、branch select/fork、model select、diff navigation 均验证实际 application command，而非只验证 callback 被调用；
- 快速输入、large paste、slow renderer、多个 tool progress、streaming + resize、permission + abort 和 provider disconnect 有 deterministic/system tests；
- extension manifest、load order、registration rollback、snapshot isolation、fault isolation、ToolHost safety 和 sample extension 有 contract/integration tests。

**退出门槛**：

- 用户可从 CLI 新建/打开 Session，选择 model，进行纯对话和 coding task，查看 tool/diff/context，处理 approval，发送 steering/follow-up，abort，resume/fork branch，并得到一致 `RunReport`；
- 全部规定状态在 design baseline 中有唯一、可理解且可操作的视觉表达；
- print 与 interactive 通过同一套 mode behavior contract，且共享 production composition；
- TUI close/reopen 不改变 durable truth，不重复 tool effect、queue delivery 或 terminal；
- sample extension 证明全部必要 extension seams 可用，plugin 无法绕过 ToolHost 或 terminal arbitration；
- 没有 TODO、stub、fake production path、hard-coded happy path 或“稍后补齐”的核心 M6 component。

### M5.5：M6 收敛、跨平台加固与验收

**目标**：证明 Bun/OpenTUI 方案在真实 terminal、故障、恢复和扩展条件下达到原 M6 退出门槛，并清理迁移期兼容层。

**实施内容**：

#### Contract 与 race matrix

- 对 `InteractionMode`、projection/event stream、keymap/focus、extension host 和 SQLite driver 执行完整 contract suites；
- 验证 snapshot/live race、duplicate semantic、sequence gap、late progress、terminal/abort、approval/settlement、queue revision、resize/render 和 close/dispose races；
- 使用 manual clock、barrier、controllable model/tool/approval stream，禁止用长 sleep 猜测时序；
- 确认所有已经建立的 Run 在 completed/failed/aborted/limited/recovered interruption 下都恰有一个 terminal event 和一份 durable `RunReport`。

#### Terminal 与平台 matrix

- Windows PowerShell/Windows Terminal 和 Linux Bash 下验证启动、输入、paste、Unicode/宽字符、颜色能力、resize、scroll、signal、process cleanup 和 terminal restore；
- 覆盖 40/80/120+ columns、低高度、redirected stdio、非 TTY、无颜色、无 Unicode/受限 terminal；
- 验证 OpenTUI native artifact 对 release targets 可加载，clean clone 不依赖 developer machine cache；
- 验证 Bun source run 与 release artifact 在 config、extension discovery、SQLite path、session reopen 和 exit code 上一致；
- 记录 startup、large transcript reopen、large diff、fast streaming、slow renderer 和 abort convergence 的性能基线，并处理无界内存/明显卡顿。

#### Fault injection

- provider 断流、malformed delta、model retry exhaustion；
- approval deny/stale、abort during approval、abort during child process；
- tool timeout、tool progress flood、unknown tool effect；
- SQLite busy/lease loss、crash between assistant commit and tool settlement、artifact write/rename failure；
- compaction failure、missing artifact/context source、recovery reopening；
- extension manifest invalid、duplicate registration、load/hook exception；
- renderer exception、terminal resize storm、stdin close、SIGINT/SIGTERM；
- 每种故障都验证 user-visible diagnostic、terminal restore、durable state 和可继续/不可继续条件。

#### Product acceptance 与 review

- 使用 deterministic production composition 完成全功能 scripted TUI journey；
- 使用至少一个 production provider + production TUI 完成真实小型 coding task：读取代码、修改、运行验证、查看 diff、继续对话并核对 `RunReport`；
- 外部 verifier 核对 changed files、commands、tool outcomes、artifacts、diff 和 final report，不只相信 UI 文本；
- 执行 dependency audit、secret scan、package boundary audit、production-stub scan 和公开术语检查；
- 对 design baseline 执行人工 visual/interaction review，检查信息层级、密度、状态辨识、focus、键位可发现性和真实任务操作负担；
- 完成 V8 全 journey review；发现结构性问题时回到相应 N1/V1–V7 决策和 fixtures 修正，不能用增加提示文字掩盖错误的命名或信息架构；
- 删除已通过 parity 的 Node/npm/Vitest/旧 SQLite driver 配置、迁移 shim 和临时 feature flag；文档、CI 和 examples 只保留受支持的 Bun/OpenTUI 路径。

**退出门槛**：

- 原 M6A design baseline 和 M6B implementation 条目全部完成，无被降级或延期的核心功能；
- approval、abort、resize、快速输入、慢 renderer、provider 断流和 Session reopen 均有自动化证据；
- Windows/Linux clean clone 可以 install/build/typecheck/test/start，production TUI 能完成真实 coding task；
- 用户能新建 Session、纯对话、执行 coding task、查看 diff、继续 Session 并得到一致 `RunReport`；
- extension load order/collision/snapshot/fault semantics deterministic，sample extension 不改 core 即可工作；
- UI 到 SQLite、provider transport、ToolHost/tool adapter 的越层依赖扫描为零；
- migration 兼容层全部移除，不存在双 runtime、双 lockfile、双 test runner 或隐藏 Node fallback；
- 所有 M6 blocker、critical 和 high severity issue 清零。

完成 M5.5 后，原计划 M6 视为完成。原 M7 的跨语言六组 acceptance、完整 release fault matrix、系统级性能加固与更广泛人工 QA 仍按原计划执行，不用 M5.5 的 M6 验收代替。

## 6. Frontend contract 目标形态

### 6.1 Projection ownership

| State | 唯一 owner | Projection 来源 | TUI 可拥有的 local state |
| --- | --- | --- | --- |
| Session/branch/current Run | Session + Harness | snapshot + semantic events | selector 是否展开 |
| Transcript/message/tool outcome | Session ledger | snapshot/replay | block 展开、scroll anchor |
| assistant streaming | active Model/Agent progress | coalesced progress + committed replacement | follow-tail 开关 |
| permission | ToolHost/approval bridge | requested/resolved semantic events | overlay focus |
| steering/follow-up queue | Session queue | revisioned snapshot/events | queue editor draft buffer |
| context/compaction | ContextManager + Session | manifest/derivation/events | detail 展开 |
| terminal/RunReport | Harness + Session | terminal semantic + durable report | summary tab |
| composer/focus/overlay | interactive mode | local reducer | 全部由 TUI 持有 |

### 6.2 Semantic event 到视觉区域的最低映射

| Event/state | Projection | Visual region |
| --- | --- | --- |
| Run started / phase | active run + status | header/status line |
| assistant delta/commit | stream block -> transcript message | Transcript |
| tool planned/started/update/outcome | tool activity group | Transcript tool card + status |
| permission requested/resolved | active approval | modal overlay + tool card |
| queue changed/delivered | revisioned queue | queue panel + composer badge |
| context prepared/compaction | context status/checkpoint | contextual panel + status |
| recovery observed | recovery state/diagnostic | blocking banner or recovery view |
| terminal committed | immutable `RunReport` | terminal summary + history record |

该表是最低 mapping，不限制设计 baseline 增加更好的组合视图；任何新增 visual region 仍必须从 projection 获得数据。

## 7. 测试与证据矩阵

| 层级 | 主要对象 | 关键证据 | Gate |
| --- | --- | --- | --- |
| Unit | event reducer、selectors、layout rules、keymap、tokens | 全状态与非法 transition | 每次提交 |
| Contract | SQLite driver、InteractionMode、extension registry、frontend stream | adapter parity、version/ordering/cleanup | 每个 Module 合并前 |
| Component | OpenTUI views、composer、overlay、diff、scroll | frame/style/cursor/focus/intent | M5.3 起持续运行 |
| Integration | CodingAgent + projection + controller | command ack、snapshot/live、RunReport | M5.2 起持续运行 |
| System | Bun、SQLite、OpenTUI、PTY、filesystem/process | terminal lifecycle、native load、recovery | M5.1 起持续运行 |
| Acceptance | production CLI/TUI + real/deterministic agent | 完整 user journey、diff、continue | M5.4/M5.5 |
| Human checkpoint | design baseline + real terminal | hierarchy、density、readability、operation burden | M5.3、M5.5 |

测试额外遵守：

- TUI fixtures 从 public projection types 构造，不从 SQLite rows 或 private ToolHost objects 构造；
- renderer snapshot 只验证稳定区域，动态 ID/time 通过 structured assertions 验证；
- Unicode、combining marks、emoji、East Asian width、ANSI-like user content 和超长 unbroken line 必须进入 rendering fixtures；
- 每个 keyboard command 验证作用域、focus precondition、intent 和 application ack，不只检查按键字符串；
- terminal tests 运行后断言 raw mode、alternate screen、cursor 和 signal handler 已恢复；
- coverage 之外必须保留 concurrency、crash、slow consumer 和 malformed input evidence。

## 8. Definition of Done

一个 M5.1–M5.5 工作项只有同时满足以下条件才算完成：

1. 通过最高层 public Interface 可达，并已接入唯一 production composition；
2. 不依赖 Node/npm/Vitest/旧 SQLite driver fallback 才能通过；
3. projection 输入、状态 ownership、command ack 和 failure behavior 明确；
4. renderer 只消费 immutable view-model，不能从 infrastructure 补查数据；
5. happy path、invalid input、dependency failure、abort、timeout、late event、dispose/reopen 语义明确；
6. unit/contract 测试完成，并按风险具有 component/integration/system/PTY evidence；
7. Windows/Linux 的适用行为均有证据，不把单平台成功推断为兼容；
8. diagnostic、exit code、redaction 和 terminal restore 可供用户验证；
9. 没有生产 TODO、stub、test fake、silent fallback 或只服务演示的分支；
10. 文档、design baseline、tests 和实际 production behavior 一致。

## 9. 关键风险与处理顺序

| 风险 | 早期信号 | 处理方式 |
| --- | --- | --- |
| Bun 迁移看似完成但仍依赖 Node | scripts/fixtures/release command 中残留 `node`/npm | M5.1 建立全仓扫描和 clean-clone gate，最终只保留一个 runtime |
| test runner 迁移降低证据 | skipped tests、mock 代替 native/system test | 旧 runner 作为短期 parity oracle，数量/coverage/行为全部对齐后才移除 |
| SQLite driver 语义漂移 | busy、transaction、integer 或 error mapping 不一致 | 共享 driver/repository conformance，加 migration/lease/crash system tests |
| TUI 变成第二套 state machine | component 内根据事件自行推断 Run/tool terminal | M5.2 先建立 pure projection，component 只消费 view-model |
| streaming 与 durable truth 冲突 | delta 被写进 Transcript 或 commit 后重复文本 | delta 仅作 progress，committed message 以 semantic event 原子替换 |
| 慢 renderer 导致丢状态或内存增长 | 无界 replay array、每个 delta 都触发 render | semantic non-lossy + keyed progress coalescing + bounded frame scheduling |
| OpenTUI 控件被误当成完整产品 | 有 textarea/diff 但没有 queue/focus/multi-file orchestration | M5.3/M5.4 明确 product controller、overlay、layout 和 state matrix ownership |
| terminal exit 污染 shell | exception/signal 后 raw mode 或 alternate screen 未恢复 | 单一 lifecycle owner + finally restore + PTY fault tests |
| extension 破坏安全/状态 | plugin 直接操作 Session/ToolHost implementation | capability-limited registration，tool 统一走 ToolHost，registry per-Run snapshot |
| 视觉调整成本失控 | 无 tokens、无宽度规则、snapshot 大面积抖动 | M5.3 先确认 design baseline；结构化 visual fixtures 与人工 checkpoint 并用 |

风险消除顺序固定为 runtime parity、frontend event/projection correctness、terminal lifecycle、input/focus、完整 interaction、visual polish。视觉工作可以提前探索，但不能反向要求 core 把 presentation state 持久化。

## 10. 原 M6 完成映射

| 原 M6 要求 | 本计划落点 |
| --- | --- |
| TUI information architecture、flow、state matrix、wireframe、tokens、keyboard map | M5.3 design baseline |
| semantic event -> projection -> visual mapping | M5.2 + M5.3 |
| 完整 CLI 和 print mode | M5.2 application modes + M5.4 CLI |
| Session/model/Transcript/composer/streaming/tool/approval/queue/diff | M5.4 interactive TUI |
| steering/follow-up/abort/resume/branch | M5.2 commands + M5.4 interactions |
| context/compaction/recovery/RunReport | M5.2 projection + M5.4 views |
| resize、keyboard、focus、terminal lifecycle | M5.3 foundation + M5.5 platform matrix |
| semantic non-lossy/progress coalescing | M5.2 stream policy |
| extension/plugin + sample extension | M5.4 |
| approval/abort/resize/fast input/slow renderer/provider disconnect tests | M5.4 + M5.5 |
| production provider + production TUI coding task | M5.5 |
| 无 UI 越层依赖 | M5.2 package gate + M5.5 audit |

只有表中每项均有 implementation、automated evidence 和需要的人工确认，M5.5 才能关闭。不得以 OpenTUI 已提供某个 primitive、Bun 能运行某个 Node package、或手工演示一次成功为完成证据。
