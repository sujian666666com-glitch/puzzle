# puzzle

个人 Claude Code 组件仓库。每个组件一个顶层目录，彼此独立安装。

| 目录 | 类型 | 作用 |
|---|---|---|
| `delegate-cli/` | Skill | 让 Claude 调度 Codex、Pi、Cursor：派发、续接、实时进度、验收 |
| `delegate-cli-panel/` | 插件（函数钩子 mod） | 桌面 App 右侧「子 Agent」面板，配合 delegate-cli 查看任务、结果与实时过程 |

两者只通过 `~/.claude/cli-runs/` 里的运行记录衔接：skill 单独可用，面板是可选的界面。暂时分开存放，以后需要一键安装时再合成一个插件。

## 安装（以本仓库为准）

```bash
# Skill：让 Claude 从仓库加载
ln -s ~/Desktop/jj/puzzle/delegate-cli ~/.claude/skills/delegate-cli

# 面板插件：user 级安装，直接读取仓库目录
claude plugin marketplace add ~/Desktop/jj/puzzle/delegate-cli-panel
claude plugin install delegate-cli-panel@delegate-cli-panel
```

改 skill 后立即生效；改面板后在会话里执行 `/reload-plugins`。

## 测试

```bash
cd delegate-cli && python3 -m unittest discover -s tests
claude plugin validate delegate-cli-panel && claude plugin test delegate-cli-panel
```

## 打包 Skill

```bash
git archive --format=zip --prefix=delegate-cli/ -o delegate-cli.zip HEAD:delegate-cli -- . ':(exclude)tests'
```

`delegate-cli/tests/fixtures/` 是真实运行采集的事件样本，含本机路径，不随分发包发出。
