// @vitest-environment happy-dom
/** The terminal theme follows `<html>` live (F-31): a colour change in the same scheme repaints, not only a scheme flip. */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { watchDocumentTheme, type TerminalTheme } from '@/browser/webview/terminal/xtermTheme'

const inlineToken = (token: string, doc: Document): string | null =>
  doc.documentElement.style.getPropertyValue(token).trim() || null

const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

describe('watchDocumentTheme', () => {
  const root = document.documentElement
  let release: () => void = () => {}

  afterEach(() => {
    release()
    root.removeAttribute('style')
    root.className = ''
  })

  it('reports new card colours written inline in the same scheme', async () => {
    root.style.setProperty('--card', '#101010')
    const seen: TerminalTheme[] = []
    release = watchDocumentTheme(theme => seen.push(theme), document, inlineToken)

    root.style.setProperty('--card', '#203040')
    root.style.setProperty('--card-foreground', '#fafafa')
    await flush()

    expect(seen.at(-1)?.background).toBe('#203040')
    expect(seen.at(-1)?.foreground).toBe('#fafafa')
  })

  it('reports a scheme flip with the other palette', async () => {
    const seen: TerminalTheme[] = []
    release = watchDocumentTheme(theme => seen.push(theme), document, inlineToken)
    const before = seen.length

    root.classList.add('dark')
    await flush()

    expect(seen.length).toBe(before + 1)
    expect(seen.at(-1)?.red).toBe('#e5635c')
  })

  it('stays quiet when a mutation leaves the theme unchanged', async () => {
    const onChange = vi.fn()
    release = watchDocumentTheme(onChange, document, inlineToken)

    root.classList.add('unrelated')
    root.style.setProperty('--other', '#123456')
    await flush()

    expect(onChange).not.toHaveBeenCalled()
  })
})
