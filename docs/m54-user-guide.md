# Dex Code CLI 与 extension 使用说明

Dex Code 使用 Bun 运行，生产 CLI executable 为 `dex`。源码入口可通过 `bun run start:source` 启动。

## CLI

```text
dex                                  # interactive TUI
dex --print "完成一个明确任务"        # non-interactive
dex session list|new
dex session open|resume <session-id>
dex session branch <session-id> [branch-id]
dex models list
dex skills list
dex extensions list|diagnose
dex doctor
```

Run override 包括 `--provider`、`--model`、`--permission`、model budget、tool、extension 和 skill。配置优先级固定为：默认值 < user `config.json` < project `.dex/config.json` < `DEX_*` environment < CLI。user config 位于 `DEX_DATA_HOME/config.json`；未设置 data home 时使用平台 data directory。Bun workspace `.env` 不会被自动导入。

配置文件只接受 `provider`、`model`、`permissionMode`、`maxModelTurns`、`maxModelAttempts`、`maxRetries`、`tools`、`extensions` 和 `skills`。未知字段和非法值会 fail closed。

## Trusted local extensions

Extension 使用 versioned `coding-agent.extension.json` manifest，并且必须显式 enable。默认 discovery 位置为 user data directory 下的 `extensions/` 和 project `.dex/extensions/`；也可以通过 `--extension <id-or-path>` 指定。

Extension 是 trusted local code，不是 sandbox，但只取得 versioned registration API。extension tool 仍经过 core ToolHost 的 schema validation、hard guard、approval、settlement 和 evidence 流程。

[`examples/sample-extension`](../examples/sample-extension) 展示一个同时贡献 `sample_echo` tool 与 `sample.echo` skill source 的独立 extension。
