---
name: delegate-cli
description: 让 Claude Code 通过本机 Codex CLI、Pi coding agent 与 Cursor CLI 委派开发、排查、测试、代码审查及浏览器/桌面验收任务，按需并行、续接指定会话并验收结果。用户要求调用 Codex/Pi/Cursor、让多个编码 Agent 协作、分担任务或交叉审查时使用；简单任务和纯概念问答无需委派。
---

# Claude 调度 Codex、Pi 与 Cursor

担任主控：理解用户目标、分工、收回结果、整合并验收。调用真实 CLI，不把自己推测的答案冒充外部 Agent 的结果。遵守用户已给出的范围和授权；子任务不增加原任务权限。

## 1. 确认能力

首次调用或 CLI 升级后运行一次（加 `--models` 可列出各 CLI 的有效模型 ID）：

```bash
python3 "${CLAUDE_SKILL_DIR}/scripts/run_cli.py" doctor --cwd "/绝对/项目路径"
```

从 Skill 的实际加载目录定位脚本；旧版 Claude 未替换上述变量时，使用加载位置的绝对路径。需要 Python 3.9+，支持 macOS/Linux/WSL/原生 Windows；Windows 上 `python3` 可能是应用商店占位程序，改用 `python`。缺少某个 CLI 时使用可用者。

- 以本机 `--help` 为准；不自动安装、升级 CLI，不改模型、代理、认证配置。
- 子进程不会获得 Claude 的对话、权限、MCP、Skill 或浏览器状态；必要信息写进任务文件，需要的工具另行核实。
- Codex 的沙箱可约束本地命令；Pi 的工具白名单、Cursor 的 ask 模式和 Git worktree 都不是操作系统沙箱。
- 各 CLI 的细节按需读：[Codex](references/codex.md)、[Pi](references/pi.md)、[Cursor](references/cursor.md)；能力对比、进度面板安装与常驻接入见[接入选择](references/integration.md)。

## 2. 分配任务

先给一句简短分工，然后执行。只拆有明确产物、可独立验证的子任务；小改动自己做。三家都能开发、测试、审查，按实际模型选择，不预设谁弱。

| 场景 | 执行方式 |
|---|---|
| 独立代码检索、方案复核 | 一个或多个只读任务；固定共同的代码版本 |
| 一个模块实现 | 选择合适的 Agent，明确文件所有权 |
| 多个独立模块实现 | 每个写入者一个独立 worktree、分支、工作目录 |
| 开发后审查 | 等实现结束并固定 diff，再交另一 Agent 审查 |
| 网页/桌面功能验收 | 实现稳定后委派 Codex 用已验证的 MCP 实际操作，见 [GUI 验收指南](references/gui-acceptance.md) |
| 需要跑测试 | 允许必要的测试产物写入；不要误设只读后把权限错误当代码错误 |

独立任务用 Claude 的后台 Bash 执行，有依赖的串行。默认最多同时委派两个，有明显收益时再加；不强制每次都用多家。

启动 worktree 前检查 `git status` 和基准提交。未提交改动不会进入新 worktree：先明确哪些是输入，复制选定改动或改为串行，保留用户工作。依赖安装、端口、数据库和外部账号也要分开或协调。子任务运行时，主控不修改其文件或同一 Git 工作区状态。

## 3. 写清交接

每个任务一个 UTF-8 任务文件。使用 Write 工具或带引号的 heredoc，禁止把任务文本拼进 shell 命令。

```text
目标：一个可验收的结果。
角色：你是被委派的执行者，只完成本子任务，不再次调用其他 AI CLI 或调度 Skill。
工作目录与基准：绝对路径、分支/提交；必要的现有改动。
输入：必要背景、文件入口、已确认约束；不要假设能看到主控聊天。
可修改范围：明确文件/目录；审查任务写“只读”。
完成标准：实际行为、需要执行的测试/端到端检查。
输出：结论；改动与文件；实际验证命令及结果；未验证项；阻塞与证据。
边界：遵守仓库规则；不要擅自扩大范围、提交、推送、部署或处理凭据。
```

用户已明确授权提交等操作时，精确调整最后一条。不要把凭据或整段历史写进交接。审查时提供冻结的 diff，包括相关新增文件；单独的 `git diff` 不含未跟踪文件。

## 4. 调用并保留会话

```bash
python3 "${CLAUDE_SKILL_DIR}/scripts/run_cli.py" run \
  --agent codex --cwd "/绝对/项目或worktree" \
  --prompt-file "/绝对/任务文件.md" --access write \
  --title "审查 runner 改动" --model astra --thinking 中
```

`--agent` 取 `codex`、`pi`、`cursor`；`--access read|write`。任务文件必须已存在。

- **任务名**：每次派发都传 `--title`，10～20 字说清做什么（如“审查 runner 改动”“补面板停止按钮”）。它就是面板卡片标题和后台任务名，不传时取交接里「目标：」那一行。
- **模型**：用户说的简称原样传，脚本按 skill 根目录的 `models.json` 解析，并在启动前用 CLI 自带的模型列表校验（`astra`→`gpt-6-astra`，`flash`→`deepseek/deepseek-flash`，`grok4.7`+`中`→`grok-4.7-medium`）。写错会立即 `blocked` 并给出候选，不会白跑。不传时用 `models.json` 的 `defaults`（目前只给 Cursor 配了 `grok-4.7-medium`），再没有就用 CLI 自己配置的默认模型；用户的"老样子"写进 `models.json`，三家都生效。Cursor 的思考档按同一模型族换档（没有的档位会报错并列出可用档），带方括号参数的 ID 原样放行。
- **Cursor**：read 用 `--mode ask`，write 用 `--force`（执行命令，且隐含信任目录）。只读任务遇到未信任目录会 `blocked`；只有用户授权信任该目录时才加 `--cursor-trust approved`。
- **Pi**：read 只选读取工具并在支持时关闭内置 MCP，保留扩展；尚未信任的项目资源用 `--pi-trust existing|skip|approved`（默认沿用已有信任；`skip` 对应 `--no-approve`，`approved` 对应一次性 `--approve`）。
- **非 Git 目录**：Codex 默认拒绝；确属预期时加 `--skip-git-check`（只对 Codex 有效，用在其他 Agent 上会直接报错）。
- 每次运行生成独立目录（默认 `~/.claude/cli-runs/`，`--run-root` 可改），保留 `task.md`、`handoff.md`、`run.json`、`result.md`、`stderr.log`、`progress.log` 和 CLI 帮助（解析过模型时另存 `models.txt`）；Codex/Cursor 另存 `events.jsonl`，Pi 保留会话文件。不要把日志提交进业务仓库。

续接时给出该任务完成后的精确 `run.json`，Agent 和工作目录必须相同：

```bash
python3 "${CLAUDE_SKILL_DIR}/scripts/run_cli.py" run \
  --agent cursor --cwd "/原工作目录" \
  --prompt-file "/绝对/后续任务.md" --access write \
  --resume-from "/上次运行目录/run.json"
```

保留最新一次运行记录。不要使用 Codex `--last`、Pi/Cursor `--continue` 或会话选择器；不要同时向同一个会话发送任务。审查改开发时显式选择 write，新增权限仍受原任务授权约束。

## 5. 让用户看见进度

- 用后台 Bash 派发，description 写成「Agent：任务名」，任务名与 `--title` 相同（如“Cursor：审查 runner 改动”）：Background tasks 按它列出任务。点进去是 runner 的实时输出：首行 JSON（`run_file`、`watch_command`），接着「── 任务：<任务名> ──」和交接全文（不含 runner 附注），然后逐行进度，末行最终 JSON。
- 派发后在对话里贴一张派发卡片：一张小表，列出任务名、Agent、模型、读写、工作目录、完成标准；不贴交接全文（全文在面板「任务」页和 Background tasks 开头）。再附一句提示和 `watch_command` 方便终端跟随，命令用本次真实路径，不硬编码用户名或项目名。
- 装了 `delegate-cli-panel` 插件时，底部状态栏显示运行中的子 Agent，`/delegate-runs` 打开面板（pane 是否显示由 App 决定）。卡片以任务名命名，副信息是 Agent · 模型 · 读写 · 派发时刻 · 耗时 · token；详情分「任务 / 过程 / 结果」三页。运行中底部有实时状态行（正在思考 / 正在执行 xx / 正在写回复 / 等待模型 + 秒数；只有 Cursor 有思考与逐字事件，Codex 和 Pi 只在执行工具与等待模型之间切换），Cursor 正在写的回复以“输入中”气泡逐字出现；可用「停止」「追问」处理跑偏或需要补要求的运行。
- 后台 Bash 结束时 Claude 会收到完成通知：等通知再收结果，不要轮询，也不要整份读取后台输出（那是给人看的进度流）。最终状态读 `run.json`，或只取输出的最后一行；确需中途判断时用 `watch --once` 读一次快照。前台短任务可加 `--quiet`，只输出首尾两行 JSON。
- `progress.log` 展示工具调用（每次一行；失败、退出码非 0、超过 3 秒的另记结果）、文件改动、Agent 消息、错误、会话 ID 和最终用量。无日志 60 秒会提示安静时长，不能据此判定卡死或自动重试。runner 每分钟至少写一次心跳，面板把超过 3 分钟没写日志的 running 运行标为"可能已中断"（runner 可能被强杀），需核实进程。面板只扫描默认目录 `~/.claude/cli-runs/` 里最近 7 天的运行；用 `--run-root` 改了目录的运行只能用 `watch` 看。
- 默认日志不含私有推理。不要擅自启动终端窗口。

## 6. 收回、纠错、验收

- 等后台任务真正结束，再读 `run.json` 和 `result.md`。先读摘要；需要定位问题时再检索日志，避免整份事件流挤进主控上下文。
- `process_succeeded` 只表示 CLI 正常完成，`verified: false` 要由主控实际检查。审查 diff、核实文件范围并运行所需集成/端到端验证后，才能报告任务完成。
- `blocked`、`failed`、`timed_out`、`cancelled`、`planned`（dry-run）都不能当作成功。`blocked` 的 `error` 是前置条件提示（模型、目录信任、非 Git、锁冲突），`error_detail` 保留 CLI 原文；`failed` 的 `error` 是 CLI 给出的真实原因。启动前的校验失败（模型名、`models.json`、CLI 不可用）只输出一行 blocked JSON，不建运行目录。先区分参数/版本、模型、认证/额度、网络、沙箱、项目配置和代码问题。
- 对临时网络问题，先检查已有改动和进程状态，再续接原会话；不要盲目重跑写入任务。保留有用产物。用户在面板里停止的运行是 `cancelled`，同样不算成功：先看已经产生的改动，再决定续接还是重派。
- 用户说“用 delegate-cli 续接这次运行（<运行目录名>）：<要求>”时，读 `~/.claude/cli-runs/<运行目录名>/run.json`，把要求写成新的任务文件，用同一 Agent、同一 `cwd` 和 `--resume-from` 续接。
- 超时默认 1800 秒，可用 `--timeout` 调整。Claude 自身的后台时限也可能先触发；不能凭"文件存在"判断完成。脚本会尝试终止自己的进程组；若被强杀，需核实是否仍有工作在运行。
- 同一目录可并行多个只读任务，写入任务独占该目录；同一续接会话也只能有一个任务。主控的操作不受该锁约束。被锁阻挡时串行执行，或换独立 worktree/会话。
- 不通过禁用审批、放开全盘权限、删除规则或关闭保护扩展来修复被拒绝的任务。Codex 的 never 策略保留沙箱，并使需要升级权限的操作失败。
- `run.json` 的 `usage` 记录本次 token 用量（输入含缓存；Pi 另有美元成本），可用来比较各家成本。
- 结束时简报：谁做了什么、合并后的结果、实际验证、未验证项与阻塞。只有剩余信息确实阻挡进展时才问用户。

## 7. 提交与界面验收（按需读）

- 用户授权提交时，默认子 Agent 只改不提交，主控验收后用 `commit-message` 子命令生成带 `Agent-Session`/`Agent-Run` trailer 的提交信息，见[提交溯源](references/commit-provenance.md)。
- 涉及页面、交互或桌面行为时，把真实用户流程纳入完成标准，委派已具备能力的 Codex 实际操作，返回逐项结果和截图，见 [GUI 验收指南](references/gui-acceptance.md)。纯后端或小范围非 UI 改动无需强制 GUI 验收。
