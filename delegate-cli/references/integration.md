# Claude 接入选择

## 安装与触发

把整个 `delegate-cli` 目录放在 Claude Code 本机的 `~/.claude/skills/delegate-cli/`，或项目的 `.claude/skills/delegate-cli/`。保留 scripts、references 与 `models.json` 的相对位置。主入口只需标准 name/description；无需固定 Claude 模型、放宽工具权限或给调度 Skill 加 `context: fork`。

在 Claude Code 输入：

```text
/delegate-cli 检查当前项目的鉴权问题，按需调用 Codex、Pi 和 Cursor，修复后做端到端验证。
```

默认留在主会话，使 Claude 继续掌握完整目标；独立 CLI 的内部日志写文件，按需读取。`context: fork` 会把 Skill 放进新的 Claude 子 Agent，该子 Agent 不自动拥有当前完整对话，通常不适合作为总调度默认值。[Claude Skills](https://code.claude.com/docs/en/skills)

## 接入层选择

| 需求 | 建议 |
|---|---|
| Claude 一次委派、收回、继续 | 本 Skill：Bash 调用 Codex exec / Pi print / Cursor print |
| 少量独立任务同时工作 | Claude 后台 Bash + 唯一任务目录 + 文件所有权/worktree |
| 读取大量过程事件 | Codex JSONL、Pi 会话 JSONL、Cursor stream-json，分别解析各自事件语义 |
| 用户实时看进度 | 桌面 App 右侧 Background tasks（runner 把进度逐行写到 stdout）；进度面板 mod（下文）；终端 `watch` |
| 常驻、实时改任务、取消、双向审批 | Codex app-server / Pi RPC，单独建设协议适配器 |
| 产品内调度、可视化任务队列 | 对应 SDK/server，超出这个轻量 Skill 的范围 |

上述是基于接口的工程选择，不是模型能力排名。后台任务要使用宿主真正提供的状态/结果工具，不虚构后台工具名称；不要仅加 `&` 后就结束会话。[Claude Bash](https://code.claude.com/docs/en/tools-reference)、[Codex app-server](https://developers.openai.com/codex/app-server)、[Pi integration](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli-integration.md)

## 脚本边界

`run_cli.py` 使用 Python 标准库，以 argv 数组和 stdin 调用真实 CLI。保留认证环境；不读取/打印 token，不自动改配置。`doctor` 只核对可执行文件和帮助（`--models` 另列模型目录），不证明账户、模型或网络已可用。`--dry-run` 把计划写进 `run.json`（`status: planned`，退出码 0），不调用模型，也不代表已执行或端到端成功。

传了 `--model`（Cursor 总是）时，脚本先按 `models.json` 解析简称和中文思考强度，再用 `codex debug models`、`pi --list-models`、`cursor-agent models` 校验；列表取不到时只做别名替换，并在 `run.json` 的 `model_check` 里写明。结果另记 `claude_session_id`（派发它的 Claude 会话，面板据此筛选）、`usage`（token 用量）和 `watch_command`。

`run.json` 还记 `title`（任务名，来自 `--title`，不传时取「目标：」行，超过 40 字截断）、`goal`（交接里的「目标：」行）、`handoff_file`（交接原文 `handoff.md` 的绝对路径）、`activity`（`{kind: thinking|tool|writing|waiting, label, since}`，结束置 null）和 `live_text`（Cursor 尚未成段的逐字文本，其他 Agent 恒为 `""`）。运行目录里 `task.md` 是实际发送给 CLI 的全文（前面有 runner 加的两段说明），`handoff.md` 是主控写的交接原文，不要混用。

脚本保留进程退出状态、会话指针和结果；不会自动做 Git 合并、安装依赖、提交或部署。这些决定留给掌握上下文的 Claude。结果里的 `verified` 始终为 false，避免把外部 Agent 的“完成”当成主控验收。

第一次实际使用时，先以小范围只读任务验证认证、模型和工作目录，再执行真实开发任务。若本机版本不支持当前封装参数，依据本机帮助做兼容调整；禁止通过绕过权限/规则来制造成功。

## 进度面板（delegate-cli-panel）

面板是与本 skill 分开存放的 Claude Code 函数钩子插件 `delegate-cli-panel`（puzzle 仓库的 `delegate-cli-panel/` 目录）：在桌面 App 对话右侧停靠一个「子 Agent」pane，定时读取 `~/.claude/cli-runs/*/run.json` 与 `progress.log`（打开运行中的运行时每 1 秒，有运行中任务 2 秒，空闲约 10 秒）。

- 只扫描默认目录 `~/.claude/cli-runs/` 里最近 7 天的运行（`--run-root` 改过目录的看不到）。默认列出本会话派发的运行（按 `claude_session_id` 匹配），可切到“近 24 小时”（按 `cwd` 最后一段分组）；运行中的排最前，其余按时间倒序。
- 卡片以 `title` 命名（旧记录回退到交接里的「目标：」行），副信息是 Agent · 模型(/思考档) · 只读|可写 · 派发时刻 · 耗时 · token，失败的显示原因。
- 点卡片进详情，分「任务 / 过程 / 结果」三页：「任务」渲染 `handoff.md`（旧记录用 `task.md` 去掉 runner 说明）。「过程」是实时日志，Agent 的话用 Markdown，工具调用压成一行；运行中底部有实时状态行（`activity`：正在思考 / 正在执行 xx / 正在写回复 / 等待模型 + 秒数），Cursor 的 `live_text` 以“输入中”气泡逐字出现。可复制 `watch` 命令。
- 运行中可「停止」（先变成“确认停止”，再校验 `runner_pid` 是 `run_cli.py` 后发 SIGTERM，状态由 runner 记为 `cancelled`）和「追问」（把“用 delegate-cli 续接这次运行（<运行目录名>）：”填进输入框）。
- 超过 3 分钟没写日志的 running/preparing 运行标为“可能已中断”。
- 本会话有新运行启动时尝试打开 pane，底部状态栏同时显示“子 Agent 运行中”。定时器发起的打开属于“非主动请求”，界面不够宽时 App 会先挂起不显示，此时状态栏会提示 `/delegate-runs`；该命令是主动请求，打不开时会直接报出 App 给的原因。pane 由 App 决定落位，mod 不能插进 App 内置的会话信息列表。
- 除「停止」向 runner 发 SIGTERM 外不改变任何状态：不调用模型、不改运行记录。旧版 runner 产生的记录没有 `claude_session_id`，只在“近 24 小时”里出现。

安装方式见插件目录里的 `README.md`。CLI 使用的 MCP 和桌面端内置插件不是自动共享关系，面板与 GUI 验收互不依赖。

## 浏览器与桌面验收

通过本机已配置的 Playwright / Computer Use MCP 委派 Codex 做真实界面验收；配置方法、用户实测记录、runner 策略差异和任务模板见 [GUI 验收指南](gui-acceptance.md)。
