# Domain docs

本文规定工程 skills 在探索和修改代码前，如何读取本项目的 domain documentation。

## 文档布局

本项目采用 single-context 布局：

```text
/
├── CONTEXT.md
├── docs/
│   ├── agents/
│   └── adr/
└── src/
```

- 项目文档统一放在 `docs/`。
- Domain glossary 与核心概念放在仓库根目录的 `CONTEXT.md`。
- Architecture Decision Records 统一放在 `docs/adr/`。
- ADR 文件建议使用 `NNNN-short-title.md` 格式，例如 `0001-use-sqlite-for-local-storage.md`。

`CONTEXT.md` 与具体 ADR 按需创建，不需要为了满足目录结构而提前生成空文档。

## 开始探索前

1. 如果根目录存在 `CONTEXT.md`，先阅读其中与当前任务相关的术语和边界。
2. 阅读 `docs/adr/` 中与当前修改范围相关的 ADR。
3. 如果这些文件暂时不存在，继续执行任务，不把缺失本身视为错误，也不主动生成无内容的占位文档。

## 使用 glossary 中的术语

当 issue 标题、refactor proposal、hypothesis、test name 或代码设计涉及 domain concept 时，使用 `CONTEXT.md` 中定义的术语，避免改用 glossary 明确排除的同义词。

如果所需概念尚未进入 glossary，先判断它是项目中真实存在的语言缺口，还是实现过程中临时创造的不必要术语。确认属于真实缺口后，再通过 `domain-modeling` 补充。

## 标记 ADR 冲突

若计划或实现与现有 ADR 冲突，必须明确指出冲突，不得静默覆盖原有决策。例如：

> 与 ADR-0007（event-sourced orders）冲突，但由于新的性能数据，建议重新评估该决策。

需要改变既有决策时，新建一份 ADR，并在新旧 ADR 中记录 supersede 关系。
