import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  CollapsibleUserMessageText,
  USER_MESSAGE_COLLAPSED_PREVIEW_LINES,
  USER_MESSAGE_MAX_DISPLAY_LINES,
  USER_MESSAGE_WRAP_COLUMNS,
  buildCollapsedUserMessageText,
  getCollapsibleUserMessageText,
  shouldCollapseUserMessageText,
} from '../components/assistant-ui/user-message-text'

function lines(count: number, prefix = 'line'): string {
  return Array.from({ length: count }, (_, i) => `${prefix}-${i + 1}`).join('\n')
}

function longMessage() {
  const totalLines = USER_MESSAGE_MAX_DISPLAY_LINES + 5
  const text = lines(totalLines)
  return { text, totalLines }
}

describe('user message text collapse', () => {
  it('does not collapse text at or below the line threshold', () => {
    const text = lines(USER_MESSAGE_MAX_DISPLAY_LINES)

    expect(shouldCollapseUserMessageText(text)).toBe(false)
    expect(buildCollapsedUserMessageText(text)).toBeNull()

    const html = renderToStaticMarkup(
      createElement(CollapsibleUserMessageText, { text }),
    )
    expect(html).toContain('data-role="user-message-text"')
    expect(html).not.toContain('Show full message')
  })

  it('renders a head preview with a toggle for text over the line threshold', () => {
    const { text, totalLines } = longMessage()
    const hiddenLines = totalLines - USER_MESSAGE_COLLAPSED_PREVIEW_LINES

    const collapsed = buildCollapsedUserMessageText(text)
    expect(collapsed).not.toBeNull()
    expect(collapsed?.hiddenLineCount).toBe(hiddenLines)

    const html = renderToStaticMarkup(
      createElement(CollapsibleUserMessageText, { text }),
    )
    expect(html).toContain('data-role="user-message-collapsible"')
    expect(html).toContain('line-1')
    expect(html).toContain(`line-${USER_MESSAGE_COLLAPSED_PREVIEW_LINES}`)
    // The hidden-line count is merged into the single right-aligned toggle
    // ("Show full message (N more lines)") — no separate "… N lines hidden …"
    // label anymore.
    expect(html).toContain(`Show full message (${hiddenLines} more lines)`)
    expect(html).not.toContain('lines hidden')
    expect(html).toContain('flex justify-end')
    // The preview keeps only the first N lines — nothing past them.
    expect(html).not.toContain(`line-${USER_MESSAGE_COLLAPSED_PREVIEW_LINES + 1}`)
    expect(html).not.toContain(`line-${totalLines}`)
    expect(html).not.toContain('Show less')
  })

  it('renders the full text when expanded', () => {
    const { text, totalLines } = longMessage()

    const html = renderToStaticMarkup(
      createElement(CollapsibleUserMessageText, { text, defaultExpanded: true }),
    )
    expect(html).toContain('data-role="user-message-full"')
    expect(html).toContain(`line-${totalLines}`)
    expect(html).toContain('Show less')
    expect(html).not.toContain('Show full message')
    // The collapse control stays right-aligned in the expanded state too.
    expect(html).toContain('flex justify-end')
  })

  it('collapses a few long paragraphs that wrap past the threshold', () => {
    // Regression for "Show full never appears on a long paste": a review of
    // 20 paragraphs (19 newlines, ~3,300 characters) rendered as ~45 rows,
    // but the threshold counted newlines only, so it never collapsed. Here:
    // as many paragraphs as the threshold allows lines, two display lines each.
    const paragraph = (n: number) =>
      `para-${n} ${'word '.repeat(40)}`.slice(0, USER_MESSAGE_WRAP_COLUMNS * 2)
    const text = Array.from(
      { length: USER_MESSAGE_MAX_DISPLAY_LINES },
      (_, i) => paragraph(i + 1),
    ).join('\n')
    // The label counts REAL lines: the 7 paragraphs not in the preview, not
    // the 14 estimated rows they wrap into.
    const hidden = USER_MESSAGE_MAX_DISPLAY_LINES - 5

    expect(shouldCollapseUserMessageText(text)).toBe(true)
    const collapsed = buildCollapsedUserMessageText(text)
    // The 10-line preview is the first five two-line paragraphs, whole.
    expect(collapsed?.head.split('\n')).toHaveLength(5)
    expect(collapsed?.head).toContain('para-5')
    expect(collapsed?.head).not.toContain('para-6')
    expect(collapsed?.hiddenLineCount).toBe(hidden)

    const html = renderToStaticMarkup(
      createElement(CollapsibleUserMessageText, { text }),
    )
    expect(html).toContain('data-role="user-message-collapsible"')
    expect(html).toContain(`Show full message (${hidden} more lines)`)
  })

  it('reports a single cut line as one more line, in the singular', () => {
    // One unbroken ~3,600-column line: the preview shows part of it. The
    // estimate says ~35 more ROWS; the label says what it can know — the
    // rest of one line — and says it in the singular.
    const text = 'lorem ipsum '.repeat(300).trim()
    expect(buildCollapsedUserMessageText(text)?.hiddenLineCount).toBe(1)
    const html = renderToStaticMarkup(
      createElement(CollapsibleUserMessageText, { text }),
    )
    expect(html).toContain('Show full message (1 more line)')
    expect(html).not.toContain('more lines')
  })

  it('counts a tab up to the next 8-column tab stop', () => {
    // 12 lines of ten tabs + a word: 80+ columns each under
    // whitespace-pre-wrap's tab-size 8, so two rows each — past the
    // threshold. Counted as one column per tab they were 15 columns and
    // never collapsed.
    const tabbed = Array.from(
      { length: USER_MESSAGE_MAX_DISPLAY_LINES },
      (_, i) => `${'\t'.repeat(10)}w${i}`,
    ).join('\n')
    expect(shouldCollapseUserMessageText(tabbed)).toBe(true)
    // A tab after text only reaches the next stop: 'abc' + tab = 8 columns,
    // so ten of those are exactly 80 columns — one row each, no collapse.
    const aligned = Array.from(
      { length: USER_MESSAGE_MAX_DISPLAY_LINES },
      () => 'abc\t'.repeat(10),
    ).join('\n')
    expect(shouldCollapseUserMessageText(aligned)).toBe(false)
  })

  it('collapses past 12 display lines', () => {
    expect(USER_MESSAGE_MAX_DISPLAY_LINES).toBe(12)
    expect(shouldCollapseUserMessageText(lines(12))).toBe(false)
    expect(shouldCollapseUserMessageText(lines(13))).toBe(true)
  })

  it('cuts a single unbroken line inside it, at a word, with an ellipsis', () => {
    const text = 'lorem ipsum '.repeat(300).trim() // one line, ~3,600 columns

    const collapsed = buildCollapsedUserMessageText(text)
    expect(collapsed).not.toBeNull()
    const head = collapsed!.head
    expect(head.endsWith('…')).toBe(true)
    expect(head).not.toContain('\n')
    expect(head.length - 1).toBeLessThanOrEqual(
      USER_MESSAGE_COLLAPSED_PREVIEW_LINES * USER_MESSAGE_WRAP_COLUMNS,
    )
    // Pulled back to a word boundary: no half word before the ellipsis.
    expect(head.slice(0, -1)).toMatch(/(lorem|ipsum)$/)
  })

  it('counts wide characters as two columns', () => {
    // 45 CJK characters = 90 columns = 2 display lines each, so a threshold's
    // worth of such lines is twice the threshold in display lines.
    const count = USER_MESSAGE_MAX_DISPLAY_LINES
    const wide = '如'.repeat(45)
    const text = Array.from({ length: count }, () => wide).join('\n')
    expect(shouldCollapseUserMessageText(text)).toBe(true)
    // The same count of ASCII characters fits one line each and stays put.
    const narrow = Array.from({ length: count }, () => 'x'.repeat(45)).join('\n')
    expect(shouldCollapseUserMessageText(narrow)).toBe(false)
  })

  it('opts a single-text-part message into the custom renderer', () => {
    const { text } = longMessage()

    // Regression for the "Show full/less never appears" bug: the adapter
    // delivers user content as `[{ type: 'text', text }]`, which previously
    // returned null and bypassed the collapse entirely.
    expect(getCollapsibleUserMessageText(text)).toBe(text)
    expect(
      getCollapsibleUserMessageText([{ type: 'text', text }]),
    ).toBe(text)
  })

  it('ignores multi-part and non-text messages', () => {
    const { text } = longMessage()

    expect(
      getCollapsibleUserMessageText([
        { type: 'text', text },
        { type: 'text', text: 'second' },
      ]),
    ).toBeNull()
    expect(
      getCollapsibleUserMessageText([{ type: 'image', image: 'x' }]),
    ).toBeNull()
    expect(getCollapsibleUserMessageText(undefined)).toBeNull()
    expect(getCollapsibleUserMessageText([])).toBeNull()
  })

  it('constrains long unbroken text so the bubble cannot overflow the chat width', () => {
    // Regression for the width-overflow bug: a pasted paragraph with a long
    // unbroken token (CJK run / URL) must carry `wrap-break-word` + `min-w-0`
    // on every container (plain, preview, expanded) so it wraps inside the
    // bubble instead of stretching past the chat max width.
    const short = renderToStaticMarkup(
      createElement(CollapsibleUserMessageText, { text: 'hi' }),
    )
    expect(short).toContain('wrap-break-word')
    expect(short).toContain('min-w-0')

    const { text } = longMessage()
    const collapsed = renderToStaticMarkup(
      createElement(CollapsibleUserMessageText, { text }),
    )
    expect(collapsed).toContain('wrap-break-word')

    const expanded = renderToStaticMarkup(
      createElement(CollapsibleUserMessageText, { text, defaultExpanded: true }),
    )
    expect(expanded).toContain('wrap-break-word')
  })
})
