# Fast Tool 与安全规范

## 1. 安全边界

Fast 第一阶段在宿主机执行本地 Tool。它提供严格 schema、workspace containment、Permission Mode、Hard Guard、timeout/cancel/output cap、process cleanup、secret redaction 与 SSRF 防护，但不宣称通用 OS sandbox。Docker isolation 不属于 mandatory path，只能位于完整 Fast acceptance 之后的 stretch cut line。

所有 Tool 执行都受 Run 启动时冻结的 `ToolPolicySnapshot` 约束，其中包含 workspace、Permission Mode、budgets、web provider、policy version 与 `SecretRegistry`。Run 中途配置变化只影响后续 Run。

## 2. Tool contract 与执行管线

`AgentRuntime` 拥有 `ToolPort` 和 Tool-call Batch；`CodingToolHost` 实现单次调用安全管线：

```ts
interface ToolPort {
  definitions(): readonly ToolDefinition[];
  execute(call: ToolCall, context: ToolExecutionContext): ToolExecution;
}

interface ToolExecution {
  updates: AsyncIterable<ToolUpdate>;
  outcome: Promise<ToolOutcome>;
}
```

执行顺序固定为：

```text
lookup
→ strict schema validation
→ immutable ToolPlan
→ path / URL Hard Guard
→ effects / risk classification
→ permission evaluation
→ approval
→ volatile-state revalidation
→ timeout / cancellation / output limits
→ Adapter execution
→ cleanup
→ ToolOutcome
```

`ToolPlan` 是规范化影响声明；它与 policy version、resource preconditions 生成不含 secret value 的 `planFingerprint`。任何改变实际影响的变化都会使已有批准失效。

`ToolUpdate` 只服务实时 UI，不是终态事实源。Update 按 call 递增 sequence、发出前脱敏并使用 bounded buffer；慢 consumer 时可合并或丢弃旧 update，最终由 `ToolOutcome.updatesDropped` 记录。终态只以 `outcome` 为准。

## 3. 第一阶段 Tool set 与 schema

固定 Tool set：

- `list_files`
- `read_file`
- `search_text`
- `create_file`
- `apply_patch`（每次一个文件）
- `replace_file`
- `delete_file`
- `run_command`
- `git_status`
- `git_diff`
- `web_search`
- `web_fetch`

Input schema 使用 `additionalProperties: false` 和明确长度/数量上限。禁止 coercion、参数修复、validation 后隐式改写，以及万能 filesystem、任意 HTTP、递归目录删除接口。

动态 effects 为 `read_workspace | mutate_workspace | delete_workspace | spawn_process | network`；risk signals 为 `destructive | broad_scope | opaque_effects | secret_exposure`。

## 4. Permission 与 approval

Safe Mode 自动允许 workspace read/search/list 与 Git evidence；file mutation、process、network 每次请求 `allow_once | deny`。Autonomous Mode 是显式 opt-in，可以自动通过普通 policy 检查，但不能绕过 Hard Guard。

```ts
interface ApprovalPort {
  request(
    request: {
      approvalId: string;
      callId: string;
      toolName: string;
      summary: string;
      effects: readonly ToolEffect[];
      riskReasons: readonly RiskReason[];
      resources: readonly ToolResource[];
      planFingerprint: string;
    },
    signal: AbortSignal,
  ): Promise<"allow_once" | "deny">;
}
```

Permission 必须发生在 schema validation、`ToolPlan` 与 policy checks 之后、实际 Tool execution 之前。TUI 接收包含 `approvalId`、`callId` 和 plan summary 的 `PermissionRequested`，以 `RespondToPermission` 返回决定；acknowledgement 明确区分 `permission_allowed | permission_denied`。

`deny` 时 Tool 不启动，Host 生成 `status: "denied"`、`effectState: "none"`、`isError: true` 的 model-visible result。Deny 默认不终止 Run，Model 可以调整方案或说明限制；只有 `AbortRun` 终止整个 Run。

同一 `approvalId` 只接受一次响应。Run abort 取消等待；迟到、重复或 fingerprint mismatch 的响应是 stale/rejected acknowledgement，不能启动 Tool。等待 approval 不计 Tool timeout。第一阶段没有 approval auto-timeout、permanent grant 或 policy learning。

## 5. Workspace 与 file safety

Model 提供的路径必须是 workspace-relative；absolute path、UNC、device path、NUL、traversal 直接拒绝。Host 在 Run 开始时固定 workspace root realpath。

- Read 可以跟随最终 realpath 仍在 workspace 内的 symlink；recursive listing 不跟随 symlink directory。
- 所有 mutation 拒绝目标或任一 ancestor 为 symlink/junction。
- Approval 后、commit 前重新验证 canonical path 与 volatile precondition。
- Direct file tools 禁止修改 `.git/**`，并拒绝读取 known credential files；example config 可读。
- 防护不宣称抵御同一 OS user 主动制造的 TOCTOU attack。

File tools 只处理 UTF-8 text，拒绝 binary 与 invalid UTF-8。`contentHash` 基于 raw bytes，保留 BOM 与原换行。`read_file` 每页最多 50 KiB 或 2,000 行；单文件整体覆盖最多 2 MiB，更大文件必须分页读取。

- `create_file` 使用 exclusive create。
- `apply_patch` 在 preflight 读取内容并生成 `baseHash`，commit 前复核；不要求 Model 回传 hash。
- `replace_file`、`delete_file` 要求 `expectedHash`。
- Conflict 不做 fuzzy matching、silent retry 或 implicit replanning。
- `replace_file`、`delete_file` commit 前创建 Run-scoped recovery Artifact。
- Mutation 使用同目录 temporary file、flush、replace、cleanup 并持有 target path lock；只承诺进程期间一致性，不承诺 power-loss durability。

## 6. Command、process 与 output

`run_command` 只接受 `command`、可选 workspace-relative `cwd`、可选 `timeoutMs`。Windows 固定 non-profile、non-interactive PowerShell；Linux 固定 non-profile、non-interactive Bash。Model 不能选择 shell、传入 env/stdin/TTY/proxy 或请求 background mode。Default timeout 120 秒，maximum 600 秒。

任意 script 无法可靠静态分析，因此所有 command 都声明 `spawn_process + mutate_workspace + network + opaque_effects`。Hard Guard 拒绝明显的：

- privilege elevation；
- shutdown、disk、account、service、firewall administration；
- root/drive/home recursive destruction；
- `git reset --hard`、危险 `git clean`、whole-tree restore；
- background/detach/daemon；
- 显式向 workspace 外 absolute path 输出重定向。

Linux command 使用独立 process group；cancel 时先 `TERM`，2 秒后 `KILL`。Windows 使用可信系统路径下的 `taskkill /T /F` 并验证结果。Process tree 无法确认清理时升级为 `tool_host_infrastructure_error`。

Command 继承清洗后的 host environment：保留正常 platform/build variables，移除 provider credentials、registered secrets 与敏感命名变量。项目允许的 env names 在 Run 启动时解析，value 不写入 Session；Model 不能传任意 env map。

stdout/stderr 分别捕获，各向 Model 保留最后 32 KiB 或 2,000 行。Redacted full-output Artifact 上限 8 MiB；超过即终止 process 并返回 `output_limit`，不创建 unbounded temp file。Binary output 不进入 Model Context。

## 7. ToolOutcome、batch 与 cleanup

`ToolOutcome.status` 固定为：

```text
succeeded | rejected | denied | failed | timed_out | output_limit | cancelled | conflict
```

每个 Outcome 还包含：

```ts
effectState: "none" | "committed" | "partial" | "unknown";
abortObserved: boolean;
```

已发生 effect 必须如实记录，不虚构 rollback。File operation 若在观察到 abort 前已经 commit，可以是 `succeeded + committed + abortObserved`；被终止 process 通常为 `cancelled + partial/unknown`。

Stable machine codes 至少覆盖 schema、path、policy、approval、conflict、process、network、timeout、output、internal；human message 必须脱敏。Model-facing envelope 固定为：

```ts
{
  callId: string;
  content: string;
  isError: boolean;
}
```

`content` 使用固定 field order、LF 和 workspace-relative slash，不含 timestamp、duration、absolute path 或 random temp path；stdout/stderr 使用固定 sections。`isError` 由 Host 根据 Outcome 计算，Adapter 不得自行决定。

第一阶段 Tool-call Batch 按 source order 串行执行，每个 call just-in-time preflight。普通 Tool failure 只结算当前调用，剩余调用继续；仅 Run abort 或 `tool_host_infrastructure_error` 停止 batch。未启动的 accepted calls 生成 `cancelled_before_start`，保持一一配对。

同一 application process 中 read-only tools 可共享 workspace lease；file mutation 与 `run_command` 使用 exclusive lease；web tools 不占 workspace lease。不承诺多个独立 app processes 互斥。可能遗留 process/lock、unknown file state 或破坏 pairing 的 cleanup failure 是 infrastructure termination；只有可识别 temp file 遗留时返回 `cleanup_failed` 并记录 recovery reference。

## 8. Secret 与 restricted data

`SecretRegistry` 对 Model、TUI、log、Artifact 与 evidence export 全部出口执行 exact-value redaction。Exception stack、host absolute path 与 Adapter raw error 不进入 model result。

Credential、authorization header、environment secret 与 designated sensitive Tool argument 在 persistence 前移除或替换为 safe handle。Provider-required opaque reasoning/signature 作为 restricted Artifact 时，只允许投影给兼容 provider，并从常规 TUI、summary、export 排除。Artifact/persistence 的 canonical 规则见 [architecture.md §6](architecture.md#6-transcriptmodel-context-与-artifact)。

## 9. Web search 与 fetch

### 9.1 Search profiles

保留窄 `WebSearchProvider` seam。Production profiles 为：中国大陆默认百度千帆“百度搜索” standard，全球默认 Brave Web Search API；用户显式配置时支持 self-hosted SearXNG JSON endpoint。Run 启动时固定 provider，不做静默 fallback。无 credential/endpoint 返回 `not_configured`，不得抓取公开 search result pages。

Model-facing `web_search` Tool input 固定为 `query`、result `limit`、`safeSearch` level；禁止 arbitrary provider options 与 raw response passthrough。内部 `WebSearchProvider` 使用窄 canonical request，只携带 query、limit 与有限 freshness；outer Tool schema 与 provider seam 不得合并成 provider-specific option bag。

Canonical search result 包含 `title`、`url`、`snippet`，并在 provider 返回时保留 `publishedAt`、`siteName`；不得把 raw provider response 暴露给 Model。Provider failure 覆盖 configuration、auth、permission、request、rate limit、quota、timeout、network、unavailable、invalid response，并给出 retryable/retryAfter/requestId metadata；Adapter 不自行 retry。

### 9.2 Fetch contract

`web_fetch` 使用 fixed-version `undici` injectable transport、WHATWG `URL`、IANA special-purpose address policy、`cheerio.loadBuffer` 和 fixed-config `html-to-text`。它只接受 absolute HTTP/HTTPS URL 并执行 GET；Model 不能提供 method、headers、cookies、authorization、body、proxy、userinfo 或 non-default port。

Initial URL 和每个 redirect hop 都重新执行 URL/DNS/IP policy：解析所有 A/AAAA，只要任一地址不是 globally reachable 就拒绝；将已验证 address pin 到当前 hop socket，防止 DNS rebinding。Redirect manual、最多 3 hops；拒绝 HTTPS downgrade、loop、invalid Location 与 restricted target。只自动跟随 same-origin；cross-origin 返回 `redirect_requires_new_call`，由 Model 显式发起新 ToolCall。

不执行 JavaScript，不加载 iframe/image/stylesheet/other subresources，不引入 browser runtime。只接受 HTML/XHTML、plain text、JSON。

Limits 固定为：connect 3 秒、headers 5 秒、body idle 5 秒、total 15 秒、response headers 16 KiB、decoded body 2 MiB、extracted text 50,000 Unicode code points。

### 9.3 Deterministic web contracts

普通 CI 使用 `MockAgent.disableNetConnect()` 禁止真实 network，并注入 scripted DNS、address policy、clock/deadline、dispatcher factory 与 fixed byte chunks，覆盖 SSRF、DNS rebinding、redirect、encoding、size、timeout、abort。Search 使用 `ScriptedSearchProvider`；production Adapters 用 fixed official-schema fixtures 做 conformance test。真实 endpoint 只用于显式 opt-in smoke。

对应 acceptance 与 evidence 要求见 [testing.md §7](testing.md#7-live-coverage-与-aggregate-gate)。

### 9.4 选型依据与排除项

实现和 deployment 验证必须保留下列已决选型事实，避免无依据替换 provider：

- 百度 standard 是 Bearer HTTP endpoint，提供境内服务、公开免费额度与 QPS，作为中国大陆 profile；
- Brave 提供稳定 Web Search schema 与 rate-limit headers，作为全球 profile；其中国大陆可达性必须在 deployment 前实测，不能假定；
- SearXNG 只在用户显式提供 self-hosted JSON endpoint 时作为 no-key path；
- Bing Search APIs 已退役、Google Custom Search JSON API 不再接受新客户、DuckDuckGo Instant Answers 不提供通用 ranked web-results contract，因此不进入第一阶段候选。

历史决策所依据的官方资料：[百度搜索 API](https://cloud.baidu.com/doc/qianfan-api/s/Wmbq4z7e5)、[Brave Web Search API](https://api-dashboard.search.brave.com/api-reference/web/search/get)、[SearXNG Search API](https://docs.searxng.org/dev/search_api.html)、[Undici documentation](https://github.com/nodejs/undici/tree/main/docs/docs/api)、[IANA IPv4 registry](https://www.iana.org/assignments/iana-ipv4-special-registry)、[IANA IPv6 registry](https://www.iana.org/assignments/iana-ipv6-special-registry)、[Cheerio loading](https://cheerio.js.org/docs/basics/loading/)、[html-to-text](https://github.com/html-to-text/node-html-to-text/tree/master/packages/html-to-text)。
