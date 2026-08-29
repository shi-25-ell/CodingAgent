# M5.1 Bun runtime、SQLite 与 distribution 说明

## 支持范围

M5.1 将 Bun 1.4.0 固定为唯一受支持的 JavaScript runtime、package manager、script runner、
test runner 和 release build host。版本同时记录在 `.bun-version`、`packageManager`、`engines`
和 CLI startup diagnostic 中。`bun.lock` 是唯一 dependency truth；npm lockfile、Vitest 和
`better-sqlite3` 已移除。

本阶段没有实现 projection、OpenTUI renderer 或 TUI package，也没有改变
`CodingAgent -> AgentHarness -> Agent -> SessionRepository` 的产品语义。

## Runtime 与 config policy

所有 repository scripts 都由 Bun 启动。`tsc -b` 作为 compiler 保留，但不构成 Node runtime
fallback。CLI 可用以下命令输出机器可读的 runtime、version、revision、platform 和 architecture：

```bash
bun packages/coding/bin/dex.js --runtime-diagnostic
```

`.env` policy 分三层落实：

- `bunfig.toml` 设置 `env = false`，workspace package bin 不隐式导入 `.env`；
- source、release、fixture 和检查脚本显式使用 `bun --no-env-file`；
- standalone executable build 同时关闭 `autoloadDotenv` 与 `autoloadBunfig`，避免运行目录改变
  credential precedence。

credential 值仍只通过现有 environment/local config credential sources 进入 composition。自动化
测试在含 canary `.env` 的隔离目录运行 Bun，并确认变量不可见。

## Node compatibility API audit

production 不启动 `node`，但在 Bun 上继续使用其明确支持的 `node:*` compatibility APIs。保留这些
API 是为了复用稳定的跨平台语义，不代表存在第二套 runtime。

| Surface | Bun 路径与决定 | Evidence |
| --- | --- | --- |
| `process` | 使用 argv、env、cwd、platform、arch、exit code；`process.execPath` 在测试中指向 Bun | runtime/system 与真实 CLI process tests |
| `fs` / `path` | 使用 Bun 的 Node-compatible filesystem APIs；containment、symlink/junction、atomic replace 语义不变 | Windows/Linux filesystem system tests |
| `child_process` | process adapter 使用 Bun 提供的 `spawn`/`spawnSync`，实际 shell 为 PowerShell 或 Bash；没有 Node executable fallback | process conformance、abort/timeout/tree cleanup tests |
| Web APIs | 使用 Bun native `fetch`、`Response`、`AbortController`、`AbortSignal.timeout` 和 streams | provider/web contract tests |
| signals/timers | AbortSignal 与 bounded timers 保持原 lifecycle；native process cleanup 后才结算 outcome | Agent abort、web timeout、process tree tests |
| ESM resolution | workspace 维持 `type=module`、显式 `.js` specifier 和 declaration build；release conditions 为 `bun`,`import` | typecheck、package exports、source/bundle smoke |
| package conditions | source packages 发布 `dist` exports；Bun bundle 使用 `bun`,`import`，static dependencies bundle，动态 specifier 留给未来 extension loader | boundary/export checks 与 release manifest |

测试迁移到 `bun:test` 后保留原有 unit、contract、integration、system、recovery 和 acceptance 分层。
Bun 1.4.0 对嵌套 asymmetric matcher 存在会改写 actual object 的行为，因此相关用例改为直接字段断言；
断言内容没有减少。Windows 原生进程退出后偶发短暂 `EBUSY`，测试清理采用有限显式重试，业务 cleanup
与 process-alive 断言保持不变。

## SQLite driver

`sqlite` package 通过私有 `SqliteConnection`/`SqliteStatement` boundary 使用 `bun:sqlite`。该 boundary
集中隐藏 Bun strict binding、statement disposal、pragma result shape、transaction state、forced close
和 error translation；driver types 不进入 `SessionRepository` 或上层 package，因此不是一一转发的浅包装。

迁移保留：

- WAL、`foreign_keys=ON`、`synchronous=FULL` 和 bounded busy timeout；
- `BEGIN IMMEDIATE` 写事务、`BEGIN EXCLUSIVE` migration、rollback 和 schema checksum；
- strict parameter binding、integer/JSON/blob、future version rejection；
- writer lease fencing、artifact atomic commit、reopen、integrity check 和 process crash recovery。

所有直接依赖旧 driver 的 fixtures 已改用 `bun:sqlite`。

## Build 与 distribution

`bun run build:release` 生成 milestone-scoped 的 `artifacts/m51/` evidence：

- Bun-targeted ESM bundle 与 linked source map；
- 当前 platform/architecture 的 standalone executable；
- 包含 Bun revision、target、SHA-256、bundle/package condition、`.env` policy、license 状态和 future
  target matrix 的 manifest。

JS bundle 是保留未来 trusted local extension 动态加载能力的 release 路径。standalone executable
目前只作为 M5.1 compatibility evidence，不在 extension loader 完成前把 single-file compile 固化为
唯一发布形式。未来 native target matrix 预留 Windows x64、Linux x64 和 Linux arm64；本阶段未创建
空 TUI package。仓库当前没有 license 文件，因此 private evidence 明确标记为 `UNLICENSED`，不会生成
虚假的 license artifact。

source、bundle 和 executable 由同一个 production CLI entry/composition 构建。smoke 同时核对 runtime
diagnostic、unsupported-provider exit code 和 stderr 分类。

## 可复现验证

Windows x64 与 WSL2 Ubuntu 22.04/Linux x64 都从本地 clean clone 执行：

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun test
bun run build:release
bun run smoke:release
```

验证结果：

- Windows x64：237 pass、8 个 Linux-only tests skip、0 fail；bundle/executable smoke 通过；
- Linux x64：230 pass、15 个 Windows-only/Windows integration tests skip、0 fail；8 个 Linux
  process/filesystem tests 实际执行并通过；bundle/executable smoke 通过；
- 两个平台均使用 Bun 1.4.0，revision `34cbb9a40`。

Windows Bun native LCOV gate 为 lines 93.61%、functions 92.44%，高于本阶段 75% line target。
Bun 1.4.0 原生 reporter 不提供 branch counters，因此没有把 functions 冒充 branch coverage，也没有为
此项保留 Vitest/Node runner。高风险的 terminal、ToolOutcome、abort、migration、write lock、lease、
artifact 与 recovery 路径均由明确行为测试覆盖。

真实 provider smoke 不是 runtime 迁移的核心 gate，本次未调用付费模型；GLM/DeepSeek/Anthropic 和
OpenAI-compatible 的 deterministic production composition fixtures 均已通过。需要人工 live smoke 时，
应在显式 opt-in 环境使用已配置的 direct provider 和低成本模型，且不得输出 credential。

M5.1 完成时尚未触发 N1；项目 owner 后续在 M5.3 确认品牌为 “Dex Code”、CLI 为 `dex`。现有
`@coding-agent/*` 保持技术 namespace，用户可见 config/env/data identity 已迁移到 `DEX_*`、`.dex`
与 Dex Code 对应目录。完整记录见 [m53-tui-design-baseline.md](./m53-tui-design-baseline.md)。
