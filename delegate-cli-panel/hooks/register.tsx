import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Blueprint, RunActivity, RunDetail, RunRow } from '../types'
import {
  apply,
  blueprintPaths,
  derive,
  describe,
  isRefusal,
  parseOp,
  readLog,
  replay,
  replyLine,
  writeLog,
} from './blueprint'
import { homeDir, isWindows } from './host'
import { drawPuzzle, PUZZLE_COLUMNS, PUZZLE_PANE, PUZZLE_TITLE } from './puzzle'
import type { PuzzleActions, PuzzleModel } from './puzzle'
import { drawBlueprintRow, drawDispatchRow, drawTaskNotice, RUN_CALL, TASK_FLAG } from './rows'
import type { RowModel } from './rows'

const VERSION = '0.5.1'
const PANE = 'delegate-agents'
const TITLE = '子 Agent'
// One second, so an open live run can tick its status line. Other gaps skip ticks.
const TICK_MS = 1000
const LIVE_MS = 2000
// Rescan for new runs this often while nothing runs and no run is open.
const IDLE_MS = 10000
// The runner writes progress.log at least once a minute while it is alive.
const STALE_MS = 180000
const WINDOW_MS = 7 * 86400000
const RECENT_MS = 86400000
const RESULT_CHARS = 8000
const TITLE_CHARS = 40
const STOP_MS = 5000
const TASK_NOTE = '发送时另附 runner 说明 2 条（记录会话 ID、禁止递归调用其他 AI）'
const RUN_DIR = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(codex|pi|cursor)-/
const LINE = /^(\d\d:\d\d:\d\d) (\S+)(?: (.*))?$/
const ACTIVE = new Set(['running', 'preparing'])
const AGENTS: Record<string, string> = { codex: 'Codex', pi: 'Pi', cursor: 'Cursor' }
const VERBS: Record<string, string> = {
  read: '读取',
  grep: '搜索',
  find: '查找',
  glob: '查找',
  ls: '列目录',
  list: '列目录',
  shell: '命令',
  bash: '命令',
  edit: '编辑',
  write: '写入',
  delete: '删除',
  semSearch: '语义搜索',
  webSearch: '搜索网页',
  webFetch: '抓取网页',
  fetch: '抓取网页',
  updateTodos: '更新待办',
  todo: '更新待办',
}
// Consecutive calls of these collapse into one row.
const GROUPED = new Set(['read', 'grep', 'find', 'glob', 'ls', 'list'])

type Tone = 'claude' | 'success' | 'error' | 'warning' | 'inactive' | 'subtle'
type Tool = { kind: 'tool'; name: string; details: string[]; note: string; isFailed: boolean }
type Entry =
  | Tool
  | { kind: 'message'; time: string; text: string }
  | { kind: 'edit'; detail: string }
  | { kind: 'mark'; text: string; tone: Tone }
  | { kind: 'quiet'; text: string }

// Change a tag when that value's fields change: it declines what an earlier version stored,
// which outlives a reload. The state scan reads only the atoms a module makes itself, so every
// value the panes and the transcript rows draw from is made here and handed to them.
const runs = atom({ plugin: 'delegate-cli-panel', key: 'runs' } as const, [], { shape: 'runs-4' })
const detail = atom({ plugin: 'delegate-cli-panel', key: 'detail' } as const, null, { shape: 'detail-3' })
const selected = atom({ plugin: 'delegate-cli-panel', key: 'selected' } as const, null)
const scope = atom({ plugin: 'delegate-cli-panel', key: 'scope' } as const, 'mine')
const tab = atom({ plugin: 'delegate-cli-panel', key: 'tab' } as const, 'auto')
const autoOpened = atom({ plugin: 'delegate-cli-panel', key: 'autoOpened' } as const, [])
const dismissed = atom({ plugin: 'delegate-cli-panel', key: 'dismissed' } as const, false)
const stopArm = atom({ plugin: 'delegate-cli-panel', key: 'stopArm' } as const, null, { shape: 'stop-1' })
const blueprint = atom({ plugin: 'delegate-cli-panel', key: 'blueprint' } as const, null, { shape: 'blueprint-1' })
const dispatches = atom({ plugin: 'delegate-cli-panel', key: 'dispatches' } as const, {}, { shape: 'dispatches-1' })
const puzzleView = atom({ plugin: 'delegate-cli-panel', key: 'puzzleView' } as const, 'board')
const puzzleSelected = atom({ plugin: 'delegate-cli-panel', key: 'puzzleSelected' } as const, null)
const puzzleFocused = atom({ plugin: 'delegate-cli-panel', key: 'puzzleFocused' } as const, null)
const puzzleDismissed = atom({ plugin: 'delegate-cli-panel', key: 'puzzleDismissed' } as const, false)

const UNTRACKED_RUN =
  '这次派发没有带 --task，需求拼图里不会出现这次运行。按 blueprint 里的任务 ID 补上，或用 blueprint task 增加对应任务后续接。'
const BLUEPRINT_DESCRIPTION = [
  "Keeps this session's requirement blueprint (需求拼图) for delegate-cli work. The panel derives every status from it and from each run's run.json; never write a status yourself.",
  'IDs are yours and stay stable (pieces R1, groups G1, tasks T1, questions Q1, blockers B1); the panel never shows them to the person. Dispatch every run with run_cli.py run --task <task id>.',
  'Ops: plan — first time: goal {title, summary}, groups [{id, title}], pieces [{id, group, title, summary, scope?, needs?, criteria [{id, text}]}], tasks [{id, pieces, role, agent, title, after?}]; replace: true starts over.',
  'piece — upsert pieces; a change to summary, scope or criteria raises the version, and an accepted piece then needs re-acceptance. task — upsert tasks.',
  'ask — id, piece, text, owner. answer — id, text. check — piece, results [{criterion, pass, evidence}], only after you verified it yourself.',
  'block — id, piece, reason, owner, for a blocker outside any run. unblock — id. get — id of a piece, or none for the whole blueprint.',
  "A piece is an outcome ('搜索性能达标'), not an activity ('压测'); group pieces by what the requirement is made of, 3–9 in all. owner is user only when the person's move is next: an access, a rule, a decision, an authorization; anything an agent or you can fix is agent.",
  'The answer is one line: rev · change · 可开工 · 需关注.',
].join('\n')
const PIECE_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    group: { type: 'string' },
    title: { type: 'string', description: 'An outcome, in the words the person uses' },
    summary: { type: 'string', description: 'One line on what it is' },
    scope: { type: 'string', description: 'What it includes and what it leaves out' },
    needs: { type: 'array', items: { type: 'string' }, description: 'Pieces that must be accepted first' },
    criteria: {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] },
    },
  },
  required: ['id'],
}
const TASK_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    pieces: { type: 'array', items: { type: 'string' } },
    role: { type: 'string', description: '实现, 审查, 验收, 排查…' },
    agent: { type: 'string', enum: ['codex', 'pi', 'cursor'] },
    title: { type: 'string', description: 'The run title, as passed to --title' },
    after: { type: 'array', items: { type: 'string' } },
  },
  required: ['id'],
}
const BLUEPRINT_SCHEMA = {
  type: 'object',
  properties: {
    op: { type: 'string', enum: ['plan', 'piece', 'task', 'ask', 'answer', 'check', 'block', 'unblock', 'get'] },
    goal: { type: 'object', properties: { title: { type: 'string' }, summary: { type: 'string' } }, required: ['title'] },
    groups: {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } }, required: ['id', 'title'] },
    },
    pieces: { type: 'array', items: PIECE_SCHEMA },
    tasks: { type: 'array', items: TASK_SCHEMA },
    replace: { type: 'boolean' },
    id: { type: 'string', description: 'The question or blocker, or the piece for get' },
    piece: { type: 'string' },
    text: { type: 'string' },
    reason: { type: 'string' },
    owner: { type: 'string', enum: ['user', 'agent'] },
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: { criterion: { type: 'string' }, pass: { type: 'boolean' }, evidence: { type: 'string' } },
        required: ['criterion', 'pass'],
      },
    },
  },
  required: ['op'],
}

// A finished run's files never change again, so it is read once per load.
const finished = new Map<string, RunRow>()
const results = new Map<string, string>()
const tails = new Map<string, { size: number; mtimeMs: number; lines: string[] }>()
let isBusy = false
let lastScan = 0
let isWoken = false
let lastStatus: string | undefined
let isPaneHeld = false
// The blueprint log as last read or written, and the session it belongs to.
let logLines: string[] = []
let logSession = ''
// Blueprint calls run one at a time: two in one model turn must not interleave their writes.
let blueprintChain: Promise<unknown> = Promise.resolve()

const text = (value: unknown) => (typeof value === 'string' ? value : '')
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null)

function stampOf(name: string) {
  const m = RUN_DIR.exec(name)
  if (!m) return 0
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number]

  return new Date(y, mo - 1, d, h, mi, s).getTime()
}

// Keep the one argument worth reading; older logs printed Pi arguments as a Python dict
// and Codex commands inside `/bin/zsh -lc '...'`.
function tidy(value: string, cwd: string) {
  let shown = value
  if (shown.startsWith('{')) {
    const key = /'(?:command|pattern|path)': '([^']*)'/.exec(shown)
    if (key?.[1]) shown = key[1]
  }
  const shell = /^\/bin\/(?:ba|z)?sh -lc '(.*)'$/.exec(shown)
  if (shell?.[1]) shown = shell[1]
  if (!cwd) return shown

  return shown === cwd ? '.' : shown.split(`${cwd}/`).join('').split(`${cwd}\\`).join('')
}

// A long path outside the project keeps its end, where the file name is: …/core/session-manager.js.
function compact(value: string) {
  const [head = '', ...more] = value.split(' · ')
  const tail = more.join(' · ')
  const path = (one: string) => {
    const home = one.replace(/^\/Users\/[^/]+(?=\/|$)/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/i, '~')
    const isPath = /^[~/]\S*$/.test(home) || /^[A-Za-z]:\\\S*$/.test(home)
    return isPath && home.length > 44 ? `…/${home.split(/[\\/]/).slice(-2).join('/')}` : home
  }

  return tail ? `${head} · ${path(tail)}` : path(head)
}

function shortName(value: string) {
  if (value.startsWith('"')) return value.split(' · ')[0] ?? value

  return value.split('/').pop() || value
}

function parse(lines: string[], cwd: string): Entry[] {
  const out: Entry[] = []
  for (const line of lines) {
    const m = LINE.exec(line)
    if (!m) continue
    const time = m[1] ?? ''
    const mark = m[2] ?? ''
    const rest = m[3] ?? ''
    if (mark === '▶') {
      const cut = rest.indexOf(' ')
      let name = cut < 0 ? rest : rest.slice(0, cut)
      let arg = cut < 0 ? '' : rest.slice(cut + 1)
      if (name.startsWith('/')) [name, arg] = ['shell', rest]
      out.push({ kind: 'tool', name, details: [tidy(arg, cwd)], note: '', isFailed: false })
    } else if (mark === '✓' || mark === '!') {
      // A finished tool worth noting (slow, failed, non-zero exit), or an error of its own.
      const tools = [...out].reverse().filter((one): one is Tool => one.kind === 'tool')
      const shown = tidy(rest, cwd)
      const tool =
        tools.find(one => shown.startsWith(`${one.name} ${one.details[0] ?? ''}`)) ??
        tools.find(one => rest === one.name || rest.startsWith(`${one.name} `))
      const note = (/(\[exit=-?\d+\])?\s*(\(\d+s\))?\s*$/.exec(rest)?.[0] ?? '').trim()
      if (tool) {
        tool.isFailed ||= mark === '!'
        tool.note = note.replace('[exit=0]', '').replace('[exit=', '退出码 ').replace(']', '').replace(/\((\d+)s\)/, '$1 秒').trim()
      } else if (mark === '!') {
        out.push({ kind: 'mark', text: tidy(rest, cwd), tone: 'error' })
      }
    } else if (mark === '✎') {
      out.push({ kind: 'edit', detail: tidy(rest, cwd) })
    } else if (mark === '💬') {
      out.push({ kind: 'message', time, text: rest.split(' ⏎ ').join('\n') })
    } else if (mark === '●') {
      if (rest.startsWith('本轮完成')) out.push({ kind: 'mark', text: '本轮完成，待主控验收', tone: 'success' })
      else if (rest.startsWith('用量')) out.push({ kind: 'mark', text: rest, tone: 'subtle' })
    } else if (mark === '…') {
      out.push({ kind: 'quiet', text: rest.replace(/；.*$/, '') })
    }
    // 会话 / 模型 lines and the header are what the pane's own header shows.
  }
  const grouped: Entry[] = []
  for (const entry of out) {
    // A heartbeat only matters while it is the latest line.
    if (grouped.at(-1)?.kind === 'quiet') grouped.pop()
    const last = grouped.at(-1)
    const isSame = entry.kind === 'tool' && last?.kind === 'tool' && last.name === entry.name
    if (isSame && GROUPED.has(entry.name) && !entry.note && !last.note && !entry.isFailed && !last.isFailed) {
      last.details.push(...entry.details)
    } else {
      grouped.push(entry)
    }
  }

  return grouped
}

function toolLabel(tool: Tool) {
  const verb = VERBS[tool.name] ?? tool.name
  if (tool.details.length === 1) return { verb, arg: compact(tool.details[0] ?? '') }
  const names = [...new Set(tool.details.map(shortName))]

  return { verb: `${verb} ${tool.details.length} 项`, arg: names.join(' · ') }
}

// The latest thing a run did, as one readable line for its card.
function activityOf(lines: string[], cwd: string) {
  const entry = parse(lines.slice(-12), cwd).filter(one => one.kind !== 'quiet').at(-1)
  if (!entry) return ''
  if (entry.kind === 'message') return entry.text.split('\n')[0] ?? ''
  if (entry.kind === 'tool') {
    const { verb, arg } = toolLabel(entry)
    return `${verb} ${arg}`
  }
  if (entry.kind === 'edit') return `编辑 ${entry.detail}`

  return entry.text
}

function isPreamble(line: string) {
  return line.startsWith('Your runner metadata') || line.startsWith('Delegated subtask:')
}

// The runner prepends two English paragraphs. Drop those, and nothing else.
function stripRunnerNotes(body: string) {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  let i = 0
  let skipped = 0
  while (skipped < 2) {
    while (i < lines.length && (lines[i] ?? '').trim() === '') i++
    if (i >= lines.length || !isPreamble((lines[i] ?? '').trim())) break
    i++
    while (i < lines.length && (lines[i] ?? '').trim() !== '' && !isPreamble((lines[i] ?? '').trim())) i++
    skipped++
  }
  while (i < lines.length && (lines[i] ?? '').trim() === '') i++

  return lines.slice(i).join('\n')
}

function goalLine(body: string) {
  for (const line of body.split('\n')) {
    const matched = /^(?:目标[:：])\s*(.*)$/.exec(line.trim())
    const goal = matched?.[1]?.trim()
    if (goal) return goal
  }

  return ''
}

function firstLine(body: string) {
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (trimmed) return trimmed
  }

  return ''
}

function clipTitle(value: string) {
  const chars = Array.from(value.trim())
  if (chars.length <= TITLE_CHARS) return chars.join('')

  return `${chars.slice(0, TITLE_CHARS).join('')}…`
}

// Markdown refuses every control character except tab and newline.
function forMarkdown(value: string) {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
}

function parseActivity(value: unknown): RunActivity | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const kind = record.kind
  if (kind !== 'thinking' && kind !== 'tool' && kind !== 'writing' && kind !== 'waiting') return null
  const since = num(record.since)
  if (since === null) return null

  return { kind, label: text(record.label), since }
}

function pidOf(value: unknown) {
  const pid = num(value)
  if (pid === null || pid <= 0) return null

  return Math.trunc(pid)
}

async function readTail($: EngineInterface, path: string, size: number, mtimeMs: number) {
  const known = tails.get(path)
  if (known && known.size === size && known.mtimeMs === mtimeMs) return known.lines
  const body = await $.fs.read(path).catch(() => '')
  const lines = (typeof body === 'string' ? body : '').split('\n').filter(line => line.trim()).slice(-400)
  tails.set(path, { size, mtimeMs, lines })
  return lines
}

async function progressLog($: EngineInterface, dir: string) {
  const files = await $.fs.list(dir).catch(() => [])
  return files.find(file => file.name === 'progress.log')
}

async function readResult($: EngineInterface, run: RunRow) {
  const known = results.get(run.id)
  if (known !== undefined) return known
  const body = await $.fs.read(`${run.runDir}/result.md`).catch(() => '')
  const result = typeof body === 'string' ? body.trim() : ''
  results.set(run.id, result)
  return result
}

async function readFile($: EngineInterface, path: string) {
  if (!path) return ''
  const body = await $.fs.read(path).catch(() => '')

  return typeof body === 'string' ? body : ''
}

// Title: run.json title, else 「目标：」 in task.md, else the handoff's first line,
// else the first line of task.md once the runner's two paragraphs are gone.
async function taskTitle($: EngineInterface, dir: string, meta: Record<string, unknown>) {
  const given = text(meta.title).trim()
  if (given) return clipTitle(given)
  const task = stripRunnerNotes(await readFile($, `${dir}/task.md`))
  const goal = goalLine(task)
  if (goal) return clipTitle(goal)
  const handoffPath = text(meta.handoff_file) || `${dir}/handoff.md`
  const handoff = firstLine(await readFile($, handoffPath))
  if (handoff) return clipTitle(handoff)

  return clipTitle(firstLine(task)) || '未命名任务'
}

async function readTask($: EngineInterface, run: RunRow) {
  const paths = [run.handoffFile, `${run.runDir}/handoff.md`].filter((path, index, all) => path && all.indexOf(path) === index)
  for (const path of paths) {
    const body = (await readFile($, path)).trim()
    if (body) return { task: body, taskNote: false }
  }
  const task = stripRunnerNotes(await readFile($, `${run.runDir}/task.md`)).trim()

  return { task, taskNote: true }
}

async function loadRow($: EngineInterface, root: string, name: string, sessionId: string, now: number) {
  const dir = `${root}/${name}`
  let meta: Record<string, unknown>
  try {
    const body = await $.fs.read(`${dir}/run.json`)
    meta = JSON.parse(typeof body === 'string' ? body : '{}') as Record<string, unknown>
  } catch {
    return null
  }
  const usage = (meta.usage ?? null) as { total_tokens?: unknown } | null
  const finishedAt = num(meta.finished_at)
  const row: RunRow = {
    id: name,
    title: await taskTitle($, dir, meta),
    agent: text(meta.agent) || (RUN_DIR.exec(name)?.[7] ?? '?'),
    model: text(meta.model) || text(meta.requested_model) || '默认模型',
    thinking: text(meta.thinking),
    access: text(meta.access),
    status: text(meta.status) || 'unknown',
    startedAt: (num(meta.started_at) ?? stampOf(name) / 1000) * 1000,
    finishedAt: finishedAt === null ? null : finishedAt * 1000,
    cwd: text(meta.cwd),
    runDir: dir,
    watch: text(meta.watch_command) || (await isWindows($)
      ? `Get-Content -Wait -Encoding UTF8 "${dir.replace(/\//g, '\\')}\\progress.log"`
      : `tail -n +1 -f "${dir}/progress.log"`),
    isMine: meta.claude_session_id === sessionId,
    isStale: false,
    lastLine: '',
    tokens: num(usage?.total_tokens),
    error: text(meta.error),
    activity: parseActivity(meta.activity),
    liveText: text(meta.live_text),
    runnerPid: pidOf(meta.runner_pid),
    handoffFile: text(meta.handoff_file),
    task: text(meta.task).trim() || null,
  }
  if (ACTIVE.has(row.status)) {
    const log = await progressLog($, dir)
    const lines = log ? await readTail($, `${dir}/progress.log`, log.size, log.mtimeMs) : []
    row.lastLine = activityOf(lines, row.cwd)
    row.isStale = now - (log ? log.mtimeMs : row.startedAt) > STALE_MS
  }
  return row
}

async function loadDetail($: EngineInterface, run: RunRow) {
  const log = await progressLog($, run.runDir)
  const size = log?.size ?? 0
  const mtimeMs = log?.mtimeMs ?? 0
  const result = ACTIVE.has(run.status) ? '' : await readResult($, run)
  const task = await readTask($, run)
  const known = await read($, detail)
  if (
    known?.id === run.id &&
    known.size === size &&
    known.mtimeMs === mtimeMs &&
    known.result === result &&
    known.task === task.task &&
    known.taskNote === task.taskNote
  ) {
    return
  }
  const lines = log ? await readTail($, `${run.runDir}/progress.log`, size, mtimeMs) : []
  const next: RunDetail = { id: run.id, lines, size, mtimeMs, result, task: task.task, taskNote: task.taskNote }
  await update($, detail, () => next)
}

async function announce($: EngineInterface, rows: RunRow[]) {
  const live = rows.filter(run => run.isMine && isLiveRun(run))
  const opened = await read($, autoOpened)
  const fresh = live.filter(run => !opened.includes(run.id))
  if (fresh.length) {
    await update($, autoOpened, list => [...list, ...fresh.map(run => run.id)].slice(-200))
    await update($, dismissed, () => false)
    // Opened unasked (from a timer), a surface may hold the pane back until the person opens it.
    const placed = await $.ui.open({ id: PANE, title: TITLE })
    isPaneHeld = !placed.isPlaced
  }
  const hint = isPaneHeld ? ' · /delegate-runs 查看' : ''
  const status = live.length ? `子 Agent 运行中：${live.map(run => AGENTS[run.agent] ?? run.agent).join('、')}${hint}` : undefined
  if (status !== lastStatus) {
    lastStatus = status
    $.ui.status(status)
  }
}

async function refresh($: EngineInterface, isForced = false) {
  if (isBusy) return
  isBusy = true
  try {
    const now = await $.clock.now()
    const open = await read($, selected)
    const known = await read($, runs)
    const openRun = known.find(run => run.id === open)
    const openLive = !!openRun && isLiveRun(openRun)
    const isLive = known.some(run => isLiveRun(run))
    // Open and still running: every tick. Any other live run, or a run left open: 2s. Idle: ~10s.
    const gap = openLive ? TICK_MS : (isLive || open !== null ? LIVE_MS : IDLE_MS)
    if (!isForced && !isWoken && now - lastScan < gap) return
    isWoken = false
    lastScan = now
    const home = await homeDir($)
    if (!home) return
    const sessionId = await $.session.id()
    const root = `${home}/.claude/cli-runs`
    const entries = await $.fs.list(root).catch(() => [])
    const names = entries
      .filter(entry => entry.kind === 'dir' && RUN_DIR.test(entry.name) && stampOf(entry.name) >= now - WINDOW_MS)
      .map(entry => entry.name)
      .sort()
      .reverse()
      .slice(0, 200)
    const rows: RunRow[] = []
    for (const name of names) {
      const row = finished.get(name) ?? (await loadRow($, root, name, sessionId, now))
      if (!row) continue
      if (!ACTIVE.has(row.status)) finished.set(name, row)
      rows.push(row)
    }
    await update($, runs, () => rows)
    const run = rows.find(one => one.id === open)
    if (run) await loadDetail($, run)
    await announce($, rows)
  } finally {
    isBusy = false
  }
}

// A session that has dispatched before gets its pane back after a reload or a resume,
// unless the person closed it themselves.
async function reopen($: EngineInterface) {
  await refresh($, true)
  const rows = await read($, runs)
  if (!rows.some(run => run.isMine) || (await read($, dismissed))) return
  if ((await $.ui.panes()).some(pane => pane.id === PANE)) return
  const placed = await $.ui.open({ id: PANE, title: TITLE })
  isPaneHeld = !placed.isPlaced
}

function duration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} 秒`
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')} 秒`
  return `${Math.floor(s / 3600)} 小时 ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')} 分`
}

function tokens(n: number | null) {
  if (n === null) return ''
  const shown = n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n)
  return `${shown} tok`
}

function isLiveRun(run: RunRow) {
  return ACTIVE.has(run.status) && !run.isStale
}

function state(run: RunRow): { glyph: string; label: string; tone: Tone } {
  if (ACTIVE.has(run.status)) {
    return run.isStale
      ? { glyph: '◌', label: '可能已中断', tone: 'warning' }
      : { glyph: '●', label: run.status === 'running' ? '运行中' : '准备中', tone: 'claude' }
  }
  const done: Record<string, { glyph: string; label: string; tone: Tone }> = {
    process_succeeded: { glyph: '✓', label: '完成 · 待验收', tone: 'success' },
    failed: { glyph: '✗', label: '失败', tone: 'error' },
    blocked: { glyph: '✗', label: '受阻', tone: 'error' },
    timed_out: { glyph: '✗', label: '超时', tone: 'error' },
    cancelled: { glyph: '○', label: '已取消', tone: 'inactive' },
    planned: { glyph: '○', label: '仅计划', tone: 'inactive' },
  }
  return done[run.status] ?? { glyph: '○', label: run.status, tone: 'inactive' }
}

function modelOf(run: RunRow) {
  const model = run.model.includes('/') ? (run.model.split('/').pop() ?? run.model) : run.model
  return run.thinking ? `${model} / ${run.thinking}` : model
}

function clockOf(ms: number) {
  const date = new Date(ms)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function subtitle(run: RunRow, now: number) {
  const agent = AGENTS[run.agent] ?? run.agent
  const access = run.access === 'read' ? '只读' : '可写'

  return [agent, modelOf(run), access, clockOf(run.startedAt), duration((run.finishedAt ?? now) - run.startedAt), tokens(run.tokens)]
    .filter(Boolean)
    .join(' · ')
}

function projectOf(run: RunRow) {
  return run.cwd.split('/').filter(part => part !== '').at(-1) || '未知项目'
}

function byRecency(a: RunRow, b: RunRow) {
  const live = Number(isLiveRun(b)) - Number(isLiveRun(a))
  if (live !== 0) return live

  return b.startedAt - a.startedAt
}

// One section per project, in the order each project's top run sorts.
function groupRuns(rows: RunRow[]) {
  const groups: { project: string; runs: RunRow[] }[] = []
  for (const run of [...rows].sort(byRecency)) {
    const project = projectOf(run)
    const found = groups.find(group => group.project === project)
    if (found) found.runs.push(run)
    else groups.push({ project, runs: [run] })
  }

  return groups
}

function liveLine(run: RunRow, now: number) {
  const activity = run.activity
  if (!activity || !isLiveRun(run)) return ''
  const seconds = Math.max(0, Math.floor((now - activity.since * 1000) / 1000))
  if (activity.kind === 'thinking') return `◐ 正在思考 · 已 ${seconds} 秒`
  if (activity.kind === 'tool') return `◐ 正在执行 ${activity.label} · ${seconds} 秒`
  if (activity.kind === 'writing') return '◐ 正在写回复…'
  if (activity.kind === 'waiting') return `◐ 等待模型 · 已 ${seconds} 秒`

  return ''
}

// Rows an entry takes at this width, roughly: a message wraps, everything else is one line.
function height(entry: Entry, columns: number) {
  if (entry.kind !== 'message') return entry.kind === 'mark' ? 2 : 1
  let rows = 2
  for (const part of entry.text.split('\n')) {
    let width = 0
    for (const ch of part) width += ch.charCodeAt(0) > 0x2e80 ? 2 : 1
    rows += Math.max(1, Math.ceil(width / columns))
  }
  return Math.min(rows, 14)
}

async function stopRun($: EngineInterface, run: RunRow) {
  if (run.runnerPid === null) {
    $.ui.toast('没有 runner 进程号，未停止')
    return
  }
  if (await isWindows($)) {
    // No signal reaches the runner here; it polls this file and ends the agent's process tree.
    try {
      await $.fs.write(`${run.runDir}/stop.request`, '')
    } catch {
      $.ui.toast('停止请求没有写入')
      return
    }
    $.ui.toast('已请求停止')
    return
  }
  const pid = String(run.runnerPid)
  let command = ''
  try {
    const checked = await $.process.run(['ps', '-o', 'command=', '-p', pid])
    command = checked.stdout
  } catch {
    $.ui.toast('无法核对 runner 进程，未停止')
    return
  }
  if (!command.includes('run_cli.py')) {
    $.ui.toast('进程命令行不含 run_cli.py，未停止')
    return
  }
  try {
    await $.process.run(['kill', '-TERM', pid])
  } catch {
    $.ui.toast('停止信号没有发出')
    return
  }
  $.ui.toast('已发送停止信号')
}

async function openRun($: EngineInterface, run: RunRow) {
  await update($, stopArm, () => null)
  await update($, tab, () => 'auto')
  await update($, selected, () => run.id)
  await loadDetail($, run)
}

async function sessionHome($: EngineInterface) {
  return { home: await homeDir($), session: await $.session.id() }
}

// The log is the truth and the atom what the panes draw from; a reload or a resume replays the log.
async function loadBlueprint($: EngineInterface) {
  const { home, session } = await sessionHome($)
  if (!home) return
  logLines = await readLog($, blueprintPaths(home, session).log)
  logSession = session
  const replayed: Blueprint | null = replay(logLines)
  await update($, blueprint, () => replayed)
}

/** Opens the puzzle pane, and selects a block when one is named. */
async function openPuzzle($: EngineInterface, piece?: string) {
  await update($, puzzleDismissed, () => false)
  if (piece) await update($, puzzleSelected, () => piece)

  return $.ui.open({ id: PUZZLE_PANE, title: PUZZLE_TITLE, columns: PUZZLE_COLUMNS })
}

// 停止 asks twice: the first press arms it for five seconds, the second sends SIGTERM.
async function pressStop($: EngineInterface, run: RunRow) {
  const at = await $.clock.now()
  const pending = await read($, stopArm)
  if (!pending || pending.id !== run.id || at - pending.at > STOP_MS) {
    await update($, stopArm, () => ({ id: run.id, at }))
    return
  }
  await update($, stopArm, () => null)
  await stopRun($, run)
}

function puzzleActions($: EngineInterface): PuzzleActions {
  return {
    show: async id => void (await update($, puzzleSelected, () => id)),
    toggle: async id => void (await update($, puzzleSelected, current => (current === id ? null : id))),
    close: async () => void (await update($, puzzleSelected, () => null)),
    setView: async view => void (await update($, puzzleView, () => view)),
    openRun: id => showRuns($, id),
    openRuns: () => showRuns($),
    stop: run => pressStop($, run),
  }
}

async function rowModel($: EngineInterface): Promise<RowModel> {
  return {
    bp: await read($, blueprint),
    rows: await read($, runs),
    dispatches: await read($, dispatches),
    now: await $.clock.now(),
  }
}

// A new plan brings the puzzle pane forward. Opened from a tool call, it is a request the
// person did not make, so a surface may hold it back; then they hear where it is.
async function announcePuzzle($: EngineInterface) {
  const placed = await openPuzzle($)
  if (!placed.isPlaced) $.ui.toast('需求拼图已建立，输入 /puzzle 查看')
}

// After a reload or a resume the puzzle comes back, unless the person closed it.
async function reopenPuzzle($: EngineInterface) {
  if (!(await read($, blueprint)) || (await read($, puzzleDismissed))) return
  if ((await $.ui.panes()).some(pane => pane.id === PUZZLE_PANE)) return
  await openPuzzle($)
}

// From the puzzle: the 子 Agent pane, on one run's page or on its list.
async function showRuns($: EngineInterface, id?: string) {
  const run = id ? (await read($, runs)).find(one => one.id === id) : undefined
  if (run) await openRun($, run)
  else await update($, selected, () => null)
  await update($, dismissed, () => false)
  const placed = await $.ui.open({ id: PANE, title: TITLE })
  isPaneHeld = !placed.isPlaced
}

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const run = blueprintChain.then(work, work)
  blueprintChain = run.catch(() => undefined)

  return run
}

// One blueprint call: refuse what does not apply, else log it, then answer in one line.
async function blueprintCall($: EngineInterface, input: Record<string, unknown>): Promise<{ result: string } | { deny: string }> {
  try {
    const { home, session } = await sessionHome($)
    if (!home) return { deny: '读不到 HOME，拼图没有写入' }
    if (logSession !== session) await loadBlueprint($)
    const op = parseOp(input)
    const prior = await read($, blueprint)
    const now = await $.clock.now()
    if (op.op === 'get') {
      if (!prior) return { deny: '本会话还没有拼图，先用 plan 建立' }

      return { result: describe(derive(prior, await read($, runs), now), op.id) }
    }
    const { next, change } = apply(prior, op, now)
    const lines = [...logLines, JSON.stringify({ rev: next.rev, at: now, ...op })]
    await writeLog($, home, session, lines, next)
    logLines = lines
    await update($, blueprint, () => next)
    isWoken = true
    // Written already: a pane that fails to open must not turn the answer into a refusal.
    if (op.op === 'plan') await announcePuzzle($).catch(() => undefined)

    return { result: replyLine(derive(next, await read($, runs), now), change) }
  } catch (error) {
    if (isRefusal(error)) return { deny: `${error.message}；没有写入` }

    return { deny: `拼图没有写入：${error instanceof Error ? error.message : String(error)}` }
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'delegate-runs',
      description: '打开子 Agent 面板：delegate-cli 派发的 Codex/Pi/Cursor 运行、结果与实时过程',
    })
    await $.command.register({
      name: 'puzzle',
      description: '打开需求拼图：本会话委派的需求由哪些块组成、谁在做、哪里要你处理',
    })
    await $.tool.register({ name: 'blueprint', description: BLUEPRINT_DESCRIPTION, inputSchema: BLUEPRINT_SCHEMA })
    await update($, stopArm, () => null)
    await loadBlueprint($).catch(() => undefined)
    $.clock.every(TICK_MS, () => void refresh($).catch(() => undefined))
    void reopen($).catch(() => undefined)
    void reopenPuzzle($).catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: 'puzzle' }, async $ => {
    const placed = await openPuzzle($)
    if (!placed.isPlaced) return { text: `需求拼图没能显示：${placed.reason}` }

    return {
      text: (await read($, blueprint))
        ? '需求拼图已打开。'
        : '需求拼图已打开。本会话还没有拼图，用 delegate-cli 委派时 Claude 会先建立。',
    }
  })

  on('ui.close', { id: 'delegate-puzzle' }, async ($, e, next) => {
    if (e.origin.kind === 'person') await update($, puzzleDismissed, () => true)

    return next(e)
  })

  // Keyboard focus on a card shows what a pointer would.
  on('ui.focus', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId === PUZZLE_PANE) {
      const element = e.element ?? ''
      await update($, puzzleFocused, () => (element.startsWith('open-') ? element.slice(5) : null))
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: 'delegate-puzzle' }, async ($, e) => {
    const now = await $.clock.now()
    const arm = await read($, stopArm)
    const model: PuzzleModel = {
      bp: await read($, blueprint),
      rows: await read($, runs),
      view: await read($, puzzleView),
      open: await read($, puzzleSelected),
      focus: await read($, puzzleFocused),
      armed: arm && now - arm.at <= STOP_MS ? arm.id : null,
      now,
    }

    return drawPuzzle($, e, model, puzzleActions($))
  })

  // ctrl+o shows the engine's own rows; the compact ones join their block's hover group.
  on('ui.render', { component: 'ToolUse', props: { tool: 'mcp__delegate-cli-panel__blueprint' } }, async ($, e, next) =>
    e.props.isExpanded ? next(e) : drawBlueprintRow($, e, await rowModel($), piece => openPuzzle($, piece)),
  )

  on('ui.render', { component: 'ToolUse', props: { tool: 'Bash' } }, async ($, e, next) => {
    const command = (e.props.input as { command?: unknown } | null)?.command
    if (e.props.isExpanded || typeof command !== 'string' || !RUN_CALL.test(command)) return next(e)

    return drawDispatchRow($, e, await rowModel($), piece => openPuzzle($, piece)) ?? next(e)
  })

  // The blueprint row already says what the call changed.
  on('ui.render', { component: 'ToolResult', props: { tool: 'mcp__delegate-cli-panel__blueprint' } }, async ($, e, next) => {
    if (e.props.isExpanded) return next(e)
    const { Box } = $.ui.resolve(e)

    return <Box />
  })

  on('ui.render', { component: 'UserMessage', props: { origin: { kind: 'task-notification' } } }, async ($, e, next) => {
    const started = e.props.task?.toolUseId
    if (e.props.isExpanded || !started || !(started in (await read($, dispatches)))) return next(e)

    return drawTaskNotice($, e, await rowModel($), piece => openPuzzle($, piece)) ?? next(e)
  })

  on('tool.call', { tool: 'mcp__delegate-cli-panel__blueprint' }, async ($, e) =>
    serialize(() => blueprintCall($, e as unknown as Record<string, unknown>)),
  ).catch(() => ({ deny: '拼图工具出错，没有写入' }))

  on('command.run', { command: 'delegate-runs' }, async $ => {
    await update($, dismissed, () => false)
    await refresh($, true)
    const placed = await $.ui.open({ id: PANE, title: TITLE })
    isPaneHeld = !placed.isPlaced
    if (placed.isPlaced) return { text: '子 Agent 面板已打开。' }
    const surfaces = (await $.session.surfaces()).join('、') || '无'

    return {
      text: `子 Agent 面板没能显示：${placed.reason}（当前界面：${surfaces}）。进度可在右侧 Background tasks 里点开对应任务查看。`,
    }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') await update($, dismissed, () => true)

    return next(e)
  })

  // A dispatch through run_cli.py: rescan on the next tick instead of waiting idle, remember
  // which blueprint task it names, and tell Claude alone when it names none.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!RUN_CALL.test(e.command)) return next(e)
    isWoken = true
    const task = TASK_FLAG.exec(e.command)?.[2]
    if (task) {
      await update($, dispatches, map => Object.fromEntries([...Object.entries(map), [e.tool_use_id, task]].slice(-200)))

      return next(e)
    }
    const result = await next(e)
    if (result.deny !== undefined || !(await read($, blueprint))) return result

    return { ...result, context: [...(result.context ?? []), UNTRACKED_RUN] }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const now = await $.clock.now()
    const all = await read($, runs)
    const open = await read($, selected)
    const view = await read($, scope)
    const columns = Math.max(24, e.props.bodyColumns)
    const room = Math.max(10, e.props.scroll.bodyRows)
    const run = all.find(one => one.id === open)

    if (run) {
      const bp = await read($, blueprint)
      const ownerTask = run.task && bp ? bp.tasks.find(one => one.id === run.task) : undefined
      const belongs = (bp?.pieces ?? []).filter(piece => ownerTask?.pieces.includes(piece.id))
      const log = await read($, detail)
      const page = await read($, tab)
      const arm = await read($, stopArm)
      const look = state(run)
      const isLive = isLiveRun(run)
      const armed = !!arm && arm.id === run.id && now - arm.at <= STOP_MS
      const result = log?.id === run.id ? log.result : ''
      const task = log?.id === run.id ? log.task : ''
      const taskNote = log?.id === run.id ? log.taskNote : false
      const isResult = page === 'result' || (page === 'auto' && !isLive && result !== '')
      const showing = page === 'task' ? 'task' : isResult ? 'result' : 'log'
      const entries = parse(log?.id === run.id ? log.lines : [], run.cwd)
      const latest = entries.filter(one => one.kind !== 'quiet').at(-1)
      const current = isLive && latest?.kind === 'tool' ? latest : undefined
      const beat = liveLine(run, now)
      const streaming = forMarkdown(run.liveText)
      const hasStreaming = isLive && streaming.trim() !== ''
      let budget = room - (run.error ? 9 : 7) - (beat ? 1 : 0) - (hasStreaming ? 4 : 0)
      let first = entries.length
      while (first > 0 && budget - height(entries[first - 1] as Entry, columns) >= 0) {
        budget -= height(entries[first - 1] as Entry, columns)
        first--
      }

      return (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between">
            <Button
              key="back"
              label="‹ 全部运行"
              onPress={async () => {
                await update($, stopArm, () => null)
                await update($, selected, () => null)
              }}
            />
            {result ? (
              <Button
                key="copy-result"
                label="复制结果"
                onPress={async press => {
                  const copied = await $.ui.copy({ text: result, surface: press.surface })
                  $.ui.toast(copied.isCopied ? '已复制结果' : `复制失败：${copied.reason}`)
                }}
              />
            ) : (
              <Button
                key="copy-watch"
                label="复制监看命令"
                onPress={async press => {
                  const copied = await $.ui.copy({ text: run.watch, surface: press.surface })
                  $.ui.toast(copied.isCopied ? '已复制，可粘贴到终端实时跟随' : `复制失败：${copied.reason}`)
                }}
              />
            )}
          </Box>
          <Box flexDirection="row" justifyContent="space-between" marginTop={1}>
            <Text size="heading" weight="semibold" wrap="truncate-end">
              {run.title}
            </Text>
            <Text color={look.tone} weight="medium">
              {look.glyph} {look.label}
            </Text>
          </Box>
          <Text size="caption" dimColor wrap="truncate-end">
            {subtitle(run, now)}
          </Text>
          {belongs.length ? (
            <Box flexDirection="row" gap="xs">
              <Text size="caption" dimColor>
                所属
              </Text>
              {belongs.map(piece => (
                <Button key={`piece-${piece.id}`} plain dimColor onPress={() => void openPuzzle($, piece.id)}>
                  {piece.title}
                </Button>
              ))}
            </Box>
          ) : null}
          <Box flexDirection="row" gap={1} marginTop={1}>
            {isLive ? (
              <Button
                key="stop"
                label={armed ? '确认停止' : '停止'}
                variant={armed ? 'primary' : 'secondary'}
                onPress={() => pressStop($, run)}
              />
            ) : null}
            <Button
              key="follow"
              label="追问"
              onPress={async () => {
                await $.prompt.fill({ text: `用 delegate-cli 续接这次运行（${run.id}）：`, mode: 'replace' })
                $.ui.toast('在输入框补充要求后发送')
              }}
            />
          </Box>
          {run.error ? (
            <Text size="footnote" color="error" wrap="wrap">
              {run.error}
            </Text>
          ) : null}
          <Box flexDirection="row" gap={1} marginTop={1}>
            <Button
              key="tab-task"
              label="任务"
              variant={showing === 'task' ? 'primary' : 'secondary'}
              onPress={() => update($, tab, () => 'task')}
            />
            <Button
              key="tab-log"
              label={isLive ? '实时过程' : '过程'}
              variant={showing === 'log' ? 'primary' : 'secondary'}
              onPress={() => update($, tab, () => 'log')}
            />
            <Button
              key="tab-result"
              label="结果"
              variant={showing === 'result' ? 'primary' : 'secondary'}
              onPress={() => update($, tab, () => 'result')}
            />
          </Box>
          {showing === 'result' ? (
            <Box flexDirection="column" marginTop={1}>
              {result ? (
                <Markdown text={result.length > RESULT_CHARS ? `${result.slice(0, RESULT_CHARS)}\n\n…` : result} />
              ) : (
                <Text dimColor>{isLive ? '还在运行，结束后这里显示最终结果。' : '这次运行没有留下结果。'}</Text>
              )}
              {result.length > RESULT_CHARS ? (
                <Text size="caption" dimColor>
                  结果较长，只显示前 {RESULT_CHARS} 字；“复制结果”可拿到全文。
                </Text>
              ) : null}
            </Box>
          ) : showing === 'task' ? (
            <Box flexDirection="column" marginTop={1}>
              {task ? <Markdown text={forMarkdown(task)} /> : <Text dimColor>这次运行没有留下任务说明。</Text>}
              {taskNote ? (
                <Text size="caption" dimColor>
                  {TASK_NOTE}
                </Text>
              ) : null}
            </Box>
          ) : (
            <Box flexDirection="column" marginTop={1}>
              {first > 0 ? (
                <Text size="caption" dimColor>
                  前面还有 {first} 条，完整记录可用监看命令查看
                </Text>
              ) : null}
              {entries.length === 0 ? <Text dimColor>还没有进度输出。</Text> : null}
              {entries.slice(first).map(entry => {
                if (entry.kind === 'message') {
                  return (
                    <Box flexDirection="column" marginTop={1}>
                      <Text size="caption" dimColor>
                        {entry.time}
                      </Text>
                      <Markdown text={entry.text} />
                    </Box>
                  )
                }
                if (entry.kind === 'tool') {
                  const { verb, arg } = toolLabel(entry)
                  const icon = entry.isFailed ? '✗' : entry === current ? '◐' : '·'
                  const tone: Tone = entry.isFailed ? 'error' : entry === current ? 'claude' : 'subtle'

                  return (
                    <Text size="footnote" wrap="truncate-end">
                      <Text color={tone}>{icon}</Text> <Text dimColor>{verb}</Text> <Text mono>{arg}</Text>
                      {entry.note ? <Text color={entry.isFailed ? 'error' : 'subtle'}> {entry.note}</Text> : null}
                    </Text>
                  )
                }
                if (entry.kind === 'edit') {
                  return (
                    <Text size="footnote" wrap="truncate-end">
                      <Text color="success">✎</Text> <Text dimColor>修改</Text> <Text mono>{entry.detail}</Text>
                    </Text>
                  )
                }
                if (entry.kind === 'mark') {
                  return (
                    <Box marginTop={1}>
                      <Text
                        size="footnote"
                        color={entry.tone}
                        weight={entry.tone === 'subtle' ? 'regular' : 'medium'}
                        wrap="wrap"
                      >
                        {entry.text}
                      </Text>
                    </Box>
                  )
                }
                return (
                  <Text size="caption" dimColor italic>
                    {entry.text}
                  </Text>
                )
              })}
              {hasStreaming ? (
                <Box flexDirection="column" marginTop={1}>
                  <Text size="caption" dimColor>
                    输入中
                  </Text>
                  <Markdown key="live-text" text={`${streaming}▍`} />
                </Box>
              ) : null}
              {beat ? (
                <Text size="footnote" color="claude" tabular>
                  {beat}
                </Text>
              ) : null}
            </Box>
          )}
        </Box>
      )
    }

    const shown = all.filter(one => (view === 'mine' ? one.isMine : one.startedAt >= now - RECENT_MS))
    const ordered = [...shown].sort(byRecency).slice(0, 60)
    const blocks = view === 'all' ? groupRuns(ordered) : [{ project: '', runs: ordered }]
    const live = shown.filter(one => isLiveRun(one)).length

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Box flexDirection="row" gap={1}>
            <Button
              key="scope-mine"
              label="本会话"
              variant={view === 'mine' ? 'primary' : 'secondary'}
              onPress={() => update($, scope, () => 'mine')}
            />
            <Button
              key="scope-all"
              label="近 24 小时"
              variant={view === 'all' ? 'primary' : 'secondary'}
              onPress={() => update($, scope, () => 'all')}
            />
          </Box>
          <Text size="caption" dimColor>
            {live ? `运行中 ${live} · ` : ''}共 {shown.length} 个
          </Text>
        </Box>
        {shown.length === 0 ? (
          <Box marginTop={1}>
            <Text dimColor wrap="wrap">
              {view === 'mine'
                ? '本会话还没有派发子 Agent。用 delegate-cli 派发后会出现在这里。'
                : '近 24 小时没有运行记录。'}
            </Text>
          </Box>
        ) : null}
        {blocks.map(block => (
          <Box key={`group-${block.project || 'mine'}`} flexDirection="column">
            {view === 'all' ? (
              <Box marginTop={1}>
                <Text size="caption" dimColor weight="medium">
                  {block.project}
                </Text>
              </Box>
            ) : null}
            {block.runs.map(one => {
              const look = state(one)
              const beat = liveLine(one, now)
              const failed = one.error && !ACTIVE.has(one.status) ? one.error : ''

              return (
                <Box
                  key={`card-${one.id}`}
                  flexDirection="column"
                  marginTop={1}
                  paddingX={1}
                  borderStyle="round"
                  borderDimColor
                  hover={{ borderColor: 'suggestion', borderDimColor: false }}
                >
                  {/* A desktop Button draws its label as one plain line, so only the title goes in it. */}
                  <Box flexDirection="row" justifyContent="space-between" gap={1}>
                    <Button key={one.id} plain onPress={() => openRun($, one)}>
                      {one.title}
                    </Button>
                    <Text size="caption" color={look.tone} weight="medium">
                      {look.glyph} {look.label}
                    </Text>
                  </Box>
                  <Box flexDirection="column" paddingLeft="xs">
                    <Text size="caption" dimColor wrap="truncate-end">
                      {subtitle(one, now)}
                    </Text>
                    {one.lastLine ? (
                      <Text size="footnote" wrap="truncate-end">
                        {one.lastLine}
                      </Text>
                    ) : null}
                    {beat ? (
                      <Text size="footnote" color="claude">
                        {beat}
                      </Text>
                    ) : null}
                    {failed ? (
                      <Text size="footnote" color="error" wrap="truncate-end">
                        {failed}
                      </Text>
                    ) : null}
                  </Box>
                </Box>
              )
            })}
          </Box>
        ))}
        <Box marginTop={1}>
          <Text size="caption" dimColor>
            delegate-cli-panel {VERSION}
          </Text>
        </Box>
      </Box>
    )
  })
}
