import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const HOME = '/home/t'
const ROOT = `${HOME}/.claude/cli-runs`
// The engine hands fs hooks a host path: on Windows "/home/t" arrives as "D:\home\t".
const posix = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
const NOW = new Date(2026, 10, 2, 17, 16, 0).getTime()
const LIVE = '20261102-171500-cursor-live0001'
const STALE = '20261102-150000-pi-stale001'
const OTHER = '20261102-160000-codex-other001'
const DONE = '20261102-140000-pi-done0001'

const META: Record<string, object> = {
  [LIVE]: {
    agent: 'cursor', status: 'running', access: 'read', model: 'grok-4.7-medium', cwd: '/w/blog',
    started_at: NOW / 1000 - 60, claude_session_id: 'sess-1', watch_command: 'python3 run_cli.py watch --run-file x',
  },
  [STALE]: {
    agent: 'pi', status: 'running', access: 'write', model: 'deepseek/deepseek-flash', cwd: '/w/api',
    started_at: NOW / 1000 - 3600, claude_session_id: 'sess-1',
  },
  [OTHER]: {
    agent: 'codex', status: 'process_succeeded', access: 'write', model: 'gpt-6-astra', thinking: 'medium',
    cwd: '/w/web', started_at: NOW / 1000 - 1200, finished_at: NOW / 1000 - 900, claude_session_id: 'sess-2',
    usage: { total_tokens: 31923 },
  },
  [DONE]: {
    agent: 'pi', status: 'process_succeeded', access: 'read', model: 'deepseek/deepseek-flash', cwd: '/w/docs',
    started_at: NOW / 1000 - 7200, finished_at: NOW / 1000 - 7000, claude_session_id: 'sess-1',
  },
}
const LOG: Record<string, { text: string; mtimeMs: number }> = {
  [LIVE]: {
    text: '17:15:00 ● cursor · grok-4.7-medium · 只读 | /w/blog\n17:15:01 会话 abc\n17:15:05 ▶ read a.txt\n',
    mtimeMs: NOW - 5000,
  },
  [STALE]: { text: '15:00:00 ● pi · deepseek/deepseek-flash · 可写 | /w/api\n', mtimeMs: NOW - 600000 },
  [OTHER]: { text: '16:00:00 ● codex · gpt-6-astra/medium · 可写 | /w/web\n', mtimeMs: NOW - 900000 },
  [DONE]: {
    text: [
      '14:00:00 ● pi · deepseek/deepseek-flash · 只读 | /w/docs',
      '14:00:01 💬 我先看一下 `docs` 目录。',
      "14:00:02 ▶ read {'limit': 300, 'path': '/w/docs/a.md'}",
      '14:00:02 ✓ read',
      '14:00:02 ▶ read b.md',
      '14:00:02 ▶ read c.md',
      '14:00:03 ▶ read d.md',
      '14:00:04 ▶ shell npm test',
      '14:00:16 ! shell npm test [exit=1] (12s)',
      '14:01:20 … 已 64 秒无新输出；不代表卡死',
      '14:01:30 💬 测试有 1 个失败，已定位原因。',
      '14:01:31 ● 本轮完成；待主控验收',
      '14:01:31 ● 用量 输入 1,200（缓存 800）/ 输出 90 tokens',
      '14:01:31 ● process_succeeded',
    ].join('\n'),
    mtimeMs: NOW - 7000000,
  },
}

const RESULT: Record<string, string> = {
  [DONE]: '## 结论\n\n- 测试有 1 个失败\n- 原因：**fixture 过期**',
}

const TITLE_RUN = '20261102-171000-cursor-title001'
const TASK_RUN = '20261102-170900-cursor-taskmd01'
const LONG_TITLE = '20261102-170800-cursor-longtitl1'
const LONG_GOAL = '20261102-170700-cursor-longgoal1'
const HANDOFF_RUN = '20261102-170600-pi-handoff01'
const BODY_RUN = '20261102-170500-codex-body0001'
const ZETA_LIVE = '20261102-121600-pi-zetalive1'
const ZETA_DONE = '20261102-111600-cursor-zetadone1'
const ALPHA_DONE = '20261102-164600-codex-alphadone'
const STALE_TOP = '20261102-171400-pi-staletop1'
const THINK = '20261102-171200-cursor-think001'
const STOP_RUN = '20261102-171300-cursor-stop0001'
const NOPID = '20261102-171100-pi-nopid001'
const ASK = '20261102-100000-pi-ask00001'
const LONG = '修'.repeat(45)
const LONG_GOAL_TEXT = '改'.repeat(50)
const PREAMBLE = `${[
  'Your runner metadata (session_id is populated asynchronously): /tmp/run.json',
  '',
  'Delegated subtask: complete only the task below. Do not invoke other AI CLIs.',
  '',
].join('\n')}\n`

const PANE = {
  plugin: 'delegate-cli-panel',
  component: 'Pane',
  requestId: 'delegate-agents',
  props: {
    title: '子 Agent',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

type Extra = {
  meta?: Record<string, object>
  logs?: Record<string, { text: string; mtimeMs: number }>
  results?: Record<string, string>
  files?: Record<string, string>
  commands?: string[][]
  fills?: { text: string; mode: string }[]
  toasts?: string[]
  ps?: { stdout: string }
  env?: Record<string, string>
  writes?: string[]
}

// Nothing sits beneath the plugin: these hooks stand for the engine and the disk.
function world(
  on: On,
  opened: string[],
  statuses: (string | undefined)[],
  isPlaced = true,
  names = Object.keys(META),
  extra: Extra = {},
) {
  const commands = extra.commands ?? []
  const fills = extra.fills ?? []
  const toasts = extra.toasts ?? []
  const ps = extra.ps ?? { stdout: '' }
  mock.env(on, extra.env ?? { HOME })
  on('fs.write', (_, e) => {
    extra.writes?.push(posix(e.path))

    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [] }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.surfaces', () => ({ value: ['desktop'] as const }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__delegate-cli-panel__${e.name}` } }))
  on('ui.open', (_, e) => {
    opened.push(e.id)

    return { value: isPlaced ? { isPlaced: true } : { isPlaced: false, reason: 'opened unasked below 144 columns' } }
  })
  on('ui.status', (_, e) => {
    statuses.push(e.text)

    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('prompt.fill', (_, e) => {
    fills.push({ text: e.text, mode: e.mode })

    return { isFilled: true }
  })
  on('process.run', (_, e) => {
    commands.push([...e.argv])

    return {
      value: {
        exitCode: 0,
        stdout: e.argv[0] === 'ps' ? ps.stdout : '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('fs.list', (_, e) => {
    if (posix(e.path) === ROOT) {
      return {
        value: [...names, '.locks'].map(name => ({
          name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false,
        })),
      }
    }
    const name = posix(e.path).split('/').pop() ?? ''
    const log = extra.logs?.[name] ?? LOG[name]

    return {
      value: log
        ? [{ name: 'progress.log', kind: 'file' as const, size: log.text.length, mtimeMs: log.mtimeMs, isLink: false }]
        : [],
    }
  })
  on('fs.read', (_, e) => {
    const parts = posix(e.path).split('/')
    const file = parts.at(-1) ?? ''
    const name = parts.at(-2) ?? ''
    if (file === 'run.json') return { value: JSON.stringify(extra.meta?.[name] ?? META[name] ?? {}) }
    if (extra.files && posix(e.path) in extra.files) return { value: extra.files[posix(e.path)] ?? '' }
    if (file === 'result.md') return { value: (extra.results ?? RESULT)[name] ?? RESULT[name] ?? '' }
    if (file === 'progress.log') return { value: (extra.logs?.[name] ?? LOG[name])?.text ?? '' }
    if (file === 'task.md' || file === 'handoff.md') return { value: extra.files?.[`${name}/${file}`] ?? '' }

    return { value: '' }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
}

function runMeta(over: Record<string, unknown> = {}) {
  return {
    agent: 'cursor',
    status: 'process_succeeded',
    access: 'read',
    model: 'grok-4.7-medium',
    cwd: '/w/blog',
    started_at: NOW / 1000 - 600,
    finished_at: NOW / 1000 - 300,
    claude_session_id: 'sess-1',
    ...over,
  }
}

test("lists this session's runs as cards, opens itself, and shows a run's live log", async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const opened: string[] = []
  world(on, opened, [])

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  expect(opened).toContain('delegate-agents')

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    // The title alone is the button: a desktop button draws its label as one plain line.
    expect((await ui.find({ key: LIVE }))?.text).toBe('未命名任务')
    expect((await ui.find({ key: `card-${LIVE}` }))?.text).toMatch(/Cursor · grok-4\.7-medium · 只读 · 17:15 · 1 分 00 秒/)
    expect(await ui.find({ type: 'Text', text: /读取 a\.txt/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /可能已中断/ })).toBeDefined()
    expect(await ui.find({ key: OTHER })).toBeUndefined()
    expect(await ui.find({ key: 'group-blog' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /delegate-cli-panel 0\.5\.1/ })).toBeDefined()

    await ui.press({ key: 'scope-all' })
    expect((await ui.find({ key: `card-${OTHER}` }))?.text).toMatch(/Codex · gpt-6-astra \/ medium · 可写 · 16:56 · 5 分 00 秒 · 31\.9k tok/)
    expect(await ui.find({ type: 'Text', text: /31\.9k tok/ })).toBeDefined()
    expect(await ui.find({ key: 'group-web' })).toBeDefined()
    await ui.press({ key: 'scope-mine' })

    await ui.press({ key: LIVE })
    expect(await ui.find({ type: 'Text', text: /运行中/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /a\.txt/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /会话 abc/ })).toBeUndefined()
    expect(await ui.find({ key: 'copy-watch' })).toBeDefined()
    expect(await ui.find({ key: 'stop' })).toBeDefined()
    expect(await ui.find({ key: 'follow' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /正在思考|正在执行|正在写回复|等待模型|输入中/ })).toBeUndefined()
    expect(await ui.find({ type: 'Markdown', text: /结论/ })).toBeUndefined()
    await ui.press({ key: 'back' })
    expect(await ui.find({ key: LIVE })).toBeDefined()
    await ui.unmount()
  }
})

test('a finished log reads as a timeline: grouped reads, failures, messages, no stale heartbeat', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  world(on, [], [])

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: DONE })

  // A finished run opens on its result, rendered as Markdown.
  expect(await ui.find({ type: 'Markdown', text: /## 结论/ })).toBeDefined()
  expect(await ui.find({ key: 'copy-result' })).toBeDefined()
  expect(await ui.find({ key: 'follow' })).toBeDefined()
  expect(await ui.find({ key: 'stop' })).toBeUndefined()
  await ui.press({ key: 'tab-log' })

  expect(await ui.find({ type: 'Text', text: /读取 4 项/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /a\.md · b\.md · c\.md · d\.md/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /npm test.*退出码 1 12 秒/ })).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: /测试有 1 个失败/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /本轮完成，待主控验收/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /无新输出/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /'limit'/ })).toBeUndefined()
  await ui.unmount()
})

test('the command says why a pane was held back, and the status line points to it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const statuses: (string | undefined)[] = []
  world(on, [], statuses, false)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ran = await $.command.run({
    command: 'delegate-runs',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
  await clock.settle()

  expect(ran.text).toContain('opened unasked below 144 columns')
  expect(ran.text).toContain('desktop')
  expect(statuses.at(-1)).toBe('子 Agent 运行中：Cursor · /delegate-runs 查看')
})

test('a session that dispatched before reopens its pane after a reload', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const opened: string[] = []
  // Only a finished run of this session: nothing live would open the pane by itself.
  world(on, opened, [], true, [DONE])

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  expect(opened).toEqual(['delegate-agents'])
})

test('a session that never dispatched keeps the pane closed', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const opened: string[] = []
  world(on, opened, [], true, [OTHER])

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  expect(opened).toEqual([])
})

test('a card is named from title, then task.md, then the handoff, and clips at 40', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const names = [TITLE_RUN, TASK_RUN, LONG_TITLE, LONG_GOAL, HANDOFF_RUN, BODY_RUN]
  world(on, [], [], true, names, {
    meta: {
      [TITLE_RUN]: runMeta({ title: '修博客样式' }),
      [TASK_RUN]: runMeta({ started_at: NOW / 1000 - 700 }),
      [LONG_TITLE]: runMeta({ title: LONG, started_at: NOW / 1000 - 800 }),
      [LONG_GOAL]: runMeta({ started_at: NOW / 1000 - 900 }),
      [HANDOFF_RUN]: runMeta({ agent: 'pi', started_at: NOW / 1000 - 1000 }),
      [BODY_RUN]: runMeta({ agent: 'codex', started_at: NOW / 1000 - 1100 }),
    },
    files: {
      [`${TITLE_RUN}/task.md`]: `${PREAMBLE}目标：不要用任务文件里的这行\n`,
      [`${TASK_RUN}/task.md`]: `${PREAMBLE}目标：把面板改成按任务命名\n角色：执行者\n`,
      [`${LONG_TITLE}/task.md`]: `${PREAMBLE}目标：标题字段优先，这行不该出现\n`,
      [`${LONG_GOAL}/task.md`]: `${PREAMBLE}目标：${LONG_GOAL_TEXT}\n`,
      [`${HANDOFF_RUN}/task.md`]: `${PREAMBLE}角色：这行不是标题\n`,
      [`${HANDOFF_RUN}/handoff.md`]: '先修登录页的报错\n\n细节在下面。\n',
      [`${BODY_RUN}/task.md`]: `${PREAMBLE}直接写交接正文的第一行\n`,
    },
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect((await ui.find({ key: TITLE_RUN }))?.text).toContain('修博客样式')
  expect((await ui.find({ key: TITLE_RUN }))?.text).not.toContain('不要用任务文件')
  expect((await ui.find({ key: TASK_RUN }))?.text).toContain('把面板改成按任务命名')
  expect((await ui.find({ key: TASK_RUN }))?.text).not.toContain('Your runner metadata')
  expect((await ui.find({ key: TASK_RUN }))?.text).not.toContain('Delegated subtask')
  expect((await ui.find({ key: LONG_TITLE }))?.text).toContain(`${'修'.repeat(40)}…`)
  expect((await ui.find({ key: LONG_TITLE }))?.text).not.toContain(LONG)
  expect((await ui.find({ key: LONG_GOAL }))?.text).toContain(`${'改'.repeat(40)}…`)
  expect((await ui.find({ key: LONG_GOAL }))?.text).not.toContain(LONG_GOAL_TEXT)
  expect((await ui.find({ key: HANDOFF_RUN }))?.text).toContain('先修登录页的报错')
  expect((await ui.find({ key: HANDOFF_RUN }))?.text).not.toContain('这行不是标题')
  expect((await ui.find({ key: BODY_RUN }))?.text).toContain('直接写交接正文的第一行')
  await ui.unmount()
})

test('the day view groups by project and keeps a live run above newer finished ones', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const names = [ZETA_LIVE, ZETA_DONE, ALPHA_DONE, STALE_TOP]
  world(on, [], [], true, names, {
    meta: {
      [ZETA_LIVE]: runMeta({
        agent: 'pi', status: 'running', cwd: '/w/zeta', started_at: NOW / 1000 - 5 * 3600, finished_at: undefined,
      }),
      [ZETA_DONE]: runMeta({
        agent: 'cursor', cwd: '/w/zeta', started_at: NOW / 1000 - 6 * 3600, finished_at: NOW / 1000 - 6 * 3600 + 60,
      }),
      [ALPHA_DONE]: runMeta({
        agent: 'codex', cwd: '/w/alpha', started_at: NOW / 1000 - 30 * 60, finished_at: NOW / 1000 - 20 * 60,
      }),
      [STALE_TOP]: runMeta({
        agent: 'pi', status: 'running', cwd: '/w/staleproj', started_at: NOW / 1000 - 60, finished_at: undefined,
      }),
    },
    logs: {
      [ZETA_LIVE]: { text: '12:16:00 ▶ read zeta.ts\n', mtimeMs: NOW - 1000 },
      [STALE_TOP]: { text: '17:15:00 ▶ read old.ts\n', mtimeMs: NOW - 600000 },
    },
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const keysOf = async () =>
    (await ui.findAll({ type: 'Button' })).flatMap(button => (button.key && names.includes(button.key) ? [button.key] : []))

  expect(await keysOf()).toEqual([ZETA_LIVE, STALE_TOP, ALPHA_DONE, ZETA_DONE])
  expect(await ui.find({ key: 'group-zeta' })).toBeUndefined()

  await ui.press({ key: 'scope-all' })
  expect(await keysOf()).toEqual([ZETA_LIVE, ZETA_DONE, STALE_TOP, ALPHA_DONE])
  expect(await ui.find({ key: 'group-zeta' })).toBeDefined()
  expect(await ui.find({ key: 'group-alpha' })).toBeDefined()
  expect(await ui.find({ key: 'group-staleproj' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'zeta' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /可能已中断/ })).toBeDefined()
  await ui.unmount()
})

test('the task page renders handoff.md, or task.md without the runner notes', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const taskBody = `${PREAMBLE}目标：修首页标题\n\n请改 \`index.html\`。\n`
  world(on, [], [], true, [HANDOFF_RUN, TASK_RUN], {
    meta: {
      [HANDOFF_RUN]: runMeta({ title: '交接任务', cwd: '/w/web' }),
      [TASK_RUN]: runMeta({ title: '无交接文件', cwd: '/w/docs', started_at: NOW / 1000 - 800 }),
    },
    results: {
      [HANDOFF_RUN]: '## 结论\n\n做完了',
    },
    files: {
      [`${HANDOFF_RUN}/handoff.md`]: '## 交接\n\n- 先修登录页\n',
      [`${HANDOFF_RUN}/task.md`]: taskBody,
      [`${TASK_RUN}/task.md`]: taskBody,
    },
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: HANDOFF_RUN })

  expect(await ui.find({ type: 'Markdown', text: /## 结论/ })).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: /先修登录页/ })).toBeUndefined()
  await ui.press({ key: 'tab-task' })
  expect(await ui.find({ type: 'Markdown', text: /## 交接/ })).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: /先修登录页/ })).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: /Your runner metadata|Delegated subtask|index\.html/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /另附 runner 说明/ })).toBeUndefined()

  await ui.press({ key: 'back' })
  await ui.press({ key: TASK_RUN })
  await ui.press({ key: 'tab-task' })
  expect(await ui.find({ type: 'Markdown', text: /请改 `index\.html`/ })).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: /Your runner metadata|Delegated subtask/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /发送时另附 runner 说明 2 条（记录会话 ID、禁止递归调用其他 AI）/ })).toBeDefined()
  await ui.unmount()
})

test('a live run shows the activity line, its seconds, and the Cursor draft', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const meta: Record<string, unknown> = {
    ...runMeta({ status: 'running' }),
    finished_at: undefined,
    activity: { kind: 'thinking', label: '', since: NOW / 1000 - 12 },
    live_text: '正在写**一半**',
  }
  world(on, [], [], true, [THINK], {
    meta: { [THINK]: meta },
    logs: { [THINK]: { text: '17:12:00 ▶ read SKILL.md\n', mtimeMs: NOW - 1000 } },
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: THINK })

  expect(await ui.find({ type: 'Text', text: '◐ 正在思考 · 已 12 秒' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '输入中' })).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: /正在写\*\*一半\*\*▍/ })).toBeDefined()

  await clock.advance(5000)
  expect(await ui.find({ type: 'Text', text: '◐ 正在思考 · 已 17 秒' })).toBeDefined()

  const at = clock.now()
  meta.activity = { kind: 'tool', label: 'read SKILL.md', since: Math.floor((at + 1000) / 1000) - 3 }
  meta.live_text = ''
  await clock.advance(1000)
  expect(await ui.find({ type: 'Text', text: '◐ 正在执行 read SKILL.md · 3 秒' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '输入中' })).toBeUndefined()

  meta.activity = { kind: 'writing', label: '', since: clock.now() / 1000 }
  await clock.advance(1000)
  expect(await ui.find({ type: 'Text', text: '◐ 正在写回复…' })).toBeDefined()

  const waitAt = clock.now()
  meta.activity = { kind: 'waiting', label: '', since: Math.floor((waitAt + 1000) / 1000) - 40 }
  await clock.advance(1000)
  expect(await ui.find({ type: 'Text', text: '◐ 等待模型 · 已 40 秒' })).toBeDefined()
  await ui.unmount()
})

test('stop asks twice, checks the process, and reverts; follow fills the prompt', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const commands: string[][] = []
  const fills: { text: string; mode: string }[] = []
  const toasts: string[] = []
  const ps = { stdout: '' }
  world(on, [], [], true, [STOP_RUN, NOPID, ASK], {
    commands,
    fills,
    toasts,
    ps,
    meta: {
      [STOP_RUN]: runMeta({ status: 'running', finished_at: undefined, runner_pid: 4242, started_at: NOW / 1000 - 30 }),
      [NOPID]: runMeta({ agent: 'pi', status: 'running', finished_at: undefined, started_at: NOW / 1000 - 40 }),
      [ASK]: runMeta({ agent: 'pi', title: '已完成的任务', started_at: NOW / 1000 - 3600 }),
    },
    logs: {
      [STOP_RUN]: { text: '17:13:00 ● cursor\n', mtimeMs: NOW - 1000 },
      [NOPID]: { text: '17:12:00 ● pi\n', mtimeMs: NOW - 1000 },
    },
    results: { [ASK]: '## 结论\n\n可以追问' },
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: NOPID })
  await ui.press({ key: 'stop' })
  expect((await ui.find({ key: 'stop' }))?.text).toContain('确认停止')
  await ui.press({ key: 'stop' })
  expect(commands).toEqual([])
  expect(toasts.at(-1)).toBe('没有 runner 进程号，未停止')

  await ui.press({ key: 'back' })
  await ui.press({ key: STOP_RUN })
  expect((await ui.find({ key: 'stop' }))?.text).toContain('停止')
  await ui.press({ key: 'stop' })
  expect((await ui.find({ key: 'stop' }))?.text).toContain('确认停止')
  await ui.press({ key: 'back' })
  await ui.press({ key: STOP_RUN })
  expect((await ui.find({ key: 'stop' }))?.text).not.toContain('确认停止')

  await ui.press({ key: 'stop' })
  await clock.advance(6000)
  expect((await ui.find({ key: 'stop' }))?.text).not.toContain('确认停止')
  expect(commands).toEqual([])

  ps.stdout = '/usr/bin/python3 /tmp/other.py\n'
  await ui.press({ key: 'stop' })
  await ui.press({ key: 'stop' })
  expect(commands).toEqual([['ps', '-o', 'command=', '-p', '4242']])
  expect(toasts.at(-1)).toBe('进程命令行不含 run_cli.py，未停止')

  commands.length = 0
  ps.stdout = 'python3 /opt/delegate-cli/scripts/run_cli.py run --run-dir /tmp/x\n'
  await ui.press({ key: 'stop' })
  await ui.press({ key: 'stop' })
  expect(commands).toEqual([
    ['ps', '-o', 'command=', '-p', '4242'],
    ['kill', '-TERM', '4242'],
  ])
  expect(toasts.at(-1)).toBe('已发送停止信号')

  await ui.press({ key: 'follow' })
  expect(fills.at(-1)).toEqual({ text: `用 delegate-cli 续接这次运行（${STOP_RUN}）：`, mode: 'replace' })
  expect(toasts.at(-1)).toBe('在输入框补充要求后发送')

  await ui.press({ key: 'back' })
  await ui.press({ key: ASK })
  expect(await ui.find({ key: 'stop' })).toBeUndefined()
  await ui.press({ key: 'follow' })
  expect(fills.at(-1)).toEqual({ text: `用 delegate-cli 续接这次运行（${ASK}）：`, mode: 'replace' })
  await ui.unmount()
})

test('on Windows, stop finds the runs under USERPROFILE and asks the runner through stop.request', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const commands: string[][] = []
  const toasts: string[] = []
  const writes: string[] = []
  // No HOME, as a desktop app on Windows sees it; the drive letter drops out in posix().
  world(on, [], [], true, [STOP_RUN], {
    commands,
    toasts,
    writes,
    env: { USERPROFILE: 'C:\\home\\t', OS: 'Windows_NT' },
    meta: { [STOP_RUN]: runMeta({ status: 'running', finished_at: undefined, runner_pid: 4242, started_at: NOW / 1000 - 30 }) },
    logs: { [STOP_RUN]: { text: '17:13:00 ● cursor\n', mtimeMs: NOW - 1000 } },
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: STOP_RUN })
  await ui.press({ key: 'stop' })
  await ui.press({ key: 'stop' })
  expect(commands).toEqual([])
  expect(writes).toEqual([`${ROOT}/${STOP_RUN}/stop.request`])
  expect(toasts.at(-1)).toBe('已请求停止')
  await ui.unmount()
})
