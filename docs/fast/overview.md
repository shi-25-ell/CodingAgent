# Fast 概览与外部契约

## 1. 目标与范围

Fast 是第一阶段的任务控制路径。用户发起一次完整 `Run`，`FastController` 恰好启动一次 `AgentRuntime.run()`；Runtime 在该 Run 内执行多轮 model ↔ tool loop。Fast 不是一次模型调用，也不自动编排多个 Runs。

第一阶段交付一个 TypeScript + TUI 本地 coding agent，覆盖持久 Session、双协议 provider、本地 workspace/command/web tools、Safe/Autonomous Modes、明确的 terminal semantics，以及可复核的真实任务证据。

## 2. Session、Run 与输入生命周期

- `Session` 绑定一个 workspace，是可持久化、可分支的 Conversation Tree，可包含多个串行 Runs；同一 Session 同一时刻最多一个 active Run。
- `Run` 是一次完整的 `FastController → AgentRuntime.run()`，内部可以包含多个 Model Turns、Model Attempts 与 Tool-call Batches。
- active Run 中的 `Steering` 在当前 Tool-call Batch 完整结束后的 safe point 按 FIFO 全部交付。
- `Follow-up` 仅在 Runtime 原本即将正常停止时按 FIFO 每次交付一个；Steering 优先于 Follow-up。
- terminal Run 之后的新输入在同一 Session 中启动新 Run，不构成自动 multi-run orchestration。
- `Conversation Branch` 只改变后续 Model Context 使用的 Transcript ancestry，不切换、不回滚 workspace。
- abort 是唯一的立即停止语义；Steering 和 Follow-up 不承担 cancel。abort 后保留已产生的 Transcript、partial evidence 和 workspace effects，未交付消息回到 drafts。
- abort 后 Session 保持可恢复；用户可以基于当前 workspace 显式启动新 Run，但不会自动续跑或回滚。

Runtime 内部状态机、队列交付点与 terminal taxonomy 的 canonical 定义见 [architecture.md §5](architecture.md#5-generic-agent-runtime)。

## 3. Workspace 与平台契约

- 新建 Session 必须从 clean Git repository 开始。
- 同一 Session 的后续 Runs 可以继续使用前一 Run 留下的 dirty workspace。
- Session 与每个 Run 记录 Git HEAD、workspace fingerprint 与 changed files。
- workspace 与 Session 最近 fingerprint 不一致时，TUI 必须警告并要求用户确认新 baseline；切换 Conversation Branch 时执行相同检查。
- 正式支持 Windows + PowerShell 与 Linux + Bash；Linux 可通过 WSL2/Docker 验证。
- macOS 不属于第一阶段正式支持范围。

Conversation Branch 不提供 workspace checkpoint 或自动恢复语义。

## 4. Provider 与配置契约

- 一个 OpenAI-compatible Adapter，正式 profile 为 OpenAI、DeepSeek、GLM。
- 一个 Anthropic native Messages Adapter。
- 两类 Adapter 均支持 streaming、native function tool calls，以及必要的 reasoning-content 保存语义。
- Session 保存默认 provider/model profile，但不保存 API key。
- 每个新 Run 可以选择 provider/model；active Run 内固定，不能切换。
- credential 只来自环境变量或未入库配置。缺少 credential 的 Session 仍可读取，但不能启动依赖该 credential 的新 Run。
- provider 不做静默跨 profile fallback。

字段级 canonical model protocol 见 [architecture.md §4](architecture.md#4-canonical-model-protocol)。精确 provider/model 实例是 [testing.md §8](testing.md#8-implementationevidence-inputs) 的 evidence input。

## 5. 用户交互与输出契约

Production TUI 必须支持：

- 新建、列出、恢复、fork 与浏览 Session tree；
- 选择 workspace、provider/model 与 Permission Mode；
- 输入初始任务，添加、编辑、删除 queued Steering/Follow-up；
- 展示 streaming assistant output、tool progress、队列与 workspace mismatch；
- 处理 `allow_once | deny` permission；
- abort active Run；
- 查看 `completed | aborted | failed | limited` 的 `RunReport`。

Permission 的执行位置、acknowledgement 与 deny 行为只在 [safety.md §4](safety.md#4-permission-与-approval) 定义。TUI 只能依赖 `FastApplication`，详细 application interface 见 [architecture.md §3](architecture.md#3-application-与-tui-interface)。

每个已经建立的 Run 恰好产生一个 `RunReport`。它至少记录 status、termination reason、final answer 或 partial artifact reference、Model Turn/Attempt 与 tool 计数、tool/permission/retry summary、usage、duration、changed files、commands/evidence、未交付队列数量、unfinished work、redacted error summary，以及 terminal 前最后一个 phase。

`completed/no_tool_calls` 只表示 Runtime 在没有待执行 tool call 或 Follow-up 时正常结束，不表示编程任务已经通过 external verifier。真实任务成功语义见 [testing.md §5](testing.md#5-真实任务与-scenarioverdict)。

## 6. 正式验收边界

| 维度 | 第一阶段正式边界 |
| --- | --- |
| 平台 | Windows、Linux |
| 语言 | TypeScript/JavaScript、Python、Java |
| Workspace | 新建 Session 为 clean Git repository |
| 任务 | 有可运行验证命令的小型 bug fix 与小型 feature，通常修改 1–5 个文件 |
| Provider | OpenAI-compatible profiles 与 Anthropic native Adapter |
| Tool | workspace 读写/搜索、patch、Windows/Linux command、Git evidence、本地 `web_search`/`web_fetch` |
| Permission | Safe Mode、显式 opt-in 的 Autonomous Mode；两者都执行 Hard Guard |

其它语言与更大任务只能声明 best-effort。正式矩阵不要求 platform × language × task × provider 的完整笛卡尔积；canonical coverage 与 aggregate gate 见 [testing.md](testing.md)。

## 7. 非目标与明确排除

第一阶段不包含：

- Deep controller、阶段编排、router、scheduler，或为其预留的空 Module/Interface；
- multi-agent、MCP/plugin ecosystem、graph planner、Patch Tournament；
- 多个并发 active Runs、后台任务或自动 multi-run orchestration；
- dirty workspace 上新建 Session；
- macOS 正式支持；
- 通用 OS sandbox；Docker isolation 只位于完整 Fast acceptance 之后的 optional stretch cut line；
- 模型厂商托管的 code execution、file management、browser 或 search tools；
- server-hosted code/file/browser/search tools；
- Conversation Branch 自动恢复 workspace；
- 完整 counterfactual verifier；
- 宣称支持所有语言、build systems 或任意规模 repository。

不得使用 agent framework/SDK 接管 Agent loop、context、tool execution、output parsing、termination 或 error handling。模型厂商 client、HTTP/SSE、schema validation 与 TUI library 只作为基础设施。
