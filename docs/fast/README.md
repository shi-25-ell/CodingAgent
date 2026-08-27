# Fast 第一阶段规划

本目录是 Fast 第一阶段的 canonical 实施规范。历史决策与理由保存在 GitHub Issue resolution comments；这里将其归一化为可直接指导实现、测试和验收的文档。

| 文档 | Canonical 内容 |
| --- | --- |
| [overview.md](overview.md) | 范围、外部运行契约、正式支持边界与非目标 |
| [architecture.md](architecture.md) | code layout、Module seams、ModelProtocol、Runtime、Session/context/artifact、TUI/application interaction |
| [safety.md](safety.md) | Tool contract、Permission Mode、Hard Guard、workspace/process/secret/web safety |
| [testing.md](testing.md) | deterministic test architecture、真实任务验收、预算与 evidence package |
| [implementation-plan.md](implementation-plan.md) | M0–M6、entry/exit gates、quality gates、lanes 与 cut lines |
| [traceability.md](traceability.md) | Issue → canonical section → owner → test/evidence → implementation status |

阅读顺序建议为 `overview.md` → `architecture.md` → `safety.md` → `testing.md` → `implementation-plan.md`。实现时以 [traceability.md](traceability.md) 检查决策、代码和证据是否闭环。

事实源层级如下：

1. `CONTEXT.md`：领域术语；
2. 已关闭 Issue 的 resolution comment：历史决策与理由；
3. 本目录：归一化实施规范；
4. contract tests 与 evidence package：实现和验证事实。

同一规范只在一个 canonical section 中定义；其它位置只链接。具体 provider/model 实例、人民币预算执行值和 benchmark task IDs 是 implementation/evidence inputs，不是新的架构决策。

## Implementation handoff 与 Destination gate

本轮不新增领域术语、不修改 `CONTEXT.md`、不创建 ADR。此前删除的 `ADR-0001` 不再是事实源。Milestone、gate、lane 与 `ScenarioVerdict` 都是 implementation/testing 术语，不进入 domain glossary。已关闭 Issue resolution 保留历史决策与理由；本目录只负责规范归一化。

规划到达 Destination 必须同时满足：

1. 所有已决内容映射到唯一 canonical section；不存在核心未决项、隐式 Deep 抽象或 research recommendation 冒充 architecture decision。
2. M0 只依赖本目录与 [traceability.md](traceability.md) 即可开工，无需重新决定 Module、Interface、state owner、persistence、provider、Tool safety、TUI interaction、testing 或 acceptance boundary。
3. 所有正式 support claim 都链接 gate/evidence；未验证 capability 明确标为 `unverified`。
4. Public-content scan 不包含 private reference 名称、可识别来源、credential、敏感 host path 或超出 evidence 的宣传。
5. Fresh checkout 可以按 [implementation-plan.md](implementation-plan.md) 执行 build、typecheck、test、TUI 与 M0–M6 handoff；capability freeze 使用 clean worktree、annotated tag 与完整 evidence checklist。

这些条件只关闭规划 fog，不把 implementation inputs 伪装成已验证事实。Production code、live runs 和 evidence 仍按 M0–M6/G0–G5 实施。
