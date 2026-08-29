# Dex Code M5.3 TUI design baseline

> 状态：进行中。本文是 M5.3 的 owner-confirmed design record；N1 已确认，V1–V7 按依赖顺序补充。未经确认的结构性方案不得进入 production root layout、theme 或 keymap。

## 1. N1：产品、CLI 与 namespace 命名

确认日期：2026-08-29

项目 owner 将 “Dex Code” 定义为品牌名，而不是必须替换全部技术术语的 namespace。品牌 Interface 与内部实现 seam 分离如下：

| Surface | 决定 | 说明 |
| --- | --- | --- |
| Display name / wordmark | `Dex Code` | TUI title、welcome、help/about、对外文档与截图使用 |
| CLI executable | `dex` | usage、shell completion 与 release bin 使用 |
| Environment namespace | `DEX_*` | model、provider、credential、data home 等用户配置 |
| Project config/data directory | `.dex` | project credential、project skill 等用户可见目录 |
| User data directory | Unix `dex`；Windows `Dex Code` | 遵循各平台 data root 约定 |
| Package scope | `@coding-agent/*` | 保持技术 namespace；不为品牌做无收益的全仓改名 |
| Code identifiers | `CodingAgent`、`CodingSession` 等 | 保持准确的领域/技术命名 |
| Extension contract namespace | `coding-agent` | 表达技术协议，不强制 extension ID 使用品牌前缀 |

### 1.1 选择理由

- 品牌名和简短 executable 形成一致、易记的用户入口；
- config/env/data surface 使用同一品牌 namespace，减少用户面对两套名称的认知负担；
- package、type 与 extension protocol 是内部或开发者 Interface，保留 `coding-agent` 能避免大范围低价值 rename，也更准确地表达职责；
- 产品尚未发布，采用一次原子迁移，不背负永久双 namespace。

未采用“所有 namespace 全部改成 Dex”方案，因为它会把品牌选择扩散到稳定的 Module 边界，增加 churn 而不改善产品行为。未采用“只改 title、其余继续 Fast”方案，因为用户会在 executable、配置和路径上看到互相矛盾的 identity。

### 1.2 迁移规则与验收

- production 只读取 `DEX_*` 与 `.dex`；不静默读取旧 `FAST_*` 或 `.fast`；
- 检测到旧环境变量或只有旧项目目录时，startup 返回明确的目标名称与迁移提示；
- renderer、CLI、composition 通过集中式 `productIdentity` / `productEnvironment` 获取命名；
- `@coding-agent/*`、`CodingAgent`、`CodingSession` 等不属于迁移范围；
- public docs、usage、release smoke 不得把旧工作名描述成当前品牌。

## 2. Owner checkpoint 状态

| ID | 状态 | 记录 |
| --- | --- | --- |
| N1 | 已确认 | 本文第 1 节 |
| V1 | 待确认 | 整体信息架构、密度、三档 responsive layout |
| V2 | 待确认 | 视觉方向与 token sheet |
| V3 | 待确认 | tool activity 呈现与展开规则 |
| V4 | 待确认 | composer、queue 与 steering flow |
| V5 | 待确认 | approval 与危险操作 flow |
| V6 | 待确认 | diff 导航与 width matrix |
| V7 | 待确认 | executable keymap、可发现性与 conflict report |

V1–V7 确认后，本文还必须包含 information architecture、end-to-end flows、完整状态矩阵、responsive rules、visual tokens、keyboard/focus/overlay 规则，以及 `CodingEvent -> TuiViewModel -> visual region -> UiIntent` 的可追踪 mapping。
