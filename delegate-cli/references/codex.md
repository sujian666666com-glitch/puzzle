# Codex CLI：调用与能力

核对日期：2026-11-02（本机 `codex-cli 0.166.0`，exec/resume 帮助与 10-14 版逐字一致）。以用户机器的 `codex --version`、`codex exec --help`、`codex exec resume --help` 为执行依据。以下是官方文档当前接口，不代表旧版均支持。

封装脚本传 `--model` 前用 `codex debug models` 的目录校验 slug 和该模型支持的思考档位（`supported_reasoning_levels`），`astra` 这类简称按 `models.json` 解析成 `gpt-6-astra`。非 Git 且未信任的目录会被拒绝（`Not inside a trusted directory`）；确属预期时给脚本加 `--skip-git-check`，对应 `codex exec --skip-git-repo-check`，它不放宽沙箱。

## 常规任务

用 `exec` 做代码调查、实现、修复、测试或带自定义要求的审查。它默认不启动交互界面，可读取 stdin。`--json` 输出过程事件；`-o` 将最终回答另存；两者配合便于只向主控返回简短结果。[官方非交互文档](https://developers.openai.com/codex/non-interactive-mode)

```bash
codex exec --sandbox workspace-write -c 'approval_policy="never"' \
  --json -o "/绝对/结果.md" - < "/绝对/任务.md" \
  > "/绝对/事件.jsonl" 2> "/绝对/错误.log"
```

这条命令在指定的项目工作目录执行。只读分析改用 `--sandbox read-only`；需要生成测试缓存或构建产物时用 workspace-write。默认保留认证、模型、规则和插件配置；不要继承“父 Claude 能访问，所以子 Codex 一定能访问”的假设。

## 会话与审查

从 JSONL 的 `thread.started.thread_id` 保存确切会话 ID。按原 cwd 执行 `codex exec ... resume SESSION_ID -`，把后续任务送入 stdin。并行工作不要用 `--last`。需要独立方案时可以开新会话；新版 `exec fork` 的支持先查本机帮助。[命令参考](https://developers.openai.com/codex/developer-commands)

专门代码审查可用 `codex review --uncommitted`、`codex review --base BRANCH` 或 `codex review --commit SHA`，每次选择一个目标。自定义 prompt 与目标选项的组合先查 `codex review --help`，不要拼接未支持的参数。

输出验收同时检查退出码、最后一轮是否 `turn.completed`、最终答复和实际 diff。`turn.completed.usage` 的 token 计数会累加进 `run.json` 的 `usage`（`input_tokens` 已含缓存）。出现 `turn.failed`、错误或空结果时不能仅凭有文件就宣布成功；`turn.completed` 也不等于业务功能通过。

## 能力与边界

`exec --json` 没有思考增量，也没有逐字片段：面板的 `activity` 只在工具执行（`tool`）与等待模型（`waiting`）之间切换，`live_text` 恒为空。

Codex 可使用仓库规则、Skills、已配置 MCP、图像输入以及其环境允许的工具；模型和客户端配置决定实际可用项。脚本仅封装常规文字任务；需传图、指定输出 JSON Schema 或调用 review 时，核对本机帮助后直接使用原生命令，并沿用任务隔离、日志和验收要求。

当前文档已移除 `--full-auto` 和 `codex mcp-server`。不要照旧教程把它注册成 Claude 的 MCP server。需要长连接、过程事件、审批交互和中途控制时，评估 [Codex app-server](https://developers.openai.com/codex/app-server)；普通 Skill 默认用 exec。

`--sandbox` 是本地执行边界；`approval_policy="never"` 使越界操作失败，不是解除边界。MCP/远端服务的权限要单独评估。[权限与沙箱](https://developers.openai.com/codex/agent-approvals-security)
