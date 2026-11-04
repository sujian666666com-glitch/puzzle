import type { EngineInterface } from 'claude-code'

import type { Blocker, Blueprint, Criterion, Group, Owner, Piece, Question, RunRow, Task } from '../types'
import { isWindows } from './host'

// The requirement blueprint. Claude writes intent and verdicts through the blueprint tool;
// the runner writes run facts; every status below is derived from those two, never stored.

export const BLUEPRINT_TOOL = 'mcp__delegate-cli-panel__blueprint'

const ACTIVE = new Set(['running', 'preparing'])
const ENDED_BADLY = new Set(['blocked', 'failed', 'timed_out', 'cancelled'])
const AGENT_NAMES: Record<string, string> = { codex: 'Codex', pi: 'Pi', cursor: 'Cursor' }
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
// Run failures only the person can clear: directory trust, sign-in, quota. Anything else is
// the agents' and Claude's to handle, until Claude raises it as a question or a blocker.
const PERSON_ONLY = [
  /trust/i,
  /\bauth|\blog ?in\b|\bsign ?in\b|unauthori[sz]ed|forbidden|\b40[13]\b/i,
  /quota|billing|credit|rate.?limit|payment/i,
]

export type PieceStatus =
  | 'accepted'
  | 'reverify'
  | 'blocked'
  | 'fix'
  | 'running'
  | 'unverified'
  | 'review'
  | 'clarify'
  | 'waiting'
  | 'idle'

export const STATUS_LABEL: Record<PieceStatus, string> = {
  accepted: '已验收',
  reverify: '需复验',
  blocked: '受阻',
  fix: '需修复',
  running: '进行中',
  unverified: '待核实',
  review: '待验收',
  clarify: '待澄清',
  waiting: '等待前置',
  idle: '未开始',
}

/** Something only the person can move: an answer, an access, a decision. */
export type Concern = { piece: string; text: string }

export type PieceView = {
  piece: Piece
  status: PieceStatus
  /** What a blocked or unclear block shows in place of its summary; empty otherwise. */
  reason: string
  /** Who works on it: "Codex 实现中 · Cursor 审查". */
  who: string
  /** What is happening now, one line. */
  now: string
  passed: number
  tasks: Task[]
  /** Every run of its tasks, oldest first. */
  runs: RunRow[]
  /** Titles of the blocks that need this one. */
  after: string[]
}

export type Board = {
  blueprint: Blueprint
  views: PieceView[]
  accepted: number
  concerns: Concern[]
  /** Blocks whose prerequisites are accepted and that nothing has started on yet. */
  ready: string[]
  /** Runs this session started after the plan that name no task of it. */
  loose: RunRow[]
}

type CriterionInput = { id: string; text: string }
export type PieceInput = {
  id: string
  group?: string
  title?: string
  summary?: string
  scope?: string
  needs?: string[]
  criteria?: CriterionInput[]
}
export type TaskInput = { id: string; pieces?: string[]; role?: string; agent?: string; title?: string; after?: string[] }
export type Op =
  | {
      op: 'plan'
      goal: { title: string; summary: string }
      groups: { id: string; title: string }[]
      pieces: PieceInput[]
      tasks: TaskInput[]
      replace: boolean
    }
  | { op: 'piece'; pieces: PieceInput[] }
  | { op: 'task'; tasks: TaskInput[] }
  | { op: 'ask'; id: string; piece: string; text: string; owner: Owner }
  | { op: 'answer'; id: string; text: string }
  | { op: 'check'; piece: string; results: { criterion: string; pass: boolean; evidence: string }[] }
  | { op: 'block'; id: string; piece: string; reason: string; owner: Owner }
  | { op: 'unblock'; id: string }
  | { op: 'get'; id: string }

class Refusal extends Error {}

function need(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Refusal(message)
}

export function isRefusal(error: unknown): error is Error {
  return error instanceof Refusal
}

const str = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
const list = (value: unknown) => (Array.isArray(value) ? value : [])
const strings = (value: unknown) => list(value).map(str).filter(Boolean)

function checkId(id: string, kind: string) {
  need(ID.test(id), `${kind} 的 ID“${id}”不合法：1–64 位字母、数字、点、下划线或连字符`)
}

function unique(ids: string[], kind: string) {
  const seen = new Set<string>()
  for (const id of ids) {
    checkId(id, kind)
    need(!seen.has(id), `${kind} 的 ID 重复：${id}`)
    seen.add(id)
  }
}

function owner(value: unknown): Owner {
  return value === 'agent' ? 'agent' : 'user'
}

/** The tool's arguments as the model sent them, shaped into one operation or refused. */
export function parseOp(input: Record<string, unknown>): Op {
  const op = str(input.op)
  const pieces = list(input.pieces).map(raw => {
    const one = (raw ?? {}) as Record<string, unknown>
    const piece: PieceInput = { id: str(one.id) }
    if (one.group !== undefined) piece.group = str(one.group)
    if (one.title !== undefined) piece.title = str(one.title)
    if (one.summary !== undefined) piece.summary = str(one.summary)
    if (one.scope !== undefined) piece.scope = str(one.scope)
    if (one.needs !== undefined) piece.needs = strings(one.needs)
    if (one.criteria !== undefined) {
      piece.criteria = list(one.criteria).map(c => {
        const criterion = (c ?? {}) as Record<string, unknown>
        return { id: str(criterion.id), text: str(criterion.text) }
      })
    }
    return piece
  })
  const tasks = list(input.tasks).map(raw => {
    const one = (raw ?? {}) as Record<string, unknown>
    const task: TaskInput = { id: str(one.id) }
    if (one.pieces !== undefined) task.pieces = strings(one.pieces)
    if (one.role !== undefined) task.role = str(one.role)
    if (one.agent !== undefined) task.agent = str(one.agent).toLowerCase()
    if (one.title !== undefined) task.title = str(one.title)
    if (one.after !== undefined) task.after = strings(one.after)
    return task
  })
  switch (op) {
    case 'plan': {
      const goal = (input.goal ?? {}) as Record<string, unknown>
      return {
        op,
        goal: { title: str(goal.title), summary: str(goal.summary) },
        groups: list(input.groups).map(raw => {
          const one = (raw ?? {}) as Record<string, unknown>
          return { id: str(one.id), title: str(one.title) }
        }),
        pieces,
        tasks,
        replace: input.replace === true,
      }
    }
    case 'piece':
      need(pieces.length, 'piece 需要 pieces（至少一块）')
      return { op, pieces }
    case 'task':
      need(tasks.length, 'task 需要 tasks（至少一个）')
      return { op, tasks }
    case 'ask':
      return { op, id: str(input.id), piece: str(input.piece), text: str(input.text), owner: owner(input.owner) }
    case 'answer':
      return { op, id: str(input.id), text: str(input.text) }
    case 'check':
      return {
        op,
        piece: str(input.piece),
        results: list(input.results).map(raw => {
          const one = (raw ?? {}) as Record<string, unknown>
          return { criterion: str(one.criterion), pass: one.pass === true, evidence: str(one.evidence) }
        }),
      }
    case 'block':
      need(input.owner === 'user' || input.owner === 'agent', 'block 需要 owner：user（要你处理）或 agent')
      return { op, id: str(input.id), piece: str(input.piece), reason: str(input.reason), owner: owner(input.owner) }
    case 'unblock':
      return { op, id: str(input.id) }
    case 'get':
      return { op, id: str(input.id) }
    default:
      throw new Refusal(`不认识的 op：${op || '（空）'}；可用 plan、piece、task、ask、answer、check、block、unblock、get`)
  }
}

function criteriaOf(input: CriterionInput[], prior: Criterion[] = []): Criterion[] {
  unique(input.map(c => c.id), '验收条件')
  return input.map(c => {
    need(c.text, `验收条件 ${c.id} 缺少 text`)
    return { id: c.id, text: c.text, verdict: prior.find(one => one.id === c.id)?.verdict ?? null }
  })
}

// Prerequisites must name blocks that exist and must not loop back.
function checkNeeds(pieces: Piece[]) {
  const ids = new Set(pieces.map(piece => piece.id))
  for (const piece of pieces) {
    for (const id of piece.needs) need(ids.has(id), `${piece.title} 的前置 ${id} 不存在`)
    need(!piece.needs.includes(piece.id), `${piece.title} 不能以自己为前置`)
  }
  const state = new Map<string, 'open' | 'done'>()
  const visit = (id: string, path: string[]) => {
    if (state.get(id) === 'done') return
    need(state.get(id) !== 'open', `前置成环：${[...path, id].join(' → ')}`)
    state.set(id, 'open')
    for (const next of pieces.find(piece => piece.id === id)?.needs ?? []) visit(next, [...path, id])
    state.set(id, 'done')
  }
  for (const piece of pieces) visit(piece.id, [])
}

function checkTasks(tasks: Task[], pieces: Piece[]) {
  const pieceIds = new Set(pieces.map(piece => piece.id))
  const taskIds = new Set(tasks.map(task => task.id))
  for (const task of tasks) {
    need(task.pieces.length, `任务 ${task.id} 至少要属于一块`)
    for (const id of task.pieces) need(pieceIds.has(id), `任务 ${task.id} 所属的块 ${id} 不存在`)
    for (const id of task.after) need(taskIds.has(id), `任务 ${task.id} 的先后任务 ${id} 不存在`)
  }
}

function newTask(input: TaskInput): Task {
  need(input.title && input.agent && input.role && input.pieces?.length, `新任务 ${input.id} 需要 pieces、role、agent、title`)
  return { id: input.id, pieces: input.pieces ?? [], role: input.role ?? '', agent: input.agent ?? '', title: input.title ?? '', after: input.after ?? [] }
}

/** One operation applied to the blueprint, or a Refusal saying why it was not. `get` changes nothing. */
export function apply(prior: Blueprint | null, op: Op, at: number): { next: Blueprint; change: string } {
  if (op.op === 'plan') {
    need(!prior || op.replace, '本会话已有拼图；用 piece / task 增改，或加 replace: true 整体替换')
    need(op.goal.title, 'plan 需要 goal.title')
    need(op.groups.length, 'plan 至少需要一个分组')
    need(op.pieces.length, 'plan 至少需要一块')
    unique(op.groups.map(group => group.id), '分组')
    unique(op.pieces.map(piece => piece.id), '需求块')
    unique(op.tasks.map(task => task.id), '任务')
    const groups: Group[] = op.groups.map((group, order) => {
      need(group.title, `分组 ${group.id} 缺少 title`)
      return { id: group.id, title: group.title, order }
    })
    const groupIds = new Set(groups.map(group => group.id))
    const pieces: Piece[] = op.pieces.map((input, order) => {
      need(input.title, `需求块 ${input.id} 缺少 title`)
      need(input.group && groupIds.has(input.group), `需求块 ${input.id} 的分组 ${input.group ?? '（空）'} 不存在`)
      return {
        id: input.id,
        group: input.group ?? '',
        order,
        title: input.title ?? '',
        summary: input.summary ?? '',
        scope: input.scope ?? '',
        needs: input.needs ?? [],
        criteria: criteriaOf(input.criteria ?? []),
        version: 1,
        acceptedVersion: null,
      }
    })
    checkNeeds(pieces)
    const tasks = op.tasks.map(newTask)
    checkTasks(tasks, pieces)
    const next: Blueprint = {
      schema: 2,
      rev: (prior?.rev ?? 0) + 1,
      createdAt: at,
      updatedAt: at,
      goal: { title: op.goal.title, summary: op.goal.summary },
      groups,
      pieces,
      tasks,
      questions: [],
      blockers: [],
    }
    return { next, change: `${op.replace && prior ? '整体替换为' : '建立'} ${pieces.length} 块、${tasks.length} 个任务` }
  }

  need(prior, '本会话还没有拼图，先用 plan 建立')
  const bp = JSON.parse(JSON.stringify(prior)) as Blueprint
  bp.rev += 1
  bp.updatedAt = at
  const pieceOf = (id: string) => {
    const piece = bp.pieces.find(one => one.id === id)
    need(piece, `需求块 ${id || '（空）'} 不存在`)
    return piece
  }

  switch (op.op) {
    case 'piece': {
      unique(op.pieces.map(piece => piece.id), '需求块')
      const notes: string[] = []
      for (const input of op.pieces) {
        const existing = bp.pieces.find(one => one.id === input.id)
        if (input.group !== undefined) need(bp.groups.some(group => group.id === input.group), `分组 ${input.group} 不存在`)
        if (!existing) {
          need(input.title && input.group, `新需求块 ${input.id} 需要 group 和 title`)
          const order = Math.max(-1, ...bp.pieces.filter(one => one.group === input.group).map(one => one.order)) + 1
          bp.pieces.push({
            id: input.id,
            group: input.group ?? '',
            order,
            title: input.title ?? '',
            summary: input.summary ?? '',
            scope: input.scope ?? '',
            needs: input.needs ?? [],
            criteria: criteriaOf(input.criteria ?? []),
            version: 1,
            acceptedVersion: null,
          })
          notes.push(`新增 ${input.title}`)
          continue
        }
        const before = JSON.stringify([existing.summary, existing.scope, existing.criteria.map(c => [c.id, c.text])])
        if (input.title) existing.title = input.title
        if (input.group && input.group !== existing.group) {
          existing.group = input.group
          existing.order = Math.max(-1, ...bp.pieces.filter(one => one.group === input.group && one !== existing).map(one => one.order)) + 1
        }
        if (input.summary !== undefined) existing.summary = input.summary
        if (input.scope !== undefined) existing.scope = input.scope
        if (input.needs !== undefined) existing.needs = input.needs
        if (input.criteria !== undefined) existing.criteria = criteriaOf(input.criteria, existing.criteria)
        const isRevised = JSON.stringify([existing.summary, existing.scope, existing.criteria.map(c => [c.id, c.text])]) !== before
        if (isRevised) existing.version += 1
        notes.push(
          `更新 ${existing.title}${isRevised && existing.acceptedVersion !== null ? '，需要重新验收' : ''}`,
        )
      }
      checkNeeds(bp.pieces)
      return { next: bp, change: notes.join('；') }
    }
    case 'task': {
      unique(op.tasks.map(task => task.id), '任务')
      for (const input of op.tasks) {
        const existing = bp.tasks.find(one => one.id === input.id)
        if (!existing) {
          bp.tasks.push(newTask(input))
          continue
        }
        if (input.pieces !== undefined) existing.pieces = input.pieces
        if (input.role) existing.role = input.role
        if (input.agent) existing.agent = input.agent
        if (input.title) existing.title = input.title
        if (input.after !== undefined) existing.after = input.after
      }
      checkTasks(bp.tasks, bp.pieces)
      return { next: bp, change: `任务 ${op.tasks.map(task => task.id).join('、')}` }
    }
    case 'ask': {
      checkId(op.id, '问题')
      const piece = pieceOf(op.piece)
      need(op.text, 'ask 需要 text')
      const question: Question = { id: op.id, piece: piece.id, text: op.text, owner: op.owner, answer: null }
      bp.questions = [...bp.questions.filter(one => one.id !== op.id), question]
      return { next: bp, change: `${piece.title} 待${op.owner === 'user' ? '你' : ''}明确：${op.text}` }
    }
    case 'answer': {
      const question = bp.questions.find(one => one.id === op.id)
      need(question, `问题 ${op.id || '（空）'} 不存在`)
      need(op.text, 'answer 需要 text')
      question.answer = op.text
      return { next: bp, change: `已回答：${question.text}` }
    }
    case 'check': {
      const piece = pieceOf(op.piece)
      need(op.results.length, 'check 需要 results')
      for (const result of op.results) {
        const criterion = piece.criteria.find(one => one.id === result.criterion)
        need(criterion, `${piece.title} 没有验收条件 ${result.criterion || '（空）'}`)
        criterion.verdict = { pass: result.pass, evidence: result.evidence, version: piece.version, at }
      }
      const passed = piece.criteria.filter(c => c.verdict?.pass && c.verdict.version === piece.version).length
      const isWhole = passed === piece.criteria.length && passed > 0
      if (isWhole) piece.acceptedVersion = piece.version
      return { next: bp, change: `${piece.title} 验收 ${passed}/${piece.criteria.length}${isWhole ? ' → 已验收' : ''}` }
    }
    case 'block': {
      checkId(op.id, '阻碍')
      const piece = pieceOf(op.piece)
      need(op.reason, 'block 需要 reason')
      const blocker: Blocker = { id: op.id, piece: piece.id, reason: op.reason, owner: op.owner, since: at }
      bp.blockers = [...bp.blockers.filter(one => one.id !== op.id), blocker]
      return { next: bp, change: `${piece.title} 受阻：${op.reason}（${op.owner === 'user' ? '要你处理' : 'Agent 处理'}）` }
    }
    case 'unblock': {
      const blocker = bp.blockers.find(one => one.id === op.id)
      need(blocker, `阻碍 ${op.id || '（空）'} 不存在`)
      bp.blockers = bp.blockers.filter(one => one.id !== op.id)
      return { next: bp, change: `解除受阻：${blocker.reason}` }
    }
    case 'get':
      return { next: prior, change: '' }
  }
}

/** The log replayed from its first line; a line that no longer applies is skipped, not fatal. */
export function replay(lines: string[]): Blueprint | null {
  let bp: Blueprint | null = null
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as Record<string, unknown>
      const op = parseOp(entry)
      if (op.op === 'get') continue
      bp = apply(bp, op, typeof entry.at === 'number' ? entry.at : 0).next
    } catch {
      // A hand-edited or truncated line: keep what replayed so far.
    }
  }
  return bp
}

const isAccepted = (piece: Piece) =>
  piece.criteria.length > 0 &&
  piece.criteria.every(c => c.verdict?.pass && c.verdict.version === piece.version) &&
  !(piece.acceptedVersion !== null && piece.acceptedVersion < piece.version)

function runReason(run: RunRow) {
  if (run.status === 'cancelled') return '运行已停止'
  const error = run.error.trim()
  if (!error) return run.status === 'timed_out' ? '运行超时' : '运行失败'

  return error.length > 60 ? `${error.slice(0, 60)}…` : error
}

const isPersons = (run: RunRow) => PERSON_ONLY.some(pattern => pattern.test(run.error))

function activityText(run: RunRow, now: number) {
  const activity = run.activity
  if (activity) {
    const seconds = Math.max(0, Math.floor((now - activity.since * 1000) / 1000))
    if (activity.kind === 'thinking') return `正在思考 · ${seconds} 秒`
    if (activity.kind === 'tool') return `正在执行 ${activity.label} · ${seconds} 秒`
    if (activity.kind === 'writing') return '正在写回复'
    if (activity.kind === 'waiting') return `等待模型 · ${seconds} 秒`
  }

  return run.lastLine || '运行中'
}

/** Everything the pane and the tool's reply show, derived from the blueprint and this session's runs. */
export function derive(bp: Blueprint, rows: RunRow[], now: number): Board {
  const taskIds = new Set(bp.tasks.map(task => task.id))
  const mine = rows.filter(run => run.isMine).sort((a, b) => a.startedAt - b.startedAt)
  const runsOf = (taskId: string) => mine.filter(run => run.task === taskId)
  const latest = (taskId: string) => runsOf(taskId).at(-1)
  const titleOf = (id: string) => bp.pieces.find(piece => piece.id === id)?.title ?? id
  const concerns: Concern[] = []
  const pieces = [...bp.pieces].sort((a, b) => {
    const ga = bp.groups.find(group => group.id === a.group)?.order ?? 0
    const gb = bp.groups.find(group => group.id === b.group)?.order ?? 0
    return ga - gb || a.order - b.order
  })

  const views = pieces.map((piece): PieceView => {
    const tasks = bp.tasks.filter(task => task.pieces.includes(piece.id))
    const lasts = tasks.map(task => latest(task.id)).filter((run): run is RunRow => !!run)
    const runs = mine.filter(run => run.task !== null && tasks.some(task => task.id === run.task))
    const questions = bp.questions.filter(q => q.piece === piece.id && q.answer === null)
    const blockers = bp.blockers.filter(b => b.piece === piece.id)
    const current = piece.criteria.filter(c => c.verdict && c.verdict.version === piece.version)
    const passed = current.filter(c => c.verdict?.pass).length
    const failed = current.length - passed
    const bad = lasts.filter(run => ENDED_BADLY.has(run.status))
    const live = lasts.filter(run => ACTIVE.has(run.status))
    const unmet = piece.needs.filter(id => {
      const other = bp.pieces.find(one => one.id === id)
      return !other || !isAccepted(other)
    })
    const who =
      tasks
        .map(task => {
          const run = latest(task.id)
          const name = AGENT_NAMES[task.agent] ?? task.agent
          if (!run) return `${name} ${task.role}`
          if (ACTIVE.has(run.status)) return `${name} ${task.role}${run.isStale ? '（待核实）' : '中'}`
          return `${name} ${task.role}${run.status === 'process_succeeded' ? ' ✓' : ' ✗'}`
        })
        .join(' · ') || '还未分配'

    for (const q of questions) if (q.owner === 'user') concerns.push({ piece: piece.id, text: q.text })
    for (const b of blockers) if (b.owner === 'user') concerns.push({ piece: piece.id, text: b.reason })
    for (const run of bad) if (isPersons(run)) concerns.push({ piece: piece.id, text: `${piece.title}：${runReason(run)}` })

    const view = (status: PieceStatus, line: string, reason = ''): PieceView => ({
      piece,
      status,
      reason,
      who,
      now: line,
      passed,
      tasks,
      runs,
      after: bp.pieces.filter(one => one.needs.includes(piece.id)).map(one => one.title),
    })
    if (piece.acceptedVersion !== null && piece.acceptedVersion < piece.version) return view('reverify', '需求改过，需要重新验收')
    if (isAccepted(piece)) return view('accepted', '验收条件全部通过')
    if (blockers.length) {
      const blocker = blockers[0] as Blocker
      return view('blocked', `受阻：${blocker.reason}${blocker.owner === 'user' ? '，需要你处理' : ''}`, blocker.reason)
    }
    if (bad.length) {
      const run = bad[0] as RunRow
      return view('blocked', `受阻：${runReason(run)}${isPersons(run) ? '，需要你处理' : ''}`, runReason(run))
    }
    if (failed > 0) return view('fix', `有 ${failed} 项验收没通过`)
    const fresh = live.find(run => !run.isStale)
    if (fresh) return view('running', `当前：${activityText(fresh, now)}`)
    if (live.length) return view('unverified', '超过 3 分钟没有更新，状态待核实')
    if (lasts.length && lasts.every(run => run.status === 'process_succeeded')) return view('review', '运行已结束，等 Claude 验收')
    if (questions.length || !piece.criteria.length) {
      const question = questions[0]
      const text = question ? `待${question.owner === 'user' ? '你' : ''}明确：${question.text}` : '还没有验收条件'
      return view('clarify', text, text)
    }
    if (unmet.length) return view('waiting', `等待：${unmet.map(titleOf).join('、')}`)

    return view('idle', '还没开始')
  })

  return {
    blueprint: bp,
    views,
    accepted: views.filter(one => one.status === 'accepted').length,
    concerns,
    ready: views.filter(one => one.status === 'idle').map(one => one.piece.id),
    loose: mine.filter(run => run.startedAt >= bp.createdAt && (run.task === null || !taskIds.has(run.task))),
  }
}

/** The one line the tool answers: what changed, what can start, how much waits on the person. */
export function replyLine(board: Board, change: string) {
  const name = (id: string) => `${id} ${board.views.find(view => view.piece.id === id)?.piece.title ?? ''}`.trim()
  const ready = board.ready.length ? board.ready.map(name).join('、') : '无'

  return `rev ${board.blueprint.rev} · ${change} · 可开工：${ready} · 需关注 ${board.concerns.length} 项`
}

/** What `get` answers: the blueprint as Claude reads it, with the IDs the pane never shows. */
export function describe(board: Board, id: string) {
  const bp = board.blueprint
  if (id) {
    const view = board.views.find(one => one.piece.id === id)
    need(view, `需求块 ${id} 不存在`)
    const piece = view.piece
    const criteria = piece.criteria
      .map(c => {
        const verdict = c.verdict && c.verdict.version === piece.version ? (c.verdict.pass ? '✓' : '✗') : '○'
        return `  ${verdict} ${c.id} ${c.text}${c.verdict?.evidence ? `（${c.verdict.evidence}）` : ''}`
      })
      .join('\n')
    const tasks = view.tasks.map(task => `  ${task.id} ${task.role} ${task.agent}：${task.title}`).join('\n')

    return [
      `${piece.id} ${piece.title} · ${STATUS_LABEL[view.status]} · 版本 ${piece.version} · 验收 ${view.passed}/${piece.criteria.length}`,
      piece.summary,
      piece.scope ? `范围：${piece.scope}` : '',
      `前置：${piece.needs.join('、') || '无'} · 后续：${view.after.join('、') || '无'}`,
      `现在：${view.now}`,
      criteria ? `验收条件：\n${criteria}` : '验收条件：无',
      tasks ? `任务：\n${tasks}` : '任务：无',
      view.runs.length ? `运行：${view.runs.map(run => `${run.id}（${run.status}）`).join('、')}` : '运行：无',
    ]
      .filter(Boolean)
      .join('\n')
  }
  const lines = [`${bp.goal.title} · rev ${bp.rev} · 已验收 ${board.accepted}/${board.views.length} · 需关注 ${board.concerns.length} 项`]
  for (const group of [...bp.groups].sort((a, b) => a.order - b.order)) {
    const parts = board.views
      .filter(view => view.piece.group === group.id)
      .map(view => {
        const needs = view.piece.needs.length ? `，需要 ${view.piece.needs.join('、')}` : ''
        return `${view.piece.id} ${view.piece.title}：${STATUS_LABEL[view.status]} ${view.passed}/${view.piece.criteria.length}${needs}`
      })
    lines.push(`[${group.id} ${group.title}] ${parts.join('；')}`)
  }
  if (bp.tasks.length) lines.push(`任务：${bp.tasks.map(task => `${task.id}→${task.pieces.join('+')} ${task.role} ${task.agent}`).join('；')}`)
  const open = bp.questions.filter(q => q.answer === null)
  if (open.length) lines.push(`问题：${open.map(q => `${q.id} ${q.piece}（${q.owner === 'user' ? '你' : 'Agent'}）${q.text}`).join('；')}`)
  if (bp.blockers.length) lines.push(`受阻：${bp.blockers.map(b => `${b.id} ${b.piece}（${b.owner === 'user' ? '你' : 'Agent'}）${b.reason}`).join('；')}`)
  if (board.loose.length) lines.push(`未归属的运行：${board.loose.map(run => run.id).join('、')}`)

  return lines.join('\n')
}

/** Where this session's log and snapshot live, beside the runs the pane already scans. */
export function blueprintPaths(home: string, session: string) {
  const base = `${home}/.claude/cli-runs/blueprints/${session}`

  return { log: `${base}.jsonl`, snapshot: `${base}.json` }
}

// Write beside, then rename: a reader never meets half a file.
async function replaceFile($: EngineInterface, path: string, text: string) {
  const temp = `${path}.tmp`
  await $.fs.write(temp, text)
  if (await isWindows($)) {
    // No mv here; cmd's move reads "/" as a switch, so it gets backslashes. A reader holding
    // the file makes the move fail: then write in place, which only that reader can catch half.
    const win = (one: string) => one.replace(/\//g, '\\')
    const moved = await $.process.run(['cmd', '/d', '/c', 'move', '/y', win(temp), win(path)]).catch(() => null)
    if (moved?.exitCode !== 0) await $.fs.write(path, text)
    return
  }
  const moved = await $.process.run(['mv', '-f', temp, path])
  if (moved.exitCode !== 0) throw new Error(`没能写入 ${path}`)
}

export async function readLog($: EngineInterface, path: string) {
  const body = await $.fs.read(path).catch(() => '')

  return (typeof body === 'string' ? body : '').split('\n').filter(line => line.trim())
}

export async function writeLog($: EngineInterface, home: string, session: string, lines: string[], bp: Blueprint) {
  const paths = blueprintPaths(home, session)
  await replaceFile($, paths.log, `${lines.join('\n')}\n`)
  await replaceFile($, paths.snapshot, `${JSON.stringify(bp, null, 2)}\n`)
}
