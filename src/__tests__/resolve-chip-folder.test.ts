import { describe, expect, it } from 'vitest'
import { resolveChipFolder } from '../components/assistant-ui/resolveChipFolder'

const SANDBOX = '/repo/.velloc/workspace/'
const FOLDER_A = '/home/me/projA'
const FOLDER_B = '/home/me/projB'

describe('resolveChipFolder', () => {
  it('shows the live folder while the session is unlocked', () => {
    const r = resolveChipFolder(undefined, {
      locked: false,
      needsProjectFolder: false,
      projectRoot: FOLDER_A,
    })
    expect(r).toEqual({
      remembered: FOLDER_A,
      display: FOLDER_A,
      showOpenCta: false,
    })
  })

  it('follows a re-bind while still unlocked', () => {
    const a = resolveChipFolder(undefined, {
      locked: false,
      needsProjectFolder: false,
      projectRoot: FOLDER_A,
    })
    const b = resolveChipFolder(a.remembered, {
      locked: false,
      needsProjectFolder: false,
      projectRoot: FOLDER_B,
    })
    expect(b.display).toBe(FOLDER_B)
    expect(b.remembered).toBe(FOLDER_B)
  })

  it('keeps the bound folder when the session locks', () => {
    const unlocked = resolveChipFolder(undefined, {
      locked: false,
      needsProjectFolder: false,
      projectRoot: FOLDER_A,
    })
    const locked = resolveChipFolder(unlocked.remembered, {
      locked: true,
      needsProjectFolder: false,
      projectRoot: FOLDER_A,
    })
    expect(locked.display).toBe(FOLDER_A)
    expect(locked.showOpenCta).toBe(false)
  })

  it('IGNORES a transient sandbox projectRoot once locked (the bug fix)', () => {
    // Bound to A, locked, then a stray snapshot reports the sandbox workspace
    // (e.g. mid-turn during an LLM auth error). The chip must keep showing A.
    let remembered: string | undefined
    remembered = resolveChipFolder(remembered, {
      locked: false,
      needsProjectFolder: false,
      projectRoot: FOLDER_A,
    }).remembered
    remembered = resolveChipFolder(remembered, {
      locked: true,
      needsProjectFolder: false,
      projectRoot: FOLDER_A,
    }).remembered
    const glitch = resolveChipFolder(remembered, {
      locked: true,
      needsProjectFolder: false,
      projectRoot: SANDBOX,
    })
    expect(glitch.display).toBe(FOLDER_A)
    expect(glitch.remembered).toBe(FOLDER_A)
    expect(glitch.showOpenCta).toBe(false)
  })

  it('IGNORES a transient needsProjectFolder once locked (no "Open folder…" flash)', () => {
    // A locked session can never legitimately need a folder. If a stray snapshot
    // reports needsProjectFolder=true for it, the chip must NOT flip to the CTA.
    let remembered: string | undefined
    remembered = resolveChipFolder(remembered, {
      locked: false,
      needsProjectFolder: false,
      projectRoot: FOLDER_A,
    }).remembered
    const glitch = resolveChipFolder(remembered, {
      locked: true,
      needsProjectFolder: true, // transient / wrong for a locked session
      projectRoot: SANDBOX,
    })
    expect(glitch.showOpenCta).toBe(false)
    expect(glitch.display).toBe(FOLDER_A)
  })

  it('captures the folder for a session resumed already-locked', () => {
    const first = resolveChipFolder(undefined, {
      locked: true,
      needsProjectFolder: false,
      projectRoot: FOLDER_A,
    })
    expect(first.display).toBe(FOLDER_A)
    expect(first.remembered).toBe(FOLDER_A)
    const glitch = resolveChipFolder(first.remembered, {
      locked: true,
      needsProjectFolder: false,
      projectRoot: SANDBOX,
    })
    expect(glitch.display).toBe(FOLDER_A)
  })

  it('shows the Open-folder CTA for a genuinely unbound (unlocked) session', () => {
    const r = resolveChipFolder(undefined, {
      locked: false,
      needsProjectFolder: true,
      projectRoot: SANDBOX,
    })
    expect(r.showOpenCta).toBe(true)
    expect(r.remembered).toBeUndefined()
  })
})
