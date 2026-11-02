# 在提交中记录子 Agent 会话

用户授权提交时，默认让子 Agent 完成修改并返回，由主控验收后提交。这样真实会话 ID 已落盘，避免子 Agent 猜测自己的 ID、漏写 trailer 或提前提交未验收结果。该习惯不代表每个子任务都必须提交。

先把提交标题/正文写入文件，再生成完整消息（这条命令本身不执行 Git 提交）：

```bash
python3 "${CLAUDE_SKILL_DIR}/scripts/run_cli.py" commit-message \
  --run-file "/执行任务/run.json" \
  --message-file "/提交正文.txt" > "/完整提交正文.txt"
# 验收通过，确认暂存文件均属本任务且已获提交授权后：
git commit -F "/完整提交正文.txt"
```

示例 trailer：

```text
Agent-Session: codex:真实会话ID
Agent-Run: codex:本次运行目录名
```

- 支持重复 `--run-file`，记录实际参与该提交的多个执行/审查会话（Codex、Pi、Cursor 均可）。
- 读取 `run.json` 中真实 `session_id`，不使用 Claude 会话 ID、后台任务 ID 或日志目录名冒充。Codex 取 `thread.started.thread_id`，Cursor 取事件流里的 `session_id`（即 chatId），Pi 取会话文件头的 ID；会话首次被观察到时即更新运行记录。
- 显式要求子 Agent 自行提交时，在任务中传入其真实运行记录路径，让它等记录中 session_id 可用后使用同样 trailer；完成后主控检查 `git log -1 --format=%B`。不要调用只接受已完成运行的 commit-message 子命令给尚在运行的自己生成消息。
- 不要自动 amend 用户现有提交。查验可用 `git log --all --grep='Agent-Session: codex:会话ID'`；会话日志保留在本机，不把日志或绝对个人路径提交到仓库。
