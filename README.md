# puzzle

个人 Claude Code 组件仓库。每个组件一个顶层目录，彼此独立安装。

| 目录 | 类型 | 作用 |
|---|---|---|
| `delegate-cli/` | Skill | 让 Claude 调度 Codex、Pi、Cursor：派发、续接、实时进度、验收 |
| `delegate-cli-panel/` | 插件（函数钩子 mod） | 桌面 App 右侧的「子 Agent」和「需求拼图」两个面板：查看委派的任务、结果、实时过程，以及需求由哪些块组成、哪里要你处理 |

两者只通过 `~/.claude/cli-runs/` 里的运行记录衔接：skill 单独可用，面板是可选的界面。暂时分开存放，以后需要一键安装时再合成一个插件。

## 安装（以本仓库为准）

macOS / Linux / WSL：

```bash
# Skill：让 Claude 从仓库加载
ln -s ~/Desktop/jj/puzzle/delegate-cli ~/.claude/skills/delegate-cli

# 面板插件：user 级安装，会把当前版本复制到插件缓存
claude plugin marketplace add ~/Desktop/jj/puzzle/delegate-cli-panel
claude plugin install delegate-cli-panel@delegate-cli-panel
```

原生 Windows（PowerShell）：符号链接需要管理员权限或开发者模式，改用目录联接，效果相同。

```powershell
New-Item -ItemType Junction -Path "$HOME\.claude\skills\delegate-cli" -Target "D:\workspace\puzzle\delegate-cli"
claude plugin marketplace add D:\workspace\puzzle\delegate-cli-panel
claude plugin install delegate-cli-panel@delegate-cli-panel
```

改 skill 后立即生效。面板加载的是安装时复制到 `~/.claude/plugins/cache/` 的那一版：改了面板，先把版本号加一，再更新安装并重开会话，步骤见 `delegate-cli-panel/README.md`。

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
| `watch_command` | POSIX 引号 | 双引号命令行，路径带空格时前加 `&`，可直接粘到 PowerShell |

面板（`delegate-cli-panel`）按 `OS=Windows_NT` 判断平台：

| 项 | macOS / Linux | Windows |
|---|---|---|
| 用户目录 | `HOME` | `HOME`，没有时用 `USERPROFILE` |
| 拼图日志原子替换 | `mv -f` | `cmd /c move /y`；目标正被读取导致移动失败时直接覆盖写入 |
| 「停止」按钮 | `ps` 核对是 `run_cli.py` 后 `kill -TERM` | 在运行目录写 `stop.request`，由 runner 结束进程树 |
| 跟随命令兜底（`run.json` 缺 `watch_command` 时） | `tail -f` | `Get-Content -Wait` |

面板测试里的模拟文件系统按 POSIX 路径记账：Windows 上引擎会把 `/home/t` 规范成 `D:\home\t` 再交给 fs 钩子，测试用 `posix()` 换回来。

## 打包 Skill

```bash
git archive --format=zip --prefix=delegate-cli/ -o delegate-cli.zip HEAD:delegate-cli -- . ':(exclude)tests'
```

`delegate-cli/tests/fixtures/` 是真实运行采集的事件样本，含本机路径，不随分发包发出。
