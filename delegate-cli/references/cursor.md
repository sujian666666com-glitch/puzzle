# Cursor CLI：调用与能力

核对日期：2026-11-02，本机 `cursor-agent 2026.10.22-27dcf5f`。以本机 `cursor-agent --help`、`cursor-agent models` 为执行依据；可执行文件也叫 `agent`，脚本固定用 `cursor-agent`。

## 常规任务

封装脚本实际执行（任务走 stdin，不进 argv，避免出现在进程列表里）：

```bash
cursor-agent --print --output-format stream-json --model grok-4.7-medium \
  --mode ask            # 只读；可写任务改为 --force
  [--trust]             # 仅 --cursor-trust approved 时
  [--resume 会话ID]     # 续接
```

- **模型**：`cursor-agent models` 列出账号可用 ID。思考强度编码在 ID 里（`grok-4.7-low/medium/high/xhigh`，以及 `-fast` 变体），没有单独参数；脚本把 `--model grok4.7 --thinking 中` 解析成 `grok-4.7-medium`：在目录里找同一模型族、同一快慢档（`-fast`）的对应档位，能处理 `extra-high`、`none`、`-thinking` 尾缀等写法。不同模型族的档位不同（grok-4.7 只有 low/medium/high/xhigh，没有 max），缺的档位会报错并列出可用档。带方括号参数的 ID（如 `claude-opus-4-8[effort=high]`）原样放行，此时不要再传 `--thinking`。默认模型见 skill 根目录 `models.json`。
- **只读**：`--mode ask` 是 Cursor 的只读问答模式（只给读取类工具）；shell 命令受 `~/.cursor/cli-config.json` 的 allowlist 约束（`approvalMode: allowlist`），无头模式下不在名单里的命令会被拒绝。它是工具选择，不是操作系统沙箱。审查任务请直接提供冻结的 diff 文件，别指望它能跑 `git diff`。
- **可写**：`--force` 让编辑落盘、命令在未被配置显式拒绝时执行。是否走沙箱取决于用户 Cursor 配置的 `sandbox.mode`，脚本不改；需要强隔离时用 Codex 沙箱或外部隔离环境。

## 工作区信任

无头模式下目录未被信任时立即退出（stderr `Workspace Trust Required`），脚本把它标成 `blocked` 并提示。`--trust`、`--yolo`、`-f` 都会跳过该确认：

- 只读任务默认不信任；只有用户授权信任该目录时加 `--cursor-trust approved`。
- 可写任务的 `--force` 本身就隐含信任，派发写任务等于让 Cursor 在该目录执行代码，选目录时要和授权范围一致。

MCP 服务器在无头模式下需要 `--approve-mcps` 才会自动启用；脚本默认不加，需要时核对本机帮助后手动评估。

## 事件与结果判定

`stream-json` 每行一个事件：

| type | 用途 |
|---|---|
| `system` / `init` | `session_id`（即 chatId，续接用）、模型显示名 |
| `assistant` | 回复文本；带 `--stream-partial-output` 时同一段会先来若干逐字片段，再来整段，见下文 |
| `tool_call` started/completed | `readToolCall`、`shellToolCall`、`editToolCall` 等；结果在 `result.success`，shell 带 `exitCode` |
| `thinking` | 推理增量/delta 与完成的 completed，只用于把 `activity` 切成 thinking，文本不展示 |
| `result` | `subtype: success`、`is_error`、`usage`（`inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens`） |

- 脚本固定加 `--stream-partial-output`，所以 `assistant` 事件分两种：带 `timestamp_ms` 且没有 `model_call_id` 的是逐字片段；带 `model_call_id`、或两者都没有的是整段。片段只累加进 `run.json` 的 `live_text`（面板据此显示“输入中”气泡），整段到达时清空；`progress.log` 每整段一行，`result.md` 取最后一个整段。
- `result.result` 把所有分段拼在一起（含“我先读一下…”之类的过程话），因此不采用它，取最后一段与 Codex 的 last message 对齐。
- 成功判定：退出码 0、出现 `result` 且 `is_error` 为 false、`result.md` 非空。失败时看 `stderr.log`。
- 用量换算：`input_tokens = inputTokens + cacheReadTokens + cacheWriteTokens`，与 Codex 的口径一致。

## 会话

用 `--resume <session_id>` 续接（2026-11-02 实测可保留上下文）；不要用 `--continue`、`resume`（最近一次）或 `ls` 选择器。`-w/--worktree` 会在 `~/.cursor/worktrees/` 自建 worktree，和本 Skill 自管 worktree 的方式混用会让文件所有权不清，默认不用。
