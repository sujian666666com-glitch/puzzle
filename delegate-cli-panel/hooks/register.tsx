import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RunDetail, RunRow } from '../types'

const VERSION = '0.2.1'
const PANE = 'delegate-agents'
const TITLE = '子 Agent'
const TICK_MS = 2000
// Rescan for new runs this often while nothing runs and no run is open.
const IDLE_MS = 10000
// The runner writes progress.log at least once a minute while it is alive.
const STALE_MS = 180000
const WINDOW_MS = 7 * 86400000
const RECENT_MS = 86400000
const RESULT_CHARS = 8000
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

// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const runs = atom({ plugin: 'delegate-cli-panel', key: 'runs' } as const, [], { shape: 'runs-2' })
const detail = atom({ plugin: 'delegate-cli-panel', key: 'detail' } as const, null, { shape: 'detail-2' })
const selected = atom({ plugin: 'delegate-cli-panel', key: 'selected' } as const, null)
const scope = atom({ plugin: 'delegate-cli-panel', key: 'scope' } as const, 'mine')
const tab = atom({ plugin: 'delegate-cli-panel', key: 'tab' } as const, 'auto')
const autoOpened = atom({ plugin: 'delegate-cli-panel', key: 'autoOpened' } as const, [])
const dismissed = atom({ plugin: 'delegate-cli-panel', key: 'dismissed' } as const, false)

// A finished run's files never change again, so it is read once per load.
const finished = new Map<string, RunRow>()
const results = new Map<string, string>()
const tails = new Map<string, { size: number; mtimeMs: number; lines: string[] }>()
let isBusy = false
let lastScan = 0
let isWoken = false
let lastStatus: string | undefined
let isPaneHeld = false

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

  return shown === cwd ? '.' : shown.split(`${cwd}/`).join('')
}

// A long path outside the project keeps its end, where the file name is: …/core/session-manager.js.
function compact(value: string) {
  const [head = '', ...more] = value.split(' · ')
  const tail = more.join(' · ')
  const path = (one: string) => {
    const home = one.replace(/^\/Users\/[^/]+(?=\/|$)/, '~')
    return /^[~/]\S*$/.test(home) && home.length > 44 ? `…/${home.split('/').slice(-2).join('/')}` : home
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
    agent: text(meta.agent) || (RUN_DIR.exec(name)?.[7] ?? '?'),
    model: text(meta.model) || text(meta.requested_model) || '默认模型',
    thinking: text(meta.thinking),
    access: text(meta.access),
    status: text(meta.status) || 'unknown',
    startedAt: (num(meta.started_at) ?? stampOf(name) / 1000) * 1000,
    finishedAt: finishedAt === null ? null : finishedAt * 1000,
    cwd: text(meta.cwd),
    runDir: dir,
    watch: text(meta.watch_command) || `tail -n +1 -f "${dir}/progress.log"`,
    isMine: meta.claude_session_id === sessionId,
    isStale: false,
    lastLine: '',
    tokens: num(usage?.total_tokens),
    error: text(meta.error),
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
  const known = await read($, detail)
  if (known?.id === run.id && known.size === size && known.mtimeMs === mtimeMs && known.result === result) return
  const lines = log ? await readTail($, `${run.runDir}/progress.log`, size, mtimeMs) : []
  const next: RunDetail = { id: run.id, lines, size, mtimeMs, result }
  await update($, detail, () => next)
}

async function announce($: EngineInterface, rows: RunRow[]) {
  const live = rows.filter(run => run.isMine && ACTIVE.has(run.status) && !run.isStale)
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
    const isLive = known.some(run => ACTIVE.has(run.status) && !run.isStale)
    if (!isForced && !isWoken && !isLive && open === null && now - lastScan < IDLE_MS) return
    isWoken = false
    lastScan = now
    const home = await $.env.get('HOME')
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

function facts(run: RunRow, now: number) {
  const project = run.cwd.split('/').pop() || run.cwd
  return [run.access === 'read' ? '只读' : '可写', duration((run.finishedAt ?? now) - run.startedAt), tokens(run.tokens), project]
    .filter(Boolean)
    .join(' · ')
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'delegate-runs',
      description: '打开子 Agent 面板：delegate-cli 派发的 Codex/Pi/Cursor 运行、结果与实时过程',
    })
    $.clock.every(TICK_MS, () => void refresh($).catch(() => undefined))
    void reopen($).catch(() => undefined)

    return next(e)
  })

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

  // A dispatch through run_cli.py: rescan on the next tick instead of waiting idle.
  on('tool.call', { tool: 'Bash' }, ($, e, next) => {
    if (/run_cli\.py['"]?\s+run\b/.test(e.command)) isWoken = true

    return next(e)
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
      const log = await read($, detail)
      const page = await read($, tab)
      const look = state(run)
      const isLive = ACTIVE.has(run.status) && !run.isStale
      const result = log?.id === run.id ? log.result : ''
      const isResult = page === 'result' || (page === 'auto' && !isLive && result !== '')
      const entries = parse(log?.id === run.id ? log.lines : [], run.cwd)
      const latest = entries.filter(one => one.kind !== 'quiet').at(-1)
      const current = isLive && latest?.kind === 'tool' ? latest : undefined
      let budget = room - (run.error ? 9 : 7)
      let first = entries.length
      while (first > 0 && budget - height(entries[first - 1] as Entry, columns) >= 0) {
        budget -= height(entries[first - 1] as Entry, columns)
        first--
      }

      return (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between">
            <Button key="back" label="‹ 全部运行" onPress={() => update($, selected, () => null)} />
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
              {AGENTS[run.agent] ?? run.agent}
              <Text dimColor weight="regular"> {modelOf(run)}</Text>
            </Text>
            <Text color={look.tone} weight="medium">
              {look.glyph} {look.label}
            </Text>
          </Box>
          <Text size="caption" dimColor wrap="truncate-end">
            {facts(run, now)}
          </Text>
          {run.error ? (
            <Text size="footnote" color="error" wrap="wrap">
              {run.error}
            </Text>
          ) : null}
          <Box flexDirection="row" gap={1} marginTop={1}>
            <Button
              key="tab-result"
              label="结果"
              variant={isResult ? 'primary' : 'secondary'}
              onPress={() => update($, tab, () => 'result')}
            />
            <Button
              key="tab-log"
              label={isLive ? '实时过程' : '过程'}
              variant={isResult ? 'secondary' : 'primary'}
              onPress={() => update($, tab, () => 'log')}
            />
          </Box>
          {isResult ? (
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
            </Box>
          )}
        </Box>
      )
    }

    const shown = all.filter(one => (view === 'mine' ? one.isMine : one.startedAt >= now - RECENT_MS))
    const live = shown.filter(one => ACTIVE.has(one.status) && !one.isStale).length

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
        {shown.slice(0, 60).map(one => {
          const look = state(one)

          return (
            <Box key={`card-${one.id}`} flexDirection="column" marginTop={1} paddingX={1} borderStyle="round" borderDimColor>
              <Box flexDirection="row" justifyContent="space-between">
                <Button
                  key={one.id}
                  plain
                  onPress={async () => {
                    await update($, tab, () => 'auto')
                    await update($, selected, () => one.id)
                    await loadDetail($, one)
                  }}
                >
                  {AGENTS[one.agent] ?? one.agent} <Text dimColor>{modelOf(one)}</Text>
                </Button>
                <Text size="caption" color={look.tone} weight="medium">
                  {look.glyph} {look.label}
                </Text>
              </Box>
              <Text size="caption" dimColor wrap="truncate-end">
                {facts(one, now)}
              </Text>
              {one.lastLine ? (
                <Text size="footnote" wrap="truncate-end">
                  {one.lastLine}
                </Text>
              ) : null}
              {one.error && !ACTIVE.has(one.status) ? (
                <Text size="footnote" color="error" wrap="truncate-end">
                  {one.error}
                </Text>
              ) : null}
            </Box>
          )
        })}
        <Box marginTop={1}>
          <Text size="caption" dimColor>
            delegate-cli-panel {VERSION}
          </Text>
        </Box>
      </Box>
    )
  })
}
