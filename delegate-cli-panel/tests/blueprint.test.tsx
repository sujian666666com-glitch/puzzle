import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const HOME = '/home/t'
const ROOT = `${HOME}/.claude/cli-runs`
// The engine hands fs hooks a host path: on Windows "/home/t" arrives as "D:\home\t".
const posix = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
const LOG = `${ROOT}/blueprints/sess-1.jsonl`
const SNAPSHOT = `${ROOT}/blueprints/sess-1.json`
const NOW = new Date(2026, 10, 3, 10, 0, 0).getTime()
const TOOL = 'mcp__delegate-cli-panel__blueprint'

const PLAN = {
  op: 'plan',
  goal: { title: '商品搜索上线', summary: '用户能按关键词找到商品' },
  groups: [
    { id: 'G1', title: '搜索能力' },
    { id: 'G2', title: '质量与数据' },
  ],
  pieces: [
    { id: 'R1', group: 'G1', title: '搜索接口', summary: '按关键词返回商品列表', criteria: [{ id: 'R1.1', text: '关键词为空时提示错误' }] },
    { id: 'R2', group: 'G1', title: '结果排序', summary: '按相关度和销量排序', needs: ['R1'], criteria: [{ id: 'R2.1', text: '同分时新品排在前面' }] },
    { id: 'R6', group: 'G2', title: '搜索性能达标', summary: '200 人同时搜索也稳定', needs: ['R1'], criteria: [{ id: 'R6.1', text: '出错率低于千分之一' }] },
  ],
  tasks: [
    { id: 'T1', pieces: ['R1'], role: '实现', agent: 'codex', title: '实现搜索接口' },
    { id: 'T2', pieces: ['R2'], role: '实现', agent: 'cursor', title: '实现结果排序' },
  ],
}

type Disk = {
  files: Record<string, string>
  writes: string[]
  runs: Record<string, object>
  argv?: string[][]
  /** cmd's move fails, as it does while a reader holds the target. */
  isMoveLocked?: boolean
}

// Nothing sits beneath the plugin: these hooks stand for the engine and the disk.
function world(on: On, disk: Disk, env: Record<string, string> = { HOME }) {
  mock.env(on, env)
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.surfaces', () => ({ value: ['desktop'] as const }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__delegate-cli-panel__${e.name}` } }))
  on('fs.list', (_, e) => {
    if (posix(e.path) !== ROOT) return { value: [] }

    return {
      value: Object.keys(disk.runs).map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })),
    }
  })
  on('fs.read', (_, e) => {
    const parts = posix(e.path).split('/')
    if (parts.at(-1) === 'run.json') return { value: JSON.stringify(disk.runs[parts.at(-2) ?? ''] ?? {}) }

    return { value: disk.files[posix(e.path)] ?? '' }
  })
  on('fs.write', (_, e) => {
    disk.files[posix(e.path)] = e.text
    disk.writes.push(posix(e.path))

    return { value: undefined }
  })
  on('process.run', (_, e) => {
    disk.argv?.push([...e.argv])
    const isMove = e.argv[0] === 'cmd' && e.argv[3] === 'move'
    const [command, , from, to] = isMove ? ['mv', '', e.argv[5] ?? '', e.argv[6] ?? ''] : e.argv
    if (isMove && disk.isMoveLocked) {
      return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (command === 'mv' && from && to && posix(from) in disk.files) {
      disk.files[posix(to)] = disk.files[posix(from)] ?? ''
      delete disk.files[posix(from)]
    }

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
}

const fresh = (): Disk => ({ files: {}, writes: [], runs: {} })

async function call($: { tool: { call: (input: never) => Promise<unknown> } }, input: object) {
  return (await $.tool.call({ tool: TOOL, ...input } as never)) as { result?: string; deny?: string }
}

test('plan logs the blueprint and answers in one line', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const disk = fresh()
  world(on, disk)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const answer = await call($, PLAN)
  expect(answer.result).toBe('rev 1 · 建立 3 块、2 个任务 · 可开工：R1 搜索接口 · 需关注 0 项')
  expect(disk.files[LOG]).toContain('"op":"plan"')
  expect(JSON.parse(disk.files[SNAPSHOT] ?? '{}').pieces).toHaveLength(3)
  expect(disk.writes.every(path => path.endsWith('.tmp'))).toBe(true)
})

test('on Windows the log lands under USERPROFILE through cmd move, or in place when the move is refused', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const disk: Disk = { ...fresh(), argv: [] }
  world(on, disk, { USERPROFILE: 'C:\\home\\t', OS: 'Windows_NT' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  expect((await call($, PLAN)).result).toMatch(/^rev 1 /)
  expect(disk.argv?.[0]).toEqual([
    'cmd', '/d', '/c', 'move', '/y',
    'C:\\home\\t\\.claude\\cli-runs\\blueprints\\sess-1.jsonl.tmp',
    'C:\\home\\t\\.claude\\cli-runs\\blueprints\\sess-1.jsonl',
  ])
  expect(disk.argv?.some(argv => argv[0] === 'mv')).toBe(false)
  expect(disk.files[LOG]).toContain('"op":"plan"')

  disk.isMoveLocked = true
  const answer = await call($, { op: 'check', piece: 'R1', results: [{ criterion: 'R1.1', pass: true, evidence: 'pytest' }] })
  expect(answer.deny).toBeUndefined()
  expect(disk.writes.at(-1)).toBe(SNAPSHOT)
  expect(disk.files[LOG]?.trim().split('\n')).toHaveLength(2)
})

test('what does not apply is refused and nothing is written', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const disk = fresh()
  world(on, disk)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const twice = await call($, { ...PLAN, pieces: [PLAN.pieces[0], PLAN.pieces[0]] })
  expect(twice.deny).toMatch(/需求块 的 ID 重复：R1；没有写入/)
  expect(disk.writes).toEqual([])
  expect((await call($, { op: 'piece', pieces: [{ id: 'R9' }] })).deny).toMatch(/还没有拼图/)

  await call($, PLAN)
  const loop = await call($, { op: 'piece', pieces: [{ id: 'R1', needs: ['R2'] }] })
  expect(loop.deny).toMatch(/前置成环/)
  expect((await call($, PLAN)).deny).toMatch(/replace: true/)
  expect((await call($, { op: 'smash' })).deny).toMatch(/不认识的 op/)
  expect((await call($, { op: 'block', id: 'B1', piece: 'R6', reason: '缺账号' })).deny).toMatch(/owner/)
  expect(disk.files[LOG]?.trim().split('\n')).toHaveLength(1)
})

test('verdicts accept a piece, and a revision asks for re-acceptance', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const disk = fresh()
  world(on, disk)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  await call($, PLAN)

  const accepted = await call($, { op: 'check', piece: 'R1', results: [{ criterion: 'R1.1', pass: true, evidence: 'npm test 通过' }] })
  expect(accepted.result).toBe('rev 2 · 搜索接口 验收 1/1 → 已验收 · 可开工：R2 结果排序、R6 搜索性能达标 · 需关注 0 项')

  const revised = await call($, { op: 'piece', pieces: [{ id: 'R1', criteria: [{ id: 'R1.1', text: '关键词为空时返回 400' }] }] })
  expect(revised.result).toMatch(/更新 搜索接口，需要重新验收/)
  expect((await call($, { op: 'get', id: 'R1' })).result).toMatch(/R1 搜索接口 · 需复验 · 版本 2/)
  const whole = (await call($, { op: 'get' })).result ?? ''
  expect(whole).toMatch(/商品搜索上线 · rev 3 · 已验收 0\/3/)
  expect(whole).toMatch(/\[G1 搜索能力\] R1 搜索接口：需复验/)
})

test('only what the person must move counts as 需关注', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const disk = fresh()
  world(on, disk)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  await call($, PLAN)

  await call($, { op: 'ask', id: 'Q1', piece: 'R2', text: '同分时按什么排？', owner: 'user' })
  await call($, { op: 'block', id: 'B1', piece: 'R6', reason: '缺压测环境访问账号', owner: 'user' })
  const agent = await call($, { op: 'block', id: 'B2', piece: 'R2', reason: '测试数据要重建', owner: 'agent' })
  expect(agent.result).toMatch(/需关注 2 项$/)
  expect((await call($, { op: 'answer', id: 'Q1', text: '新品优先' })).result).toMatch(/需关注 1 项$/)
  expect((await call($, { op: 'unblock', id: 'B1' })).result).toMatch(/需关注 0 项$/)
})

test('the log replays when the session starts again', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const disk = fresh()
  disk.files[LOG] = [
    JSON.stringify({ rev: 1, at: NOW - 60000, ...PLAN, replace: false }),
    JSON.stringify({ rev: 2, at: NOW - 30000, op: 'check', piece: 'R1', results: [{ criterion: 'R1.1', pass: true, evidence: '' }] }),
    '{"truncated',
  ].join('\n')
  world(on, disk)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const whole = (await call($, { op: 'get' })).result ?? ''
  expect(whole).toMatch(/rev 2 · 已验收 1\/3/)
  expect((await call($, { op: 'task', tasks: [{ id: 'T3', pieces: ['R6'], role: '验收', agent: 'codex', title: '压测' }] })).result).toMatch(/^rev 3 · 任务 T3/)
})

test('runs on its tasks drive a piece, and a trust refusal waits on the person', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const disk = fresh()
  disk.runs = {
    '20261103-095900-codex-t1run0001': {
      agent: 'codex', status: 'running', access: 'write', cwd: '/w', task: 'T1',
      started_at: NOW / 1000 - 60, claude_session_id: 'sess-1',
      activity: { kind: 'tool', label: 'npm test', since: NOW / 1000 - 41 },
    },
    '20261103-095800-cursor-t2run0001': {
      agent: 'cursor', status: 'blocked', access: 'read', cwd: '/w', task: 'T2',
      started_at: NOW / 1000 - 120, finished_at: NOW / 1000 - 119, claude_session_id: 'sess-1',
      error: 'Cursor workspace is not trusted; add --cursor-trust approved only when the user has authorized trusting this directory',
    },
  }
  world(on, disk)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  expect((await call($, PLAN)).result).toMatch(/需关注 1 项$/)
  expect((await call($, { op: 'get', id: 'R1' })).result).toMatch(/现在：当前：正在执行 npm test · 41 秒/)
  expect((await call($, { op: 'get', id: 'R2' })).result).toMatch(/R2 结果排序 · 受阻/)
})

test('a dispatch names its task; one that names none gets a note only Claude reads', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const disk = fresh()
  world(on, disk)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const before = await $.tool.call({ tool: 'Bash', command: 'python3 /s/run_cli.py run --agent codex --cwd /w --prompt-file /t.md' })
  expect(before.context ?? []).toEqual([])
  await call($, PLAN)
  const named = await $.tool.call({ tool: 'Bash', command: 'python3 /s/run_cli.py run --agent codex --task T1 --cwd /w --prompt-file /t.md' })
  expect(named.context ?? []).toEqual([])
  const unnamed = await $.tool.call({ tool: 'Bash', command: 'python3 /s/run_cli.py run --agent codex --cwd /w --prompt-file /t.md' })
  expect(unnamed.context?.[0]).toMatch(/没有带 --task/)
  const other = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(other.context ?? []).toEqual([])
})
