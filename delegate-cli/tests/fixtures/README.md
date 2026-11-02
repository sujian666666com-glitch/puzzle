真实运行采集的事件样本（2026-11-02），供离线测试使用；含本机绝对路径，不随分发包发出。
- cursor-partial.jsonl：`cursor-agent -p --output-format stream-json --stream-partial-output`。逐字片段 = assistant 事件带 `timestamp_ms` 且无 `model_call_id`；整段 = 带 `model_call_id`（工具调用前刷出）或两者都没有（结束前最后一段）。另有 thinking delta/completed。
- cursor-plain.jsonl：同上但未开 `--stream-partial-output`，只有整段 assistant 事件。
- codex-events.jsonl：`codex exec --json`（gpt-6-astra/low），cwd 为 /private/tmp/dcli-e2e.K6Mo。
- pi-session.jsonl：Pi print 模式的会话文件（deepseek-flash），cwd 为 ~/.claude/skills/delegate-cli。
