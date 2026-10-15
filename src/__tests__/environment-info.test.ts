import { describe, expect, it } from 'vitest'
import { buildEnvironmentInfo } from '../utils/environmentInfo'
import { formatShellLine } from '../utils/hostPlatform'

describe('formatShellLine', () => {
  it('returns null when no shell is known', () => {
    expect(formatShellLine('win32', undefined)).toBeNull()
    expect(formatShellLine(undefined, undefined)).toBeNull()
  })

  it('appends Unix-syntax warning when a POSIX shell runs on Windows', () => {
    expect(formatShellLine('win32', 'bash')).toBe(
      'Shell: bash (use Unix shell syntax, not Windows — e.g., /dev/null not NUL, forward slashes in paths)',
    )
  })

  it('drops cmd on Windows: no Velloc shell tool runs it', () => {
    // An older host reports %COMSPEC% when $SHELL is unset; `Shell: cmd` would
    // steer the model to cmd syntax inside Git Bash commands.
    expect(formatShellLine('win32', 'cmd')).toBeNull()
    expect(formatShellLine('win32', 'CMD.EXE')).toBeNull()
    // Only on Windows, and only cmd itself.
    expect(formatShellLine('linux', 'cmd')).toBe('Shell: cmd')
    expect(formatShellLine('win32', 'pwsh')).toBe('Shell: pwsh')
  })

  it('does NOT append the warning for PowerShell on Windows', () => {
    expect(formatShellLine('win32', 'PowerShell 7+ (pwsh)')).toBe(
      'Shell: PowerShell 7+ (pwsh)',
    )
  })

  it('uses the explicit shell on POSIX without warnings', () => {
    expect(formatShellLine('linux', 'zsh')).toBe('Shell: zsh')
  })

  it('renders the explicit shell even when platform is missing', () => {
    // No platform → can't tell whether to add the Unix-syntax warning,
    // so render the bare shell name. The C++ host is expected to push
    // both fields together, so this branch is mostly a defensive case
    // for partial test fixtures.
    expect(formatShellLine(undefined, 'fish')).toBe('Shell: fish')
  })
})

describe('buildEnvironmentInfo', () => {
  it('returns null when no useful info is available', () => {
    expect(buildEnvironmentInfo({})).toBeNull()
  })

  it('skips the cwd line when cwd is the placeholder "."', () => {
    // Mirrors the bug we are guarding against: host failed to push a
    // real cwd, the bootstrap fell back to ".", and the prompt should
    // NOT advertise that to the model as a writable directory.
    const block = buildEnvironmentInfo({ cwd: '.', platform: 'win32' })
    expect(block).not.toContain('Primary working directory: .')
  })

  it('says whether the working directory is a git repository, and nothing while that is unknown', () => {
    expect(buildEnvironmentInfo({ cwd: '/w', gitRepository: true })).toContain('- Git repository: yes')
    expect(buildEnvironmentInfo({ cwd: '/w', gitRepository: false })).toContain('- Git repository: no')
    expect(buildEnvironmentInfo({ cwd: '/w' })).not.toContain('Git repository')
  })

  it('renders the full block with all four load-bearing fields', () => {
    const block = buildEnvironmentInfo({
      cwd: 'D:\\project\\shift\\nexus_web',
      platform: 'win32',
      osVersion: 'Windows 11 Pro 10.0.26200',
      shell: 'PowerShell 7+ (pwsh)',
      mainLoopModel: 'claude-sonnet-4-6',
    })
    expect(block).toBe(
      [
        '# Environment',
        'This session is running in the following environment:',
        '- Primary working directory: D:\\project\\shift\\nexus_web',
        '- Platform: win32',
        '- Shell: PowerShell 7+ (pwsh)',
        '- OS Version: Windows 11 Pro 10.0.26200',
        '- Model running this session: claude-sonnet-4-6',
      ].join('\n'),
    )
  })

  it('renders additional working directories as nested bullets', () => {
    const block = buildEnvironmentInfo({
      cwd: '/home/peijun/projects/foo',
      platform: 'linux',
      extraWorkspaceRoots: ['/home/peijun/projects/bar'],
    })
    expect(block).toContain('- Additional working directories:')
    expect(block).toContain('  - /home/peijun/projects/bar')
  })

  it('omits Platform/Shell/OS lines when host did not push them', () => {
    // No JS fallback — if the host omits these, the env block omits
    // them too. Accurate info or no info; never guesses.
    const block = buildEnvironmentInfo({
      cwd: '/home/peijun/projects/foo',
    })
    expect(block).not.toContain('Platform:')
    expect(block).not.toContain('Shell:')
    expect(block).not.toContain('OS Version:')
    expect(block).toContain('Primary working directory:')
  })
})
