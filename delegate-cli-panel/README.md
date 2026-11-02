# delegate-cli-panel

Claude Code 的函数钩子 mod，配合 `delegate-cli` skill 使用：在桌面 App 对话右侧停靠一个「子 Agent」面板，列出 skill 派发出去的 Codex / Pi / Cursor 运行，点进去看实时进度。

## 它做什么

- 读取 `~/.claude/cli-runs/` 里最近 7 天的运行目录（按目录名里的时间判断）的 `run.json`、`progress.log`、`task.md` / `handoff.md`。打开的那个运行若仍在跑，每 1 秒刷新；否则有运行中的任务、或正打开某个运行时每 2 秒刷新，空闲时约 10 秒重扫一次。不调用模型。停止运行会向 runner 进程发 `SIGTERM`（先核对命令行含 `run_cli.py`）；除此以外不改运行记录。`--run-root` 改过目录的运行不在这里。
- 默认显示本会话派发的运行（`run.json` 的 `claude_session_id` 等于当前会话），不分组。可切到「近 24 小时」（按开始时间，不分会话），按项目（`cwd` 最后一段）分组，每组前一行小标题。两组视图都把仍在运行（running / preparing，且不是「可能已中断」）的排在最前，其余按开始时间倒序。
- 卡片标题是任务名：优先 `run.json` 的 `title`；没有则读 `task.md`，跳过开头两段 runner 说明（以 `Your runner metadata` 和 `Delegated subtask:` 开头），取「目标：」那一行并去掉前缀；还没有就用交接文件第一行非空文字，再没有就用去掉说明后的 `task.md` 第一行；超过 40 字截断并加「…」。没有这些就显示「未命名任务」。Agent、模型、只读/可写、派发时刻、耗时、token 在副信息行。运行中的还显示最新一步和实时状态，失败的显示原因。标题、副信息和这些动态在同一个按钮里，点整段文字进入详情（卡片边框是外层盒子，按钮画不了边框）。
- 详情有「任务」「过程」「结果」三页。默认仍是：已经结束且有结果 → 结果，否则 → 过程；「任务」要手动点。任务页渲染 `handoff.md`（或 `handoff_file`）；没有则渲染去掉 runner 说明后的 `task.md`，并注明发送时另附了 2 条 runner 说明。过程页里，运行中且 runner 写了 `activity` 时，时间线底部有一行实时状态（思考、执行、写回复、等待模型），秒数随刷新走；Cursor 的 `live_text` 非空时，末尾多一个「输入中」气泡。可复制结果或终端 `watch` 命令。「停止」只在运行中出现，按一次变成「确认停止」，5 秒内再按才发信号，超时或返回列表就复原。「追问」把续接这句话填进输入框。
- **怎么打开**：输入 `/delegate-runs` 回车。本会话派发过子 Agent 的话，重载插件或恢复会话时会自动打开；你手动关掉后本会话不再自动弹出，直到下次派发或执行 `/delegate-runs`。
- 本会话有新运行启动时尝试自动打开面板，底部状态栏显示“子 Agent 运行中：…”。自动打开不是用户主动请求，App 可能先挂起不显示；这时状态栏会带上 `/delegate-runs` 提示，输入它主动打开，打不开时命令会报出原因。
- 状态为 running/preparing 但超过 3 分钟没有写日志的运行显示为「可能已中断」（runner 每分钟至少写一次心跳）。

面板放在哪里由 App 决定（对话右侧的 pane 区），mod 不能把内容插进 App 内置的 Environment / Context 列表。

## 安装（让每个会话都有面板）

在终端执行一次，user 级安装，之后新开的会话都会加载；插件直接从本目录读取：

```bash
claude plugin marketplace add ~/.claude/skills/delegate-cli/panel
claude plugin install delegate-cli-panel@delegate-cli-panel
```

改了本目录的代码后，在会话里运行 `/reload-plugins` 或新开会话即可生效。卸载：

```bash
claude plugin uninstall delegate-cli-panel@delegate-cli-panel
claude plugin marketplace remove delegate-cli-panel
```

## 开发与测试

```bash
claude plugin validate ~/.claude/skills/delegate-cli/panel
claude plugin test ~/.claude/skills/delegate-cli/panel
```

数据格式依赖 `scripts/run_cli.py` 写出的 `run.json` 字段（`status`、`agent`、`model`、`thinking`、`access`、`started_at`、`finished_at`、`claude_session_id`、`usage.total_tokens`、`watch_command`、`error`，以及 `title`、`goal`、`handoff_file`、`activity`、`live_text`、`runner_pid`）。旧记录没有后六个字段，面板照常列出。改 runner 字段时同步修改 `hooks/register.tsx` 并把对应 atom 的 `shape` 标签加一。
