import type { EngineInterface } from 'claude-code'

// What differs on native Windows, where the module has no os module of its own to ask.

/** True on native Windows (cmd and PowerShell set OS=Windows_NT; WSL does not). */
export async function isWindows($: EngineInterface) {
  return (await $.env.get('OS')) === 'Windows_NT'
}

/** The user's home: HOME, else USERPROFILE, which is all Windows sets for a desktop app. */
export async function homeDir($: EngineInterface) {
  return (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''
}
