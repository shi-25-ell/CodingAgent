# 项目协作指南

本项目为个人开发项目。所有交流和文档正文使用中文，技术术语、代码标识符、命令、文件名与协议名称保留英文。

## Agent skills

### Issue tracker

项目使用 GitHub Issues 跟踪工作项，并通过 `gh` CLI 操作。详见 `docs/agents/issue-tracker.md`。

### Triage labels

项目使用五个默认 triage labels：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。详见 `docs/agents/triage-labels.md`。

### Domain docs

项目采用 single-context 文档布局，项目文档位于 `docs/`，ADR 位于 `docs/adr/`。详见 `docs/agents/domain.md`。

### Design baseline

架构、接口、实现、测试或开发计划任务开始前，读取 `docs/step1/architecture-design.md`、`docs/step1/detailed-design.md` 和 `docs/step1/development-plan.md`。三份文档分别负责 Module ownership 与依赖、Interface 与运行语义、实施顺序与质量 gate；开发计划不能降低前两份文档定义的产品完整性。

当前源码和目录状态不是需求来源。新实现以设计基线为目标；复用已有内容前，先验证它满足新 Interface、不变量和测试要求。`docs/research/` 只保存本地历史研究材料，不代表当前决定，也不作为公开文档的引用来源。

## 公开内容

上传到 GitHub 的 issue、map、代码和文档使用本项目自己的术语与独立设计，不出现本地参考项目的名称或可识别来源。参考项目只用于私下研究；含有相关名称的本地材料在清理前不得提交或上传。

发布压缩包从 clean clone 或 Git tracked files 生成，不直接打包包含 ignored local materials 的工作目录。
