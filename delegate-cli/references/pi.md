# Pi coding agent：调用与能力

核对日期：2026-11-02（本机 `pi 1.2.0`，帮助与 10-14 版一致）。用本机 `pi --version`、`pi --help` 确认接口。封装脚本传 `--model` 前用 `pi --list-models` 校验 `provider/model`，`flash` 等简称按 `models.json` 解析。Pi 的提供商、模型、工具和扩展共同决定能力，不把它固定成审查器或低成本模型。

## 选调用模式

| 模式 | 适用任务 | 判定依据 |
|---|---|---|
| `--print` / `-p` | 一次执行，读取最终回答 | 退出码、stderr、最终文本和实际产物 |
| `--mode json` | 需要结构化过程事件 | 退出码加消息终态；JSONL 不是最终回答的 JSON Schema |
| `--mode rpc` | 常驻进程，需要多轮、中途 steering/abort | 用请求 ID 关联响应，并检查运行终态 |
| TypeScript SDK | 嵌入业务应用，定制工具和会话 | 使用 SDK 生命周期与错误语义 |

默认选择 print，stdin 可承载任务文本，不打开交互 UI。[CLI Integration](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli-integration.md)

```bash
pi --print --session-dir "/绝对/本任务会话目录" \
  < "/绝对/任务.md" > "/绝对/结果.md" 2> "/绝对/错误.log"
```

Pi 可读写文件、运行命令、使用不同提供商模型、Skills、扩展和 MCP。按需指定 `--model` 和 `--thinking`，不假设某个模型 ID 在所有提供商都存在。可通过 `pi --list-models` 核对目录，但目录存在不等于认证和额度可用。[CLI Reference](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md)

## 会话和扩展

保留任务专属 session 目录，用其中实际生成的 JSONL 路径执行 `pi --print --session /确切/会话.jsonl` 续接。不要使用 `--continue` 猜最近会话。需要后续沟通时不要加 `--no-session`。[Sessions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sessions.md)

默认保留用户扩展。`--no-extensions` 还可能关掉提供商或保护逻辑，不能作为通用“加速”参数。`--tools read,grep,find,ls` 可限制声明给模型的普通工具；当前版本还需关注 MCP 的独立选择规则。

非交互运行无法弹出项目 trust 提示；尚未信任的项目资源可能被跳过，导致和手动 Pi 能力不同。先查明依赖哪些资源，沿用已有信任；仅在已有授权覆盖该项目配置时使用一次性 `--approve`。封装脚本对应 `--pi-trust approved`；`--pi-trust skip` 对应 `--no-approve`，默认 `existing` 不传任何信任参数。脚本不会替用户写信任配置。[Security](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md)

Pi 没有默认操作系统沙箱。工具筛选、cwd、项目 trust 和 worktree 都不能替代沙箱；扩展本身仍是本机代码。需要硬性只读或隔离时用已配置的外部隔离环境，或改用 Codex 沙箱。

## 结果判定

print 的 error、aborted、输出长度截断会以非零状态结束，仍可能留有部分文本。JSON 模式的模型错误未必导致进程非零；检查最终 assistant `message_end.message.stopReason` 与 `errorMessage`。新版本 `agent_settled` 表示自动重试/后续工作结束；`agent_end` 可能还会重试。不要把工具调用消息、增量 token 或低层 agent_end 当最终成功。[JSON events](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md)

封装脚本从会话文件里本次新增的 assistant 消息累加 `usage`（含 `cost.total` 美元成本），写进 `run.json`。Pi 同样没有思考事件和逐字片段：面板的 `activity` 只在工具执行（`tool`）与等待（`waiting`）之间切换，`live_text` 恒为空。

需要实时双向交互时再用 [RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)。CLI 子任务本身通常只需“发任务—等结束—读结果—明确续接”。
