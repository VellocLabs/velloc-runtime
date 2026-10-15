import { describe, expect, it } from 'vitest'
import {
  PLAIN_STYLE_ID,
  REPLY_STYLE_TABLE,
  replyStyleFor,
  resolveOutputStyleSection,
} from '../prompting/responseStyles'

describe('reply styles', () => {
  it('exposes the built-in styles (default is null, Explanatory + Learning configured)', () => {
    expect(REPLY_STYLE_TABLE[PLAIN_STYLE_ID]).toBeNull()
    expect(REPLY_STYLE_TABLE.Explanatory?.name).toBe('Explanatory')
    expect(REPLY_STYLE_TABLE.Learning?.name).toBe('Learning')
  })

  it('replyStyleFor resolves built-in styles and falls back to null', () => {
    expect(replyStyleFor('Explanatory')?.name).toBe('Explanatory')
    expect(replyStyleFor('Learning')?.name).toBe('Learning')
    // default / absent / unknown all resolve to "no style".
    expect(replyStyleFor('default')).toBeNull()
    expect(replyStyleFor(undefined)).toBeNull()
    expect(replyStyleFor('Nonexistent')).toBeNull()
  })

  it('names inherited from Object.prototype are not styles', () => {
    for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(replyStyleFor(name)).toBeNull()
      expect(resolveOutputStyleSection(name)).toBeNull()
    }
  })

  it('resolveOutputStyleSection renders the "# Reply style:" block for a style', () => {
    const explanatory = resolveOutputStyleSection('Explanatory')
    expect(explanatory).toContain('# Reply style: Explanatory')
    expect(explanatory).toContain('## Note format') // the frame both styles share
    const learning = resolveOutputStyleSection('Learning')
    expect(learning).toContain('# Reply style: Learning')
    expect(learning).toContain('## Note format')
    expect(learning).toContain('TODO(human)')
    expect(learning).toContain('**Your turn**')
  })

  it('both styles keep the base coding guidance', () => {
    expect(REPLY_STYLE_TABLE.Explanatory?.retainBaseGuidance).toBe(true)
    expect(REPLY_STYLE_TABLE.Learning?.retainBaseGuidance).toBe(true)
  })

  it('resolveOutputStyleSection returns null for default / absent / unknown', () => {
    expect(resolveOutputStyleSection('default')).toBeNull()
    expect(resolveOutputStyleSection(undefined)).toBeNull()
    expect(resolveOutputStyleSection('bogus')).toBeNull()
  })
})
