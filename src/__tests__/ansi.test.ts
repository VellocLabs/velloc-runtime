import { describe, expect, it } from 'vitest'
import { stripAnsiControlSequences } from '../utils/ansi'

describe('stripAnsiControlSequences', () => {
  it('removes SGR color escapes from Vitest-style output', () => {
    const raw = '\u001b[1m\u001b[46m RUN \u001b[49m\u001b[22m \u001b[36mv4.1.2 \u001b[39m\u001b[90mD:/work/repo/app\u001b[39m'

    expect(stripAnsiControlSequences(raw)).toBe(
      ' RUN  v4.1.2 D:/work/repo/app',
    )
  })

  it('removes OSC title and other non-SGR control sequences', () => {
    const raw = '\u001b]0;test-title\u0007done\u001b[?25l'

    expect(stripAnsiControlSequences(raw)).toBe('done')
  })
})
