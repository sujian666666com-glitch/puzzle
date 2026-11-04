# delegate-cli-panel

Claude Code 的函数钩子 mod，配合 `delegate-cli` skill 使用，在桌面 App 对话右侧放两个面板：
- 「子 Agent」列出 skill 派发出去的 Codex / Pi / Cursor 运行，点进去看实时进度；
- 「需求拼图」显示这次委派的需求由哪些块组成、谁在做、哪里要你处理。

## 「子 Agent」面板

- 读取 `~/.claude/cli-runs/` 里最近 7 天的运行目录（按目录名里的时间判断）的 `run.json`、`progress.log`、`task.md` / `handoff.md`。打开的那个运行若仍在跑，每 1 秒刷新；否则有运行中的任务、或正打开某个运行时每 2 秒刷新，空闲时约 10 秒重扫一次。不调用模型。停止运行会向 runner 进程发 `SIGTERM`（先核对命令行含 `run_cli.py`）；除此以外不改运行记录。`--run-root` 改过目录的运行不在这里。
- 默认显示本会话派发的运行（`run.json` 的 `claude_session_id` 等于当前会话），不分组。可切到「近 24 小时」（按开始时间，不分会话），按项目（`cwd` 最后一段）分组，每组前一行小标题。两组视图都把仍在运行（running / preparing，且不是「可能已中断」）的排在最前，其余按开始时间倒序。
- 卡片标题是任务名：优先 `run.json` 的 `title`；没有则读 `task.md`，跳过开头两段 runner 说明（以 `Your runner metadata` 和 `Delegated subtask:` 开头），取「目标：」那一行并去掉前缀；还没有就用交接文件第一行非空文字，再没有就用去掉说明后的 `task.md` 第一行；超过 40 字截断并加「…」。没有这些就显示「未命名任务」。
- 卡片下面几行是：Agent、模型、只读/可写、派发时刻、耗时、token；运行中的最新一步和实时状态；失败的原因。
- 点标题进入详情。桌面 App 的按钮只画一行纯文字，所以按钮里只放标题，状态和其余几行放在按钮旁边和下面，各自保留颜色和换行。
- 详情有「任务」「过程」「结果」三页。默认仍是：已经结束且有结果 → 结果，否则 → 过程；「任务」要手动点。任务页渲染 `handoff.md`（或 `handoff_file`）；没有则渲染去掉 runner 说明后的 `task.md`，并注明发送时另附了 2 条 runner 说明。过程页里，运行中且 runner 写了 `activity` 时，时间线底部有一行实时状态（思考、执行、写回复、等待模型），秒数随刷新走；Cursor 的 `live_text` 非空时，末尾多一个「输入中」气泡。可复制结果或终端 `watch` 命令。「停止」只在运行中出现，按一次变成「确认停止」，5 秒内再按才发信号，超时或返回列表就复原。「追问」把续接这句话填进输入框。
- 运行带了拼图任务（`run.json` 的 `task`）时，详情里有一行「所属」，点块名打开需求拼图并选中那一块。
- **怎么打开**：输入 `/delegate-runs` 回车。本会话派发过子 Agent 的话，重载插件或恢复会话时会自动打开；你手动关掉后本会话不再自动弹出，直到下次派发或执行 `/delegate-runs`。
- 本会话有新运行启动时尝试自动打开面板，底部状态栏显示“子 Agent 运行中：…”。自动打开不是用户主动请求，App 可能先挂起不显示；这时状态栏会带上 `/delegate-runs` 提示，输入它主动打开，打不开时命令会报出原因。
- 状态为 running/preparing 但超过 3 分钟没有写日志的运行显示为「可能已中断」（runner 每分钟至少写一次心跳）。

## 「需求拼图」面板

Claude 用面板注册的 `blueprint` 工具维护本会话的拼图（约定见 skill 的 SKILL.md 第 2 节），每块的状态由拼图和本会话各次运行的 `run.json` 推导。界面只用业务名称，不显示 R1、T3 这类编号。

- **默认**：
  - 顶部是目标和一句简介；
  - 浅底面板里是“已验收 x / y 项需求”和“需关注”。需关注只列要你处理的事（标了 `owner: user` 的问题和阻碍、目录信任 / 登录 / 额度这类运行失败），点一项选中对应的块；
  - 下面按需求的组成分组，两列卡片，每块是名称、状态和一句说明。要你处理的块，说明行直接写原因。已验收的块铺浅绿底，待澄清的块用琥珀色淡边框。
- **悬停**：
  - 这一块的边框变蓝，说明行原地换成“谁在做 · 做到哪”，不挪动、不遮挡别的块；
  - 和它相关的块在说明行末尾出现“前置 / 后续”小标签，标的是那一块对它是什么；
  - 悬停对话里对应的动态行，也会点亮这一块；
  - 键盘聚焦到一张卡片时，显示同样的那一行。
- **点击**：卡片换成蓝边浅蓝底，下方展开详情。
  - 内容：说明与范围；现在、负责、前置、后续；验收 x / y，以及每条条件的结论和证据；最近 5 次运行，点开在「子 Agent」里看过程。
  - 处理入口随状态变化：回答这个问题、提供所需信息、请 Claude 验收、追问这一块，都只把一句话填进输入框，不自动发送；运行中还有「停止运行」，和「子 Agent」里一样要按两次。
  - 再点一次卡片或按「收起」关掉详情。
- **视图**：右上角切换蓝图、清单、关系。关系视图按前置缩进，每块挂在它最后一个前置下面，其余前置写在卡片上。面板窄于 40 列时固定显示清单。
- **怎么打开**：
  - Claude 第一次 `plan` 时自动尝试打开；App 挂起不显示时会提示输入 `/puzzle`；
  - 重载插件或恢复会话时，有拼图就重新打开，你手动关掉的除外，直到下次 `plan` 或执行 `/puzzle`；
  - 随时可以输入 `/puzzle`。
- **对话里的动态**：下面三类行在对话里各压成一行灰色小字，末尾是对应块的状态和「定位」按钮；ctrl+o 展开时照常显示原样：
  - `blueprint` 工具的调用，写成“拼图 · <这次的变化>”，下面的结果块不再重复；
  - 带 `--task` 的派发，写成“派发 · <描述>”；
  - 这些派发在后台结束时的通知，写成“运行结束 · <任务名>”。
- 本会话在建拼图之后、没带已知任务的运行，在面板底部提示数量，可跳到「子 Agent」查看。

面板放在哪里由 App 决定（对话右侧的 pane 区），mod 不能把内容插进 App 内置的 Environment / Context 列表。

## 安装（让每个会话都有面板）

在终端执行一次，user 级安装，之后新开的会话都会加载：

```bash
claude plugin marketplace add ~/Desktop/jj/puzzle/delegate-cli-panel
claude plugin install delegate-cli-panel@delegate-cli-panel
```

安装时会把**当前版本**复制到 `~/.claude/plugins/cache/delegate-cli-panel/delegate-cli-panel/<版本>/`，会话加载的是这份副本，不是本目录。所以改了代码以后：

1. 把 `.claude-plugin/plugin.json` 的 `version` 和 `hooks/register.tsx` 的 `VERSION` 一起加一；
2. 执行下面两条命令，再重开会话：

```bash
claude plugin marketplace update delegate-cli-panel
claude plugin update delegate-cli-panel@delegate-cli-panel
```

版本号不变时 `update` 认为已是最新，不会换掉旧副本。开发中想直接跑本目录，可以用 `claude --plugin-dir ~/Desktop/jj/puzzle/delegate-cli-panel` 开一个会话，保存即重载。

卸载：

```bash
claude plugin uninstall delegate-cli-panel@delegate-cli-panel
claude plugin marketplace remove delegate-cli-panel
```

## 开发与测试

```bash
claude plugin validate ~/Desktop/jj/puzzle/delegate-cli-panel
claude plugin test ~/Desktop/jj/puzzle/delegate-cli-panel
```

代码分在三个文件：
- `hooks/register.tsx`：唯一的入口模块，持有全部状态（`$.state` 的 atom），注册命令、工具和钩子，画「子 Agent」面板；
- `hooks/puzzle.tsx`、`hooks/rows.tsx`：只负责画「需求拼图」面板和对话动态行，需要的值和按键处理都由 `register.tsx` 传进去。校验只认模块自己文件里建的 atom，所以状态不能拆到别的文件；
- `hooks/blueprint.ts`：拼图的操作、校验、日志重放和状态推导，都是纯函数。

画法按桌面 App 实际的渲染规则来，见 `docs/puzzle-desktop-proposal.md` 第 4.4 节。比如：
- 按钮只画纯文字，所以有颜色的文字放在按钮外面；
- 填充色是半透明的，所以不拿底色遮挡文字；
- 带绝对定位子元素的卡片会盖住前面的浮层，所以卡片本身不做定位元素。

数据格式依赖 `scripts/run_cli.py` 写出的 `run.json` 字段：
- `status`、`agent`、`model`、`thinking`、`access`、`started_at`、`finished_at`、`claude_session_id`、`usage.total_tokens`、`watch_command`、`error`；
- 以及 `title`、`goal`、`handoff_file`、`activity`、`live_text`、`runner_pid`、`task`。

旧记录没有后七个字段，面板照常列出。拼图记在 `~/.claude/cli-runs/blueprints/<会话ID>.jsonl`（只追加的操作日志）和同名 `.json`（快照）。改 runner 字段或拼图结构时，同步修改 `hooks/register.tsx`，并把对应 atom 的 `shape` 标签加一。
