# delegate-cli-panel

Claude Code 的函数钩子 mod，配合 `delegate-cli` skill 使用：在桌面 App 对话右侧停靠一个「子 Agent」面板，列出 skill 派发出去的 Codex / Pi / Cursor 运行，点进去看实时进度。

## 它做什么

- 读取 `~/.claude/cli-runs/` 里最近 7 天的运行目录（按目录名里的时间判断）的 `run.json` 和 `progress.log`：有运行中的任务或打开了某个运行时每 2 秒刷新，空闲时约 10 秒重扫一次。只读，不调用模型，也不改运行记录；`--run-root` 改过目录的运行不在这里。
- 默认显示本会话派发的运行（`run.json` 的 `claude_session_id` 等于当前会话），可切到「近 24 小时」（按开始时间，不分会话）。
- 每张卡片显示：状态、Agent、模型/思考强度、只读/可写、耗时、token 用量；运行中的还显示最新一步，失败的显示原因。
- 点卡片标题进入时间线：Agent 的话用 Markdown 显示，工具调用压成一行小字（连续的同类读取、搜索、查找、列目录合并成“读取 N 项”等），正在执行的一步高亮、失败标红；可一键复制终端 `watch` 命令，「‹ 全部运行」返回列表。
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

数据格式依赖 `scripts/run_cli.py` 写出的 `run.json` 字段（`status`、`agent`、`model`、`thinking`、`access`、`started_at`、`finished_at`、`claude_session_id`、`usage.total_tokens`、`watch_command`、`error`）；改 runner 字段时同步修改 `hooks/register.tsx` 并把对应 atom 的 `shape` 标签加一。
