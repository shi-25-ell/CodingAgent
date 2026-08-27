# Issue tracker：GitHub

本仓库的 issue 和 spec 统一存放在 GitHub Issues 中。所有操作优先使用 `gh` CLI。

## 基本约定

- 创建 issue：`gh issue create --title "..." --body "..."`；多行正文使用 heredoc 或 body file，避免丢失换行。
- 读取 issue：`gh issue view <number> --comments`，同时获取 labels；需要结构化数据时使用 `--json` 与 `--jq`。
- 列出 issue：使用 `gh issue list --state open --json number,title,body,labels,comments`，并按需要添加 `--label`、`--state` 等过滤条件。
- 评论 issue：`gh issue comment <number> --body "..."`。
- 添加或移除 label：`gh issue edit <number> --add-label "..."` 或 `gh issue edit <number> --remove-label "..."`。
- 关闭 issue：`gh issue close <number> --comment "..."`。

在仓库 clone 内运行时，根据 `git remote -v` 推断目标 GitHub repository；`gh` 通常会自动完成该解析。本仓库当前 remote 为 `shi-25-ell/CodingAgent`。

## Pull request 是否进入 triage

**PRs as a request surface：否。**

Pull request 默认不作为 feature request，也不进入 issue triage 队列。如后续需要接受外部 PR 作为请求入口，可将本项改为“是”，再使用对应的 `gh pr` 命令和相同 labels 处理。

GitHub 的 issue 与 pull request 共用编号空间。遇到无法确定类型的 `#<number>` 时，先运行 `gh pr view <number>`；失败后再运行 `gh issue view <number>`。

## Skill 操作语义

- 当 skill 要求“发布到 issue tracker”时，创建一个 GitHub issue。
- 当 skill 要求“获取相关 ticket”时，运行 `gh issue view <number> --comments`，并读取其 labels。
- 在执行写操作前，确认当前目录对应的 remote 正是目标 repository。

## Wayfinding 操作

`wayfinder` 使用一个 map issue 管理多个 child issues：

- Map：使用 `wayfinder:map` label，正文维护 Notes、Decisions-so-far 和 Fog。
- Child ticket：优先使用 GitHub sub-issues 关联；不可用时，在 map 的 task list 中加入 child，并在 child 正文顶部写明 `Part of #<map>`。
- Child 类型：使用 `wayfinder:research`、`wayfinder:prototype`、`wayfinder:grilling` 或 `wayfinder:task`。
- Blocking：优先使用 GitHub native issue dependencies；不可用时，在 child 正文顶部记录 `Blocked by: #<number>`。
- Claim：使用 `gh issue edit <number> --add-assignee @me`，并将其视为一次有状态的写操作。
- Resolve：先添加结论评论，再关闭 child，最后把结论引用补充到 map 的 Decisions-so-far。
