import { describe, expect, it } from 'vitest'
import type { Message } from '../runtime/RuntimeTypes'
import {
  createA2uiTurnEndCheck,
  describeA2uiBlockFailures,
  findA2uiBlockFailures,
} from '../toolkit/builtin/a2ui/express/a2uiReplyCheck'

let seq = 0
const reply = (text: string): Message =>
  ({
    type: 'assistant',
    uuid: `m${++seq}`,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  }) as unknown as Message
const block = (body: string) => `<a2ui>\n${body}\n</a2ui>`
const FORM = 'surface("contact")\nroot = Column([CheckBox("Agree", $/agree)])\n$/agree = false'

describe('findA2uiBlockFailures', () => {
  it('passes a reply with good blocks or none', async () => {
    expect(await findA2uiBlockFailures([], [reply('plain text')])).toEqual([])
    expect(await findA2uiBlockFailures([], [reply(block(FORM))])).toEqual([])
  })

  it('reports each block that does not compile, with its surface', async () => {
    const failures = await findA2uiBlockFailures([], [
      reply(`${block(FORM)}\n${block('surface("broken")\nroot = CheckBox("Agree")')}`),
    ])
    expect(failures).toEqual([
      { index: 2, surfaceIds: ['broken'], message: expect.stringContaining("missing required property 'value'") },
    ])
  })

  it('reports a block left open', async () => {
    const [failure] = await findA2uiBlockFailures([], [reply('<a2ui>\nsurface("x")\nroot = Text("a")')])
    expect(failure.message).toContain('</a2ui>')
  })

  it('accepts an update to a surface an earlier reply drew', async () => {
    const history = [reply(block(FORM))]
    expect(await findA2uiBlockFailures(history, [reply(block('surface("contact")\n$/agree = true'))])).toEqual([])
  })

  it('accepts a block that redraws a surface an earlier reply drew, root and all', async () => {
    const history = [reply(block(FORM))]
    const redraw = 'surface("contact")\nroot = Column([CheckBox("Agree", $/agree), Text("Thanks")])'
    expect(await findA2uiBlockFailures(history, [reply(block(redraw))])).toEqual([])
  })

  it('quotes the line an error names, from the column it names', async () => {
    const body = 'surface("board")\n$/metrics = {count: "87"}\nroot = Card(m1)\nm1 = Metric("Count", $/metrics.count)'
    const [failure] = await findA2uiBlockFailures([], [reply(block(body))])
    expect(failure.message).toContain('line 4:')
    expect(failure.at).toEqual({ line: 4, text: 'm1 = Metric("Count", $/metrics.count)', from: '.count)' })
    const note = describeA2uiBlockFailures([failure])
    expect(note).toContain('  Line 4 of that block is: m1 = Metric("Count", $/metrics.count)')
    expect(note).toContain('  The error is where this text starts: .count)')
  })

  it('quotes nothing for an error that names no line', async () => {
    const [failure] = await findA2uiBlockFailures([], [reply(block('surface("broken")\nroot = CheckBox("Agree")'))])
    expect(failure.at).toBeUndefined()
    expect(describeA2uiBlockFailures([failure])).not.toContain('Line ')
  })
})

describe('createA2uiTurnEndCheck', () => {
  const note = (text: string) => ({ type: 'user', isMeta: true, text }) as unknown as Message

  it('returns one note naming the failures, and nothing for a good reply', async () => {
    const check = createA2uiTurnEndCheck(note)
    const bad = reply(block('surface("s")\nroot = Card()'))
    const [row] = await check({ messages: [bad], assistantMessages: [bad] })
    expect((row as unknown as { text: string }).text).toBe(
      describeA2uiBlockFailures(await findA2uiBlockFailures([], [bad])),
    )
    expect((row as unknown as { text: string }).text).toContain('Block 1 (surface "s")')
    // A failed update keeps the statements before the error, so the note never
    // promises a clean slate; resending the whole block must stay safe.
    expect((row as unknown as { text: string }).text).toContain('may already be applied')
    expect((row as unknown as { text: string }).text).toContain('sending the whole corrected block again is safe')
    expect((row as unknown as { text: string }).text).not.toContain('Nothing of')
    const good = reply(block(FORM))
    expect(await check({ messages: [good], assistantMessages: [good] })).toEqual([])
  })
})
