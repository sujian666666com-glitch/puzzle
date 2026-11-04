import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const HOME = '/home/t'
const ROOT = `${HOME}/.claude/cli-runs`
const NOW = new Date(2026, 10, 3, 10, 0, 0).getTime()
const TOOL = 'mcp__delegate-cli-panel__blueprint'
const PLUGIN = 'delegate-cli-panel'
const RANK_RUN = '20261103-095900-codex-rank0001'
const DISPATCH = 'python3 /s/run_cli.py run --agent codex --task T2 --cwd /w --prompt-file /t.md'
const PEEK = 'Codex 实现中 · 正在执行 npm test · 41 秒'

const PLAN = {
  op: 'plan',
  goal: { title: '商品搜索上线', summary: '用户能按关键词找到商品，搜不到时也有推荐' },
  groups: [
    { id: 'G1', title: '搜索能力' },
    { id: 'G2', title: '搜索体验' },
    { id: 'G3', title: '质量与数据' },
  ],
  pieces: [
    { id: 'R1', group: 'G1', title: '搜索接口', summary: '按关键词返回商品列表', criteria: [{ id: 'R1.1', text: '关键词为空时提示错误' }] },
    { id: 'R2', group: 'G1', title: '结果排序', summary: '按相关度和销量排序', needs: ['R1'], criteria: [{ id: 'R2.1', text: '同分时新品在前' }] },
    { id: 'R3', group: 'G2', title: '搜索页面', summary: '搜索框、结果列表和分页', needs: ['R1', 'R2'], criteria: [{ id: 'R3.1', text: '翻页保留关键词' }] },
    { id: 'R4', group: 'G2', title: '空结果推荐', summary: '搜不到时给出替代建议', needs: ['R1'], criteria: [{ id: 'R4.1', text: '推荐不为空' }] },
    { id: 'R5', group: 'G3', title: '搜索性能达标', summary: '200 人同时搜索也稳定', needs: ['R1'], criteria: [{ id: 'R5.1', text: '出错率低于千分之一' }] },
  ],
  tasks: [
    { id: 'T1', pieces: ['R1'], role: '实现', agent: 'codex', title: '实现搜索接口' },
    { id: 'T2', pieces: ['R2'], role: '实现', agent: 'codex', title: '实现结果排序' },
    { id: 'T3', pieces: ['R5'], role: '验收', agent: 'codex', title: '压测搜索' },
  ],
}
const RANK = {
  agent: 'codex', status: 'running', access: 'write', cwd: '/w', task: 'T2', title: '实现结果排序',
  started_at: NOW / 1000 - 60, claude_session_id: 'sess-1', runner_pid: 4242,
  activity: { kind: 'tool', label: 'npm test', since: NOW / 1000 - 41 },
}
const PANE_PROPS = { isFocused: false, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} } as const
const PUZZLE = {
  plugin: PLUGIN,
  component: 'Pane',
  requestId: 'delegate-puzzle',
  props: { ...PANE_PROPS, title: '需求拼图', bodyColumns: 56 },
} as const
const AGENTS_PANE = {
  plugin: PLUGIN,
  component: 'Pane',
  requestId: 'delegate-agents',
  props: { ...PANE_PROPS, title: '子 Agent', bodyColumns: 60 },
} as const

type World = {
  opened: string[]
  fills: string[]
  toasts: string[]
  argv: string[][]
  /** tool_use_ids the engine gave Bash calls. */
  seen: string[]
  isPlaced: boolean
  files: Record<string, string>
  runs: Record<string, object>
}

const fresh = (over: Partial<World> = {}): World => ({
  opened: [], fills: [], toasts: [], argv: [], seen: [], isPlaced: true, files: {}, runs: { [RANK_RUN]: RANK }, ...over,
})

// Nothing sits beneath the plugin: these hooks stand for the engine and the disk.
function world(on: On, w: World) {
  mock.env(on, { HOME })
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.surfaces', () => ({ value: ['desktop'] as const }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', (_, e) => {
    w.opened.push(e.id)

    return { value: w.isPlaced ? { isPlaced: true } : { isPlaced: false, reason: 'opened unasked below 144 columns' } }
  })
  on('ui.close', () => ({}))
  on('ui.focus', () => ({}))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    w.toasts.push(e.text)

    return { value: undefined }
  })
  on('prompt.fill', (_, e) => {
    w.fills.push(e.text)

    return { isFilled: true }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__delegate-cli-panel__${e.name}` } }))
  on('fs.list', (_, e) => {
    if (e.path !== ROOT) return { value: [] }

    return { value: Object.keys(w.runs).map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', (_, e) => {
    const parts = e.path.split('/')
    if (parts.at(-1) === 'run.json') return { value: JSON.stringify(w.runs[parts.at(-2) ?? ''] ?? {}) }

    return { value: w.files[e.path] ?? '' }
  })
  on('fs.write', (_, e) => {
    w.files[e.path] = e.text

    return { value: undefined }
  })
  on('process.run', (_, e) => {
    w.argv.push([...e.argv])
    const [command, , from, to] = e.argv
    if (command === 'mv' && from && to && from in w.files) {
      w.files[to] = w.files[from] ?? ''
      delete w.files[from]
    }
    const stdout = command === 'ps' ? 'python3 /s/run_cli.py run --agent codex' : ''

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', { tool: 'Bash' }, (_, e) => {
    w.seen.push(e.tool_use_id)

    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
}

type Node = { type?: string; props?: Record<string, unknown>; hover?: Record<string, unknown>; children?: unknown[] }

// Every object in a drawn tree, element or not; the checks pick the elements out.
function nodes(tree: unknown): Node[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (tree === null || typeof tree !== 'object') return []

  return [tree as Node, ...Object.values(tree).flatMap(nodes)]
}

// The host's rule: a hover reveals only a Box drawn hidden, and one drawn shown fails the
// whole tree, which closes the pane.
const refused = (tree: unknown) =>
  nodes(tree).filter(node => node.type === 'Box' && node.hover?.display === 'flex' && node.props?.display !== 'none')

// A Text's own words: `需关注 {n} 项` reaches the tree as three children.
const own = (node: Node) =>
  (node.children ?? []).map(child => (typeof child === 'string' || typeof child === 'number' ? String(child) : '')).join('')

const texts = (tree: unknown, text: string) => nodes(tree).filter(node => node.type === 'Text' && own(node).includes(text))

async function call($: { tool: { call: (input: never) => Promise<unknown> } }, input: object) {
  return (await $.tool.call({ tool: TOOL, ...input } as never)) as { result?: string; deny?: string }
}

type Engine = Parameters<Parameters<typeof test>[1]>[0]

async function begin($: Engine, on: On, w: World) {
  const clock = mock.clock(on, { now: NOW })
  world(on, w)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  return clock
}

// Accepted, running, waiting, unclear and blocked: one block of each.
async function planned($: Engine) {
  await call($, PLAN)
  await call($, { op: 'check', piece: 'R1', results: [{ criterion: 'R1.1', pass: true, evidence: 'npm test 通过' }] })
  await call($, { op: 'ask', id: 'Q1', piece: 'R4', text: '搜不到时推荐什么', owner: 'user' })
  await call($, { op: 'block', id: 'B1', piece: 'R5', reason: '缺压测环境访问账号', owner: 'user' })
}

// A person's close (ui.close, origin person) is the engine's to raise; a test cannot.
test('the first plan opens the puzzle, a reload brings it back, and /puzzle opens it', async ($, on) => {
  const w = fresh()
  const clock = await begin($, on, w)
  const opens = () => w.opened.filter(id => id === 'delegate-puzzle').length
  expect(opens()).toBe(0)

  await call($, PLAN)
  expect(opens()).toBe(1)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  expect(opens()).toBe(2)

  const ran = await $.command.run({
    command: 'puzzle',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
  expect(ran.text).toBe('需求拼图已打开。')
  expect(opens()).toBe(3)
})

test('a plan whose pane the surface holds back says where the puzzle is', async ($, on) => {
  const w = fresh({ isPlaced: false })
  await begin($, on, w)
  await call($, PLAN)
  expect(w.toasts).toContain('需求拼图已建立，输入 /puzzle 查看')
})

test('a pane that fails to open leaves the plan written and the answer a success', async ($, on) => {
  const w = fresh()
  on('ui.open', { id: 'delegate-puzzle' }, () => {
    throw new Error('no surface')
  })
  await begin($, on, w)
  const answer = await call($, PLAN)
  expect(answer.deny).toBeUndefined()
  expect(answer.result).toMatch(/^rev 1 · 建立 5 块、3 个任务/)
})

test('the board shows the requirement in its groups, with plain-label cards and no IDs', async ($, on) => {
  const w = fresh()
  await begin($, on, w)
  await planned($)
  const ui = await $.ui.mount({ ...PUZZLE, surface: 'desktop' })
  const drawn = await ui.drawn()

  expect(texts(drawn, '商品搜索上线')).toHaveLength(1)
  expect(texts(drawn, '1 / 5')).toHaveLength(1)
  expect(texts(drawn, '需关注 2 项')).toHaveLength(1)
  expect(texts(drawn, '质量与数据')).toHaveLength(1)
  // A desktop button draws its label alone, so the card's title is the whole label.
  expect((await ui.find({ key: 'open-R1' }))?.text).toBe('搜索接口')
  expect((await ui.find({ key: 'card-R1' }))?.props).toMatchObject({ backgroundColor: 'diffAddedDimmed' })
  expect((await ui.find({ key: 'card-R4' }))?.props).toMatchObject({ borderColor: 'warning' })
  expect(texts(drawn, '缺压测环境访问账号').length).toBeGreaterThan(0)
  expect(nodes(drawn).filter(node => node.type === 'Text' && /\b[RTGQB]\d\b/.test(JSON.stringify(node.children ?? [])))).toEqual([])
  expect(refused(drawn)).toEqual([])
  await ui.unmount()
})

test('hover lights a block, swaps its line in place, and tags its related blocks', async ($, on) => {
  const w = fresh()
  await begin($, on, w)
  await planned($)
  const ui = await $.ui.mount({ ...PUZZLE, surface: 'desktop' })
  const drawn = await ui.drawn()
  const chips = (scope: string) =>
    nodes(drawn)
      .filter(node => node.type === 'Box' && node.hover?.scope === scope && node.hover?.display === 'flex')
      .map(node => (nodes(node).find(one => one.type === 'Text')?.children ?? []).join(''))
      .filter(text => text === '前置' || text === '后续')

  // Every block needs the search API, so under it they all read 后续.
  expect(chips('piece-R1')).toEqual(['后续', '后续', '后续', '后续'])
  expect(chips('piece-R2')).toEqual(['前置', '后续'])
  const [summary] = texts(drawn, '按相关度和销量排序')
  expect(summary?.hover).toEqual({ scope: 'piece-R2', color: '#0000' })
  expect(texts(drawn, PEEK)).toHaveLength(1)
  // A Box with an absolute child is positioned, and the pane sets no stacking order: a
  // positioned card later in the tree would paint over what an earlier one shows.
  const isCard = (node: Node) => /^(card|row)-/.test(String(node.props?.key ?? ''))
  const anchors = (node: Node) =>
    (node.children ?? []).some(child => (child as Node)?.type === 'Box' && (child as Node).props?.position === 'absolute')
  expect(nodes(drawn).filter(node => node.type === 'Box' && isCard(node) && anchors(node))).toEqual([])
  await ui.unmount()
})

test('a click opens the detail; its actions only fill the prompt, and 停止 asks twice', async ($, on) => {
  const w = fresh()
  await begin($, on, w)
  await planned($)
  const ui = await $.ui.mount({ ...PUZZLE, surface: 'desktop' })

  await ui.press({ key: 'open-R4' })
  await ui.press({ key: 'act-answer' })
  expect(w.fills.at(-1)).toBe('回答「空结果推荐」的问题（搜不到时推荐什么）：')
  await ui.press({ key: 'open-R5' })
  await ui.press({ key: 'act-unblock' })
  expect(w.fills.at(-1)).toBe('关于「搜索性能达标」受阻（缺压测环境访问账号）：')

  await ui.press({ key: 'open-R2' })
  expect(texts(await ui.drawn(), '验收 0 / 1')).toHaveLength(1)
  expect(await ui.find({ key: `run-${RANK_RUN}` })).toBeDefined()
  await ui.press({ key: 'act-stop' })
  expect(w.argv.some(argv => argv[0] === 'kill')).toBe(false)
  await ui.press({ key: 'act-stop' })
  expect(w.argv).toContainEqual(['kill', '-TERM', '4242'])

  await ui.press({ key: 'act-close' })
  expect(await ui.find({ key: 'act-ask' })).toBeUndefined()
  // 需关注 lists the open question first, as the blocks are ordered.
  await ui.press({ key: 'attention-0' })
  expect(await ui.find({ key: 'act-answer' })).toBeDefined()
  await ui.unmount()
})

test('keyboard focus shows the peek in place, with no reveal on a box already shown', async ($, on) => {
  const w = fresh()
  await begin($, on, w)
  await planned($)
  await $.ui.focus({ component: 'Pane', requestId: 'delegate-puzzle', plugin: PLUGIN, element: 'open-R2', origin: { kind: 'person' } })
  const ui = await $.ui.mount({ ...PUZZLE, surface: 'desktop' })
  const drawn = await ui.drawn()

  // In the card's own line, and in the swap that a pointer would still reveal.
  expect(texts(drawn, PEEK)).toHaveLength(2)
  expect((await ui.find({ key: 'card-R2' }))?.props).toMatchObject({ borderColor: 'suggestion' })
  expect(refused(drawn)).toEqual([])
  await ui.unmount()
})

test('the list and the relation tree, and a narrow pane falls back to the list', async ($, on) => {
  const w = fresh()
  await begin($, on, w)
  await planned($)
  const ui = await $.ui.mount({ ...PUZZLE, surface: 'desktop' })

  await ui.press({ key: 'view-list' })
  expect(await ui.find({ key: 'row-R5' })).toBeDefined()
  expect(await ui.find({ key: 'card-R5' })).toBeUndefined()
  await ui.press({ key: 'view-tree' })
  // 搜索页面 sits under 结果排序, the last block it needs, and names the other.
  expect((await ui.find({ key: 'row-R3' }))?.text).toMatch(/也需要：搜索接口/)
  expect(refused(await ui.drawn())).toEqual([])
  await ui.press({ key: 'view-board' })
  await ui.unmount()

  const narrow = await $.ui.mount({ ...PUZZLE, props: { ...PUZZLE.props, bodyColumns: 36 }, surface: 'desktop' })
  expect(await narrow.find({ key: 'row-R1' })).toBeDefined()
  await narrow.unmount()
})

test('transcript rows join their block: a blueprint call, a dispatch and its notice', async ($, on) => {
  const w = fresh()
  // What the engine draws for a row the plugin leaves alone.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  await begin($, on, w)
  await planned($)
  const row = (component: 'ToolUse' | 'ToolResult', requestId: string, props: object) =>
    ({ plugin: PLUGIN, component, requestId, surface: 'desktop', props }) as const
  const idle = { isRunning: false, isErrored: false, isInterrupted: false }

  const check = await $.ui.mount(
    row('ToolUse', 'tu1', {
      ...idle,
      tool_use_id: 'tu1',
      tool: TOOL,
      input: { op: 'check', piece: 'R1', results: [] },
      output: 'rev 2 · 搜索接口 验收 1/1 → 已验收 · 可开工：R2 结果排序 · 需关注 0 项',
    }),
  )
  expect(JSON.stringify(await check.drawn())).toContain('"scope":"piece-R1"')
  expect(await check.find({ type: 'Text', text: /^拼图 · 搜索接口 验收 1\/1 → 已验收$/ })).toBeDefined()
  await check.press({ key: 'locate-tu1' })
  expect(w.opened.at(-1)).toBe('delegate-puzzle')
  await check.unmount()

  // The row already says what changed, so the result block under it draws nothing.
  const result = await $.ui.mount(row('ToolResult', 'tu1', { tool_use_id: 'tu1', tool: TOOL, output: 'rev 2', isErrored: false }))
  expect(await result.find({ type: 'Text' })).toBeUndefined()
  await result.unmount()

  const bash = await $.ui.mount(
    row('ToolUse', 'tu2', { ...idle, tool_use_id: 'tu2', tool: 'Bash', input: { command: DISPATCH, description: 'Codex：实现结果排序' } }),
  )
  expect(JSON.stringify(await bash.drawn())).toContain('"scope":"piece-R2"')
  expect(await bash.find({ type: 'Text', text: /派发 · Codex：实现结果排序/ })).toBeDefined()
  await bash.unmount()
  const ls = await $.ui.mount(row('ToolUse', 'tu3', { ...idle, tool_use_id: 'tu3', tool: 'Bash', input: { command: 'ls' } }))
  expect((await ls.find({ type: 'Text' }))?.text).toBe('engine')
  await ls.unmount()

  await $.tool.call({ tool: 'Bash', command: DISPATCH })
  const notice = await $.ui.mount({
    plugin: PLUGIN,
    component: 'UserMessage',
    requestId: 'm1',
    surface: 'desktop',
    props: {
      text: 'Background command "Codex：实现结果排序" completed',
      origin: { kind: 'task-notification' },
      isExpanded: false,
      task: { toolUseId: w.seen.at(-1), status: 'completed' },
    },
  } as never)
  expect(await notice.find({ type: 'Text', text: /运行结束 · 实现结果排序/ })).toBeDefined()
  await notice.unmount()
})

test('a run on a task names its block in the 子 Agent pane, and the name opens the puzzle on it', async ($, on) => {
  const w = fresh()
  await begin($, on, w)
  await planned($)
  const runsPane = await $.ui.mount({ ...AGENTS_PANE, surface: 'desktop' })

  await runsPane.press({ key: RANK_RUN })
  expect((await runsPane.find({ key: 'piece-R2' }))?.text).toBe('结果排序')
  await runsPane.press({ key: 'piece-R2' })
  expect(w.opened.at(-1)).toBe('delegate-puzzle')
  await runsPane.unmount()

  const puzzle = await $.ui.mount({ ...PUZZLE, surface: 'desktop' })
  expect(await puzzle.find({ key: `run-${RANK_RUN}` })).toBeDefined()
  await puzzle.unmount()
})
