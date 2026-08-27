# Fast 测试与验收

## 1. 双证据模型

Fast 使用两类正交证据：

1. `ScriptedModelAdapter` 驱动的 deterministic tests 证明工程 contract 和回归正确性，是普通合并 gate；
2. 预算受控的 live provider、真实 coding tasks、Agent canary 与公开 executable benchmark 提供外部能力证据，不替代 deterministic regression。

普通 PR 不自动发起付费调用。External trajectory 只能作为 test-only 素材，经 provenance、license、redaction 与 minimization 后转换为本项目自己的 canonical fixtures；replay 不算模型能力证据。

## 2. ScenarioHarness 与 deterministic fakes

`ScenarioHarness` 必须从 `FastApplication` 入口运行真实 `AgentRuntime`、`SessionLedger` 与 `CodingToolHost`，只替换 model 和 Host external ports；不得直接制造 Transcript、ToolOutcome 或 RunReport。

- `ScriptedModelAdapter` 严格 FIFO、request-aware；每个 Model Attempt 消费一个 scripted step。默认使用 fixed chunk plan 与 controllable clock，并可脚本化 normal completion、mid-stream failure、invalid JSON、truncation、abort。多调用、少调用、脚本未消费或 gate 未释放都使测试失败。
- Canonical `ModelEvent` fixtures 测 Runtime；OpenAI-compatible/Anthropic raw wire fixtures 测 Adapter normalization。
- `ManualClock`、barrier、promise gate 控制时间和并发；禁止 random chunk 和依赖短 `sleep` 的 ordering assertion。
- Filesystem、process、approval、clock、DNS、network 都经 production owner 内部 ports 注入 deterministic fakes。
- Temporary workspace 从可复建 seed 创建；teardown 必须证明没有残留 timer、request、process、execution handle 或 workspace lock。
- CI 默认禁止真实 network；web fakes 的规则见 [safety.md §9.3](safety.md#93-deterministic-web-contracts)。

## 3. 测试层级与 quality gates

| 层级 | 目标 | 主要 surface | Gate |
| --- | --- | --- | --- |
| L0 Static/unit | type、pure reducer、accumulator、policy 与 deterministic helpers | Biome、TypeScript、pure units | G0 |
| L1 Contract | owner Interface 与 production/fake Adapter 共用 contract | ModelProtocol、Session backend、ToolHost ports、TUI reducer | G1 |
| L2 Vertical integration | 从 `FastController` 经过 production Modules 到 RunReport | `ScenarioHarness`、temporary workspace、scripted model | G2 |
| L3 System | OS/process/persistence/web safety 的真实边界 | clean temporary Git workspace、Windows/WSL subprocess、SQLite recovery | G3 |
| Live | production provider/profile 与真实任务 | opt-in smoke、production TUI | G4 |
| Acceptance | 完整 fixtures、fault matrix、evidence package | six-task matrix、adversarial scenarios | G5 |

每个 commit 至少通过受影响的 G0/G1；每个 milestone 必须通过对应 G2；filesystem/process/web/persistence 必须通过对应 G3。G4/G5 不进入普通 PR gate。Live failure 若揭示 Runtime/protocol defect，先最小化为 deterministic fixture，再修复。禁止通过 `.skip`、只更新 snapshot、放宽 assertion 或增加 live rerun 让结果变绿。

### 3.1 Module test surfaces

| Owner Module | 必须通过其公开 seam 验证的行为 |
| --- | --- |
| `FastApplication` | 通过 `FastController/FastSession/ActiveRun`，配合真实或 scripted Runtime 与 memory Ledger，验证 start preflight、single active Run、command race、permission、abort、event 与 RunReport |
| `SessionLedger` | Memory/SQLite Adapters 共用 behavior suite，验证 tree/branch、RunLease、queue transition、Transcript append、revision、reopen、recovery |
| `AgentRuntime` | Scripted `ModelPort`/`ToolPort`/`RuntimeHost` 验证 multi-turn loop、batch、safe point、stop policy、retry、abort、error、terminal exactly-once |
| `ModelProtocol` | 两个 production Adapter 运行 canonical protocol 与 raw-wire conformance fixtures；真实 endpoint 只承担 opt-in smoke |
| `CodingToolHost` | Windows/Linux 共用 safety contract suite，验证 containment、symlink/junction、permission、timeout、output cap、cancel、cleanup |
| TUI | 通过 scripted `FastApplication` 验证 event reducer、keyboard mapping、permission flow；只对少量稳定 renderer states 使用 snapshot |

## 4. Deterministic must-pass matrix

L0–L3 必须覆盖：

- 完整多轮 loop、no-tool completion、Tool-call Batch、source-order pairing；
- invalid/truncated output、stream failure、retry、injected `RunStopPolicy`；
- abort-before-request、model streaming abort、Tool/command abort、terminal exactly-once；
- `completed | aborted | failed | limited` 的所有 RunReport 主路径；
- Session tree、Conversation Branch、continuous Runs、Run Boundary、workspace mismatch；
- Steering/Follow-up FIFO、draft edit/delete、abort 后 partial evidence/draft recovery；
- Safe/Autonomous Modes、permission allow/deny/stale/duplicate acknowledgement；
- workspace containment、path escape、symlink/junction、hash conflict、`.git/**`、credential/binary/invalid UTF-8；
- Windows/Linux spawn、non-zero、timeout、process-tree cleanup、output cap；
- context projection、pairing validation、Compaction Checkpoint、context overflow、Artifact digest failure；
- OpenAI-compatible 与 Anthropic wire normalization，包括 usage unknown、failure、malformed/truncated stream、abort；
- `web_search`/`web_fetch` deterministic fakes、SSRF、DNS rebinding、redirect、encoding、size、timeout、abort；
- TUI semantic event reducer、view-state、permission flow、terminal/progress race。

首批 M6 要求 12–16 个代表性 L2 scenarios；完整 matrix 在 G5 前补齐。

## 5. 真实任务与 ScenarioVerdict

Runtime 保持 `RunReport.status/terminationReason`。Acceptance harness 另产生：

```text
ScenarioVerdict = passed | failed | invalid
```

- `passed`：观测结果满足该 scenario 的 expected behavior；
- `failed`：Fast 或任务结果不满足预期；
- `invalid`：fixture/verifier/provider outage/environment damage 使本次运行无法评价 agent。

正常 coding task 只有同时满足以下条件才是 passed：

1. Run 以 `completed/no_tool_calls` 结束；
2. external verifier 与 regression commands 通过；
3. actual diff 满足 mutation policy；
4. 没有 safety violation；
5. RunReport、command evidence、workspace evidence、final answer 一致。

Fault scenario 以其声明的 terminal、ToolOutcome 与 `effectState` 为准，因此正确 abort 可以得到 passed。

### 5.1 六个 canonical task slots

固定六个 slots：TypeScript/JavaScript、Python、Java 各一个 small bug fix 和一个 small feature。每项都有可运行验证命令、通常修改 1–5 个文件；至少两项需要跨文件定位或修改。任务不得依赖 credential、external service 或 live network。验证命令使用相应生态的正式入口，例如 `npm test`、`python -m unittest`、`mvn test`。

`TaskFixtureManifestV1` 至少记录：schema version、fixture ID、language、`bugfix | feature`、prompt/digest、seed、starting tree/commit、visible commands、external verifier/digest、baseline expectation、allowed/forbidden globs、maximum changed-file count、platform/permission/capability tags、default budget profile。

Harness 按 raw bytes 复制 seed，固定 Git object format、branch、`core.autocrlf=false`、author、timestamp、commit message，生成 starting commit，并在启动 Session 前校验 tree hash、commit hash 与 clean status。不提交 nested `.git` 或 opaque Git bundle。每个正式 task 使用独立 clean Session；dirty continuation 由单独 integration scenario 验证。

### 5.2 External verifier 与 diff policy

External verifier 位于 agent-writable workspace 之外。Bug fixture 必须证明 target behavior baseline fail、patch pass；Feature fixture 必须证明 baseline 缺少目标行为、patch 满足目标且原 regression tests 在 baseline/patched 都通过。

External verifier 只属于 acceptance harness，不进入 Fast production Modules；第一阶段不引入完整 counterfactual verifier。

Harness 在 Run 后用独立 process 重新执行 verifier。Assistant 自述不能替代 evidence。即使功能检查通过，越界 file、超出 manifest limit、修改 `.git/**`、protected metadata 或其它 unintended diff 仍判 failed。Verifier 不能运行、baseline 不符或 environment damage 判 invalid。

Command evidence 必须来自真实 `run_command` ToolOutcome，保存 command、cwd、exit status、duration、stdout/stderr Artifact digest。正常 task 要求 agent 在 Run 内至少执行一次相关验证；若只有事后 verifier pass 而 assistant 虚构“已测试”，仍判 failed。

## 6. 八个 failure-injection scenarios

以下 scenarios 由 `ScriptedModelAdapter` 驱动，全部 must-pass：

1. Command 执行期间 abort：`aborted/user_abort`，process tree 清理，不再启动 model/tool，partial effects 如实记录。
2. Command timeout 后恢复：model-visible `timed_out` ToolOutcome，随后采用有效 command 并完成任务。
3. Safe Mode deny 后继续：denied call `effectState=none`，后续新 call 重新 approval。
4. Autonomous Mode Hard Guard：workspace 外或 `.git/**` mutation 被拒，合法 workspace mutation 可继续。
5. `RunStopPolicy` 达限：`limited/policy_limit`，保留 unfinished work，不伪装 completed。
6. Model retry 耗尽：精确消费允许的 Model Attempts，以 `failed/model_error` 结束。
7. Functional verification pass 但产生 unintended diff：ScenarioVerdict 必须 failed。
8. Assistant 声称 command pass 但无对应 execution evidence：ScenarioVerdict 必须 failed。

`output_limit`、stream truncation、call/result pairing、secret redaction 继续由 L0–L3 matrix 覆盖，不重复扩大 live task combinations。

## 7. Live coverage 与 aggregate gate

不运行 platform × language × task type × provider 的完整笛卡尔积：

1. 六个 fixtures 在 Windows、Linux 全部验证 materialization、baseline、verifier integrity，不调用 LLM。
2. 六个真实 tasks 各正式运行一次，Windows 三项、Linux 三项；每种语言的 bug/feature 分落两个平台，并共同覆盖 OpenAI-compatible/Anthropic Adapter families。
3. OpenAI、DeepSeek、GLM、Anthropic 四个 profiles 各运行一个短 opt-in live smoke，覆盖 streaming 与 native ToolCall；完整 tasks 不按四 profiles 重复。

没有成功 smoke 的正式 profile 必须标记 `not_run/unverified`，不得宣称已正式验证；provider 不得 fallback。Safe/Autonomous Modes 都必须出现在正式 task 或 adversarial scenario 中。Web deterministic contracts 必须通过；支持声明中的 search profiles 各有 opt-in smoke，`web_fetch` 另有 controlled HTTPS smoke。

每个真实 task 只有一次 pre-planned formal Run。Model 解题失败不得随意 rerun、换题或换 model；只有 provider outage、fixture/environment corruption 等 invalid 可以从同一 starting commit rerun，并保留原 record。

六任务 aggregate gate：

- 至少 4/6 passed；
- 三种语言各至少一个 passed；
- bug fix 与 feature 各至少两个 passed；
- Windows、Linux、两个 Adapter families 各至少一个 passed；
- 任一 Hard Guard escape、credential leak、workspace 外 effect 或 fabricated evidence 直接使整体失败；
- 所有 failed、limited、aborted、invalid records 必须保留，禁止 cherry-pick。

在 deterministic Harness、normal tool loop、abort/error、RunReport 主路径通过后，必须尝试至少一个 official SWE-bench task；随后按工期与预算扩展到 3–5 个或更多。此类小切片只称 development slice，不宣称 official benchmark score。

## 8. Implementation/evidence inputs

以下值在执行前进入 versioned manifest/evidence package；它们不是新的 architecture decisions，也不能留成影响 M0 开工的 core TBD：

| Input | 规则 |
| --- | --- |
| 精确 provider/model ID | 每个 live Run 记录；由可用 credential、profile compatibility 与执行环境选择 |
| 六个 fixture IDs | 必须填满 §5.1 的固定 slots，并固定 seed/verifier digests |
| SWE-bench task IDs | 至少一个 development slice；具体 IDs 在运行前固定并随 evidence 发布 |
| CNY execution budget | 运行前确认并冻结；不得超过下列 canonical ceilings，价格不可靠时记录 unknown |
| Tool/request/token/time limits | 运行前写入 budget profile，执行中不可提高 |

Canonical hard ceilings：

| Run type | Model Turns | Model Attempts | Tool calls | Input tokens | Output tokens | Wall-clock | Reliable-price CNY ceiling |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 单个真实 task | 20 | 24 | 60 | 120k | 20k | 15 min | ¥20 |
| 单个 profile smoke | 3 | 4 | 6 | 12k | 4k | 3 min | ¥2 |
| 最终整批 | — | — | — | — | — | 2 h | ¥150 |

Provider price 无法可靠获得时，cost 记录 unknown，但 request/token/time limits 仍强制执行；不得伪造 cost。Budget 达限后禁止新 request，并以 `limited/policy_limit` 结算。Implementation 可以选择更低预算，但不得以提高 ceiling 规避失败。

## 9. Evidence package

每次 acceptance 输出 machine-readable JSON 与简洁 Markdown summary，至少包含：

- agent commit、fixture ID/revision/tree hash、prompt/verifier digest；
- OS/toolchain、provider/profile、精确 model ID、config/tool-schema hash；
- Permission Mode 与全部 budgets；
- starting/ending HEAD、workspace fingerprint、changed/untracked files、patch digest；
- RunReport reference/digest、status/reason、counts、usage、duration；
- actual commands、exit status、stdout/stderr Artifact digest；
- external verifier、regression、allowed-scope、unintended-diff results；
- ScenarioVerdict 与 machine-readable reasons；
- Transcript/Artifact references 与 integrity digest；
- 所有成功和非成功 observations。

Export 必须 redaction credential、authorization header、registered secret、敏感 host absolute path。JSON schema、Artifact digest、Markdown/JSON verdict 必须能从 fresh checkout 复核一致性。

## 10. 最终 acceptance checklist

1. 六个 fixtures 在 Windows/Linux 重建相同 starting tree，baseline/verifier integrity 正确。
2. L0–L3 deterministic suite 在 Windows/Linux 全过，默认禁止真实 network。
3. 八个 adversarial scenarios 全部得到 expected verdict、termination、effect state。
4. 四个 model profiles 均有 live streaming/ToolCall smoke，无 silent fallback。
5. 六个真实 tasks 满足 aggregate gate 与 minimum coverage。
6. 每个已建立 Run 恰有一个 RunReport，且与 terminal、commands、diff、Artifacts 一致。
7. 正常 task 覆盖 read/locate、workspace mutation、actual command verification、可信 final answer。
8. 零 Hard Guard escape、credential leak、workspace 外 effect、orphan process、fabricated evidence。
9. Safe/Autonomous Modes 都有 evidence。
10. Web deterministic contracts 全过，support statement 中 production profiles 有对应 smoke。
11. 连续 Runs、dirty continuation、workspace mismatch、abort 后 draft/partial evidence recovery 有 integration evidence。
12. 至少一个真实 task 从 production TUI 完整走通 permission flow 与 RunReport view；其余 eval 从 production `FastController` interface 启动，不绕过 Module seam。
13. Evidence package 可重放校验，JSON/Markdown 一致。
14. 未运行的 profile、platform、capability 明确标记 `unverified`。
