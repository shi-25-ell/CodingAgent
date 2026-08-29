# M5.2 Frontend event 与 projection seam

M5.2 建立了 renderer-independent 的单向链路：

```text
Agent / Session durable truth
  -> versioned CodingSemanticEvent + CodingProgressEvent
  -> reduceProjection()
  -> immutable CodingProjection
  -> selectTuiViewModel()
  -> print / future interactive mode
```

本阶段不包含 OpenTUI renderer、布局、颜色、focus 或 terminal lifecycle 实现。

## Event contract

`CodingSemanticEvent` 使用每个 Run 独立的 monotonic `sequence` 和稳定 `eventId`。它覆盖 Run、user、committed assistant、tool lifecycle、approval lifecycle、queue、context、compaction、recovery、model failure、Session revision 和 terminal `RunReport`。Semantic event 不合并；重复 sequence 幂等，gap 会使 projection 标记 `requiresSnapshot`。

`CodingProgressEvent` 使用稳定 `key` 和 monotonic `revision`。Assistant text/reasoning delta 的 key 包含 Model Turn、Model Attempt、channel 与 part index；tool progress 按 call ID 合并。Pending progress key 数量有固定上限，慢消费者只看到每个 key 的最新值，不影响 semantic replay。

Assistant delta 只形成 transient `assistantStream`。`assistant_committed` 到达后，canonical `AssistantMessage` 替换 transient stream；重新打开 Session 时只从 durable message 重建。Terminal semantic event 到达后，progress 不再改变 Run 状态。

## Snapshot/live join

`CodingRunHandle.snapshot()` 返回 `CodingSessionSnapshot` 与 `CodingEventCursor`。实现先捕获 cursor，再读取 durable snapshot，并把 cursor 之前的 application semantic/progress 状态合入 snapshot；调用方随后用 `events(cursor)` 消费 live event。因此 inspect 与 subscribe 之间发生的 semantic transition 会被 snapshot 或 replay 至少覆盖一次，reducer 的 stable identity/sequence 去重负责消除重复。

`CodingSession.snapshot()` 用 durable branch records、queue、context manifests、derivations、checkpoints 和 terminal reports 重建 projection input。最终 live projection 与 close/reopen 后 snapshot 选择出的 `TuiViewModel` 相同。

## Application Interface

Frontend 只使用 `CodingAgent`、`CodingSession`、`CodingRunHandle`、projection 和 mode Interface：

- model catalog、availability 与 per-Run immutable `RunConfigSnapshot`；
- Session/branch snapshot、RunReport、queue、context/compaction 和 recovery；
- start/resume、select/fork、steer/follow-up、queue edit、permission response 与 abort；
- `InteractionModeRegistry` 的 deterministic register/resolve/list；
- print mode 通过同一 snapshot/event/projection seam 读取 terminal report。

`Agent`、`AgentHarness` 和 Session persistence 仍拥有各自的通用运行、durability 与恢复语义；projection 不读取 SQLite、不接触 provider transport、ToolHost implementation 或 renderer object，也不成为第二套事实来源。

## Deterministic evidence

主要自动化证据覆盖 reducer transition table、duplicate/gap、retry stream reset、并发 tool identity、approval、queue revision conflict、context/compaction、recovery、terminal late progress、slow/multiple subscribers、dispose、snapshot/live join、Session reopen 和 print projection path。并发与 lifecycle 测试使用 controllable stream、manual clock 或 barrier，不依赖 `sleep` 推测顺序。
