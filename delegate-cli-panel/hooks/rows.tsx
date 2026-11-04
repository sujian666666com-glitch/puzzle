import type { EngineInterface, RenderInput } from 'claude-code'

import type { Blueprint, RunRow } from '../types'
import { derive, STATUS_LABEL } from './blueprint'
import { pieceScope, toneOf } from './puzzle'

// Transcript rows for puzzle work: a blueprint call, a dispatch that names a task, and the
// notice when that dispatch ends, each drawn as one dim line in its block's hover group, so a
// pointer on the row lights the block in the pane. ctrl+o still shows the engine's own rows.
// Like the pane, these hold no state: register.tsx reads it and passes it in.

export const RUN_CALL = /run_cli\.py['"]?\s+run\b/
export const TASK_FLAG = /--task(?:=|\s+)(['"]?)([A-Za-z0-9][A-Za-z0-9._-]{0,63})\1(?=\s|$)/

const OP_WORDS: Record<string, string> = {
  plan: '建立拼图',
  piece: '修订需求块',
  task: '安排任务',
  ask: '记下问题',
  answer: '记下回答',
  check: '记下验收',
  block: '记下阻碍',
  unblock: '解除阻碍',
  get: '查看拼图',
}
const ENDINGS: Record<string, string> = { completed: '结束', failed: '失败', killed: '已停止' }

export type RowModel = {
  bp: Blueprint | null
  rows: RunRow[]
  /** tool_use_id of a dispatching Bash call, to the task it named. */
  dispatches: Record<string, string>
  now: number
}

/** Opens the puzzle pane on a block, or on the whole puzzle. */
export type Locate = (piece?: string) => Promise<unknown>

const str = (value: unknown) => (typeof value === 'string' ? value : '')

// A tool's stored output: the text itself, or the text blocks of a content list.
function textOf(output: unknown): string {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) return output.map(block => str((block as { text?: unknown } | null)?.text)).join('')
  if (output && typeof output === 'object') return str((output as { result?: unknown }).result)

  return ''
}

/** The one block a blueprint call is about, when it is about one that exists. */
function pieceOf(bp: Blueprint | null, input: Record<string, unknown>) {
  if (!bp) return null
  const op = str(input.op)
  const listed = (key: string) => (Array.isArray(input[key]) ? (input[key] as { id?: unknown; pieces?: unknown }[]) : [])
  let id = ''
  if (op === 'check' || op === 'ask' || op === 'block') id = str(input.piece)
  else if (op === 'get') id = str(input.id)
  else if (op === 'answer') id = bp.questions.find(q => q.id === str(input.id))?.piece ?? ''
  else if (op === 'unblock') id = bp.blockers.find(b => b.id === str(input.id))?.piece ?? ''
  else if (op === 'piece' && listed('pieces').length === 1) id = str(listed('pieces')[0]?.id)
  else if (op === 'task' && listed('tasks').length === 1) {
    const pieces = listed('tasks')[0]?.pieces
    id = Array.isArray(pieces) ? str(pieces[0]) : ''
  }

  return bp.pieces.some(piece => piece.id === id) ? id : null
}

function pieceRow(
  $: EngineInterface,
  e: RenderInput<'ToolUse'> | RenderInput<'UserMessage'>,
  model: RowModel,
  locate: Locate,
  at: { key: string; text: string; piece: string | null; isFailed?: boolean },
) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const view =
    model.bp && at.piece ? derive(model.bp, model.rows, model.now).views.find(one => one.piece.id === at.piece) : undefined
  const scoped = at.piece ? { hover: { scope: pieceScope(at.piece), color: 'suggestion' } } : {}

  return (
    <Box flexDirection="row" gap={1}>
      <Text size="footnote" wrap="truncate-end" {...(at.isFailed ? { color: 'error' } : { dimColor: true })} {...scoped}>
        {at.text}
      </Text>
      {view ? (
        <Text size="caption" color={toneOf(view.status)} {...scoped}>
          ● {STATUS_LABEL[view.status]}
        </Text>
      ) : null}
      <Button key={`locate-${at.key}`} plain dimColor onPress={() => void locate(at.piece ?? undefined)}>
        {at.piece ? '定位' : '打开拼图'}
      </Button>
    </Box>
  )
}

/** A blueprint call: what it did, in the words of its one-line answer. */
export function drawBlueprintRow($: EngineInterface, e: RenderInput<'ToolUse'>, model: RowModel, locate: Locate) {
  const input = (e.props.input ?? {}) as Record<string, unknown>
  const word = OP_WORDS[str(input.op)] ?? '拼图'
  const answer = textOf(e.props.output)
  // rev N · <change> · 可开工：… · 需关注 N 项
  const change = /^rev \d+ · (.*?) · 可开工/.exec(answer)?.[1] ?? ''
  const isFailed = e.props.isErrored || e.props.isInterrupted
  const text = e.props.isRunning
    ? `拼图 · ${word}…`
    : isFailed
      ? `拼图没有写入 · ${answer.split('\n')[0] || word}`
      : `拼图 · ${change || word}`

  return pieceRow($, e, model, locate, { key: e.props.tool_use_id, text, piece: pieceOf(model.bp, input), isFailed })
}

/** A Bash call that dispatches with --task: which task, for which block. Null for any other call. */
export function drawDispatchRow($: EngineInterface, e: RenderInput<'ToolUse'>, model: RowModel, locate: Locate) {
  const input = (e.props.input ?? {}) as { command?: unknown; description?: unknown }
  const command = str(input.command)
  if (!RUN_CALL.test(command)) return null
  const id = TASK_FLAG.exec(command)?.[2]
  const task = model.bp?.tasks.find(one => one.id === id)
  if (!task) return null
  const what = str(input.description) || task.title || task.id

  return pieceRow($, e, model, locate, { key: e.props.tool_use_id, text: `派发 · ${what}`, piece: task.pieces[0] ?? null })
}

/** The notice a background dispatch leaves when it ends. Null when it named no task. */
export function drawTaskNotice($: EngineInterface, e: RenderInput<'UserMessage'>, model: RowModel, locate: Locate) {
  const started = e.props.task?.toolUseId
  if (!started) return null
  const id = model.dispatches[started]
  const task = model.bp?.tasks.find(one => one.id === id)
  if (!task) return null
  const ending = ENDINGS[e.props.task?.status ?? ''] ?? '结束'

  return pieceRow($, e, model, locate, {
    key: started,
    text: `运行${ending} · ${task.title || task.id}`,
    piece: task.pieces[0] ?? null,
    isFailed: e.props.task?.status === 'failed',
  })
}
