// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeClipboard, writeClipboardWhenFocused } from '../utils/clipboard'

/**
 * `writeClipboard`, the shared copy util: uses `navigator.clipboard` when available, falls back to the
 * `execCommand` textarea path when it rejects or is absent, and reports success honestly.
 */

describe('writeClipboard', () => {
  let clipboardSpy: ReturnType<typeof vi.fn>
  let execSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    clipboardSpy = vi.fn()
    execSpy = vi.fn()
    // happy-dom ships a real `Clipboard` whose `writeText` rejects without
    // a permission grant, so stub it deterministically for every test.
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: clipboardSpy },
      configurable: true,
    })
    Object.defineProperty(document, 'execCommand', {
      value: execSpy,
      configurable: true,
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses navigator.clipboard.writeText when available and resolves true', async () => {
    clipboardSpy.mockResolvedValue(undefined)
    const ok = await writeClipboard('hello')
    expect(ok).toBe(true)
    expect(clipboardSpy).toHaveBeenCalledWith('hello')
    expect(execSpy).not.toHaveBeenCalled()
  })

  it('falls back to execCommand when navigator.clipboard.writeText rejects', async () => {
    clipboardSpy.mockRejectedValue(new Error('clipboard denied'))
    execSpy.mockReturnValue(true)
    const ok = await writeClipboard('fallback')
    expect(ok).toBe(true)
    expect(clipboardSpy).toHaveBeenCalledWith('fallback')
    expect(execSpy).toHaveBeenCalled()
  })

  it('falls back to execCommand when navigator.clipboard is absent', async () => {
    // Simulate a context with no clipboard API at all (old webview).
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    execSpy.mockReturnValue(true)
    const ok = await writeClipboard('no-api')
    expect(ok).toBe(true)
    expect(execSpy).toHaveBeenCalled()
  })

  it('on the insecure path (no navigator.clipboard) the execCommand copy runs inside the caller\'s task', async () => {
    // The http://<LAN IP> remote page: no clipboard API at all, so only the
    // textarea path can copy, and execCommand is gated on transient user
    // activation. writeClipboard must reach execCommand in the SAME task the
    // click handler called it in — before any continuation of its own — so the
    // gesture still counts. (The regression class here is deferring the
    // fallback behind an await and having the browser refuse it.)
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    const order: string[] = []
    execSpy.mockImplementation(() => { order.push('exec'); return true })
    const pending = writeClipboard('sync-fallback')
    order.push('caller-resumed')
    expect(order).toEqual(['exec', 'caller-resumed'])
    await expect(pending).resolves.toBe(true)
  })

  it('removes the fallback textarea even when execCommand throws (no leftover node, honest false)', async () => {
    // A throwing execCommand must not strand the hidden textarea in the DOM
    // nor propagate — the caller still gets a clean \'false\' to render its
    // failure state on. (The old code only removed the node on the success
    // path, leaking one per failed copy.)
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    execSpy.mockImplementation(() => { throw new Error('execCommand refused') })
    const ok = await writeClipboard('throws')
    expect(ok).toBe(false)
    expect(document.body.querySelector('textarea')).toBeNull()
  })

  it('reports false when both write paths fail (no false "copied" state)', async () => {
    clipboardSpy.mockRejectedValue(new Error('denied'))
    execSpy.mockReturnValue(false)
    const ok = await writeClipboard('fail')
    expect(ok).toBe(false)
  })

  it('cleans up the fallback textarea after execCommand', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    execSpy.mockReturnValue(true)
    const appendSpy = vi.spyOn(document.body, 'appendChild')
    const removeSpy = vi.spyOn(HTMLTextAreaElement.prototype, 'remove')
    await writeClipboard('cleanup')
    expect(appendSpy).toHaveBeenCalled()
    expect(removeSpy).toHaveBeenCalled()
  })

  it('does not create a fallback textarea when the modern API succeeds', async () => {
    clipboardSpy.mockResolvedValue(undefined)
    const appendSpy = vi.spyOn(document.body, 'appendChild')
    await writeClipboard('modern')
    expect(appendSpy).not.toHaveBeenCalled()
  })

  it("the fallback puts back the person's focus and caret (a mod's copy lands while they type)", async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    execSpy.mockReturnValue(true)
    const box = document.createElement('textarea')
    box.value = 'half a sentence'
    document.body.appendChild(box)
    box.focus()
    box.setSelectionRange(4, 6)
    expect(await writeClipboard('copied')).toBe(true)
    expect(document.activeElement).toBe(box)
    expect([box.selectionStart, box.selectionEnd]).toEqual([4, 6])
    box.remove()
  })
})

/**
 * `writeClipboardWhenFocused` — the last of `$.ui.copy`'s page paths (F-25):
 * `writeText` rejects in a document without focus, and a mod's copy can
 * land while the person is in another window. It waits, bounded, for the
 * focus, then writes.
 */
describe('writeClipboardWhenFocused', () => {
  let clipboardSpy: ReturnType<typeof vi.fn>
  beforeEach(() => {
    clipboardSpy = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: clipboardSpy }, configurable: true })
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('focused already: writes at once', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    expect(await writeClipboardWhenFocused('now', 1_000)).toBe(true)
    expect(clipboardSpy).toHaveBeenCalledWith('now')
  })

  it('unfocused: writes when the focus comes back', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    const pending = writeClipboardWhenFocused('later', 1_000)
    expect(clipboardSpy).not.toHaveBeenCalled()
    window.dispatchEvent(new Event('focus'))
    expect(await pending).toBe(true)
    expect(clipboardSpy).toHaveBeenCalledWith('later')
  })

  it('the focus never coming back, a rejected write, or no API: false, never a throw', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    expect(await writeClipboardWhenFocused('never', 20)).toBe(false)
    expect(clipboardSpy).not.toHaveBeenCalled()
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    clipboardSpy.mockRejectedValue(new Error('denied'))
    expect(await writeClipboardWhenFocused('x', 20)).toBe(false)
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    expect(await writeClipboardWhenFocused('x', 20)).toBe(false)
  })
})
