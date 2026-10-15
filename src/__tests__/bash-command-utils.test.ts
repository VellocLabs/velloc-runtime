import { describe, expect, it } from 'vitest'
import {
  idleWaitRejection,
  detectBlockedSleepPatternPS,
  classifyShellLine,
  expectsNoOutput,
  splitCommandSimple,
} from '../toolkit/builtin/glic/bashCommandUtils'

// Bash command classification (search/read, silent) and the blocked-sleep
// guard. These are UI-classification / input-validation helpers — NOT security
// boundaries (those live in the C++ policy layer + permission engine).

describe('splitCommandSimple', () => {
  it('splits on top-level operators', () => {
    expect(splitCommandSimple('ls && echo hi')).toEqual(['ls', 'echo hi'])
    expect(splitCommandSimple('a || b')).toEqual(['a', 'b'])
    expect(splitCommandSimple('a ; b ; c')).toEqual(['a', 'b', 'c'])
    expect(splitCommandSimple('cat f | grep x')).toEqual(['cat f', 'grep x'])
  })

  it('does not split inside quotes', () => {
    expect(splitCommandSimple('echo "a && b"')).toEqual(['echo "a && b"'])
    expect(splitCommandSimple("echo 'a ; b'")).toEqual(["echo 'a ; b'"])
  })

  it('returns a single command unchanged', () => {
    expect(splitCommandSimple('ls -la')).toEqual(['ls -la'])
  })

  it('drops empty segments', () => {
    expect(splitCommandSimple('ls ;; echo')).toEqual(['ls', 'echo'])
  })
})

// Pins 2-6-4 (sleep guard) — test IDs 2-6-4.1 … 2-6-4.5.
describe('idleWaitRejection', () => {
  // 2-6-4.5: unit cases
  it('detects a standalone sleep', () => {
    expect(idleWaitRejection('sleep 3')).toBe('standalone sleep 3')
  })

  it('detects a leading sleep followed by another command', () => {
    expect(idleWaitRejection('sleep 3; ls')).toBe('sleep 3 followed by: ls')
    expect(idleWaitRejection('sleep 5 && npm test')).toBe(
      'sleep 5 followed by: npm test',
    )
  })

  it('returns null for non-sleep commands', () => {
    expect(idleWaitRejection('echo hi')).toBeNull()
  })

  // 2-6-4.3: sub-2s sleeps are allowed
  it('allows sleep 1 and sleep 0.5', () => {
    expect(idleWaitRejection('sleep 1')).toBeNull()
    expect(idleWaitRejection('sleep 0.5')).toBeNull()
    expect(idleWaitRejection('sleep 0')).toBeNull()
  })

  it('allows a float sleep >= 2 (pacing, not a poll)', () => {
    // `sleep 2.5` does not match the integer-only guard regex.
    expect(idleWaitRejection('sleep 2.5')).toBeNull()
  })

  it('does not block sleep that is not the first subcommand', () => {
    // `npm test && sleep 30` — the sleep is trailing, not a leading poll.
    expect(idleWaitRejection('npm test && sleep 30')).toBeNull()
  })

  it('does not block sleep inside a pipeline', () => {
    expect(idleWaitRejection('echo hi | sleep 5')).toBeNull()
  })
})

// Pins 2-6-8 (classification) — test ID 2-6-8.1.
describe('classifyShellLine', () => {
  it('classifies a read command', () => {
    expect(classifyShellLine('cat f')).toMatchObject({ isRead: true })
  })

  it('classifies a list command', () => {
    expect(classifyShellLine('ls dir')).toMatchObject({ isList: true })
  })

  it('classifies a search command', () => {
    expect(classifyShellLine('grep x f')).toMatchObject({
      isSearch: true,
    })
  })

  // 2-6-8.1: neutral echo between reads stays read/list
  it('treats neutral commands as transparent in a compound', () => {
    const r = classifyShellLine('ls && echo --- && ls d2')
    expect(r.isList).toBe(true)
  })

  it('returns all-false when any segment is not read/search/list', () => {
    expect(classifyShellLine('cat f && rm g')).toEqual({
      isSearch: false,
      isRead: false,
      isList: false,
    })
  })

  it('returns all-false for only-neutral commands', () => {
    expect(classifyShellLine('echo foo')).toEqual({
      isSearch: false,
      isRead: false,
      isList: false,
    })
  })
})

// Pins 2-7-4 (PowerShell sleep guard) — test IDs 2-7-4.2 … 2-7-4.4.
describe('detectBlockedSleepPatternPS', () => {
  // 2-7-4.2: MONITOR_TOOL on: Start-Sleep 5 / Start-Sleep -Seconds 5 / sleep 5 → code 10
  it('detects standalone Start-Sleep N', () => {
    expect(detectBlockedSleepPatternPS('Start-Sleep 5')).toBe(
      'standalone Start-Sleep 5',
    )
  })

  it('detects Start-Sleep -Seconds N', () => {
    expect(detectBlockedSleepPatternPS('Start-Sleep -Seconds 5')).toBe(
      'standalone Start-Sleep 5',
    )
  })

  it('detects Start-Sleep -s N (abbreviated)', () => {
    expect(detectBlockedSleepPatternPS('Start-Sleep -s 5')).toBe(
      'standalone Start-Sleep 5',
    )
  })

  it('detects sleep N (PS built-in alias)', () => {
    expect(detectBlockedSleepPatternPS('sleep 5')).toBe(
      'standalone Start-Sleep 5',
    )
  })

  it('detects Start-Sleep followed by another command', () => {
    expect(detectBlockedSleepPatternPS('Start-Sleep 3; Get-Content x')).toBe(
      'Start-Sleep 3 followed by: Get-Content x',
    )
  })

  // 2-7-4.3: Start-Sleep 1 / -Milliseconds 500 allowed; Start-Sleep 5 + run_in_background allowed
  it('allows Start-Sleep 1 (sub-2s)', () => {
    expect(detectBlockedSleepPatternPS('Start-Sleep 1')).toBeNull()
  })

  it('allows Start-Sleep -Milliseconds 500 (sub-second pacing)', () => {
    expect(detectBlockedSleepPatternPS('Start-Sleep -Milliseconds 500')).toBeNull()
  })

  // 2-7-4.4: unit idleWaitRejection
  it('returns null for non-sleep commands', () => {
    expect(detectBlockedSleepPatternPS('Get-Date')).toBeNull()
    expect(detectBlockedSleepPatternPS('Get-Process | Stop-Process')).toBeNull()
  })

  it('is case-insensitive', () => {
    expect(detectBlockedSleepPatternPS('start-sleep 5')).toBe(
      'standalone Start-Sleep 5',
    )
    expect(detectBlockedSleepPatternPS('START-SLEEP -SECONDS 10')).toBe(
      'standalone Start-Sleep 10',
    )
  })

  it('does not block sleep inside a pipeline (not first statement)', () => {
    expect(detectBlockedSleepPatternPS('Get-Process | Start-Sleep 5')).toBeNull()
  })
})

describe('expectsNoOutput', () => {
  // 2-6-8.1: rm is silent
  it('classifies a mutating command as silent', () => {
    expect(expectsNoOutput('rm f')).toBe(true)
    expect(expectsNoOutput('mkdir dir')).toBe(true)
  })

  it('returns false for a command that produces output', () => {
    expect(expectsNoOutput('cat f')).toBe(false)
  })

  // 2-6-8.1: `cat f && rm g` — cat is not silent → whole thing not silent
  it('returns false when any segment is non-silent', () => {
    expect(expectsNoOutput('cat f && rm g')).toBe(false)
  })

  it('treats a trailing `|| true` fallback as silent', () => {
    expect(expectsNoOutput('mkdir x || true')).toBe(true)
  })
})
