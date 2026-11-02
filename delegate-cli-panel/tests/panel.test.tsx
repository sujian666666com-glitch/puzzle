import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const HOME = '/home/t'
const ROOT = `${HOME}/.claude/cli-runs`
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

// Nothing sits beneath the plugin: these hooks stand for the engine and the disk.
function world(on: On, opened: string[], statuses: (string | undefined)[], isPlaced = true, names = Object.keys(META)) {
  mock.env(on, { HOME })
  on('ui.panes', () => ({ value: [] }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.surfaces', () => ({ value: ['desktop'] as const }))
  on('command.register', () => ({ value: { command: 'delegate-runs' } }))
  on('ui.open', (_, e) => {
    opened.push(e.id)

    return { value: isPlaced ? { isPlaced: true } : { isPlaced: false, reason: 'opened unasked below 144 columns' } }
  })
  on('ui.status', (_, e) => {
    statuses.push(e.text)

    return { value: undefined }
  })
  on('fs.list', (_, e) => {
    if (e.path === ROOT) {
      return {
        value: [...names, '.locks'].map(name => ({
          name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false,
        })),
      }
    }
    const log = LOG[e.path.split('/').pop() ?? '']

    return {
      value: log
        ? [{ name: 'progress.log', kind: 'file' as const, size: log.text.length, mtimeMs: log.mtimeMs, isLink: false }]
        : [],
    }
  })
  on('fs.read', (_, e) => {
    const name = e.path.split('/').slice(-2, -1)[0] ?? ''

    if (e.path.endsWith('run.json')) return { value: JSON.stringify(META[name]) }

    return { value: e.path.endsWith('result.md') ? (RESULT[name] ?? '') : (LOG[name]?.text ?? '') }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
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

    expect((await ui.find({ key: LIVE }))?.text).toMatch(/Cursor.*grok-4\.7-medium/)
    expect(await ui.find({ type: 'Text', text: /读取 a\.txt/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /可能已中断/ })).toBeDefined()
    expect(await ui.find({ key: OTHER })).toBeUndefined()

    await ui.press({ key: 'scope-all' })
    expect((await ui.find({ key: OTHER }))?.text).toMatch(/Codex.*gpt-6-astra \/ medium/)
    expect(await ui.find({ type: 'Text', text: /31\.9k tok/ })).toBeDefined()
    await ui.press({ key: 'scope-mine' })

    await ui.press({ key: LIVE })
    expect(await ui.find({ type: 'Text', text: /运行中/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /a\.txt/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /会话 abc/ })).toBeUndefined()
    expect(await ui.find({ key: 'copy-watch' })).toBeDefined()
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
