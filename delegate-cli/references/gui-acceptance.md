# Codex exec 浏览器与桌面控制配置指南（macOS）

> 来源：用户提供的配置指南与 2026-10-15 本机实测记录；本 Skill 维护环境未复现 macOS GUI 链路。浏览器使用 Playwright MCP，桌面使用本地 Computer Use MCP；不等于 CLI 自动继承桌面端的内置 Browser 插件。组件可用性与权限以接收者机器为准。

## 目录

- [环境与准备](#1-环境与准备)
- [浏览器：配置两个入口](#2-浏览器配置两个入口)
- [桌面：Codex Computer Use](#3-桌面codex-computer-use)
- [非交互执行与权限](#4-非交互执行与权限的区别)
- [常见问题](#5-常见问题)
- [验证记录](#6-本次验证记录)
- [接入本 Skill 验收](#7-接入本-skill-验收)

本文介绍如何让终端里的 `codex exec` 使用两类 MCP 工具：Playwright 浏览器控制，以及 Codex Computer Use 桌面控制。浏览器提供“独立 Chrome”和“连接现有 Chrome”两个入口。

验收目标：独立浏览器和现有 Chrome 都能读取测试页面标题；桌面工具能截图、点击计算器、输入算式并确认结果。配置文件可解析、MCP 能启动，并不等于实际操作已经成功。

## 1. 环境与准备

需要 macOS、Google Chrome、Node.js/npm，以及已登录并能正常执行任务的 Codex CLI。桌面控制还需要下文所述的本地组件。桌面应用中的工具不会自动成为 CLI 的工具，需要配置 MCP。

```bash
node --version
npx --version
codex --version
codex login status
```

如果未安装 Codex CLI，可按 [Codex 官方 CLI 文档](https://developers.openai.com/codex/cli) 安装并登录；已有可用版本则不必为本文重装。

下文默认使用 `~/.codex/config.toml`。如果设置了 `CODEX_HOME`，应改用该目录下的 `config.toml`。先备份已有文件，保留模型、登录提供方及其他 MCP 配置。相同名称的 TOML 配置节只能出现一次，已有条目请原地修改。

配置读取方式见 [Codex MCP 官方文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。修改后，重新启动一次 `codex exec`。

## 2. 浏览器：配置两个入口

### 2.1 独立 Chrome

在 `config.toml` 末尾追加：

```toml
[mcp_servers.browser_independent]
command = "npx"
args = ["-y", "@playwright/mcp@latest", "--browser", "chrome"]
enabled = true
startup_timeout_sec = 60
```

首次运行会通过 npm 获取 Playwright MCP，需要网络可用。它启动独立的浏览器环境，不自动继承日常 Chrome 的登录状态；需要登录的网站可在这个环境中单独登录。这里未启用 `--isolated` 临时模式。

可先预热下载并检查命令是否可用：

```bash
npx -y @playwright/mcp@latest --help
```

不需要额外安装 Playwright CLI 或技能才能使用本文的 MCP 方案。参数说明见 [Playwright MCP 官方仓库](https://github.com/microsoft/playwright-mcp)。

### 2.2 现有 Chrome 与免确认连接

1. 在日常使用的 Chrome 用户配置中，按 [Playwright Extension 官方安装说明](https://github.com/microsoft/playwright/tree/main/packages/extension#installation-steps) 安装扩展。
2. 点击扩展图标或打开扩展状态页，找到 `PLAYWRIGHT_MCP_EXTENSION_TOKEN`。
3. 将等号后面的令牌值填入下面的占位符。令牌只保存在本机，不放入共享文档或代码仓库。

```toml
[mcp_servers.browser_existing]
command = "npx"
args = ["-y", "@playwright/mcp@latest", "--extension"]
enabled = true
startup_timeout_sec = 60

[mcp_servers.browser_existing.env]
PLAYWRIGHT_MCP_EXTENSION_TOKEN = "替换为你自己的扩展令牌"
```

扩展默认要求每次新连接都确认；配置对应用户配置的有效令牌后，可以自动连接，无需逐次手动确认。重置令牌后必须同步修改这里的值。详见 [官方连接认证说明](https://github.com/microsoft/playwright/tree/main/packages/extension#bypassing-the-connection-approval-dialog)。

如果多个 Chrome 用户配置都安装了扩展，可在 `args` 中加入 `"--profile-dir-name", "Profile 1"`。实际目录名查看目标 Chrome 的 `chrome://version` 中的 Profile Path；令牌也必须来自同一个用户配置。

### 2.3 验证浏览器

检查入口已注册：

```bash
codex mcp list
```

测试独立 Chrome：

```bash
codex exec --skip-git-repo-check \
  -c mcp_servers.browser_existing.enabled=false \
  '只使用 browser_independent MCP 打开 https://example.com，读取并报告实际页面标题，不使用其他浏览器工具。'
```

测试现有 Chrome：先打开装有扩展的 Chrome，再执行：

```bash
codex exec --skip-git-repo-check \
  -c mcp_servers.browser_independent.enabled=false \
  '只使用 browser_existing MCP，新建标签页打开 https://example.com，读取标题，不导航或关闭已有标签页。'
```

两次都应实际返回 `Example Domain`。第二次还应确认未出现扩展连接确认弹窗。首次扩展界面、标签页选择等行为可能随版本变化，以实际界面为准。

## 3. 桌面：Codex Computer Use

### 3.1 先确认组件存在

本次实测使用本机已有的 `Codex Computer Use.app`，不是通过 npm 安装的 Playwright 组件。先执行：

```bash
CUA_CLIENT="$HOME/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient"
test -x "$CUA_CLIENT" && "$CUA_CLIENT" --help
```

成功时帮助中应包含 `mcp` 子命令。如果文件不存在，请先通过你所使用产品或组织提供的分发渠道安装对应组件，并确认实际路径。**本文未核实面向所有人的公开下载入口；仅安装 Codex CLI 不代表一定拥有此组件。缺少组件时，本节尚不能执行，浏览器部分仍可独立使用。**

### 3.2 添加配置

将以下两处 `YOUR_USERNAME` 替换为自己的 macOS 用户目录名。必须填写实际绝对路径，不要原样复制其他人的用户名，也不要假定 TOML 字符串会展开 `$HOME` 或 `~`。

```toml
[mcp_servers.computer-use]
command = "/Users/YOUR_USERNAME/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient"
args = ["mcp"]
cwd = "/Users/YOUR_USERNAME"
enabled = true
startup_timeout_sec = 60
```

如果原来已有 `computer-use`，修正 `command` 和 `cwd`，并把 `enabled = false` 改成 `true`。使用绝对路径可以避免从不同工作目录启动时找不到程序。

### 3.3 macOS 权限

首次实际调用可能触发系统授权。根据弹窗指向的应用，在“系统设置 → 隐私与安全性”中开启需要的权限：

- 辅助功能：用于点击、键盘输入等交互。
- 屏幕录制，或系统版本中对应的“屏幕与系统音频录制”：用于获取画面。

以系统实际显示的请求应用为准，不要凭名称猜测授权对象。如果系统要求退出重开，按提示重启相应组件，再启动新的 `codex exec`。通常授权后可以复用；组件身份或路径改变、重新安装以及手动撤销权限后可能需要重新授权。

桌面测试应在本机已登录且可交互的桌面会话中进行。不要把 `codex exec` 的“非交互终端模式”理解为无需桌面环境。

### 3.4 验证截图、点击、输入

先检查只读状态：

```bash
codex exec --skip-git-repo-check \
  '只使用 computer-use MCP 查看原生应用状态，不点击、不输入、不读取本地文件，仅报告成功或缺少的权限。'
```

然后做完整的无害测试：

```bash
codex exec --skip-git-repo-check \
  '只使用 computer-use MCP，遵循工具说明。打开计算器并截图，点击清除按钮，然后通过键盘计算 123 + 456。用界面状态和最终截图确认结果为 579。分别报告截图、点击、键盘输入和结果验证是否成功。不要修改其他应用；若缺权限，报告具体权限名称。'
```

只读状态成功不代表截图权限也已通过；必须分别确认上述四项。出现权限拦截时，授权后重新运行测试。

## 4. 非交互执行与权限的区别

有三层互相独立的设置：

| 层次 | 作用 | 设置位置 |
| --- | --- | --- |
| 扩展连接认证 | 允许 MCP 连接现有 Chrome | Playwright 扩展令牌 |
| macOS 系统权限 | 允许组件获取画面、点击和输入 | 系统设置 |
| Codex 执行策略 | 决定本次任务可以调用哪些工具或执行哪些操作 | Codex 配置与组织策略 |

本文未要求全局关闭 Codex 审批或沙箱。令牌不会替代 Codex 执行授权。如果出现审批拒绝，应检查具体被拒绝的工具与策略；无法弹出交互审批的任务，需要在运行前配置允许的权限范围。

本次实测机器原有 `approval_policy = "on-request"`、`sandbox_mode = "danger-full-access"`，本次没有修改这两项，三项验收均通过。这个环境事实不代表所有机器在其他策略下也会直接成功，也不表示必须照搬该沙箱设置。

`--skip-git-repo-check` 用于在非 Git 目录运行；不是权限绕过选项。自动化集成需要事件日志时可加 `--json`，需要只保存最终答复时可加 `-o result.txt`。真实页面内容可能进入日志，分享前先检查。参见 [Codex 非交互模式文档](https://learn.chatgpt.com/docs/non-interactive-mode)。

如果机器还有其他 MCP，排障时可用 `-c mcp_servers.实际名称.enabled=false` 临时关闭无关入口。上述命令只显式关闭了另一种浏览器入口；本次实测为了隔离问题，逐项关闭了所有无关 MCP。不要并发运行多个任务控制同一个桌面或同一个浏览器用户配置。

## 5. 常见问题

| 现象 | 检查与处理 |
| --- | --- |
| 启动时报 TOML 错误 | 检查重复配置节、引号以及占位符是否正确替换。 |
| 找不到 `npx` | 先安装 Node.js；用 `command -v npx` 获取绝对路径，必要时填入 `command`。 |
| Playwright 首次启动超时 | 手动执行本文的 `npx ... --help` 完成下载，再重试；检查网络与启动超时设置。 |
| 现有 Chrome 每次仍要确认 | 检查令牌是否来自当前用户配置、是否已重置，以及 MCP 是否使用 `--extension`。 |
| 连接到了错误的 Chrome 用户配置 | 显式填写 `--profile-dir-name`，同步使用该用户配置中的令牌。 |
| 桌面组件无法启动 | 检查程序是否存在且可执行，路径是否为绝对路径，`enabled` 是否为 `true`。 |
| 能读应用状态但不能截图或点击 | 分别检查屏幕录制和辅助功能权限，授权后重启所需组件再测试。 |
| 工具调用被审批拒绝 | 检查 Codex 执行策略；修改浏览器令牌不能解除这一层限制。 |
| ChatGPT/Codex 桌面能操作，终端却不能 | 两个运行环境的工具注入可能不同；检查 CLI 的 MCP 配置和实际调用结果。 |

令牌更新后，修改 `[mcp_servers.browser_existing.env]` 中的值并启动新的任务。需要停用时，将相应 MCP 配置的 `enabled` 改为 `false`，无需删除其他配置。

## 6. 本次验证记录

验证日期：2026-10-15。系统：macOS。Codex CLI：`0.162.0-alpha.17.2`；Node.js：`v22.22.0`。Playwright MCP：`0.0.83`（通过当时的 `@latest` 获取）；后续版本变化时应重新执行验收。

| 项目 | 通过 codex exec 得到的结果 |
| --- | --- |
| 独立浏览器 | MCP 导航到 example.com，返回标题 `Example Domain`。 |
| 现有 Chrome | 新建测试标签页，返回标题 `Example Domain`，未要求手动确认连接。 |
| 桌面应用状态 | 成功读取原生应用状态，未提示缺少权限。 |
| 桌面截图和交互 | 取得计算器操作前后截图；点击清除并确认 0；键盘输入 `123 + 456`；界面状态与截图均确认 `579`。 |

以上证明本机当时的链路可用，不替代接收者机器上的验收。本文不包含真实令牌、登录凭据或完整个人配置。

## 7. 接入本 Skill 验收

先复用已配置且实测成功的 MCP，不因为普通开发任务而重新安装或改配置。只有用户要求配置时才执行前面的设置步骤；安装与授权完成后用实际操作验收。原文 `@latest` 是安装示例，本次记录的测试版本为 0.0.83；已有可用环境不要自动升级，升级后重测。

### 先验证真实派发路径

本指南中的直接 `codex exec` 成功，不保证封装命令在不同策略下成功：`run_cli.py` 显式使用 `approval_policy="never"` 与 `read-only`/`workspace-write` 沙箱。它没有开放全盘权限的参数，也不自动继承指南测试机的策略。用本 Skill 的 `run` 和实际项目 cwd、访问模式做一次小范围 MCP 测试，核实工具调用与真实界面结果。`doctor`、MCP 列表、模型口头声称可操作都不足以证明链路可用。不要为了通过测试自动放宽策略；失败时记录具体工具、错误和权限层，继续能完成的检查。

### 编写验收任务

使用下面的任务模板，将占位项换成实际目标；读取主入口的通用任务边界并一并传入。

```text
目标：验收 <功能> 的真实用户流程。
基准：<已固定的提交/工作区版本>；运行服务 <URL/端口>。
工具：只使用已验证的 <browser_independent/browser_existing/computer-use> MCP 操作界面。
范围：<站点、账号角色、测试数据、允许的操作>；不修改业务源码。
步骤与预期：<进入页面 → 操作 → 可见结果，以及必要的持久化/刷新检查>。
证据目录：<项目内明确允许写入的独立绝对目录>。
证据：逐步记录实际结果、截图路径、相关错误和工具调用；不以 curl 或单元测试代替 UI 实测。
边界：保留用户原有标签页与应用状态；只清理本次测试创建的可安全删除数据。
输出：每项通过/失败/阻塞/未测；复现步骤；证据；剩余风险。
```

通过现有 runner 调用，保持日志、会话 ID 与实时监看：

```bash
python3 "${CLAUDE_SKILL_DIR}/scripts/run_cli.py" run \
  --agent codex --cwd "/实际项目路径" \
  --prompt-file "/验收任务文件.md" --access write
```

示例 write 用于保存截图或测试产物，不授权改源码、生产数据或其他应用。read/write 是本地文件沙箱设置，不能限制 MCP 对浏览器/桌面的操作；任务操作范围仍需明确。

优先独立浏览器；确实需要已有登录态时使用现有 Chrome，并新建测试标签页。涉及原生应用、系统弹窗或浏览器工具无法覆盖的交互时使用桌面控制。仅在需要时读取相应工具说明；不要凭经验编造工具名称。

### 协调与收回

同一桌面、同一浏览器 profile 的 GUI 任务串行执行，即使项目 cwd 或 worktree 不同也不并行。runner 当前的 cwd/会话锁不提供桌面或 profile 锁，由 Claude 主控协调；需要共享环境时先确认没有其他控制者。独立且隔离的浏览器实例才考虑并行。

固定实现后再验收。失败时先记录证据，区分代码、测试数据、服务未启动、网络、登录、组件和权限问题；需要修复则返回实现阶段，修复后重新运行失败路径与受影响路径。不要无限循环同一失败操作或把权限拒绝记作业务缺陷。

主控检查截图与报告是否支持预期结果；页面有内容、HTTP 200 或 CLI 退出 0 都不等于功能通过。涉及保存/修改的流程，应按需求验证刷新后状态或持久化结果。缺权限、登录或人工步骤时只让用户处理阻塞点，其余验收由 Agent 完成。最终交付简短结论与证据位置，不要求用户重做所有步骤。
