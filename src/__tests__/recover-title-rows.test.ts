/**
 * extractRecoveredTitleRows — the transcript scan that brings the drawer's
 * session-title namer rows back after an app restart. Input is the raw
 * transcript the manager reads from disk: `ai-title` entries among messages.
 */
import { describe, expect, it } from 'vitest'
import {
  extractRecoveredTitleRows,
  MAX_RECOVERED_TITLE_ROWS,
} from '../browser/worker/recoverTitleRows'

function titleEntry(aiTitle: unknown, updatedAt: unknown): unknown {
  return { type: 'ai-title', sessionId: 'S1', aiTitle, updatedAt }
}

const message = {
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
}

describe('extractRecoveredTitleRows', () => {
  it('turns each stored title into a row, oldest first', () => {
    const rows = extractRecoveredTitleRows(
      'S1',
      [message, titleEntry('Draft', 100), message, titleEntry('  Final  ', 200)],
      1_000,
    )
    expect(rows).toEqual([
      { taskId: 'recovered-title:S1:0', title: 'Draft', storedAt: 100 },
      { taskId: 'recovered-title:S1:1', title: 'Final', storedAt: 200 },
    ])
  })

  it('leaves out titles stored during this lifetime, keeping the other ids stable', () => {
    const rows = extractRecoveredTitleRows(
      'S1',
      [titleEntry('Old', 100), titleEntry('New', 1_000), titleEntry('Newer', 1_500)],
      1_000,
    )
    expect(rows.map(row => row.taskId)).toEqual(['recovered-title:S1:0'])
  })

  it('skips blank titles and entries without a numeric time', () => {
    const rows = extractRecoveredTitleRows(
      'S1',
      [titleEntry('   ', 100), titleEntry('No time', '2026-01-01'), titleEntry(42, 100), null, 'x'],
      1_000,
    )
    expect(rows).toEqual([])
  })

  it('keeps ids distinct across sessions', () => {
    const a = extractRecoveredTitleRows('A', [titleEntry('T', 1)], 10)
    const b = extractRecoveredTitleRows('B', [titleEntry('T', 1)], 10)
    expect(a[0]!.taskId).not.toBe(b[0]!.taskId)
  })

  it('keeps only the most recent titles', () => {
    const entries = Array.from({ length: MAX_RECOVERED_TITLE_ROWS + 5 }, (_, i) =>
      titleEntry(`T${i}`, i),
    )
    const rows = extractRecoveredTitleRows('S1', entries, 10_000)
    expect(rows).toHaveLength(MAX_RECOVERED_TITLE_ROWS)
    expect(rows[0]!.title).toBe('T5')
    expect(rows.at(-1)!.title).toBe(`T${MAX_RECOVERED_TITLE_ROWS + 4}`)
  })
})
