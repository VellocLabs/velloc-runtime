import { describe, expect, it } from 'vitest'

import { resolveFloatingScrollButton } from '../components/assistant-ui/run-status-row'

const base = {
  runRowInView: null,
  isAtBottom: true,
  collapseOffered: false,
  canCollapseAll: true,
} as const

describe('resolveFloatingScrollButton', () => {
  it('shows nothing at the bottom of a settled conversation', () => {
    expect(resolveFloatingScrollButton(base)).toBeNull()
  })

  it('offers scroll-to-bottom once a settled conversation leaves its end', () => {
    expect(resolveFloatingScrollButton({ ...base, isAtBottom: false })).toBe('scroll')
  })

  it('paints the run animation while the run status row is out of view', () => {
    expect(resolveFloatingScrollButton({ ...base, runRowInView: false, isAtBottom: false })).toBe('run')
    expect(
      resolveFloatingScrollButton({ ...base, runRowInView: false, isAtBottom: false, collapseOffered: true }),
    ).toBe('run')
  })

  it('stays hidden during a run while the status row is visible, even short of the end', () => {
    expect(resolveFloatingScrollButton({ ...base, runRowInView: true, isAtBottom: false })).toBeNull()
  })

  it('becomes Collapse all after scrolling to the end, while the offer lasts', () => {
    expect(resolveFloatingScrollButton({ ...base, collapseOffered: true })).toBe('collapse')
    expect(resolveFloatingScrollButton({ ...base, runRowInView: true, collapseOffered: true })).toBe('collapse')
  })

  it('never offers Collapse all on an empty conversation', () => {
    expect(resolveFloatingScrollButton({ ...base, collapseOffered: true, canCollapseAll: false })).toBeNull()
  })
})
