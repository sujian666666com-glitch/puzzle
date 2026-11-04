/** One delegate-cli run as the pane lists it, read from its run.json. */
export type RunRow = {
  /** The run directory's name under ~/.claude/cli-runs. */
  id: string
  /** Task name: run.json title, else a line of task.md or the handoff, clipped to 40. */
  title: string
  agent: string
  model: string
  thinking: string
  access: string
  status: string
  startedAt: number
  finishedAt: number | null
  cwd: string
  runDir: string
  /** A command that follows progress.log in a terminal. */
  watch: string
  /** Dispatched by this Claude session (run.json claude_session_id). */
  isMine: boolean
  /** Marked running, but progress.log has been silent past the runner's heartbeat. */
  isStale: boolean
  lastLine: string
  tokens: number | null
  error: string
  /** What the runner is doing right now; absent on records from an older runner. */
  activity: RunActivity | null
  /** Cursor text not yet committed as a timeline message; other agents leave it empty. */
  liveText: string
  /** Host pid of run_cli.py; null when the record does not name one. */
  runnerPid: number | null
  /** Absolute path of handoff.md when the runner recorded one. */
  handoffFile: string
  /** The blueprint task the run works on (run.json task); null on runs dispatched without one. */
  task: string | null
}

/** Who makes the next move on a question or a blocker: the person, or the agents and Claude. */
export type Owner = 'user' | 'agent'

/** Claude's verdict on one acceptance criterion, against the piece version it judged. */
export type Verdict = { pass: boolean; evidence: string; version: number; at: number }

export type Criterion = { id: string; text: string; verdict: Verdict | null }

/** One requirement block: an outcome that can be accepted on its own. */
export type Piece = {
  id: string
  group: string
  order: number
  title: string
  summary: string
  scope: string
  needs: string[]
  criteria: Criterion[]
  /** Rises when the summary, scope or criteria change; verdicts on an older version no longer count. */
  version: number
  /** The version last accepted whole; null until it first is. */
  acceptedVersion: number | null
}

export type Group = { id: string; title: string; order: number }

export type Task = { id: string; pieces: string[]; role: string; agent: string; title: string; after: string[] }

export type Question = { id: string; piece: string; text: string; owner: Owner; answer: string | null }

export type Blocker = { id: string; piece: string; reason: string; owner: Owner; since: number }

/** What the blueprint tool's operation log replays to. Claude writes intent and verdicts; status is derived. */
export type Blueprint = {
  schema: 2
  rev: number
  /** Epoch ms of the first plan; runs of this session started before it are not its loose runs. */
  createdAt: number
  updatedAt: number
  goal: { title: string; summary: string }
  groups: Group[]
  pieces: Piece[]
  tasks: Task[]
  questions: Question[]
  blockers: Blocker[]
}

export type PuzzleView = 'board' | 'list' | 'tree'

/** A runner's current beat. `since` is epoch seconds. */
export type RunActivity = {
  kind: 'thinking' | 'tool' | 'writing' | 'waiting'
  label: string
  since: number
}

/** The tail of the selected run's progress.log, its result, and the task text. */
export type RunDetail = {
  id: string
  lines: string[]
  size: number
  mtimeMs: number
  result: string
  /** handoff.md, or task.md with the runner's two preamble paragraphs removed. */
  task: string
  /** True when `task` came from task.md because handoff.md was missing. */
  taskNote: boolean
}

export type Scope = 'mine' | 'all'

/** Which page of a run is shown; auto is the result once finished, else the live log. */
export type Tab = 'auto' | 'result' | 'log' | 'task'

/** The stop button's first press; a second press within five seconds sends SIGTERM. */
export type StopArm = { id: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    'delegate-cli-panel': {
      runs: Shaped<RunRow[]>
      detail: Shaped<RunDetail | null>
      selected: string | null
      scope: Scope
      tab: Tab
      /** The person closed the pane; it stays closed until the next dispatch or /delegate-runs. */
      dismissed: boolean
      autoOpened: string[]
      stopArm: Shaped<StopArm | null>
      /** This session's requirement blueprint, as its log last replayed. */
      blueprint: Shaped<Blueprint | null>
      puzzleView: PuzzleView
      puzzleSelected: string | null
      /** The block whose card holds the keyboard; its card shows who and where in place of the summary. */
      puzzleFocused: string | null
      /** The person closed the puzzle pane; it stays closed until the next plan or /puzzle. */
      puzzleDismissed: boolean
      /** tool_use_id of a dispatching Bash call, to the blueprint task it named. */
      dispatches: Shaped<Record<string, string>>
    }
  }
}
