# puzzle

个人 Claude Code 组件仓库。每个组件一个顶层目录，彼此独立安装。

| 目录 | 类型 | 作用 |
|---|---|---|
| `delegate-cli/` | Skill | 让 Claude 调度 Codex、Pi、Cursor：派发、续接、实时进度、验收 |
| `delegate-cli-panel/` | 插件（函数钩子 mod） | 桌面 App 右侧「子 Agent」面板，配合 delegate-cli 查看任务、结果与实时过程 |

两者只通过 `~/.claude/cli-runs/` 里的运行记录衔接：skill 单独可用，面板是可选的界面。暂时分开存放，以后需要一键安装时再合成一个插件。

## 安装（以本仓库为准）

macOS / Linux / WSL：

```bash
# Skill：让 Claude 从仓库加载
ln -s ~/Desktop/jj/puzzle/delegate-cli ~/.claude/skills/delegate-cli

# 面板插件：user 级安装，直接读取仓库目录
claude plugin marketplace add ~/Desktop/jj/puzzle/delegate-cli-panel
claude plugin install delegate-cli-panel@delegate-cli-panel
```

原生 Windows（PowerShell）：符号链接需要管理员权限或开发者模式，改用目录联接，效果相同。

```powershell
New-Item -ItemType Junction -Path "$HOME\.claude\skills\delegate-cli" -Target "D:\workspace\puzzle\delegate-cli"
```

改 skill 后立即生效；改面板后在会话里执行 `/reload-plugins`。

## 测试

```bash
cd delegate-cli && python3 -m unittest discover -s tests
claude plugin validate delegate-cli-panel && claude plugin test delegate-cli-panel
```

Windows 上 `python3` 可能是应用商店占位程序，用 `python`：

```powershell
cd delegate-cli; python -m unittest discover -s tests
```

## Windows 说明

`run_cli.py` 在原生 Windows 上自动切换到以下实现，macOS/Linux 行为不变：

| 项 | macOS / Linux | Windows |
|---|---|---|
| 检出目录与会话锁 | `fcntl.flock`，读任务持共享锁 | `msvcrt.locking`；没有共享锁，读任务只探测有无写任务占用 |
| 子进程分组 | `start_new_session` | `CREATE_NEW_PROCESS_GROUP` |
| 停止 / 超时 | `killpg` 发 SIGTERM，再 SIGKILL | `taskkill /T /F` 结束整棵进程树 |
| 外部停止入口 | 给 runner 发 SIGTERM | 在运行目录写入 `stop.request` 文件 |
| 输出编码与换行 | 系统默认 | stdout/stderr 强制 UTF-8 且不转换换行；`task.md` 按字节写入，CRLF 交接不会变成 CR CR LF |
| 写 `run.json` | 原子替换 | 面板或 `watch` 正在读时替换会被拒绝，短暂重试（最多约 1 秒） |
| Codex 沙箱 | 默认 | 追加 `-c windows.sandbox="unelevated"`，避开提权沙箱与桌面 node_repl 的冲突（os error 32） |

已知限制：面板的「停止」按钮仍用 `ps` + `kill -TERM`，在 Windows 上无效；需要停止时手动在对应运行目录下创建 `stop.request`。

## 打包 Skill

```bash
git archive --format=zip --prefix=delegate-cli/ -o delegate-cli.zip HEAD:delegate-cli -- . ':(exclude)tests'
```

`delegate-cli/tests/fixtures/` 是真实运行采集的事件样本，含本机路径，不随分发包发出。
