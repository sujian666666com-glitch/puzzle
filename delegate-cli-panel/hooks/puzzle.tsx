import type { EngineInterface, RenderInput } from 'claude-code'

import type { Blueprint, PuzzleView, RunRow } from '../types'
import { derive, STATUS_LABEL } from './blueprint'
import type { PieceStatus, PieceView } from './blueprint'

// The 需求拼图 pane. By default it shows the requirement; under the pointer, who works on a
// block and where it stands; on a click, the detail and what the person can do about it.
// Drawn to what the desktop actually renders (docs/puzzle-desktop-proposal.md, 4.4). It holds
// no state of its own: register.tsx reads the values and does what a press asks.

export const PUZZLE_PANE = 'delegate-puzzle'
export const PUZZLE_TITLE = '需求拼图'
export const PUZZLE_COLUMNS = 56
// Ink with zero alpha. The desktop takes hex or rgb() as a raw color; a CSS name such as
// "transparent" falls back to the current color.
const CLEAR = '#0000'
const TONE: Record<PieceStatus, string> = {
  accepted: 'success',
  reverify: 'merged',
  blocked: 'error',
  fix: 'error',
  running: 'claude',
  unverified: 'warning',
  review: 'merged',
  clarify: 'warning',
  waiting: 'inactive',
  idle: 'inactive',
}
const VIEWS: [PuzzleView, string][] = [
  ['board', '蓝图'],
  ['list', '清单'],
  ['tree', '关系'],
]
const AGENTS: Record<string, string> = { codex: 'Codex', pi: 'Pi', cursor: 'Cursor' }
const ENDED: Record<string, string> = {
  process_succeeded: '已结束',
  failed: '失败',
  blocked: '受阻',
  timed_out: '超时',
  cancelled: '已停止',
  planned: '仅计划',
}

/** A block's hover group: its card, its chips on related cards and its transcript rows. */
export const pieceScope = (id: string) => `piece-${id}`.slice(0, 64)

export const toneOf = (status: PieceStatus) => TONE[status]

const isLive = (run: RunRow) => (run.status === 'running' || run.status === 'preparing') && !run.isStale

/** What the pane draws from. */
export type PuzzleModel = {
  bp: Blueprint | null
  rows: RunRow[]
  view: PuzzleView
  open: string | null
  focus: string | null
  /** The run whose 停止 was pressed once and still waits for the second press. */
  armed: string | null
  now: number
}

/** What a press asks of the hooks module, which owns the state and the processes. */
export type PuzzleActions = {
  show: (id: string) => Promise<void>
  toggle: (id: string) => Promise<void>
  close: () => Promise<void>
  setView: (view: PuzzleView) => Promise<void>
  /** Shows one run in the 子 Agent pane. */
  openRun: (id: string) => Promise<void>
  /** Shows the 子 Agent pane's list. */
  openRuns: () => Promise<void>
  /** A press on 停止: the first arms it, a second within five seconds stops the run. */
  stop: (run: RunRow) => Promise<void>
}

export function drawPuzzle($: EngineInterface, e: RenderInput<'Pane'>, model: PuzzleModel, actions: PuzzleActions) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const bp = model.bp
  const columns = Math.max(24, e.props.bodyColumns)
  if (!bp) {
    return (
      <Box flexDirection="column" gap="xs">
        <Text size="heading" weight="semibold">
          {PUZZLE_TITLE}
        </Text>
        <Text dimColor wrap="wrap">
          本会话还没有需求拼图。用 delegate-cli 委派时，Claude 会先把需求拆成几块，这里就会出现。
        </Text>
      </Box>
    )
  }
  const board = derive(bp, model.rows, model.now)
  const shown: PuzzleView = columns < 40 ? 'list' : model.view
  const half = Math.floor((columns - 1) / 2)
  const byId = new Map(board.views.map(view => [view.piece.id, view]))
  const after = (id: string) => board.views.filter(view => view.piece.needs.includes(id)).map(view => view.piece.id)

  const status = (view: PieceView) => (
    <Text size="caption" color={toneOf(view.status)}>
      ● {STATUS_LABEL[view.status]}
    </Text>
  )
  // Who works on it and where it stands, in place of the summary.
  const peek = (view: PieceView) => {
    const where = view.now.replace(/^当前：/, '')
    return view.who === '还未分配' ? where : `${view.who} · ${where}`
  }
  const peekLook = (view: PieceView) => (view.reason ? { color: toneOf(view.status) } : {})
  // A block that waits on something says what, in place of its summary.
  const restLook = (view: PieceView) => (view.reason ? { color: toneOf(view.status) } : { dimColor: true })
  // Read on this card while the other block is lit: what this one is to it.
  const roleTo = (view: PieceView, other: string) => (byId.get(other)?.piece.needs.includes(view.piece.id) ? '前置' : '后续')

  // One chip per related block, revealed with that block's group. It sits in the line,
  // so it only shortens the summary, never moves a row.
  const hints = (view: PieceView) =>
    [...view.piece.needs, ...after(view.piece.id)]
      .filter((id, index, all) => byId.has(id) && all.indexOf(id) === index)
      .map(other => (
        <Box
          display="none"
          hover={{ scope: pieceScope(other), display: 'flex' }}
          flexShrink={0}
          paddingX="xs"
          backgroundColor="selectionBg"
        >
          <Text size="caption" color="suggestion">
            {roleTo(view, other)}
          </Text>
        </Box>
      ))

  // The peek lies over the summary line alone. The summary turns clear rather than being
  // painted over: the app's fills, the accepted green among them, are translucent.
  const swap = (view: PieceView) => (
    <Box
      position="absolute"
      top={0}
      bottom={0}
      left={0}
      right={0}
      display="none"
      hover={{ scope: pieceScope(view.piece.id), display: 'flex' }}
      paddingLeft="xs"
    >
      <Text size="footnote" wrap="truncate-end" {...peekLook(view)}>
        {peek(view)}
      </Text>
    </Box>
  )

  const card = (view: PieceView, at: { key: string; width: number; indent?: number; also?: string }) => {
    const id = view.piece.id
    const isOpen = model.open === id
    // A focused card shows its peek outright: a hover reveal on a Box already shown is refused.
    const isFocused = model.focus === id && !isOpen
    const edge =
      isOpen || isFocused
        ? { borderColor: 'suggestion' }
        : view.status === 'clarify'
          ? { borderColor: 'warning', borderDimColor: true }
          : { borderDimColor: true }
    const fill =
      view.status === 'accepted' ? { backgroundColor: 'diffAddedDimmed' } : isOpen ? { backgroundColor: 'selectionBg' } : {}

    return (
      <Box
        key={at.key}
        width={at.width}
        {...(at.indent ? { marginLeft: at.indent } : {})}
        flexDirection="column"
        paddingX="md"
        paddingY="sm"
        borderStyle="round"
        {...edge}
        {...fill}
        hover={{ scope: pieceScope(id), borderColor: 'suggestion', borderDimColor: false }}
      >
        {/* A desktop Button draws its label as plain text, so the status keeps its colour beside it. */}
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Button key={`open-${id}`} plain onPress={() => actions.toggle(id)}>
            {`${at.indent ? '↳ ' : ''}${view.piece.title}`}
          </Button>
          {status(view)}
        </Box>
        <Box flexDirection="row" gap={1} paddingLeft="xs">
          <Text
            size="footnote"
            wrap="truncate-end"
            {...(isFocused ? peekLook(view) : restLook(view))}
            hover={{ scope: pieceScope(id), color: CLEAR }}
          >
            {isFocused ? peek(view) : view.reason || view.piece.summary}
          </Text>
          {hints(view)}
          {swap(view)}
        </Box>
        {at.also ? (
          <Box paddingLeft="xs">
            <Text size="footnote" dimColor wrap="truncate-end">
              也需要：{at.also}
            </Text>
          </Box>
        ) : null}
      </Box>
    )
  }

  const blueprintView = () => (
    <Box flexDirection="column" gap="md" marginTop="lg">
      {[...bp.groups]
        .sort((a, b) => a.order - b.order)
        .map(group => {
          const members = board.views.filter(view => view.piece.group === group.id)
          if (!members.length) return null

          return (
            <Box flexDirection="column" gap="xs">
              <Text size="caption" weight="semibold" dimColor>
                {group.title}
              </Text>
              <Box flexDirection="row" flexWrap="wrap" gap={1}>
                {members.map(view => card(view, { key: `card-${view.piece.id}`, width: half }))}
              </Box>
            </Box>
          )
        })}
    </Box>
  )

  const listView = () => (
    <Box flexDirection="column" gap="xs" marginTop="lg">
      {board.views.map(view => card(view, { key: `row-${view.piece.id}`, width: columns }))}
    </Box>
  )

  // Each block under the last block it needs; the others it needs are named on the card.
  const treeView = () => {
    const parentOf = (view: PieceView) => view.piece.needs.filter(id => byId.has(id)).at(-1) ?? null
    const order: [PieceView, number][] = []
    const walk = (view: PieceView, depth: number) => {
      order.push([view, depth])
      for (const child of board.views.filter(one => parentOf(one) === view.piece.id)) walk(child, depth + 1)
    }
    for (const root of board.views.filter(one => parentOf(one) === null)) walk(root, 0)

    return (
      <Box flexDirection="column" gap="xs" marginTop="lg">
        {order.map(([view, depth]) => {
          const indent = Math.min(depth, 4) * 2
          const parent = parentOf(view)
          const also = view.piece.needs
            .filter(id => id !== parent && byId.has(id))
            .map(id => byId.get(id)?.piece.title ?? id)
            .join('、')

          return card(view, { key: `row-${view.piece.id}`, width: columns - indent, indent, also })
        })}
      </Box>
    )
  }

  const detail = () => {
    const view = model.open ? byId.get(model.open) : undefined
    if (!view) return null
    const piece = view.piece
    const fill = async (text: string) => {
      await $.prompt.fill({ text, mode: 'replace' })
      $.ui.toast('已填进输入框，补充后再发送')
    }
    const names = (ids: string[]) =>
      ids
        .map(id => byId.get(id))
        .filter((one): one is PieceView => !!one)
        .map(one => `${one.piece.title} ${STATUS_LABEL[one.status]}`)
        .join('、')
    const fact = (label: string, value: string, look: object = {}) => (
      <Box flexDirection="row" gap={1}>
        <Text size="caption" dimColor>
          {label}
        </Text>
        <Text size="footnote" wrap="wrap" {...look}>
          {value}
        </Text>
      </Box>
    )
    const isPersons = board.concerns.some(concern => concern.piece === piece.id)
    const question = bp.questions.find(q => q.piece === piece.id && q.answer === null && q.owner === 'user')
    const live = view.runs.filter(isLive).at(-1)
    const later = after(piece.id)

    return (
      <Box
        flexDirection="column"
        gap="xs"
        marginTop="lg"
        paddingX="md"
        paddingY="md"
        borderStyle="round"
        borderColor="suggestion"
        borderDimColor
      >
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Text size="heading" weight="semibold" wrap="truncate-end">
            {piece.title}
          </Text>
          {status(view)}
        </Box>
        {piece.summary ? (
          <Text size="footnote" dimColor wrap="wrap">
            {piece.summary}
          </Text>
        ) : null}
        {piece.scope ? (
          <Text size="footnote" dimColor wrap="wrap">
            范围：{piece.scope}
          </Text>
        ) : null}
        <Box flexDirection="column" gap="xs" marginTop="sm">
          {fact('现在', view.now, view.reason ? { color: toneOf(view.status) } : {})}
          {fact('负责', view.who)}
          {piece.needs.length ? fact('前置', names(piece.needs)) : null}
          {later.length ? fact('后续', names(later)) : null}
        </Box>
        <Box flexDirection="column" marginTop="sm">
          <Text size="caption" dimColor>
            验收 {view.passed} / {piece.criteria.length}
          </Text>
          {piece.criteria.length === 0 ? (
            <Text size="footnote" dimColor>
              还没有验收条件
            </Text>
          ) : null}
          {piece.criteria.map(criterion => {
            const verdict = criterion.verdict && criterion.verdict.version === piece.version ? criterion.verdict : null

            return (
              <Text size="footnote" wrap="wrap">
                <Text color={verdict ? (verdict.pass ? 'success' : 'error') : 'inactive'}>
                  {verdict ? (verdict.pass ? '✓' : '✗') : '○'}
                </Text>{' '}
                {criterion.text}
                {verdict?.evidence ? <Text dimColor>（{verdict.evidence}）</Text> : null}
              </Text>
            )
          })}
        </Box>
        {view.runs.length ? (
          <Box flexDirection="column" marginTop="sm">
            <Text size="caption" dimColor>
              运行记录（点开看过程）
            </Text>
            {[...view.runs]
              .reverse()
              .slice(0, 5)
              .map(run => (
                <Button key={`run-${run.id}`} plain dimColor onPress={() => actions.openRun(run.id)}>
                  {`${AGENTS[run.agent] ?? run.agent} · ${run.title} · ${isLive(run) ? '运行中' : (ENDED[run.status] ?? run.status)}`}
                </Button>
              ))}
          </Box>
        ) : null}
        <Box flexDirection="row" flexWrap="wrap" gap="sm" marginTop="sm">
          {question ? (
            <Button
              key="act-answer"
              variant="primary"
              label="回答这个问题"
              onPress={() => fill(`回答「${piece.title}」的问题（${question.text}）：`)}
            />
          ) : isPersons && view.status === 'blocked' ? (
            <Button
              key="act-unblock"
              variant="primary"
              label="提供所需信息"
              onPress={() => fill(`关于「${piece.title}」受阻（${view.reason}）：`)}
            />
          ) : view.status === 'review' || view.status === 'reverify' ? (
            <Button key="act-accept" variant="primary" label="请 Claude 验收" onPress={() => fill(`请验收「${piece.title}」：`)} />
          ) : null}
          {live ? (
            <Button
              key="act-stop"
              label={model.armed === live.id ? '确认停止' : '停止运行'}
              variant={model.armed === live.id ? 'primary' : 'secondary'}
              onPress={() => actions.stop(live)}
            />
          ) : null}
          <Button key="act-ask" label="追问这一块" onPress={() => fill(`关于「${piece.title}」：`)} />
          <Button key="act-close" plain dimColor label="收起" onPress={() => actions.close()} />
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" gap="xs">
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Text size="heading" weight="semibold" wrap="truncate-end">
            {bp.goal.title}
          </Text>
          <Box flexDirection="row" gap="xs" flexShrink={0}>
            {VIEWS.map(([key, label]) => (
              <Button key={`view-${key}`} plain dimColor={key !== shown} onPress={() => actions.setView(key)}>
                {label}
              </Button>
            ))}
          </Box>
        </Box>
        {bp.goal.summary ? (
          <Text size="footnote" dimColor wrap="wrap">
            {bp.goal.summary}
          </Text>
        ) : null}
      </Box>
      <Box
        flexDirection="column"
        gap="sm"
        marginTop="md"
        paddingX="md"
        paddingY="sm"
        borderStyle="round"
        borderColor="userMessageBackground"
        backgroundColor="userMessageBackground"
      >
        <Text>
          已验收{' '}
          <Text weight="semibold" tabular>
            {`${board.accepted} / ${board.views.length}`}
          </Text>{' '}
          项需求
        </Text>
        {board.concerns.length ? (
          <Box flexDirection="column">
            <Text size="caption" weight="semibold" color="warning">
              需关注 {board.concerns.length} 项
            </Text>
            {board.concerns.map((concern, index) => (
              <Box flexDirection="row" gap="xs">
                <Text size="caption" color={toneOf(byId.get(concern.piece)?.status ?? 'idle')}>
                  ●
                </Text>
                <Button key={`attention-${index}`} plain onPress={() => actions.show(concern.piece)}>
                  {concern.text}
                </Button>
              </Box>
            ))}
          </Box>
        ) : null}
      </Box>
      {shown === 'board' ? blueprintView() : shown === 'list' ? listView() : treeView()}
      {detail()}
      {board.loose.length ? (
        <Box flexDirection="row" gap="xs" marginTop="md">
          <Text size="caption" dimColor>
            另有 {board.loose.length} 次运行没有归到拼图里
          </Text>
          <Button key="loose" plain dimColor onPress={() => actions.openRuns()}>
            在子 Agent 里看
          </Button>
        </Box>
      ) : null}
    </Box>
  )
}
