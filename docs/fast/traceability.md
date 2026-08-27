# Fast Traceability 与 Coverage Check

## 1. 使用方式

本表是 Issue decision、canonical specification、owner code area、test/evidence 与 implementation status 的单一索引。规范正文只存在于链接的 canonical section；本文件不复制决策内容。

Status 使用：

- `docs-ready`：resolution 已归一化为 canonical 文档；
- `not-implemented`：production code 尚未由本次 handoff 创建；
- `not-run`：对应 test/live/evidence 尚未执行。

## 2. Decision → implementation/evidence trace

| Decision | Canonical document section | Owner Interface / code area | Contract / integration / system test | Gate / evidence | Status |
| --- | --- | --- | --- | --- | --- |
| [#2 锁定 Fast 第一阶段的运行契约与验收边界](https://github.com/shi-25-ell/CodingAgent/issues/2) | [overview §2 Session、Run 与输入生命周期](overview.md#2-sessionrun-与输入生命周期)；[§3 Workspace 与平台](overview.md#3-workspace-与平台契约)；[§4 Provider](overview.md#4-provider-与配置契约)；[§5 用户交互与输出](overview.md#5-用户交互与输出契约)；[§6 正式验收边界](overview.md#6-正式验收边界)；[§7 非目标](overview.md#7-非目标与明确排除) | `FastController`、`FastSession`、`ActiveRun`；`application/`、`tui/`、composition config | Session lifecycle、workspace baseline、RunReport、support-matrix scenarios | G2、G3、G4/G5 evidence | `docs-ready`; `not-implemented`; `not-run` |
| [#3 定义领域模型、module seams、依赖方向与状态所有权](https://github.com/shi-25-ell/CodingAgent/issues/3) | [architecture §2 Deep Modules、依赖与状态 owner](architecture.md#2-deep-modules依赖方向与状态所有权)；[§3 Application 与 TUI Interface](architecture.md#3-application-与-tui-interface)；[§8 Architecture invariants](architecture.md#8-architecture-invariants) | `FastApplication`、`SessionLedger`、`AgentRuntime`、`ModelProtocol`、`CodingToolHost`；`composition/` | Module contract suites；`FastController` vertical integration；dependency-boundary check | G1、G2 | `docs-ready`; `not-implemented`; `not-run` |
| [#4 定义 canonical model protocol 与 provider adapter](https://github.com/shi-25-ell/CodingAgent/issues/4) | [architecture §4 Canonical model protocol](architecture.md#4-canonical-model-protocol) | `ModelAdapter`/`ModelPort`；`model/`；OpenAI-compatible、Anthropic、scripted Adapters | Canonical event accumulator；raw wire fixtures；tool pairing、failure、abort conformance | G1、G2、G4 profile smoke | `docs-ready`; `not-implemented`; `not-run` |
| [#5 定义 Generic Agent Runtime 状态机与 termination](https://github.com/shi-25-ell/CodingAgent/issues/5) | [architecture §5 Generic Agent Runtime](architecture.md#5-generic-agent-runtime) | `AgentRuntime.run()`、`RuntimeHost`、`RunStopPolicy`、`ModelRetryPolicy`；`runtime/` | Multi-turn loop、queue safe points、retry、abort、invalid/truncated output、terminal exactly-once | G1、G2；RunReport evidence | `docs-ready`; `not-implemented`; `not-run` |
| [#6 定义 Tool contract 与本地执行安全策略](https://github.com/shi-25-ell/CodingAgent/issues/6) | [safety §2 Tool contract 与执行管线](safety.md#2-tool-contract-与执行管线) 至 [§8 Secret 与 restricted data](safety.md#8-secret-与-restricted-data) | Runtime-owned `ToolPort`；`CodingToolHost`；filesystem/process/Git internal ports；`tools/` | ToolHost contract matrix；Windows/Linux process；path/symlink/hash/output/secret/cleanup scenarios | G1、G2、G3；zero safety violation evidence | `docs-ready`; `not-implemented`; `not-run` |
| [#7 定义 Transcript、Model Context 与 Artifact 状态模型](https://github.com/shi-25-ell/CodingAgent/issues/7) | [architecture §6 Transcript、Model Context 与 Artifact](architecture.md#6-transcriptmodel-context-与-artifact)；[§7 Physical persistence](architecture.md#7-physical-persistence) | `SessionLedger`、`RunLease`、Context projector、Artifact Store；`session/` | Memory/SQLite conformance；branch/context/compaction；Artifact integrity；recovery/degraded mode | G1、G2、G3；recovery evidence | `docs-ready`; `not-implemented`; `not-run` |
| [#8 验证 FastController、Runtime 与 TUI 交互协议](https://github.com/shi-25-ell/CodingAgent/issues/8) | [safety §4 Permission 与 approval](safety.md#4-permission-与-approval)；未确认 prototype 内容明确排除于 [architecture §3](architecture.md#3-application-与-tui-interface) | `ApprovalPort`、`ActiveRun.dispatch()`、TUI permission reducer；`application/`、`tui/`、`tools/` | allow_once/deny、deny-continue、abort-while-waiting、stale/duplicate acknowledgement | G1、G2；production TUI permission evidence | `docs-ready`; `not-implemented`; `not-run` |
| [#9 定义 fake provider 驱动的确定性测试架构](https://github.com/shi-25-ell/CodingAgent/issues/9) | [testing §1 双证据模型](testing.md#1-双证据模型)；[§2 ScenarioHarness](testing.md#2-scenarioharness-与-deterministic-fakes)；[§3 测试层级](testing.md#3-测试层级与-quality-gates)；[§4 must-pass matrix](testing.md#4-deterministic-must-pass-matrix) | `ScenarioHarness`、`ScriptedModelAdapter`、`ManualClock`、fake Host ports；test/evidence area | L0–L3 deterministic matrix；script/teardown invariants；canonical/wire fixtures | G0–G3；benchmark development slice | `docs-ready`; `not-implemented`; `not-run` |
| [#10 定义真实任务验收矩阵与证据标准](https://github.com/shi-25-ell/CodingAgent/issues/10) | [testing §5 真实任务与 ScenarioVerdict](testing.md#5-真实任务与-scenarioverdict) 至 [§10 acceptance checklist](testing.md#10-最终-acceptance-checklist) | Acceptance harness、`TaskFixtureManifestV1`、external verifier、evidence exporter | Six fixtures；eight failure injections；four profile smokes；web smoke；aggregate gate | G4、G5；JSON/Markdown evidence package | `docs-ready`; `not-implemented`; `not-run` |
| [#11 排定实现顺序、milestones 与 quality gates](https://github.com/shi-25-ell/CodingAgent/issues/11) | [implementation-plan §1–§14](implementation-plan.md) | All production areas；single composition-root owner；five implementation lanes | 每个 milestone 的 Entry/Exit；G0–G5；fresh-checkout handoff | M0–M6 exit reports；capability-freeze tag/evidence | `docs-ready`; `not-implemented`; `not-run` |
| [#12 收敛规划文档集与实现交接标准](https://github.com/shi-25-ell/CodingAgent/issues/12) | [README 文档索引与事实源](README.md)；[architecture §1 Package 与 code layout](architecture.md#1-package-与-code-layout)；[§7 Physical persistence](architecture.md#7-physical-persistence)；本文件 | `composition/`；SQLite `SessionLedger` Adapter；Artifact Store；all owner areas | Public-content scan；trace coverage；memory/SQLite conformance；fresh-checkout commands | Destination check；M6 handoff | `docs-ready`; `not-implemented`; `not-run` |
| [#13 选择 web search 与 fetch 基础设施](https://github.com/shi-25-ell/CodingAgent/issues/13) | [safety §9 Web search 与 fetch](safety.md#9-web-search-与-fetch) | `WebSearchProvider`、fetch transport/DNS/address ports；`tools/` | Provider schema fixtures；`MockAgent.disableNetConnect()`；SSRF/DNS/redirect/limit contracts | G1、G3；opt-in search/fetch smoke | `docs-ready`; `not-implemented`; `not-run` |

## 3. Coverage check

Coverage 规则：Issue #2–#13 每项必须至少映射一个 canonical section；所有链接目标必须存在；Issue #8 只能携带 final Resolution 确认的 permission 交互，不能把 provisional prototype 变为事实；implementation/evidence inputs 不能升级为 architecture decision。

| Issue | Canonical section coverage | Check |
| --- | --- | --- |
| #2 | `overview.md` §2–§7 | covered |
| #3 | `architecture.md` §2、§3、§8 | covered |
| #4 | `architecture.md` §4 | covered |
| #5 | `architecture.md` §5 | covered |
| #6 | `safety.md` §2–§8 | covered |
| #7 | `architecture.md` §6–§7 | covered |
| #8 | `safety.md` §4；`architecture.md` §3 的 prototype exclusion | covered |
| #9 | `testing.md` §1–§4 | covered |
| #10 | `testing.md` §5–§10 | covered |
| #11 | `implementation-plan.md` §1–§14 | covered |
| #12 | `README.md`；`architecture.md` §1、§7；`traceability.md` | covered |
| #13 | `safety.md` §9 | covered |

## 4. Atomic decision audit

本节把每个 Resolution 拆成可独立丢失的 decision clusters。每项只命名约束并链接 canonical section；规范仍只在目标章节定义。

### Map Issue #1

- Fast Destination、一次完整 multi-turn Run、TypeScript + TUI 范围 → [overview §1](overview.md#1-目标与范围)
- Model protocol、Runtime、Tool、Session/context、TUI、testing/acceptance 的完整文档入口 → [README](README.md)
- Provider/model instances、CNY execution value、benchmark task IDs 保持 implementation/evidence inputs → [testing §8](testing.md#8-implementationevidence-inputs)
- Deep/research layering/advanced orchestration/hosted tools/platform/sandbox 等 out-of-scope → [overview §7](overview.md#7-非目标与明确排除)
- Planning-only materialization、不写 production code → [Materialization boundary](#5-materialization-boundary)

### Issue #2

- Session tree、single active Run、Steering/Follow-up delivery、terminal 后显式新 Run、Conversation Branch boundary → [overview §2](overview.md#2-sessionrun-与输入生命周期)
- Clean Session start、dirty continuation、Git/fingerprint、Windows/Linux → [overview §3](overview.md#3-workspace-与平台契约)
- OpenAI-compatible/Anthropic families、stream/tool/reasoning、credential 与 per-Run fixed profile → [overview §4](overview.md#4-provider-与配置契约)
- TUI Session tree、queues、permission、abort、all-terminal RunReport → [overview §5](overview.md#5-用户交互与输出契约)
- Tool capabilities、Safe/Autonomous、Hard Guard、host execution/no general sandbox → [safety §1–§4](safety.md)
- Platform/language/task/provider acceptance boundary → [overview §6](overview.md#6-正式验收边界)
- Dirty-start/macOS/hosted tools/MCP/concurrency/auto-orchestration/counterfactual/workspace rollback exclusions → [overview §7](overview.md#7-非目标与明确排除)

### Issue #3

- Five logical Modules 与 owner Interfaces → [architecture §2.1](architecture.md#21-五个逻辑-modules)
- Use-side-owned ports、one-way dependencies、forbidden coupling/composition root → [architecture §2.2](architecture.md#22-依赖方向)
- Session/Run/queue/execution/tool/provider/TUI state owners → [architecture §2.3](architecture.md#23-唯一状态-owner)
- `FastController/FastSession/ActiveRun`、command acknowledgement、event projection/hot stream → [architecture §3](architecture.md#3-application-与-tui-interface)
- Run preflight、private RunLease、one Runtime invocation、typed start/terminal faults → [architecture §5.1](architecture.md#51-run-boundary-与-runtime-ports)
- Permission ownership 与 ToolHost pipeline → [safety §2](safety.md#2-tool-contract-与执行管线)、[§4](safety.md#4-permission-与-approval)
- Core invariants 与 no advanced-path placeholders → [architecture §8](architecture.md#8-architecture-invariants)、[overview §7](overview.md#7-非目标与明确排除)
- Per-Module test surfaces → [testing §3.1](testing.md#31-module-test-surfaces)

### Issue #4

- Narrow `ModelAdapter.stream`、run-scoped profile/credential boundary → [architecture §4.1](architecture.md#41-adapter-boundary)
- Canonical request/messages/content limits 与 no arbitrary parameter passthrough → [architecture §4.1](architecture.md#41-adapter-boundary)
- Incremental event grammar、accumulator、failure/abort normalization → [architecture §4.2](architecture.md#42-streaming归约与-capability)
- Reasoning replay token、capabilities、OpenAI-compatible/Anthropic profiles → [architecture §4.2](architecture.md#42-streaming归约与-capability)
- Strict ToolCall parsing、invalid/truncated exclusion、pairing/result ordering → [architecture §4.3](architecture.md#43-tool-call-pairingfinish-与-failure)
- Finish reasons、failure metadata、no hidden retry、usage unknown → [architecture §4.3](architecture.md#43-tool-call-pairingfinish-与-failure)
- Production/fake same interface、fixed scripted behaviors → [testing §2](testing.md#2-scenarioharness-与-deterministic-fakes)

### Issue #5

- Runtime single-writer、Run establishment boundary、RuntimeHost → [architecture §5.1](architecture.md#51-run-boundary-与-runtime-ports)
- Top-level RunPhase machine 与 ToolCall substates → [architecture §5.2](architecture.md#52-顶层状态机)
- Model Turn/Attempt/tool counts、injected stop/retry policies → [architecture §5.3](architecture.md#53-计数stopretry-与异常-output)
- Commit-before-tool、truncation/invalid-stream outcomes、model-visible Tool failures → [architecture §5.3](architecture.md#53-计数stopretry-与异常-output)
- Steering priority、Follow-up one-at-a-time、abort propagation/cleanup/no rollback → [architecture §5.4](architecture.md#54-steeringfollow-up-与-abort)
- Semantic/Progress events、persistence failure、terminal taxonomy → [architecture §5.5](architecture.md#55-event-与-terminal-taxonomy)
- RunReport content 与 completed semantics → [overview §5](overview.md#5-用户交互与输出契约)

### Issue #6

- Runtime-owned ToolPort、Host-owned fixed pipeline、ToolPolicySnapshot/ToolPlan/updates → [safety §2](safety.md#2-tool-contract-与执行管线)
- Fixed Tool set、strict schema、effects/risk → [safety §3](safety.md#3-第一阶段-tool-set-与-schema)
- Safe/Autonomous policy、ApprovalPort、allow_once/deny/stale/abort semantics → [safety §4](safety.md#4-permission-与-approval)
- Canonical path/symlink/.git/UTF-8/hash/atomic mutation/recovery Artifact → [safety §5](safety.md#5-workspace-与-file-safety)
- Fixed shells、command Hard Guards、process-tree cleanup、clean env、output caps → [safety §6](safety.md#6-commandprocess-与-output)
- ToolOutcome taxonomy/effects、deterministic envelope、serial batch/leases/cleanup escalation → [safety §7](safety.md#7-tooloutcomebatch-与-cleanup)
- Secret Registry 与 restricted output → [safety §8](safety.md#8-secret-与-restricted-data)
- Search profiles、fetch SSRF/DNS/redirect/time/size contract → [safety §9](safety.md#9-web-search-与-fetch)

### Issue #7

- Append-only Conversation Tree、ledgerSeq、record families → [architecture §6.1](architecture.md#61-canonical-ledger-与-ordering)
- Commit-before-tool、durable pairing、open-batch recovery → [architecture §6.1](architecture.md#61-canonical-ledger-与-ordering)
- Durable Artifact metadata/write-before-ref/truncation/lifetime → [architecture §6.2](architecture.md#62-artifact-store)
- Fresh context projection、ContextManifest、budget/priorities/pairing/fail-closed → [architecture §6.3](architecture.md#63-model-contextmanifest-与-compaction)
- Provenance-complete branch-local compaction/ContextDerivation → [architecture §6.3](architecture.md#63-model-contextmanifest-与-compaction)
- Redaction/restricted reasoning、RunBoundary/cross-Run continuity → [architecture §6.4](architecture.md#64-sensitive-projectioncontinuity-与-recovery)
- Orphan Run/call recovery、draft restoration、corruption/degraded mode/Artifact integrity → [architecture §6.4](architecture.md#64-sensitive-projectioncontinuity-与-recovery)
- SQLite + content-addressed Artifact physical persistence → [architecture §7](architecture.md#7-physical-persistence)

### Issue #8

- Permission after validation/plan/policy and before execution → [safety §4](safety.md#4-permission-与-approval)
- PermissionRequested/RespondToPermission、deny-visible-and-continue、abort/stale/duplicate → [safety §4](safety.md#4-permission-与-approval)
- Only allow_once/deny；no auto-timeout/permanent grant → [safety §4](safety.md#4-permission-与-approval)
- Web prototype/provisional layout/interface explicitly non-normative → [architecture §3](architecture.md#3-application-与-tui-interface)

### Issue #9

- Deterministic engineering evidence + budgeted live/benchmark evidence → [testing §1](testing.md#1-双证据模型)
- Real production module path、strict scripted model、canonical/raw fixtures、controlled concurrency → [testing §2](testing.md#2-scenarioharness-与-deterministic-fakes)
- Unit/contract/integration/system/live/acceptance layers → [testing §3](testing.md#3-测试层级与-quality-gates)
- Full Runtime/Session/safety/platform/web/TUI must-pass matrix → [testing §4](testing.md#4-deterministic-must-pass-matrix)
- External trajectory provenance/license/redaction/minimization and no paid PR gate → [testing §1](testing.md#1-双证据模型)
- At least one SWE-bench development slice, expandable without score claim → [testing §7](testing.md#7-live-coverage-与-aggregate-gate)

### Issue #10

- Orthogonal RunReport vs ScenarioVerdict success semantics → [testing §5](testing.md#5-真实任务与-scenarioverdict)
- Six language/task slots、reproducible seed/manifest/clean Session → [testing §5.1](testing.md#51-六个-canonical-task-slots)
- Protected external verifier、baseline behavior、mutation/diff/command evidence → [testing §5.2](testing.md#52-external-verifier-与-diff-policy)
- Eight deterministic failure-injection scenarios → [testing §6](testing.md#6-八个-failure-injection-scenarios)
- Non-Cartesian platform/task/Adapter/profile/web coverage 与 no silent fallback → [testing §7](testing.md#7-live-coverage-与-aggregate-gate)
- Single formal Run/rerun rule、4/6 aggregate gate、no cherry-pick → [testing §7](testing.md#7-live-coverage-与-aggregate-gate)
- Request/token/time/CNY ceilings plus provider/model/fixture/benchmark inputs → [testing §8](testing.md#8-implementationevidence-inputs)
- JSON/Markdown evidence package、redaction/replay consistency → [testing §9](testing.md#9-evidence-package)
- Fourteen-item final acceptance checklist 与 external-verifier production boundary → [testing §10](testing.md#10-最终-acceptance-checklist)、[§5.2](testing.md#52-external-verifier-与-diff-policy)

### Issue #11

- Gate-driven thin slice、capability freeze、OpenAI-first/Anthropic-secondary ordering → [implementation-plan §1](implementation-plan.md#1-计划原则与截止边界)
- M0–M6 complete Entry/Deliverables/Exit progression → [implementation-plan §2–§8](implementation-plan.md)
- Five parallel lanes and integration ownership → [implementation-plan §9](implementation-plan.md#9-并行-lanes-与整合规则)
- G0–G5 and anti-flake/no-rerun rules → [implementation-plan §10](implementation-plan.md#10-quality-gates)
- Credential/tool-pairing/context risk prerequisites → [implementation-plan §11.1](implementation-plan.md#111-风险前置)
- Capability/failure/stretch cut lines → [implementation-plan §11.2–§11.4](implementation-plan.md#112-capability-cut-line)
- Clean-worktree annotated freeze tag and handoff evidence → [implementation-plan §12](implementation-plan.md#12-capability-freeze-handoff)
- Freeze stop condition、domain/glossary/ADR boundary → [implementation-plan §13–§14](implementation-plan.md#13-implementation-stop-condition)

### Issue #12

- Single npm package/code directories/no common-shared、OpenAI-first dependency choices → [architecture §1](architecture.md#1-package-与-code-layout)
- SQLite/WAL/FULL/migrations/local-only + content-addressed Artifact store → [architecture §7](architecture.md#7-physical-persistence)
- Context/Resolution/docs/tests fact-source layering and one canonical section → [README](README.md)
- Issue → section → owner → tests/gate/status schema → [traceability §2](#2-decision-implementationevidence-trace)
- No new glossary term/ADR and no deleted ADR as source → [README Destination gate](README.md#implementation-handoff-与-destination-gate)
- Five Destination conditions/public-content scan/fresh-checkout handoff → [README Destination gate](README.md#implementation-handoff-与-destination-gate)
- Provider/model IDs、CNY execution value、benchmark IDs remain inputs → [testing §8](testing.md#8-implementationevidence-inputs)

### Issue #13

- Baidu/Brave explicit profiles、self-hosted SearXNG/no-key behavior、no fallback → [safety §9.1](safety.md#91-search-profiles)
- Narrow Tool/provider search requests、canonical results/failures/no raw passthrough → [safety §9.1](safety.md#91-search-profiles)
- Undici/URL/address policy/Cheerio/html-to-text、GET-only input restrictions → [safety §9.2](safety.md#92-fetch-contract)
- Per-hop DNS/IP pinning、redirect policy、no subresources/browser runtime → [safety §9.2](safety.md#92-fetch-contract)
- Connect/header/body/total/header-size/body/text limits → [safety §9.2](safety.md#92-fetch-contract)
- MockAgent/scripted DNS/search deterministic contracts、opt-in smoke → [safety §9.3](safety.md#93-deterministic-web-contracts)
- Provider rationale、deployment reachability caveat、excluded candidates、official sources → [safety §9.4](safety.md#94-选型依据与排除项)

## 5. Materialization boundary

本轮只完成 planning handoff materialization。所有 production implementation 和 runtime evidence 均保持 `not-implemented`/`not-run`；具体 provider/model IDs、fixture/benchmark IDs、运行时预算执行值在 [testing.md §8](testing.md#8-implementationevidence-inputs) 中作为 versioned inputs 保留。文档完成后不进入生产代码。
