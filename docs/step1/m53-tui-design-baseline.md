# Dex Code M5.3 TUI design baseline

> 状态：进行中。本文是 M5.3 的 owner-confirmed design record；N1 与 V1-A 已确认，V2–V7 按依赖顺序补充。未经确认的结构性方案不得进入 production theme、component behavior 或 keymap。

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

## 2. V1：整体信息架构与密度

确认日期：2026-08-29

项目 owner 修正了最初方案：Transcript 是 primary workspace，Composer 始终是主要输入入口；root 采用 terminal-native stretch layout，不使用 centered readable column、固定 content max-width 或大面积 gutter。tool activity 存在于 Transcript，diff 使用专门 full-screen view。context、todo、modified files 等可进入 lightweight sidebar，但 sidebar 只表达辅助状态，不能扩展为 activity/diff/queue/report 汇总的 contextual workspace。

项目 owner 选择 V1-A：sidebar preference 默认是 `auto`。wide terminal 自动 dock；用户可以切换为 `hide`。preference 与本次临时 open state 分离：常规/窄终端主动打开时使用 overlay；仅因 `auto` 在 wide 显示的 sidebar 在 resize 变窄后自然关闭。

确认后的约束为：

- Transcript + Composer 使用当前主区域可用宽度，只保留每侧 2 columns 的固定 horizontal padding；
- 普通消息、markdown、tool call 与 command output 都按主区域宽度自然布局，不另设正文 max-width；
- `width <= 120` 时 sidebar 不横向压缩主区域；用户主动打开时从右侧 overlay；
- `width > 120` 时 sidebar 可以 42 columns dock，剩余宽度全部归 stretch main region；
- sidebar preference 与本次临时 open state 分离；resize 只改变 dock/overlay placement，不丢失 composer、focus、scroll anchor 或 surface identity；
- 新增常驻 sidebar 内容必须证明 inline Transcript、临时 surface 或专门 view 无法有效承载。

### 2.1 三档 responsive layout

```text
Narrow / regular（sidebar closed）
┌──────────────────────────────────────────────────────────────────────┐
│  Transcript                                                          │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│  Composer                                                            │
└──────────────────────────────────────────────────────────────────────┘

Wide（sidebar enabled）
┌───────────────────────────────────────────────┬──────────────────────┐
│  Transcript                                   │ Sidebar              │
│                                               │ Context / Todo       │
│                                               │ Modified Files       │
├───────────────────────────────────────────────┤                      │
│  Composer                                     │                      │
└───────────────────────────────────────────────┴──────────────────────┘

Narrow / regular（sidebar explicitly opened）
┌──────────────────────────────────────────────────────────────────────┐
│  Transcript                              ┌────────────────────────┐  │
│                                          │ Sidebar overlay        │  │
│                                          │                        │  │
├──────────────────────────────────────────│                        │──┤
│  Composer                                │                        │  │
└──────────────────────────────────────────┴────────────────────────┴──┘
```

宽度阈值、2-column padding 与 42-column sidebar width 属于集中式 layout policy，component 不自行判断 terminal width。main region 不设置 max-width；sidebar 关闭时立即归还全部可用宽度。diff route 不复用 sidebar，approval 也不进入 sidebar。

### 2.2 Region priority 与低高度降级

从高到低的语义优先级为：blocking approval/recovery/fatal diagnostic、当前 Transcript/active activity、Composer、compact session/run identity、contextual detail、shortcut hints。优先级不表示视觉 z-order；blocking surface 才取得 overlay top 与 focus ownership。

- `height >= 20`：完整 compact identity/status、Transcript 与 Composer；
- `12 <= height < 20`：header 压缩为一行，Composer 降低最大高度，隐藏非必要 hints；
- `height < 12`：header/status 合并，secondary UI 只能使用临时 route/overlay，Composer 保留最小编辑行，其余空间归 Transcript；
- 任意高度都不能因降级丢失 active approval、fatal diagnostic 或用户草稿；
- path、model 与 Session identity 超长时中部省略，terminal status 与风险 token 不被截掉。

### 2.3 明确排除的方向

- 不采用 centered transcript、固定 112–120 column max-width 或 Web Chat 式窄内容列；
- 不把 activity/context/diff/queue/report 汇总为统一的第二 workspace；
- 不因功能增加而复制 IDE 的 pane hierarchy；
- 不单独限制 markdown 正文宽度；
- 不用 sidebar 承载 inline tool activity 或 full-screen diff。

## 3. Owner checkpoint 状态

| ID | 状态 | 记录 |
| --- | --- | --- |
| N1 | 已确认 | 本文第 1 节 |
| V1 | 已确认 | V1-A：stretch root、wide auto dock、narrow/regular explicit overlay |
| V2 | 待确认 | 视觉方向与 token sheet |
| V3 | 待确认 | tool activity 呈现与展开规则 |
| V4 | 待确认 | composer、queue 与 steering flow |
| V5 | 待确认 | approval 与危险操作 flow |
| V6 | 待确认 | diff 导航与 width matrix |
| V7 | 待确认 | executable keymap、可发现性与 conflict report |

V2–V7 确认后，本文还必须包含完整 end-to-end flows、状态矩阵、visual tokens、keyboard/focus/overlay 规则，以及 `CodingEvent -> TuiViewModel -> visual region -> UiIntent` 的可追踪 mapping。
