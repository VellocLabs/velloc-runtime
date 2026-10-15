/**
 * Shell-line rendering for the `# Environment` prompt block. Values come from
 * the host (`fs.systemInfo`); no TS-side fallback, so absent info stays absent.
 */

export type Platform = 'win32' | 'darwin' | 'linux'

/**
 * Format the `Shell:` line of the environment block. The Windows branch
 * carries an explicit "use Unix shell syntax" guidance line when the
 * configured shell is a POSIX shell — that's the case where the
 * model otherwise over-corrects toward `cmd`/PowerShell idioms.
 *
 * Returns null when no shell is known; caller drops the line entirely.
 */
export function formatShellLine(
  platform: Platform | undefined,
  shell: string | undefined,
): string | null {
  if (!shell) return null

  // No Velloc shell tool runs cmd: Bash runs Git Bash and PowerShell runs
  // pwsh / powershell. A host that names `cmd` fell back to %COMSPEC% (an older
  // binary, or one with no tool shell), and `Shell: cmd` would talk the model
  // into cmd syntax inside bash commands (`set VAR=value && …`). Say nothing.
  if (platform === 'win32' && /^cmd(\.exe)?$/i.test(shell.trim())) return null

  if (platform === 'win32' && /\b(bash|zsh|sh)\b/i.test(shell)) {
    return `Shell: ${shell} (use Unix shell syntax, not Windows — e.g., /dev/null not NUL, forward slashes in paths)`
  }
  return `Shell: ${shell}`
}
