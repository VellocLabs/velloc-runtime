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

/**
 * The `PowerShell:` line: which edition the PowerShell tool runs, so commands
 * are written for it. Windows PowerShell 5.1 lacks the pipeline-chain and
 * null operators that PowerShell 7 has. Null off Windows or when unknown.
 */
export function formatPowerShellLine(
  platform: Platform | undefined,
  powershell: string | undefined,
): string | null {
  if (platform !== 'win32' || !powershell) return null
  const name = powershell.trim().toLowerCase()
  if (name === 'pwsh') {
    return 'PowerShell: PowerShell 7+ (pwsh); `&&` and `||` chain commands'
  }
  if (name === 'powershell') {
    return 'PowerShell: Windows PowerShell 5.1 (powershell.exe); it has no `&&`, `||`, `??` or ternary: separate commands with `;` and test `$?` or `$LASTEXITCODE`, e.g. `cmd1; if ($?) { cmd2 }`'
  }
  return null
}
