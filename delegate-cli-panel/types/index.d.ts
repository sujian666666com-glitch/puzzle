/** One delegate-cli run as the pane lists it, read from its run.json. */
export type RunRow = {
  /** The run directory's name under ~/.claude/cli-runs. */
  id: string
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
}

/** The tail of the selected run's progress.log, and its result.md once it has finished. */
export type RunDetail = { id: string; lines: string[]; size: number; mtimeMs: number; result: string }

export type Scope = 'mine' | 'all'

/** Which page of a run is shown; auto is the result once finished, else the live log. */
export type Tab = 'auto' | 'result' | 'log'

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
    }
  }
}
