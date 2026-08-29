# Dex Code M5.3 TUI design baseline

> 状态：进行中。本文是 M5.3 的 owner-confirmed design record；N1、V1-A、V2、V3-A、V4-A 与 V5-A 已确认，V6–V7 按依赖顺序补充。未经确认的结构性方案不得进入 dedicated diff route 或 global keymap behavior。

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

## 3. V2：theme architecture 与视觉 tokens

确认日期：2026-08-29

默认 active theme 是 `dex`，不是 terminal-palette adaptive theme。`dex` 提供自有的完整 dark/light palette；terminal environment 只用于检测 dark/light mode，随后选择对应 variant。root/background 默认使用 palette 中明确的 opaque color。另提供显式可选的 `system` theme；只有 `system` 才读取 terminal foreground/background/palette，并让 root foreground/background 继承 terminal default。

视觉方向为 neutral dark/light UI 加 blue、green、light-purple semantic identity：

| Token group | 角色 |
| --- | --- |
| `primary` | blue；focus、selection、主要交互、Markdown link 与部分关键状态 |
| `secondary` | green；completed execution、positive state、diff add 与部分 code/command semantics |
| `accent` | light purple；reasoning、agent-related secondary emphasis、Markdown heading 与少量高层级 metadata |
| `info/success/warning/error/pending` | blue/cyan、green、amber/yellow、soft red、muted purple/gray |
| `background/backgroundPanel/backgroundElement/backgroundMenu` | 接近黑或接近白的 neutral surface steps，仅作轻微明度区分 |
| `text/textMuted/textSubtle/textDisabled` | neutral text hierarchy；普通正文不使用品牌色 |
| `border/borderActive/borderSubtle/focus` | neutral border hierarchy；focus 使用 primary blue |
| Markdown / syntax | 从完整 semantic roles 映射的克制多色 system，不为每个 tool 分配独立强色 |
| diff | add=green、remove=soft red、context=neutral、hunk=info；background 使用低强度 tint |

### 3.1 使用约束

- 大面积 root、panel、element 不使用 blue/purple tinted background；
- normal running state 不持续铺设大面积 success green；
- 不以 cyan/neon blue 制造“科技感”，不使用 rainbow-style high-saturation syntax；
- primary/secondary/accent 用于信息层级，不用于装饰；
- `dex` dark/light 正文与 selection 必须分别达到 WCAG AA；正文目标为 7:1，selection 最低 4.5:1；
- `system` 的 terminal default foreground/background 对比度由用户 terminal theme 负责，派生 panel/border 只用于层级，不假称由 Dex Code 修复 terminal palette；
- 无颜色环境下，后续 component 必须同时提供 text marker、glyph/ASCII 与 attribute fallback，不能只靠 token hue 传达状态。

### 3.2 Token ownership

theme resolver 只输出 presentation token，不进入 `CodingEvent`、projection durable state 或 `CodingSession`。当前 theme selection 属于 UI-local preference；renderer 把 token 转为 OpenTUI color/style。Markdown、syntax 与 diff Adapter 消费同一 resolved theme，component 不内嵌 hex。

## 4. V3：Semantic inline tools

确认日期：2026-08-29

所有 tool activity 都属于 Transcript，不创建 Activity workspace。presentation Adapter 按 tool semantics 在 compact row、output block、inline diff 与 code/diagnostic block 之间选择；不把所有 tool 统一成相同 card，也不把 output 一律移入 detail route。

| Tool family | 默认呈现 |
| --- | --- |
| read / grep / glob / search | compact semantic inline row |
| shell / command | inline output block；默认约 10 行，超出后 expand/collapse |
| generic tool | compact summary；raw output 默认隐藏，可单独全局开启；开启后默认约 3 行 preview |
| edit / apply_patch | 有 structured diff metadata 时直接在 Transcript 渲染 inline diff |
| write | 根据 metadata 使用 compact row 或 syntax-aware code/diagnostic block |

inline edit diff 使用 syntax highlighting、line numbers、add/remove semantic color 与 selection token。它和 dedicated Diff route 是两个不同层级：单次 mutation evidence 留在 Transcript；session/working-tree 综合审阅进入 full-screen route。inline region `width <= 120` 默认 unified，`width > 120` 可使用 split；用户选择 stacked 时始终 unified。V6 继续负责 dedicated Diff route 的多文件导航和完整 width matrix，不能反向取消这里的 inline mutation evidence。

tool details 默认显示。全局 Hide tool details 只隐藏 `succeeded` completed history；planned、running、failed、denied、cancelled、conflict 与 permission-related activity 始终可见。failure summary 永不折叠；error detail 可以通过 stable `tool:<callId>:error` identity 展开。output expansion 使用 `tool:<callId>:output`，属于 UI-local state。

tool output 在进入 renderable 前移除 ANSI escape/control injection，并按 Unicode code point 截断；preview 不能拆分 surrogate pair。颜色只按 pending/running/success/warning/error semantic tone 分配，不为每种 tool 发明独立高饱和颜色。

## 5. V4：Run-aware direct Composer

确认日期：2026-08-29

项目 owner 选择 V4-A。Session 始终只有一个底部 Composer；idle/terminal submit 映射为 `submit_task`，active Run submit 默认映射为 `steer`。用户可以在同一 Composer footer 把 delivery mode 切换为 `FOLLOW-UP`。切换只改变 delivery metadata，不创建第二输入区、不改变 draft value/revision identity，也不新增常驻 Queue workspace。

```text
idle / terminal                    active Run
draft -> submit_task               draft + STEER -> durable steering queue
                                     │
                                     └ toggle footer only
                                       draft + FOLLOW-UP -> durable follow-up queue
```

提交协议分成两个 ack：

1. controller 以 Composer revision 和 command ID 提交；active Run 通过 `CodingRunHandle.dispatch()` 进入 durable queue；
2. queue admission ack 为 `accepted` / `already_applied` 后，controller 才按原 revision 清空 Composer；失败、conflict 或 Run race 均保留原 draft；
3. Transcript 立即以 stable queue command ID 显示 `queued` user message；
4. Run loop 在下一个 safe point 消费 steering/follow-up；application event/ack 把同一消息更新为 `delivered`，不得追加重复消息；
5. queue edit/cancel 必须携带 target command ID 与 expected revision。CAS conflict 或拒绝不覆盖 durable 原文，并产生 `QUEUE_REVISION_CONFLICT` / `QUEUE_UPDATE_REJECTED` typed diagnostic。

Composer editor policy：

- OpenTUI `Textarea` 使用 word wrap；Enter submit，Shift+Enter newline；
- history 仅在 cursor 位于首个/末个 visual row 且没有 selection 时响应 Up/Down；离开 history 时恢复导航前 draft；
- bracketed paste 先移除 ANSI，再把 CRLF/CR 统一为 LF；三行以上或超过 150 Unicode code points 的 paste 保留完整实际文本，但以 compact placeholder 表示；
- submit 读取 `plainText` 前 double-defer，允许 terminal IME composition 同步；pending submit 拒绝重入；
- `height < 12` 时沿用 V1 low-height policy：Composer editor 最少 1 行、最多 3 行，footer 保留 1 行，secondary status/hints 让位于 Transcript；
- Composer 的 durable command 只能经过 `UiIntent -> InteractiveController -> CodingSession/CodingRunHandle`，Textarea Adapter 不直接持有 Session 或 Run。

## 6. V5：Bottom blocking approval prompt

确认日期：2026-08-29

项目 owner 选择 V5-A。pending approval 不进入 sidebar 或独立 workspace，而是在 Session 底部临时替换 Composer。Transcript 保持可见和原 scroll anchor；Composer draft/value/revision 保留但不再接收 input。prompt 是 blocking surface，取得 keyboard focus，直到 application event 把 approval 标记为 resolved、stale 或 withdrawn。

默认 collapsed prompt 最多 15 行，展示 tool action、redacted resource scope、effects、risks、pending count 与 plan fingerprint prefix；用户可切 full-screen 查看完整 fingerprint 和长 plan。多个 pending approval 按 projection 的 stable approval order FIFO 显示；当前项解决后下一项重置为默认状态，全部解决后恢复进入 approval 前的 focus 和原 Composer draft。

V5-A local interaction 固定为：

| Input | 行为 |
| --- | --- |
| default focus | `Allow once` |
| Left / `h` | 选择 `Allow once` |
| Right / `l` | 选择 `Deny` |
| Enter | 发送当前选择 |
| Escape | 直接发送 `Deny` |
| Ctrl+F | collapsed/full-screen 切换 |

approval response 必须经过 `respond_approval` UiIntent，携带 stable approval ID、decision 与 exact plan fingerprint。只有 application ack 为 `accepted` / `already_applied` 且后续 semantic event 收敛后 prompt 才消失；`stale` 显示 `APPROVAL_STALE`，其他拒绝显示 `APPROVAL_RESPONSE_REJECTED`，两者都保留 prompt。Escape 永远不映射 abort；abort 是独立 Run command，approval focus scope 也不允许按键泄漏到 Composer、background surface 或 global destructive command。

## 7. Owner checkpoint 状态

| ID | 状态 | 记录 |
| --- | --- | --- |
| N1 | 已确认 | 本文第 1 节 |
| V1 | 已确认 | V1-A：stretch root、wide auto dock、narrow/regular explicit overlay |
| V2 | 已确认 | 默认 `dex` dark/light palette；可选 terminal-adaptive `system` |
| V3 | 已确认 | V3-A：semantic inline tools；mutation diff 留在 Transcript |
| V4 | 已确认 | V4-A：单一 run-aware Composer；active 默认 STEER，footer 可切 FOLLOW-UP |
| V5 | 已确认 | V5-A：bottom blocking prompt；默认 Allow once；Escape Deny；可 full-screen |
| V6 | 待确认 | diff 导航与 width matrix |
| V7 | 待确认 | executable keymap、可发现性与 conflict report |

V4–V7 确认后，本文还必须包含完整 end-to-end flows、状态矩阵、keyboard/focus/overlay 规则，以及 `CodingEvent -> TuiViewModel -> visual region -> UiIntent` 的可追踪 mapping。
