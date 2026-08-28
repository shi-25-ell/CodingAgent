# Coding Agent

本项目构建一个在本地 workspace 中通过模型与工具协作完成编程任务的 Agent。领域语言区分长期交互上下文、一次完整执行及执行中的用户干预，避免把模型调用误称为任务执行。

## Language

**Fast**:
本项目的本地 coding agent 产品；Fast v1 是范围收敛但工程完整的第一版产品，不表示临时演示路径或单次模型调用。
_Avoid_: 第一阶段控制路径、快速模型调用、toy version

**Coding Task**:
用户提交给一次 Run、要求 Agent 在 workspace 中完成并以可核验证据报告结果的编程目标；后续 Steering 或 Follow-up 可以继续细化该目标。
_Avoid_: Run、Model Turn、Task/Subagent

**Session**:
绑定一个 workspace 的持久、可分支交互记录；一个 Session 可以包含多个串行 Runs，同一时刻最多有一个 active Run。
_Avoid_: Run、单次任务

**Run**:
Agent 的一次完整执行；它可以包含多轮模型与工具交互，并以明确的 termination reason 结束。
_Avoid_: 模型调用、请求、Turn

**Model Turn**:
Run 中一次逻辑模型交互及其可选的完整 Tool-call Batch；同一 Model Turn 可以因 transport retry 包含多个 Model Attempts。
_Avoid_: Run、step、单次 tool call

**Model Attempt**:
Model Turn 内一次实际发往 provider 的请求尝试；transport retry 会产生新的 Model Attempt，但不产生新的 Model Turn。
_Avoid_: Model Turn、Run、step

**Steering**:
用户在 active Run 期间提交、用于调整后续执行方向的消息；它属于当前 Run，不创建新 Run。
_Avoid_: 新任务、Follow-up

**Follow-up**:
用户在 active Run 即将结束时提交、用于继续当前工作的消息；它可以延续当前 Run，不自动创建新 Run。
_Avoid_: Steering、新 Session

**Conversation Branch**:
Session 中从某个历史节点分出的交互记录分支；切换分支只改变后续 Run 使用的对话上下文，不回滚或切换 workspace 文件。
_Avoid_: Git branch、workspace checkpoint

**Transcript**:
Session 中不可变、可审计的完整交互事实；它保留 Run 产生的完整消息、工具调用与结果，不等同于当前发送给模型的有限消息集合。
_Avoid_: Model Context、聊天窗口文本

**Model Context**:
从当前 Conversation Branch 的 Transcript 派生、受 provider、model 与上下文预算限制的一次模型输入视图；裁剪或重建 Model Context 不删除 Transcript 事实。
_Avoid_: Transcript、Session

**Artifact**:
由 Session 持久引用的大型、二进制或诊断内容；Transcript 只保存其 durable reference、preview 与 provenance，Artifact 不等同于 workspace 文件。
_Avoid_: Transcript message、OS 临时文件、workspace 文件

**Compaction Checkpoint**:
为构建后续 Model Context 而产生的、有来源范围且允许失真的派生摘要；它不覆盖、更正或删除原 Transcript。
_Avoid_: Transcript、事实记录、memory

**Context Manifest**:
描述一次 Model Context projection 引用了哪些 Transcript entries、Compaction Checkpoint 与 Artifacts 的持久清单；它用于审计和重建，不复制 Model Context 正文。
_Avoid_: Model Context、Transcript、prompt 副本

**Context Derivation**:
为生成 Compaction Checkpoint 等派生上下文而执行的内部模型交互；它不属于 Agent 工作轨迹中的 Model Turn 或 Model Attempt。
_Avoid_: Model Turn、Model Attempt、Run

**Tool-call Batch**:
一个完整 assistant response 中产生的一组 tool calls；Runtime 负责在同一个执行阶段结算该组调用，并在整组结束后到达可交付 Steering 的 safe point。
_Avoid_: 单个 tool call、Run

**Tool Plan**:
一个 ToolCall 在执行前形成的规范化影响声明，记录目标资源、effects、risk 与批准范围；任何会改变实际执行影响的变化都构成新的 Tool Plan。
_Avoid_: ToolCall、执行结果、permission prompt

**RunConfigSnapshot**:
一个 Run 启动时冻结的有效配置，包含 model reference、workspace、Permission Mode、预算、tools、search profile、extensions、skills 与 policy versions；credential value 不属于该快照。
_Avoid_: Tool Policy Snapshot、全局可变配置、credential value

**Tool Outcome**:
一个 ToolCall 的结构化结算事实；它区分成功、策略拒绝、用户拒绝、执行失败、超时、取消、输出超限与内容冲突，并通过 effect state 保留已经发生或无法确认的 effects。
_Avoid_: ToolResult 文本、异常字符串、RunReport

**Hard Guard**:
任何 Permission Mode 和用户批准都不能绕过的工具安全约束；违反 Hard Guard 时拒绝当前 ToolCall。
_Avoid_: approval rule、Sandbox

**Permission Mode**:
决定工具副作用何时需要用户批准的 Run 配置；Fast v1 提供 Safe Mode 与 Autonomous Mode，二者都受 Hard Guard 约束。
_Avoid_: Sandbox、安全边界

**Safe Mode**:
需要按照 permission policy 对有副作用的工具调用请求用户批准的 Permission Mode；硬安全约束始终生效。
_Avoid_: Sandbox、只读模式

**Autonomous Mode**:
不逐次请求用户批准、但仍受全部硬安全约束限制的 Permission Mode。
_Avoid_: 无限制模式、Sandbox

**RunReport**:
每个 Run 进入 terminal state 时产生的结构化结果，记录 termination reason、工作结果、执行证据、未完成项与错误摘要。
_Avoid_: 成功证明、模型最终文本

**Run Boundary**:
在同一 Session 的 Model Context 中表示前一 Run terminal 状态的紧凑派生记录；它引用关键结果、未完成项与证据，不等同于完整 RunReport。
_Avoid_: RunReport、assistant error message

**Interaction Mode**:
用户或脚本使用 Fast 的交互形态；Fast v1 提供 interactive TUI 和 print mode。
_Avoid_: 独立 Agent loop、TUI-only runtime

**Extension**:
用户显式启用、向 Fast 提供额外能力的 trusted local executable code bundle。
_Avoid_: Skill、sandboxed plugin

**Skill**:
带 metadata、provenance 和 digest、用于指导 Agent 行为的非 executable instruction/resource bundle。
_Avoid_: Extension、可执行插件、隐式工具权限
