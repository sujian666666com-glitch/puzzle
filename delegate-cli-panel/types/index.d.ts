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
}

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
    }
  }
}
