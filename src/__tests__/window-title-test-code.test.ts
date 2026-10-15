// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The e2e test-code prefix on the window title (G-2). Load-bearing: with no code set the helper returns its input
 * byte for byte, including the empty string (the wire-level "clear" signal).
 */

// The store is gated on the e2e trace flag, so every test controls it.
vi.mock('../browser/bridge/tracer', () => ({
  isBridgeTraceEnabled: () => traceEnabled,
}))

let traceEnabled = false

const mod = async () => {
  vi.resetModules()
  return import('../browser/webview/windowTitle')
}

beforeEach(() => {
  traceEnabled = false
  window.history.replaceState({}, '', '/')
})

describe('applyE2eTestCodePrefix', () => {
  it('is the identity function when there is no code (production)', async () => {
    const { applyE2eTestCodePrefix } = await mod()
    expect(applyE2eTestCodePrefix('My session', '')).toBe('My session')
    // The empty string is the wire-level "clear the title" signal — it must
    // survive untouched, or the host would stop falling back to the bare
    // product name.
    expect(applyE2eTestCodePrefix('', '')).toBe('')
  })

  it('prefixes the code in brackets when one is set', async () => {
    const { applyE2eTestCodePrefix } = await mod()
    expect(applyE2eTestCodePrefix('My session', 'F-11-E007')).toBe(
      '[F-11-E007] My session',
    )
  })

  it('shows the code alone before the session has a title', async () => {
    const { applyE2eTestCodePrefix } = await mod()
    // A fresh session has no title until generation lands; the window still has
    // to be identifiable from the first frame.
    expect(applyE2eTestCodePrefix('', 'F-11-E007')).toBe('[F-11-E007]')
  })

  it('composes with formatWindowTitle the way the host composes the native title', async () => {
    const { applyE2eTestCodePrefix, formatWindowTitle } = await mod()
    expect(
      formatWindowTitle(
        applyE2eTestCodePrefix('My session', 'P-4-E005'),
        'Velloc',
      ),
    ).toBe('[P-4-E005] My session - Velloc')
  })
})

describe('the test-code store', () => {
  it('stays empty and unsettable without the e2e trace flag', async () => {
    const { getE2eTestCode, setE2eTestCode } = await mod()
    setE2eTestCode('F-11-E007')
    expect(getE2eTestCode()).toBe('')
  })

  it('reads the code from ?e2eTestCode= when tracing is on', async () => {
    traceEnabled = true
    window.history.replaceState({}, '', '/?e2eTrace=1&e2eTestCode=F-11-E007')
    const { getE2eTestCode } = await mod()
    expect(getE2eTestCode()).toBe('F-11-E007')
  })

  it('ignores ?e2eTestCode= when tracing is off', async () => {
    window.history.replaceState({}, '', '/?e2eTestCode=F-11-E007')
    const { getE2eTestCode } = await mod()
    expect(getE2eTestCode()).toBe('')
  })

  it('lets the harness replace the boot code and notifies subscribers', async () => {
    traceEnabled = true
    window.history.replaceState({}, '', '/?e2eTrace=1&e2eTestCode=F-11-E007')
    const { getE2eTestCode, setE2eTestCode, subscribeE2eTestCode } = await mod()
    const seen: string[] = []
    const unsubscribe = subscribeE2eTestCode(() => seen.push(getE2eTestCode()))
    // This is the shared-browser case: one chrome serves a whole spec file, so
    // the boot param names only its first test and the harness re-stamps per
    // test. The subscriber is what re-renders the title.
    setE2eTestCode('F-11-E008')
    expect(getE2eTestCode()).toBe('F-11-E008')
    expect(seen).toEqual(['F-11-E008'])
    // Same code again must not churn a render.
    setE2eTestCode('F-11-E008')
    expect(seen).toEqual(['F-11-E008'])
    unsubscribe()
    setE2eTestCode('F-11-E009')
    expect(seen).toEqual(['F-11-E008'])
    expect(getE2eTestCode()).toBe('F-11-E009')
  })

  it('does not let a late URL read clobber a code the harness already set', async () => {
    traceEnabled = true
    window.history.replaceState({}, '', '/?e2eTrace=1&e2eTestCode=F-11-E007')
    const { getE2eTestCode, setE2eTestCode } = await mod()
    // setE2eTestCode before any read: the lazy URL read must happen first and
    // then lose, not run afterwards and win.
    setE2eTestCode('F-11-E099')
    expect(getE2eTestCode()).toBe('F-11-E099')
  })
})
