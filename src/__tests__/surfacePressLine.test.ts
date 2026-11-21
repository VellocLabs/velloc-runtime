/**
 * The line a surface's presses wait in (F-40): one delivery at a time, in
 * press order; a failed delivery does not stop the line; `clear` discards
 * only what still waits.
 */
import { describe, expect, it, vi } from 'vitest'

import { createSurfacePressLine } from '../browser/webview/a2ui/surfacePressLine'

function gate() {
  let open!: () => void
  const promise = new Promise<void>(resolve => { open = resolve })
  return { promise, open }
}

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0))

describe('the surface press line', () => {
  it('delivers a press at once when none is being answered, and the next only after the answer', async () => {
    const gates = [gate(), gate()]
    const seen: string[] = []
    const line = createSurfacePressLine<string>(press => {
      seen.push(press)
      return gates[seen.length - 1]?.promise
    })
    line.press('save')
    line.press('test')
    line.press('reset')
    expect(seen).toEqual(['save'])
    expect(line.waiting()).toBe(2)
    gates[0]!.open()
    await settle()
    expect(seen).toEqual(['save', 'test'])
    gates[1]!.open()
    await settle()
    expect(seen).toEqual(['save', 'test', 'reset'])
    expect(line.waiting()).toBe(0)
  })

  it('a delivery with no answer to wait for lets the next go at once', () => {
    const seen: string[] = []
    const line = createSurfacePressLine<string>(press => {
      seen.push(press)
    })
    line.press('a')
    line.press('b')
    expect(seen).toEqual(['a', 'b'])
  })

  it('a delivery that rejects or throws does not stop the line', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const seen: string[] = []
    const line = createSurfacePressLine<string>(press => {
      seen.push(press)
      if (press === 'rejects') return Promise.reject(new Error('no answer'))
      if (press === 'throws') throw new Error('broken')
    })
    line.press('rejects')
    line.press('throws')
    line.press('after')
    await settle()
    expect(seen).toEqual(['rejects', 'throws', 'after'])
    error.mockRestore()
  })

  it('clear discards the presses waiting and leaves the one being answered', async () => {
    const first = gate()
    const seen: string[] = []
    const line = createSurfacePressLine<string>(press => {
      seen.push(press)
      return seen.length === 1 ? first.promise : undefined
    })
    line.press('save')
    line.press('test')
    line.clear()
    first.open()
    await settle()
    line.press('later')
    expect(seen).toEqual(['save', 'later'])
  })
})
