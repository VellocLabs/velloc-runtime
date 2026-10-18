/**
 * The shells a terminal can start (F-31): each one's launch argv, the default
 * pick, and how the host's shell report becomes the topic's `shells` list.
 *
 * Security: a terminal is started from this table by shell id only — the
 * host resolves the id against its own command allowlist, so no path or
 * command line ever crosses from a client.
 */
import type { TerminalShellInfo } from './protocol'

export const TERMINAL_SHELL_IDS = ['pwsh', 'powershell', 'cmd', 'bash'] as const
export type TerminalShellId = (typeof TERMINAL_SHELL_IDS)[number]

/** What `shell.spawn` runs for each shell id: an interactive, logo-less shell. */
export const TERMINAL_SHELL_ARGV: Record<TerminalShellId, { file: string; args: string[] }> = {
  pwsh: { file: 'pwsh', args: ['-NoLogo'] },
  powershell: { file: 'powershell', args: ['-NoLogo'] },
  cmd: { file: 'cmd', args: [] },
  bash: { file: 'bash', args: ['--login', '-i'] },
}

/** `create` without a `shell` takes the first of these the host has, else the first listed shell. */
const DEFAULT_SHELL_ORDER: readonly TerminalShellId[] = ['pwsh', 'powershell', 'cmd']

export function isTerminalShellId(value: unknown): value is TerminalShellId {
  return typeof value === 'string' && (TERMINAL_SHELL_IDS as readonly string[]).includes(value)
}

export function defaultTerminalShell(shells: readonly TerminalShellInfo[]): string | undefined {
  for (const id of DEFAULT_SHELL_ORDER) {
    if (shells.some(shell => shell.id === id)) return id
  }
  return shells[0]?.id
}

/** What the host says about its shells: `exec.listShells` plus `fs.systemInfo`'s platform. */
export type HostShellReport = {
  bash: boolean
  /** `pwsh` or Windows PowerShell — the host does not say which. */
  powershell: boolean
  /** `win32`, `darwin`, `linux`, or empty when unknown. */
  platform: string
}

/**
 * The topic's `shells` from the host's report. The report has one bit for
 * PowerShell, so both ids are offered when it is set and a `pwsh` start that
 * the host cannot resolve falls back to `powershell` (`TerminalService`).
 * `cmd` is every Windows host's. Versions are not reported by the host yet.
 */
export function shellsFromHostReport(report: HostShellReport): TerminalShellInfo[] {
  const shells: TerminalShellInfo[] = []
  if (report.powershell) {
    shells.push({ id: 'pwsh', version: null }, { id: 'powershell', version: null })
  }
  if (report.platform === 'win32') shells.push({ id: 'cmd', version: null })
  if (report.bash) shells.push({ id: 'bash', version: null })
  return shells
}

export function sameShells(a: readonly TerminalShellInfo[], b: readonly TerminalShellInfo[]): boolean {
  return a.length === b.length && a.every((shell, i) => shell.id === b[i]?.id && shell.version === b[i]?.version)
}
