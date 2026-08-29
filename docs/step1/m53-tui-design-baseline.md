# Dex Code M5.3 TUI design baseline

> 状态：已完成 owner checkpoint。本文是 M5.3 的 owner-confirmed design record；N1、V1-A、V2、V3-A、V4-A、V5-A、V6-A 与 V7-A+ 均已确认。后续实现不得静默改变命名体系、信息架构、主要 interaction flow 或 executable keymap。

## 1. N1：产品、CLI 与 namespace 命名

确认日期：2026-08-29

项目 owner 将 “Dex Code” 定义为品牌名，而不是必须替换全部技术术语的 namespace。品牌 Interface 与内部实现 seam 分离如下：

| Surface                       | 决定                              | 说明                                               |
| ----------------------------- | --------------------------------- | -------------------------------------------------- |
| Display name / wordmark       | `Dex Code`                        | TUI title、welcome、help/about、对外文档与截图使用 |
| CLI executable                | `dex`                             | usage、shell completion 与 release bin 使用        |
| Environment namespace         | `DEX_*`                           | model、provider、credential、data home 等用户配置  |
| Project config/data directory | `.dex`                            | project credential、project skill 等用户可见目录   |
| User data directory           | Unix `dex`；Windows `Dex Code`    | 遵循各平台 data root 约定                          |
| Package scope                 | `@coding-agent/*`                 | 保持技术 namespace；不为品牌做无收益的全仓改名     |
| Code identifiers              | `CodingAgent`、`CodingSession` 等 | 保持准确的领域/技术命名                            |
| Extension contract namespace  | `coding-agent`                    | 表达技术协议，不强制 extension ID 使用品牌前缀     |

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

| Token group                                                   | 角色                                                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `primary`                                                     | blue；focus、selection、主要交互、Markdown link 与部分关键状态                                    |
| `secondary`                                                   | green；completed execution、positive state、diff add 与部分 code/command semantics                |
| `accent`                                                      | light purple；reasoning、agent-related secondary emphasis、Markdown heading 与少量高层级 metadata |
| `info/success/warning/error/pending`                          | blue/cyan、green、amber/yellow、soft red、muted purple/gray                                       |
| `background/backgroundPanel/backgroundElement/backgroundMenu` | 接近黑或接近白的 neutral surface steps，仅作轻微明度区分                                          |
| `text/textMuted/textSubtle/textDisabled`                      | neutral text hierarchy；普通正文不使用品牌色                                                      |
| `border/borderActive/borderSubtle/focus`                      | neutral border hierarchy；focus 使用 primary blue                                                 |
| Markdown / syntax                                             | 从完整 semantic roles 映射的克制多色 system，不为每个 tool 分配独立强色                           |
| diff                                                          | add=green、remove=soft red、context=neutral、hunk=info；background 使用低强度 tint                |

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

| Tool family                 | 默认呈现                                                                        |
| --------------------------- | ------------------------------------------------------------------------------- |
| read / grep / glob / search | compact semantic inline row                                                     |
| shell / command             | inline output block；默认约 10 行，超出后 expand/collapse                       |
| generic tool                | compact summary；raw output 默认隐藏，可单独全局开启；开启后默认约 3 行 preview |
| edit / apply_patch          | 有 structured diff metadata 时直接在 Transcript 渲染 inline diff                |
| write                       | 根据 metadata 使用 compact row 或 syntax-aware code/diagnostic block            |

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

| Input         | 行为                       |
| ------------- | -------------------------- |
| default focus | `Allow once`               |
| Left / `h`    | 选择 `Allow once`          |
| Right / `l`   | 选择 `Deny`                |
| Enter         | 发送当前选择               |
| Escape        | 直接发送 `Deny`            |
| Ctrl+F        | collapsed/full-screen 切换 |

approval response 必须经过 `respond_approval` UiIntent，携带 stable approval ID、decision 与 exact plan fingerprint。只有 application ack 为 `accepted` / `already_applied` 且后续 semantic event 收敛后 prompt 才消失；`stale` 显示 `APPROVAL_STALE`，其他拒绝显示 `APPROVAL_RESPONSE_REJECTED`，两者都保留 prompt。Escape 永远不映射 abort；abort 是独立 Run command，approval focus scope 也不允许按键泄漏到 Composer、background surface 或 global destructive command。

## 7. V6：Full-screen Diff Viewer

确认日期：2026-08-29

项目 owner 选择 V6-A。单次 `edit` / `apply_patch` 继续在 Transcript 中呈现 inline diff；session、working-tree 或 branch 的综合审阅进入 dedicated full-screen Diff route。Diff route 是按需 secondary UI，不改变 Session 的 Transcript-first 信息架构，也不在 Session 中建立第二个长期 workspace。

Diff route 的 product-owned navigation state 全部属于 UI-local state：当前 source、file-tree visibility、file/patch selection、all/single patch mode、reviewed markers、expanded directories、hunk selection、scroll anchor、focus 和 split/unified override。diff content 来自 application query/projection 提供的 redacted structured model；renderer 不执行 Git、不读取 workspace 文件，也不拥有 evidence truth。

V6-A 固定交互能力为：

- source 支持 working tree、branch 和 last turn；source 切换通过按需 dialog 完成；
- 左侧使用 32-column file tree，显示 created/modified/deleted、reviewed marker 与 additions/deletions；file tree 可以隐藏；
- patch pane 默认连续显示全部 changed files，可切 single-patch mode；支持 previous/next file、previous/next hunk 和 mark reviewed；
- patch 使用 syntax highlighting、line numbers、char wrap 与 add/remove semantic styling；缺失 patch 时显示 typed empty/unavailable state；
- patch pane 可用宽度至少 100 columns 且未配置 `stacked` 时默认 split，否则 unified；显式 view override 仅在 split 可用时生效；
- resize 重新计算 placement/view，不丢失 source、selection、reviewed state、hunk identity 或 scroll anchor；
- 关闭 route 后恢复进入前的 Session focus、Transcript scroll 与 Composer draft；blocking approval 可以临时取得 route 上方 focus，解决后返回原 Diff focus；
- V7 确认前只冻结 command semantics，不提前固化具体 key bindings。

宽度矩阵：

| 条件                                      | File tree       | Patch view    | 说明                                                         |
| ----------------------------------------- | --------------- | ------------- | ------------------------------------------------------------ |
| tree visible 且存在 files                 | 32 columns      | 剩余宽度      | narrow 下不转为 Session side panel；用户可隐藏 tree 释放空间 |
| patch columns `< 100`                     | 可见或隐藏      | unified       | split override 暂时失效，但 preference 保留                  |
| patch columns `>= 100`、default           | 可见或隐藏      | split         | `stacked` preference 除外                                    |
| patch columns `>= 100`、explicit override | 可见或隐藏      | split/unified | override 是 UI-local preference                              |
| no files / loading / failure              | 按 source state | typed state   | 不伪造空 diff，也不自行读取 repository                       |

## 8. V7：Scoped hybrid keymap

确认日期：2026-08-29

项目 owner 选择 V7-A+。Dex Code 使用显式 command registry、scope/mode stack 与固定 precedence；component registration order 不参与冲突裁决。`Ctrl+X` 是 2 秒 timed leader，`Ctrl+P` 打开 command palette，`<leader>p` 是 terminal compatibility fallback。which-key 默认隐藏，仅按需打开；command palette、route footer 与 route-local `?` help 是默认 discoverability 入口，不建立常驻快捷键 panel。

Composer 使用独立 managed Textarea scope。cursor、selection、newline、history 与 edit-buffer command 优先于 route/global binding；Enter submit，Shift+Enter newline。config load 必须分析最终 resolved bindings，产生 typed `duplicate`、`shadowed`、`unreachable` 与 `textarea conflict` report；禁止依赖后注册覆盖先注册或静默 last-write-wins。

Escape precedence 固定为：

```text
pending sequence
  -> top overlay/dialog
  -> Approval
  -> Diff
  -> Composer local state
  -> compatibility double-Escape detector
```

单次 Escape 永远不触发 Run abort。Run abort 的 canonical binding 是 `<leader>i`。`Esc Esc` 只作为 compatibility abort：必须存在 active Run、两个 Escape 在 bounded interval 内到达，并且两次都未被更高 scope 消费；Approval、Diff、dialog/overlay 或 Composer local state 一旦处理 Escape，compatibility sequence 立即清除。

确认的 direct bindings：

| Scope      | Binding               | Command semantics                       |
| ---------- | --------------------- | --------------------------------------- |
| Global     | `Ctrl+P`, `<leader>p` | command palette                         |
| Run        | `<leader>i`           | abort active Run                        |
| Diff       | `Tab`                 | files/patches focus                     |
| Diff       | `[`, `]`              | previous/next hunk                      |
| Diff       | `p`, `n`              | previous/next file                      |
| Diff       | `b`, `s`, `d`, `v`    | tree、single patch、source、view toggle |
| Diff       | `?`                   | route help                              |
| Diff       | `q`, `Esc`            | close route                             |
| Transcript | `PgUp`, `PgDn`        | page scroll                             |
| Transcript | `Home`, `End`         | first/last                              |
| Approval   | V5-A bindings         | blocking decision scope                 |
| Composer   | Enter / Shift+Enter   | submit / newline                        |

scope precedence 使用固定 numeric policy，仅用于 deterministic dispatch；视觉 z-index 仍由 surface policy 管理。blocking Approval 禁用 session/global destructive command。Diff route 可以使用 global/session non-blocking commands，但自己的 direct bindings优先。command palette 只展示当前 context 中 active/reachable command 和 resolved binding；disabled 或 unreachable command 必须带 diagnostic，不伪装为可执行项。

## 9. Owner checkpoint 状态

| ID  | 状态   | 记录                                                                                         |
| --- | ------ | -------------------------------------------------------------------------------------------- |
| N1  | 已确认 | 本文第 1 节                                                                                  |
| V1  | 已确认 | V1-A：stretch root、wide auto dock、narrow/regular explicit overlay                          |
| V2  | 已确认 | 默认 `dex` dark/light palette；可选 terminal-adaptive `system`                               |
| V3  | 已确认 | V3-A：semantic inline tools；mutation diff 留在 Transcript                                   |
| V4  | 已确认 | V4-A：单一 run-aware Composer；active 默认 STEER，footer 可切 FOLLOW-UP                      |
| V5  | 已确认 | V5-A：bottom blocking prompt；默认 Allow once；Escape Deny；可 full-screen                   |
| V6  | 已确认 | V6-A：full-screen route、32-column file tree、all/single patch、responsive split/unified     |
| V7  | 已确认 | V7-A+：Ctrl+X leader、Ctrl+P/leader-p palette、scoped direct bindings、typed conflict report |

N1 与 V1–V7 已全部确认。以下 flow、状态矩阵和 mapping 冻结 M5.3 的结构性设计；后续未决项只允许是 token 级 polish。

## 10. End-to-end flows

### 10.1 Session 与 Run

1. `dex` 在当前 workspace 创建 Session，projection 先产生 idle `TuiViewModel`；root 以 stretch layout 渲染 Transcript 与唯一 Composer。
2. idle Composer submit 发出 `submit_composer`，controller 依据 projection 状态执行 `submit_task` 语义并绑定新 Run；用户消息立即进入 Transcript。
3. Run 的 reasoning、assistant stream、tool lifecycle 与结果经 `CodingEvent` reducer 增量进入同一 Transcript；用户向上滚动后保持 anchor，并显示 unseen count，不强制跳到尾部。
4. active Run 中 Composer footer 默认显示 `STEER`；提交先取得 durable queue admission ack，再清空同一 draft。safe point application ack 到达后，queued row 转为 applied/rejected；`FOLLOW-UP` 只改变 delivery，不创建第二 Composer。
5. completed/failed/aborted Run 产生 terminal report；Composer 回到 task submit 语义，Transcript 与 scroll position 保留。

### 10.2 Tool、Approval 与 Diff

1. read/search 类 tool 投影为 compact semantic row；shell 是有限高度 inline output；带 metadata 的 edit/apply patch 直接显示结构化 inline diff。
2. permission request 出现时，bottom blocking Approval 获得 input；默认 `Allow once`，`Esc` 为 `Deny`，可切换 full-screen。响应 ack 后恢复此前 focus。
3. 单次 edit diff 始终属于 Transcript；综合审阅通过 `open_diff_viewer` 进入 full-screen Diff route。Diff 内维护 file/tree/hunk/view/scroll UI-local state，关闭后回到 Session。
4. queue CAS conflict、tool failure、renderer/keymap conflict 均保留原始信息并产生 typed diagnostic；failure summary 不因隐藏 completed tool details 而消失。

### 10.3 Terminal lifecycle

1. interactive entry 先验证 TTY，再进入 alternate screen；renderer、controller 和 Solid composition 只有一个 lifecycle owner。
2. resize 只发出 `terminal_resized`，由 layout policy 决定 sidebar dock/overlay/hidden 与 low-height chrome；不改变 durable Session。
3. normal quit、external abort、signal、startup failure 与 fatal error 都汇合到幂等 renderer stop；restore 失败输出 typed diagnostic，不静默退出。

## 11. UI 状态矩阵

| Durable / local 状态 | 主视觉 | Composer | input owner | 退出/恢复 |
| --- | --- | --- | --- | --- |
| idle Session | Transcript + Composer | `TASK` | Composer | submit 启动 Run |
| active Run | Transcript inline stream/tools | `STEER` 或 `FOLLOW-UP` | Composer | `<leader>i` abort |
| queued message | Transcript queued row | admission ack 后清空 | Composer | application ack 更新 row；CAS failure 保留文本 |
| pending Approval | bottom blocking prompt | 可见但不可输入 | Approval | decision ack 后恢复 return focus |
| Diff route | full-screen multi-file Diff | 不显示 | Diff | `q`/`Esc` 返回 Session |
| docked sidebar | Session + lightweight sidebar | 正常 | 当前 Session focus | toggle/hide，不挤压为第二 workspace |
| sidebar overlay | 覆盖 Session 右侧 | 背景不可输入 | overlay | `Esc` 关闭并恢复 focus |
| palette/dialog/which-key | temporary secondary surface | 背景不可输入 | top surface | `Esc` 关闭 top surface |
| recoverable diagnostic | inline/banner diagnostic | 正常 | 原 scope | dismiss 后保持 route |
| fatal diagnostic | blocking fatal surface | disabled | fatal dialog | quit 并 restore terminal |

状态 ownership 固定为：Session/Run/queue/approval/report 是 durable application truth；focus、surface stack、Composer draft、expanded rows、viewport、Diff navigation、sidebar 与 theme 是 interactive local state。renderer 不持有第二份业务状态。

## 12. Focus、overlay 与 keyboard precedence

surface priority 固定为 `fatal error > command palette/which-key > dialog > Approval > overlay > Diff > Session`。每次 projection/local state 更新后，同一 `surface-policy` 同时计算 render layer、focus target 与 keymap modes；不得依赖 component registration order。

`Esc` 按 `pending leader sequence -> top overlay/dialog -> Approval -> Diff -> Composer local state` 消费。active Run 的 canonical abort 是 `<leader>i`；兼容 `Esc Esc` 仅在更高 scope 均未消费时成立。managed Textarea scope 优先处理 cursor、selection、newline、visual-row history 与 paste；route/global binding 不得抢占这些键。

## 13. Semantic mapping

| `CodingEvent` / truth | `TuiViewModel` | visual region | emitted `UiIntent` |
| --- | --- | --- | --- |
| Session snapshot / branch change | `session`、`transcript` | compact status、Transcript | `select_branch`、`fork_branch` |
| Run started / phase / stream delta | `activeRun`、assistant stream | status、streaming Markdown | `abort_run`、`send_run_message` |
| user/assistant/terminal timeline | `transcript` | Transcript blocks | viewport/expand local intents |
| tool requested/running/completed/failed | `tools` | semantic inline row/block/diff | expand/tool visibility local intents |
| approval requested/resolved | `approvals` + `ui.approvalPrompt` | blocking Approval | `respond_approval`、approval local intents |
| queue admitted/applied/rejected | `queues` + Transcript row | queued status、typed diagnostic | `update_queue`（revision-aware CAS） |
| context manifest/derivation | `context` | lightweight sidebar/overlay | sidebar/surface local intents |
| Run terminal report | `terminalReport` | Transcript terminal summary/report overlay | surface local intents |
| renderer/keymap/controller failure | `diagnostics` | diagnostic/fatal surface | `report_diagnostic`、`dismiss_diagnostic` |
| terminal resize/focus | `ui.terminal`、`ui.focusedRegion` | responsive root/surface | `terminal_resized`、`focus_region` |

实现 seam 固定为 `CodingEvent -> framework-independent projection -> TuiViewModel -> OpenTUI presentation -> UiIntent -> InteractiveController`。OpenTUI types 不得越过 presentation Module；Solid component 只接收 `TuiViewModel` 并只发出 `UiIntent`。
