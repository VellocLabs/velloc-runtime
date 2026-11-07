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
    const good = reply(block(FORM))
    expect(await check({ messages: [good], assistantMessages: [good] })).toEqual([])
  })
})
