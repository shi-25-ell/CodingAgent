# Dex Code v1 开发计划

> 依据：[architecture-design.md](./architecture-design.md)、[detailed-design.md](./detailed-design.md) 与项目交付约束
> Runtime/TUI 更新：[opentui-bun-development-plan.md](./opentui-bun-development-plan.md) 已确定 Bun + OpenTUI，并以 M5.1–M5.5 完成原 M6。N1 已确认品牌为 “Dex Code”、CLI 为 `dex`；`coding-agent` 和 `@coding-agent/*` 保持技术命名。

## 1. 计划结论

Dex Code v1 按新的四包架构重新建设：

```text
packages/
├── model/
├── agent/
├── coding/
└── sqlite/
```

现有代码不作为计划基线，也不计入任何里程碑完成度。实现顺序不是“先铺满目录和接口、最后再连起来”，而是以可运行的纵向切片逐步加深四个 Module：每个里程碑都必须形成真实调用链、明确失败语义和自动化证据。

首版的目标不是演示模型会调用几个工具，而是交付一个具备以下性质的 coding agent：

- 至少一条真实 provider 链路可用，同时完整实现两类 provider adapter；
- Agent loop、tool execution、context、session、CLI/TUI 形成同一条生产路径；
- SQLite 持久化、writer lease、crash recovery 和 artifact 管理具备确定语义；
- 具有基础但完整的 context compaction，而不是截断消息假装压缩；
- skill 与 extension/plugin system 有真实加载、注册、冲突处理和安全边界；
- 关键状态机、错误路径、取消路径和恢复路径均有测试；
- 不在 production composition 中使用 fake、stub、TODO 分支或 hard-coded happy path。

## 2. 首版范围

### 2.1 不可削减的核心能力

以下能力共同构成 Dex Code v1，不能用占位实现代替：

| 领域 | 首版必须完成 |
| --- | --- |
| `model` | canonical model protocol、stream accumulator、OpenAI-compatible adapter、Anthropic native adapter、provider registry、credential source、错误分类、取消与 usage 归一化 |
| `agent` | `Agent`、`AgentHarness`、明确的 Run 状态机、exactly-one terminal、工具调用闭环、retry/policy、队列、安全点、context 构建与基础压缩 |
| `sqlite` | schema migration、append-only conversation tree、session/run/event/tool/compaction/artifact 持久化、writer lease、事务与 crash recovery |
| `coding` | `CodingAgent` facade、CLI、`print` mode、interactive TUI、workspace 管理、coding tools、权限模式、skill resolver、extension loader、配置与资源装配 |
| 工具 | 文件浏览、读取、搜索、创建、补丁修改、整文件替换、删除、命令执行、Git 状态与 diff、web search/fetch |
| 安全 | workspace 边界、symlink/junction 防逃逸、hard guard、风险分级、审批、执行前重新校验、timeout、abort、进程树清理、输出上限、secret redaction |
| 质量 | package contract tests、root integration tests、真实 OS/SQLite system tests、fault injection、真实 provider smoke、真实 coding task acceptance |

其中 “exactly-one terminal” 约束的是一次 Run 只能提交一个终态、发布一个 terminal event 并产生一份一致的 `RunReport`，与用户能打开多少终端窗口无关。

### 2.2 首版暂时不做

以下内容应该保留架构演进空间，但不在本轮用空类型或伪实现占位：

- 独立通用 TUI package；
- 多层长期记忆、向量检索和跨项目 memory；
- 完整 Task/Subagent scheduler；
- 多级、后台和语义索引式 context compaction；
- plugin sandbox、远程 plugin 分发市场和第三方信任体系；
- 通用远程 RPC/server mode；
- 容器级或虚拟机级 OS sandbox。

这些能力以后通过现有的 `AgentHarness`、`ContextSource`、`CompactionStrategy`、`SessionRepository`、`InteractionMode`、tool/extension registration 等 seam 加入。首版不承诺尚未实现的安全或隔离能力。

## 3. 实施原则

### 3.1 纵向切片优先

每个里程碑都必须穿过最高层公开接口。不得只完成底层类，再以“等待集成”为由把功能标记完成。例如 SQLite 里程碑的验收必须从 `CodingAgent` 启动和恢复 Session，而不是测试直接写表。

### 3.2 Interface 同时是测试边界

稳定 Interface 在第一次真实使用时建立：

- `Model` 至少有 `ScriptedModel` 与真实 provider adapter；
- `SessionRepository` 至少有 in-memory conformance adapter 与 `sqlite` adapter；
- `InteractionMode` 至少有 `print` 与 interactive 两种实现；
- `ToolExecutor` 同时覆盖真实文件系统、process adapter 与 deterministic test adapter。

不为纯假设能力创建空 Interface；需要扩展时，应先证明现有 seam 无法承载，再增加抽象。

### 3.3 生产路径只有一条

- CLI、TUI、测试和未来 mode 都通过 `CodingAgent`/`CodingSession` 进入；
- provider adapter 不私自 retry，retry 由 Agent policy 决定；
- UI 不直接写 Session，不直接执行工具；
- tool call 无论来自内置工具还是 plugin，都经过同一个 `ToolHost` pipeline；
- SQLite 只实现 `SessionRepository` contract，不向上泄漏 SQL row 或 transaction handle。

### 3.4 持久化先于副作用

每个 tool batch 必须遵循：

```text
完整解析 Model Turn
  -> 持久化 assistant message 与 ToolCall
  -> commit barrier
  -> 发布可见事件
  -> 执行工具
  -> 持久化 ToolOutcome
```

任何优化都不能破坏“assistant durable before tool effects”和“每个 accepted ToolCall 恰有一个最终 ToolOutcome”两项不变量。

### 3.5 当前代码的处理方式

不设置“迁移旧实现”里程碑。每个 Module 的 contract 与测试建立后，旧文件只按以下三类处理：

1. 直接满足新 contract 且通过新测试：保留；
2. 有局部算法或 fixture 价值：提取思路后按新边界重写；
3. 与新 ownership 或状态语义冲突：不接入新生产路径，待替代完成后再清理。

在替代路径尚未通过 gate 前不进行破坏性删除。旧代码的行数、测试数和运行结果均不能作为新里程碑完成证据。

## 4. 依赖与执行顺序

```text
M0 Workspace 与最小纵向链路
├──> M1 首条真实 Model/coding vertical slice
│        └──> M2 Agent loop、ToolHost 与 Windows safety ──┐
└──────────────────> M3 SQLite session backend ──────────┤
                                                         v
                                      M4 Context、compaction 与连续 Session
                                                         │
                                      M5 Provider、web 与 Linux 完整性
                                                         │
                                      M6 Extension/plugin 与 interactive TUI
                                                         │
                                      M7 系统加固与验收
                                                         │
                                      M8 交付与冻结
```

`M2` 依赖 `M1` 已经跑通的真实 vertical slice。`M3` 的 adapter 实现可在 `M0` Session contract 固定后与 `M1`/`M2` 交错开发，但 production switch 只能在前一条 vertical slice 稳定后进行。`M5` 与 `M6` 内部的 adapter、TUI 和 loader 工作可交错，最终必须复用同一个 product composition。

## 5. 里程碑

### M0：Workspace、contracts 与 walking skeleton

**目标**：建立可编译、可测试、可运行的最小纵向链路，但不把它当作功能完成版。

**实施内容**：

- 配置 workspace、共享 TypeScript 配置、lint、test、build 与 package exports；最终 Bun toolchain 迁移见 M5.1 补充计划；
- 建立目标四包的依赖边界规则，禁止循环依赖和跨包深层 import；package 必须与首个真实实现一同引入，不先创建空目录占位；
- 在 `model` 定义 canonical message/event/tool/usage/error contracts；
- 在 `agent` 定义 Run、terminal、Session、context、tool 和 policy 的核心 contracts；
- 在 `coding` 建立 `CodingAgent` facade 与最小 `print` entry；
- 实现 `ScriptedModel`、in-memory `SessionRepository`、manual clock/gate；
- 打通无工具对话：`CLI -> CodingAgent -> AgentHarness -> Agent -> Model -> RunReport`；
- 在无工具路径上实现 `completed`、`failed`、`aborted`、`limited` 四种终态。

**退出门槛**：

- clean install、typecheck、lint、unit tests 和 package boundary tests 全部通过；
- 无工具 Run 的事件顺序和持久化顺序可断言；
- 每种终态只出现一次，重复 abort/late event 不会产生第二终态；
- walking skeleton 使用显式 deterministic composition，不伪装成 production default；
- 任一公开 Interface 都已有真实调用方，不存在只为“以后可能需要”建立的空层。

### M1：首条真实 Model/coding vertical slice

**目标**：先用 OpenAI-compatible adapter、最小 coding tools 和 `print` mode 跑通一条真实生产链，同时把模型协议做成独立、稳定、可验证的 Module。

**实施内容**：

- 实现 `ModelRegistry`、provider profile、model catalog 和 capability validation；
- 实现 environment/ignored config credential sources 与 redacted diagnostics；
- 实现 OpenAI-compatible adapter，并先启用 OpenAI profile；
- 实现 `ModelTurnAccumulator`，严格处理 text、reasoning、tool-call delta、usage 与 terminal；
- 对 tool JSON 采用严格组装和校验，不做静默修补；
- 将 transport、authentication、rate limit、invalid response、abort 等错误归一化；
- 记录 raw-wire fixtures，覆盖分片边界与协议异常；
- 实现 `read_file`、`search_text`、`apply_patch`、`run_command` 的最小真实集合；
- 用 `print` mode 打通一次模型发起工具调用并继续推理的完整 Run。

**退出门槛**：

- OpenAI-compatible adapter 通过 `Model` conformance tests；
- fragmented tool arguments、multiple tool calls、missing usage、duplicate terminal、out-of-order event、断流和 abort 均有确定结果；
- adapter 内不存在隐藏 retry；
- 日志、error、event 和 fixture 中不出现 credential；
- 至少一个真实 provider 完成 opt-in live smoke；
- `print` mode 通过生产 facade 完成一次带工具的 live/deterministic vertical slice，不存在另建 demo runner 的捷径。

### M2：Agent loop、ToolHost、Windows safety 与完整本地 coding tools

**目标**：实现真正可修改项目、执行验证并安全结束的 coding loop。

**实施内容**：

- 完成 Agent Run 状态机、Attempt 计数、limits、retry policy 和 terminal arbitration；
- 完成 `AgentHarness` 的 commit barrier、safe point、steering/follow-up queue、abort 和 `RunReport`；
- 实现 `ToolRegistry`、strict schema validation、immutable `ToolPlan` 与 `ToolOutcome`；
- 完整实现 ToolHost pipeline：lookup、schema、hard guard、risk、permission、approval、revalidation、execute、cleanup；
- 补齐全部本地 coding tools；`web_search`/`web_fetch` 留在 M5 与 provider profile 一并完成；
- 实现 PowerShell process adapter，正确处理 quoting、cwd、env、timeout、abort 和 process tree cleanup；
- 实现 workspace canonicalization、path traversal 与 symlink/junction 逃逸防护；
- 对输出做 byte limit、truncation metadata、artifact spill 和 secret redaction；
- 打通一次完整的“读取代码—修改文件—运行测试—生成总结”纵向流程。

**退出门槛**：

- 每个 accepted ToolCall 在成功、拒绝、失败、timeout、abort 情况下都恰有一个 ToolOutcome；
- assistant message 与 ToolCall 未 durable commit 时，工具绝不启动；
- safe mode 的审批可被 deterministic test driver 控制；
- autonomous mode 仍受 hard guard 约束；
- Windows system tests 验证子进程清理、路径边界和命令失败；Linux 等价 adapter 与验证在 M5 完成；
- 真实临时 Git repository 中完成一次端到端修复，外部 verifier 通过。

### M3：SQLite session backend 与恢复

**目标**：将连续工作、conversation tree、并发写入和 crash recovery 做成可靠基础设施。

**实施内容**：

- 固定 `SessionRepository` conformance suite；
- 实现 schema、migration runner、foreign key、index 与 version check；
- 持久化 Session、branch、message、Run、semantic event、ToolCall/Outcome、queue、compaction、artifact metadata；
- 实现 content-addressed artifact store 与原子落盘；
- 启用 WAL、`foreign_keys=ON`、`synchronous=FULL`、bounded busy timeout；
- 用 `BEGIN IMMEDIATE` 和 writer lease token/epoch/heartbeat/expiry/fencing 保证单 Session 单 writer；
- 允许不同 Session 并发；
- 实现 reopen、lease takeover、orphan Run 归档、unknown tool effect 和 degraded read-only recovery；
- 将 production composition 从 in-memory adapter 切换到 SQLite adapter。

**退出门槛**：

- in-memory 与 SQLite 通过同一套 repository conformance tests；
- 同一 Session 双 writer 被确定拒绝，不同 Session 可并行；
- 模拟进程在 assistant commit 后、tool start 后、ToolOutcome 前、artifact rename 前崩溃，恢复时均不自动重放模型或工具副作用；
- 数据库 reopen 后 conversation tree、current branch、RunReport 和 artifact 引用一致；
- migration 能从空库升级，未知未来版本 fail closed。

### M4：Context、基础 compaction 与连续 Session

**目标**：首版即具备可解释、可回溯的 context 管理，而不是简单截断 history。

**实施内容**：

- 实现 `ContextSource`、`ContextManager`、`CompactionStrategy`；
- 实现 built-in、user、project 三类 skill source，以及 metadata、digest、provenance、precedence 和冲突校验；
- 接入 transcript、current task、steering/follow-up queue、project instructions、selected skills、latest checkpoint、artifact preview；
- 实现 token budget 分配、完整 Model Turn 边界、来源与 omission reason 记录；
- 实现基础 summary compaction，保留 source range、strategy version、input digest、summary artifact 和派生关系；
- compaction model call 使用同一 `Model` contract，但作为独立 Context Derivation 计数；
- 支持 reopen、continue、fork branch 与 workspace fingerprint 检查；
- 压缩失败时保留原始 history，不破坏 Session；
- 验证长对话、多轮工具输出和大 artifact 条件下的行为。

**退出门槛**：

- context manifest 能解释每项内容为什么被选择、压缩或省略；
- 不拆分未完成的 Model Turn，不丢失未结算 ToolCall；
- compaction 结果 durable 且可追溯到源节点，原始 transcript 不被覆盖；
- 重启后继续 Run 与未重启时得到相同的 context 选择；
- 在超预算、summary 失败、artifact 缺失和 branch 切换场景下均有确定错误或降级行为。
- skill 选择可复现并记录于 Context Manifest，skill content 不能获得执行权限或绕过 ToolHost。

### M5：Provider、web 与 Linux 完整性

**目标**：在不改变 canonical contracts 的前提下补齐第二类 provider、兼容 profiles、web tools 与 Linux OS adapter，证明核心抽象不是单实现包装。

**实施内容**：

- 实现 Anthropic native Messages adapter，独立处理 streaming、tool use、usage、reasoning replay 与 error mapping；
- 启用 DeepSeek、GLM OpenAI-compatible profiles，并校验各自 capability；
- 实现 `web_search` 的窄 provider interface、显式 profile 和 Run 内固定选择；
- 实现 `web_fetch` 的协议、大小、重定向、content-type 与 SSRF 风险限制；
- 实现 Bash/Linux process adapter，不通过字符串替换复用 PowerShell 语义；
- 在 WSL2/Docker Linux 环境执行 filesystem、Git、process、timeout、abort 与 symlink tests；
- 对两类 Model adapter 和两类 process adapter 运行共同 conformance suites；
- 验证 provider/OS 差异没有泄漏到 Agent state、Transcript 或 RunReport。

**退出门槛**：

- OpenAI-compatible 与 Anthropic adapter 均通过 raw-wire/Model conformance tests；
- OpenAI、DeepSeek、GLM profile 的 endpoint、auth 和 capability 行为可诊断，不静默互相 fallback；
- web response 超限、危险地址、重定向环、unsupported content 和 abort 均有确定 ToolOutcome；
- Windows/Linux 对同一 process contract 的 quoting、exit、timeout 和 cleanup 语义一致；
- 至少一个 provider live smoke 为 release 必需；其他 adapter 具备 credential 时执行 live smoke，否则保留完整 wire evidence 并明确记录未执行原因。

### M6：完整 CLI、extension/plugin system 与 interactive TUI

**目标**：完成产品交互面和真实可用的扩展机制，同时保证 TUI、plugin 与 core 之间只有受控 seam。

**阶段位置**：TUI 的正式实现位于 M6。交互和视觉设计在 M4 完成、`CodingEvent`/projection/context 状态基本稳定后启动，可与 M5 的 provider、web、Linux 工作并行。人工确认的 TUI 设计基线是进入 M6 实现的 gate，不把视觉决策拖到 renderer 已写完以后。

#### M6A：TUI 交互与视觉设计 checkpoint

该 checkpoint 需要较高人工参与。AI 可以辅助生成备选布局、状态清单和可运行候选实现，但最终由人确认产品命名、信息层级、密度、视觉方向和操作习惯。涉及 display name、CLI executable、config/env namespace、wordmark 或 help header 时，必须先触发补充计划中的命名决策点，不得擅自沿用工作标识。

必须形成：

- information architecture：Session/model selector、Transcript、composer、tool activity、approval、queues、status 与 RunReport 的层级；
- 关键流程：纯对话、coding task、tool approval、查看 diff、steering/follow-up、abort、resume、branch selection；
- 完整状态矩阵：idle、streaming、tool planned/running/settled、awaiting approval、compacting、recovering、failed、aborted、limited、completed；
- low-fidelity wireframes，覆盖窄终端、常规终端、长输出、多个并行 tool calls 和 resize；
- visual tokens：颜色、间距、层级、边框、状态色、focus、disabled、warning/error；
- keyboard map、focus order、可访问性、纯键盘操作和低颜色能力终端的降级规则；
- semantic event 到 projection/view-model 再到视觉区域的 mapping；
- 一份经人工确认的 TUI design baseline，作为实现和视觉验收依据。

该阶段不改变 `Agent`、`AgentHarness` 或 Session Interface。若某个视觉需求要求 renderer 直接读取 SQLite、provider 或 ToolHost 内部状态，应调整 projection，而不是让 UI 越过 `CodingAgent` seam。

#### M6B：TUI 与 extension/plugin 实现

**实施内容**：

- 完成架构文档规定的 CLI command、flag、exit code 与 config precedence；
- 强化 `print` mode，支持非交互任务、structured result 与脚本调用；
- 实现基于 OpenTUI Core、OpenTUI Solid 和 OpenTUI Keymap 的 interactive TUI，同时支持纯对话和 coding task；
- 展示 streaming text、tool plan/status/outcome、approval、queue、context/compaction 提示和 terminal summary；
- 支持 steering、follow-up、abort、session resume 与 branch 选择；
- 慢消费者只允许 progress coalescing，semantic event 不得丢失；renderer 只消费 projection/view-model；
- 将 M4 已有 built-in/user/project skill resolver 接入 extension skill source；
- 实现 versioned extension manifest、显式 enable、deterministic load order；
- 实现 extension discovery、validation、registration、startup snapshot 与错误隔离；
- 支持注册 tool、command、mode、skill source、context source、model provider、credential source、observation hook；
- 对名称冲突、版本不兼容、重复注册、加载失败给出稳定诊断；
- plugin tool 仍然进入统一 ToolHost pipeline；
- 提供至少一个独立 sample extension，同时贡献一个 tool 和一个 skill source，证明边界可用。

**退出门槛**：

- `print` 与 interactive 通过同一套 mode behavior tests；
- 关闭/重开 TUI 不影响 Session 的 durable truth；
- approval、abort、resize、快速输入、慢渲染和 provider 断流有自动化测试；
- 用户能从 CLI 新建 Session、纯对话、执行 coding task、查看 diff、继续 Session 并得到一致 RunReport；
- load order 与 collision policy 完全 deterministic；
- Run 开始后 registry snapshot 不受热变更影响；
- extension 失败不会绕过 terminal arbitration 或破坏 Session；
- 禁用 extension 后无残留注册；
- sample extension 不需要修改 `agent` 或 provider adapter 即可工作；
- 文档明确首版为 trusted local plugin，不宣称 sandbox；
- 没有 UI 到 SQLite、provider transport 或 tool adapter 的越层依赖。

M7 还需要对 M6A 的设计基线执行人工 visual QA。自动测试负责 event mapping、键盘行为、状态转换和 terminal races，人工验收负责信息层级、可读性、视觉一致性和真实任务中的操作负担；两者不能互相替代。

### M7：系统加固与验收

**目标**：从“功能存在”提升到“可证明为一个非 toy 的完整产品”。

**实施内容**：

- 执行全包 contract、integration、system、recovery 和 acceptance suites；
- 验证 OpenAI-compatible 与 Anthropic 两类 adapter；
- 验证 Windows PowerShell 与 Linux Bash；
- 在 TypeScript、Python、Java 临时仓库中分别执行 bug fix 与 feature task；
- 运行 fault-injection matrix；
- 执行 secret scan、dependency audit、package boundary audit 和 production-stub scan；
- 检查公开术语、日志 redaction、配置示例和许可证；
- 固化三项主要技术证据：Run durability、auditable compaction、ToolHost safety；
- 完成性能基线记录，重点观察 startup、large transcript reopen、large tool output 与取消收敛时间。

**退出门槛**：

- deterministic tests 全部通过，无 skipped critical test；
- 六个 scripted/system coding fixtures 6/6 通过；
- live coding acceptance 首轮至少 5/6 通过，且任何失败都不得违反安全、持久化或 terminal invariant；
- 八类 fault injection 全部得到预期恢复状态；
- 关键状态机的所有合法 transition 与非法 transition 均被测试；
- production source 不含 `TODO`、`NotImplemented`、测试 fake、静默 catch 或仅为 demo 成功的路径；
- 所有 blocker、critical 与 high severity issue 清零。

建议的八类 fault injection 为：provider 断流、malformed tool call、approval denied、tool timeout、abort during process、SQLite busy/lease loss、crash between assistant commit and tool settlement、artifact write/rename failure。

### M8：交付、冻结与复核

**目标**：交付内容、仓库历史和演示证据完全一致。

**实施内容**：

- 进入 capability freeze，只修复 blocker，不新增能力或改公开 contract；
- 从全新 clone 执行 install、build、test 和 smoke；
- 编写不超过 1000 个中文字符的 `README.txt`；
- 录制不超过 2 分钟、200 MB 的 MP4，展示真实 coding task 与验证结果；
- 检查压缩包结构、运行命令、平台说明和必要配置；
- 确认 repository 为公开状态、提交历史完整、无 credential 与本地参考材料；
- 在截止时间前完成最终 push，此后不再推送。

**退出门槛**：

- release commit 与演示视频使用同一 revision；
- 全新环境可按 README 命令启动；
- 视频中的任务、工具执行、修改、测试和最终总结均来自真实运行；
- 压缩包、远程仓库和本地 tag 指向同一版本；
- 最终检查结果被保存为 release evidence。

## 6. 测试与证据矩阵

| 层级 | 目的 | 主要对象 | Gate |
| --- | --- | --- | --- |
| Unit | 验证纯逻辑和状态转换 | accumulator、budget、risk、path、state reducer、lease rules | 每次提交 |
| Contract | 保证 adapter 可替换 | `Model`、`SessionRepository`、`InteractionMode`、`ToolExecutor` | 每个 package 合并前 |
| Integration | 验证跨 Module 不变量 | Harness + Model + Session + ToolHost | 每个纵向切片 |
| System | 验证真实依赖 | SQLite、filesystem、Git、PowerShell、Bash、Bun/OpenTUI terminal | M2 起持续运行 |
| Recovery | 验证 crash 后语义 | lease、orphan Run、unknown effect、artifact | M3 起持续运行 |
| Acceptance | 验证真实 coding outcome | TS/Python/Java bug 与 feature tasks | M7 release gate |
| Live smoke | 验证真实 provider 兼容 | OpenAI-compatible、Anthropic | M1、M7、release 前 |

测试遵循以下约束：

- 不使用 `sleep` 猜测并发顺序，使用 manual clock、barrier 和 controllable stream；
- acceptance verifier 在 agent 进程外运行，不能只相信 agent 自报成功；
- fixture 校验结果与行为，不要求生成固定 patch；
- live test 与 deterministic test 分离，缺少 credential 不能导致普通 test suite 随机失败；
- 关键模块以 invariant/transition coverage 为准，同时要求新增 production code 的 line coverage 不低于 85%、branch coverage 不低于 80%；
- coverage 数字不能替代 malformed input、取消、恢复、并发和权限场景。

## 7. Definition of Done

一个功能只有同时满足以下条件才算完成：

1. 通过最高层公开 Interface 可达，production composition 已接入；
2. happy path、invalid input、dependency failure、abort、timeout 和恢复语义明确；
3. semantic state 先持久化后发布，副作用满足相应 commit barrier；
4. 有 unit/contract 测试，并按风险具有 integration 或 system test；
5. error code、diagnostic 和 redaction 可供 CLI/TUI 使用；
6. 不产生越层依赖、重复 source of truth 或只供测试使用的生产分支；
7. 用户可观察行为已记录在相应文档；
8. 在 Windows 与 Linux 的适用测试中通过；
9. 没有依赖未完成 TODO 才能成立的前置条件；
10. 评审者能够从 test/evidence 复现该能力，而不依赖开发者口头解释。

## 8. 工作项与提交纪律

- 每个里程碑建立一个 tracking issue，子任务按可独立验收的纵向能力拆分；
- issue 进入实现前必须写清 contract、invariant、failure behavior 与验收命令；
- 一次提交只解决一个可说明的设计变化或纵向能力，不把重构、功能和格式化混成一个提交；
- contract 变更与 adapter 更新放在同一变更序列中，避免主分支持续处于半迁移状态；
- 每次合并前执行 secret scan，credential 只来自环境变量或被忽略的本地配置；
- 不改写已经公开的提交历史，不在截止时间后 push；
- 任何临时调试开关默认关闭，release build 中不得存在绕过安全链的入口。

## 9. 风险与优先处理

| 风险 | 早期信号 | 处理方式 |
| --- | --- | --- |
| 抽象很多但没有真实路径 | Interface 没有第二实现或没有上层调用 | 不创建空层；用 walking skeleton 和 conformance tests 迫使抽象落地 |
| provider 流协议被低估 | 只测完整 JSON，不测 delta 与乱序 | M1 优先完成 raw-wire fixtures 和 accumulator 状态机 |
| 工具执行可用但不安全 | UI/adapter 能绕开 policy，路径只做字符串前缀检查 | 所有工具统一进入 ToolHost；用真实 symlink/junction 与进程树测试 |
| SQLite 看似能存但不能恢复 | 测试只覆盖正常 close/reopen | M3 注入 crash point、lease loss 与 artifact 部分写入 |
| TUI 吞噬 core 时间 | renderer 内出现业务状态和数据库访问 | M6 只消费 projection；先完成 print mode 与 mode contract |
| plugin 变成任意内部注入 | extension 能拿到内部 mutable object | 只暴露 versioned registration API 和 capability-limited context |
| 压缩不可审计 | summary 覆盖原消息，无法解释 omission | append-only compaction record + manifest + provenance |
| 交付材料与代码版本不一致 | 进入交付冻结后仍在修改 contract | capability freeze 后只修复 blocker，视频和 clean-clone 验证绑定 release commit |

优先消除会推翻架构的风险：provider stream accumulator、Harness commit barrier、process cleanup、SQLite recovery 和 context provenance。视觉细节、额外快捷键和非核心 profile 在这些风险消除后处理。

## 10. 首版完成判定

Dex Code v1 只有在以下事实同时成立时才可称为完成：

- 四个 package 均形成有深度的 Module，而不是目录占位；
- coding task 通过 `CodingAgent` 进入统一 Agent/Harness/Session/ToolHost 路径；
- 两类 provider protocol 均有生产 adapter 与 conformance 证据；
- SQLite 能在冲突和崩溃后给出保守、可解释且不重复副作用的状态；
- context 超预算时执行可追溯的基础 compaction；
- print、interactive、skill 和 extension 使用同一组核心 contracts；
- 安全限制无法被 autonomous mode、plugin 或 UI 绕过；
- 外部 verifier 证明 agent 确实完成真实代码修改；
- 项目文档、仓库、演示和 release artifact 对应同一实现。

满足这些条件后，后续的高级 memory、Task/Subagent、多层 compaction 和更多 modes 才是在稳定地基上的扩展，而不是对首版缺失能力的补救。

## 11. 首版后的深化路线

这些阶段不属于 Dex Code v1 release gate，但属于明确保留的产品演进计划。它们不能通过提前放置空 manager/interface 来宣称完成。

### E1：多级 compaction 与长期 memory

- 先用现有 Context Manifest 和 compaction evidence 识别基础 summary 的真实失效模式；
- 增加多级 checkpoint、按需展开和 workspace knowledge source；
- 只有长期事实的抽取、检索、冲突、遗忘和生命周期可定义后，才新增 memory persistence contract；
- 新实现必须保持 Transcript immutable、来源可追溯，并通过与基础 strategy 相同的 context contract tests。

### E2：Task/Subagent orchestration

- 在 `AgentHarness` 之上定义 parent/child Run ownership，而不是在 tool 内递归调用 Agent internals；
- 明确子任务预算、权限继承、Session/branch 关系、取消传播、结果归并与 terminal semantics；
- 首个实现必须完成至少一个真实并行/委派任务和对应失败恢复测试，之后才固定公开 API。

### E3：Plugin 隔离与分发

- 在 trusted local loader 的 capability、故障与性能证据基础上选择 worker process、permission broker 或更强隔离；
- 增加签名、来源、安装/升级/回滚与 compatibility policy；
- sandbox 只有在文件、网络、process、credential 和 host API 边界均有可验证限制后才可对外宣称。

### E4：更多 modes 与独立 terminal Module

- JSON/RPC/IDE mode 继续通过 `InteractionMode` 和 `CodingAgent` 接入；
- 只有出现第二个非 coding 产品、稳定复用 terminal Modules、并且 OpenTUI implementation 泄漏造成真实维护问题时，才抽取独立 terminal package；
- 抽取时不迁移 Agent、Session、ToolHost 或 product command ownership，只移动已经证明通用的 rendering/input primitives。
