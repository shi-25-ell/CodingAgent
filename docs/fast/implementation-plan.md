# Fast 实施计划

## 1. 计划原则与截止边界

Fast 采用 gate-driven、thin vertical slice 的开发计划，不按 Module 分别“写完后再组装”。每个 milestone 必须留下可运行或可验证状态；提前通过 exit gate 就立即进入下一 milestone，不为填满日历而等待。

2026-08-30 12:00（北京时间）是 Fast `capability complete` freeze：全部 mandatory production paths 已实现并可组装，L0–L2 与核心 L3 通过，至少一个 OpenAI primary 的真实任务从 production TUI 跑通。四 profile live smokes、六任务完整矩阵和最终 evidence package 属于随后继续执行的 acceptance lane，不改变 capability freeze 的代码边界。

OpenAI-compatible/OpenAI 是第一 production Adapter、首个 live smoke、首个真实任务和演示默认路径。DeepSeek、GLM 是同一 Adapter 的后续 profiles。Anthropic native Adapter 保留为次级正式兼容路径，必须实现 production Adapter 与 wire contracts，但其 live smoke 不阻塞 8 月 30 日 capability gate。项目不安装、调用或封装 Claude Code；Anthropic native protocol 与 Claude Code 产品不是同一概念。

Fast M6 通过前不得开始扩展功能。若 M6 提前通过，可以立即启动独立 extension lane，但 Fast acceptance lane 继续运行，扩展不得修改冻结后的 Fast Interfaces、termination 或 evidence semantics。

## 2. M0 — No-tool walking skeleton

**目标窗口：** 2026-08-28 上午。

**Entry：** 已决 ModelProtocol、Runtime、Session、Tool 与 RunReport contracts 可作为唯一设计输入；仓库开始建立 TypeScript production scaffold。

**产物：**

- package/lockfile 与 format、lint、typecheck、test 入口；
- `ScenarioHarness`、deterministic ID factory、`ManualClock` 与 teardown invariants；
- canonical ModelEvent accumulator；
- strict FIFO `ScriptedModelAdapter`；
- memory `SessionLedger` Adapter；
- `FastController → SessionLedger → AgentRuntime → ScriptedModelAdapter → empty ToolPort → RunReport` walking skeleton。

**Exit：**

- `completed/no_tool_calls`、model failure、abort-before-request、policy limit 四条代表路径可确定性复现；
- 完整 assistant message 先提交，随后才可能 terminal；
- 每个已建立 Run 恰好一个 terminal event 和 RunReport；
- script 全消费，无残留 timer、promise、request、execution handle 或 workspace lock；
- 受影响的 G0、G1 和第一条 G2 通过。

M0 前不实现 production provider、持久格式、TUI widget 或真实 Tool Adapter。

## 3. M1 — Windows coding vertical slice

**目标窗口：** 2026-08-28 结束前。

**Entry：** M0 exit 全过。

**产物：**

- OpenAI-compatible Adapter 与 OpenAI primary profile；
- Tool-call Batch 的 source-order 串行执行与 call/result pairing；
- `list_files`、`read_file`、`search_text`、`apply_patch`、`run_command`、`git_status`、`git_diff`；
- Safe/Autonomous Modes 的最小完整 pipeline：schema → Hard Guard → Tool Plan → permission → execute → cleanup → ToolOutcome；
- Windows non-interactive PowerShell Process Adapter；
- 一个 TypeScript bug fixture。

**Exit：**

- scripted model 在 production Module path 完成 read → locate → edit → command verify → final answer；
- permission deny、timeout、abort、non-zero exit 都形成正确、model-visible ToolOutcome；
- Windows real subprocess smoke 通过，abort/timeout 后无遗留 process；
- 若未入库环境已配置 OpenAI credential，运行首个 live task；未配置时只将该 live observation 标为 `unverified`，不得阻塞 deterministic implementation 或改用 Anthropic 冒充 primary evidence。

Tool Plan、Hard Guard 与 ToolOutcome 未接通前禁止运行真实写文件或 shell coding task。

## 4. M2 — Durable Session spine

**目标窗口：** 2026-08-29 上午。

**Entry：** M1 scripted coding slice 全过。

**产物：**

- persistent append-only Ledger、RunLease 与 Artifact Store；
- Conversation Tree、Conversation Branch、连续 Runs 与 Run Boundary；
- workspace fingerprint 与 dirty continuation；
- Context Manifest 与基础 Model Context projection；
- Steering/Follow-up queues；
- reopen、torn-tail recovery 与 read-only degraded mode 主路径。

**Exit：**

- memory/file backends 运行同一 Session conformance suite；
- reopen 不重复执行 Tool、交付 queue 或生成第二个 terminal；
- branch ancestry、continuous semantic ancestry、workspace mismatch 与 explicit baseline confirmation 符合 contract；
- abort 后 partial evidence 保留，未交付 queue 恢复为 drafts；
- Session、Artifact 与 persistence 的 G1/G2 通过。

Persistent backend 替换 memory Adapter，不建立第二套 application flow。

> Materialization note：Issue #12 已将 production backend 收敛为 SQLite + content-addressed Artifact directory。因此实现 M2 时，上述 “file backend” 是 production SQLite Adapter，而不是 JSONL source of truth；JSONL 只作 export/evidence。该说明不改变 M2 Entry/Exit gate。

## 5. M3 — ToolHost hardening 与 Linux

**目标窗口：** 2026-08-29 中段。

**Entry：** M2 durable spine 可稳定保存 Tool Outcomes 与 recovery evidence。

**产物：**

- `create_file`、`replace_file`、`delete_file`；
- strict schema、workspace containment、path/symlink/junction policy、hash conflict 与 atomic replace；
- output cap、Secret Registry redaction、process-tree cleanup；
- Linux non-interactive Bash/process-group Adapter；
- Windows/Linux real subprocess smoke cases。

**Exit：**

- Safe/Autonomous decision table 参数化通过，Autonomous Mode 仍不能绕过 Hard Guard；
- Windows 与 WSL Linux 的 spawn、non-zero、timeout、abort、output cap、cleanup cases 通过；
- filesystem mutation 对 `.git/**`、credential、binary、invalid UTF-8、path escape、volatile precondition 的 contracts 通过；
- timeout/abort 后没有遗留 process、lock 或 unknown unreported effect。

当前 WSL 环境核对时只有原生 Python 与 Git；Node.js 未作为 Linux binary 安装，Java 不存在，npm/Maven 指向 Windows interop 路径。Linux G3 前必须 provision 并记录原生 Node.js、Java 与 Maven 版本，Windows interop 不计作 Linux evidence。

## 6. M4 — Provider、context 与 web completeness

**目标窗口：** 2026-08-29 晚间。

**Entry：** M0 ModelPort 稳定；web execution 另要求 M3 safety pipeline 已完成。Provider lane 可在 M2/M3 期间并行实现，但只能在 entry 满足后整合。

**产物：**

- DeepSeek、GLM OpenAI-compatible profiles；
- Anthropic native production Adapter 与 wire fixtures；
- provider retry/error/usage normalization；
- provenance-complete Compaction Checkpoint；
- `web_search` production profiles、`web_fetch` 与 DNS/redirect/SSRF policy；
- deterministic HTTP/search fakes。

**Exit：**

- OpenAI-compatible/Anthropic wire conformance 覆盖正常 stream、ToolCall、usage unknown、provider failure、malformed/truncated stream、abort；
- Adapter 不隐藏 retry、不静默降级或跨 provider fallback；
- compaction 只在完整 Model Turn boundary 切割，failed Context Derivation 不修改 Transcript；
- context overflow、restricted Artifact、digest failure 保持 fail-closed；
- web contracts 默认禁止真实 network，覆盖 private/reserved IP、DNS rebinding、redirect、HTTPS downgrade、timeout、content type、size；
- SSRF/DNS/redirect guards 完成前禁止真实 `web_fetch`。

## 7. M5 — Production TUI 与 interaction

**目标窗口：** 2026-08-30 06:00 前。

**Entry：** `FastEvent`、`ActiveRun`、permission 与 terminal contracts 已稳定。

**产物：**

- Session list/open/fork/tree 与 workspace mismatch；
- provider/model/Permission Mode 选择；
- streaming assistant/tool progress；
- permission `allow_once | deny`；
- Steering/Follow-up drafts、edit/delete、FIFO；
- abort；
- completed/aborted/failed/limited RunReport views。

**Exit：**

- TUI 只依赖 `FastApplication`，不直连 Runtime、provider、ToolHost 或 storage；
- SemanticEvent → immutable view-state tests 通过，少量稳定 renderer states 才使用 snapshot；
- deny 不启动 Tool 且默认不终止 Run；stale/duplicate approval 不能启动 Tool；
- terminal 后到达的 ProgressEvent 不复活 active state；
- OpenAI primary path 从 production TUI 完成一个真实小型任务。

`FastEvent`/`ActiveRun` contract 稳定前不堆 TUI widget 或 layout。

## 8. M6 — Capability gate 与 freeze

**截止：** 2026-08-30 12:00。

**Entry：** M0–M5 exit gates 全部满足或未满足项已被明确从支持声明移除。

**Exit：**

- 五个 deep Modules 都有 production implementation，production composition root 不引用 test fake；
- 首批 12–16 个 L2 scenarios 全过；
- Windows/Linux 核心 L3 smokes 通过；
- OpenAI 是首选配置、首个 live smoke、真实任务与演示路径；
- Anthropic production Adapter 与 wire contracts 通过，live 可留给 acceptance lane；
- mandatory paths 无 stub、空 Adapter、未解释 TODO 或 skipped tests；
- 所有未完成 profile/capability 明确 `unverified`，不产生超出 evidence 的支持声明；
- 创建 capability-freeze handoff，停止新增 Fast capability。

## 9. 并行 lanes 与整合规则

允许五条 lanes：

1. Runtime/Model：ModelEvent、accumulator、Runtime、provider Adapters；
2. Session：memory/SQLite Ledger、Artifact、context、recovery；
3. Tool：filesystem、process、Git、web internal Adapters；
4. TUI：event reducer、view state、interaction；
5. Evidence：ScenarioHarness、canonical/wire fixtures、CI、task manifests。

并行必须遵守：使用方先拥有 Interface 与 contract tests，再实现 Adapter；canonical types 同一时刻只有一个 lane 可修改；composition root 只有一个 owner；lane 内先过 G0/G1，再接入 production path 跑 G2；file scope 交叉时串行整合。Windows contract 形成后才实现 Linux Adapter，禁止复制 platform-specific Runtime。

## 10. Quality gates

- **G0 Static：** format、lint、typecheck、dependency/secret scan。
- **G1 Contract：** ModelProtocol、Session backend、ToolHost internal ports、TUI reducer。
- **G2 Vertical integration：** `FastController` 经 production Modules 到 RunReport。
- **G3 System：** clean temporary Git workspace、真实 Windows/WSL subprocess、cleanup。
- **G4 Live：** OpenAI primary live smoke/真实任务；其它 profiles 按 acceptance 运行。
- **G5 Acceptance：** 六任务矩阵、adversarial scenarios、evidence package。

每个 commit 至少通过受影响的 G0/G1；每个 milestone 必须通过对应 G2；filesystem/process/web/persistence milestone 必须通过对应 G3。G4/G5 不进入普通 PR gate。Live failure 若属于 Runtime/protocol defect，先最小化为 deterministic fixture，再修复。禁止通过 `.skip`、只更新 snapshot、放宽 assertion 或增加真实 model rerun 使结果变绿。

## 11. 风险前置、不得提前与 cut lines

### 11.1 风险前置

- M1 live 前由用户在未入库环境配置 OpenAI credential；当前规划环境未检测到 `OPENAI_API_KEY`。Credential 缺失只阻止对应 live gate。
- Web live 前配置对应 search credential；未配置不影响 deterministic implementation。
- Canonical ModelEvent/accumulator 未稳定前不解析真实 provider stream。
- Context projection 与 Tool pairing invariant 未通过前不实现 compaction。

### 11.2 Capability cut line

M6 前不实现 extension、Docker、Deep、MCP/plugin、multi-agent、自动 multi-run orchestration、通用 OS sandbox 或完整 counterfactual verifier。

### 11.3 Failure cut lines

- 若 M0/M1 未过，停止全部 extension，项目不具备可提交 core。
- 若 M2/M3 未过，优先修复 persistence/safety，不用 memory demo 冒充正式 Fast。
- 若 M4 部分未过，OpenAI primary path 可继续，但相应 provider/web capability 标为 `unverified`。
- 若 M5 未过，只保留实际可用 TUI interaction，不以 test harness 或隐藏 CLI 替代用户路径。
- 若 M6 未过，不进入 extension；缩小公开支持声明并保留诚实 evidence。

### 11.4 Stretch cut line

Docker isolation 永远位于完整 Fast acceptance 之后的 stretch cut line，不属于 Fast mandatory path 或正式 sandbox guarantee。

## 12. Capability-freeze handoff

M6 通过后，在 clean worktree 上创建 annotated tag `fast-capability-freeze`；extension 从该点之后开发。Tag 前必须满足：

- production composition root、versioned storage/fixture/event/evidence schemas；
- config example 只列 variable names，不含 credential；
- lockfile、build、typecheck、test、TUI start commands 可从 fresh checkout 执行；
- Windows/Linux differences 只存在于相应 internal Adapter；
- generated Artifacts、temporary workspace、secrets 不入库；
- milestone exit reports、G0–G3 results、OpenAI G4 evidence；
- known failures、`unverified` claims、residual risks；
- RunReport、Transcript、diff、commands、verifier evidence 可交叉核验；
- fresh-checkout verification command list。

最终 handoff 必须能链接：Module/dependency overview、Run lifecycle、OpenAI-first provider/config、Session/context/artifact/recovery、Tool/safety/Permission Mode/platform、TUI、testing/milestones/acceptance、known limitations/out-of-scope，以及 Issue → decision → code → test/acceptance traceability。本目录的 [README.md](README.md) 与 [traceability.md](traceability.md) 提供这些入口。

公开材料只使用本项目术语与独立设计，不包含 private research 来源名称或可识别实现。Commit history 保持语义清晰，不改写已推送历史。

## 13. Implementation stop condition

M6 通过且 capability-freeze handoff 完成后，停止新增 Fast capability；后续 acceptance lane 只运行已定义的 G4/G5 matrix、补齐 evidence，并如实标记 `unverified`。任何 extension 必须在 freeze point 之后独立进行，不能反向改变已冻结的 Fast Interfaces、termination 或 evidence semantics。

## 14. Domain 与 ADR boundary

本计划不新增 domain concepts；milestone、gate、lane 是 implementation-plan 术语，不进入 `CONTEXT.md`。本计划不创建 ADR，也不改变 [testing.md §1](testing.md#1-双证据模型) 的双证据 testing architecture。后续 implementation 不能把这些计划术语提升为 production domain abstraction。
