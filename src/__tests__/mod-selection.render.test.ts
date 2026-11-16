// @vitest-environment happy-dom
/**
 * The page's half of `$.ui.selection` (F-25): the person's last selection in the
 * thread, the row it lies in, held past a press on a control, dismissed by Escape
 * or a press elsewhere, and answered through the `page` round trip.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ModSelectionTracker } from '../components/assistant-ui/mod-selection'
import { answerPageRequest } from '../components/assistant-ui/use-mod-page'
import { isModsPageAnswerPayload, isModsPageRequest } from '../browser/runtimeProtocol'

afterEach(() => {
  document.body.innerHTML = ''
})

function thread(): HTMLElement {
  document.body.innerHTML = `
    <div class="aui-thread-root" id="root">
      <div data-mod-request-id="toolu_1"><p id="one">npm test passed</p></div>
      <div data-mod-request-id="m2"><p id="two">second row</p></div>
      <button id="act">act</button>
      <span id="plain">plain</span>
    </div>
    <p id="outside">outside</p>`
  return document.getElementById('root')!
}

function select(from: Node, fromOffset: number, to: Node, toOffset: number): Selection {
  const range = document.createRange()
  range.setStart(from, fromOffset)
  range.setEnd(to, toOffset)
  const selection = document.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  return selection
}

describe('the selection tracker', () => {
  it('holds the text and the row it lies in; across rows it has no row', () => {
    const root = thread()
    const tracker = new ModSelectionTracker(() => root, () => 42)
    const one = document.getElementById('one')!.firstChild!
    tracker.selectionChanged(select(one, 0, one, 8))
    expect(tracker.get()).toEqual({ text: 'npm test', requestId: 'toolu_1', at: 42 })
    const two = document.getElementById('two')!.firstChild!
    tracker.selectionChanged(select(one, 4, two, 6))
    expect(tracker.get()?.requestId).toBeUndefined()
    expect(tracker.get()?.text).toContain('test passed')
  })

  it('keeps it when the highlight goes down for a press on a control; Escape or a press elsewhere dismisses it', () => {
    const root = thread()
    const tracker = new ModSelectionTracker(() => root)
    const one = document.getElementById('one')!.firstChild!
    tracker.selectionChanged(select(one, 0, one, 3))
    document.getSelection()!.removeAllRanges()
    tracker.selectionChanged(document.getSelection())
    tracker.pressed(document.getElementById('act'))
    expect(tracker.get()?.text).toBe('npm')
    tracker.keyed('Enter')
    expect(tracker.get()?.text).toBe('npm')
    tracker.keyed('Escape')
    expect(tracker.get()).toBeUndefined()
    tracker.selectionChanged(select(one, 0, one, 3))
    tracker.pressed(document.getElementById('outside'))
    expect(tracker.get()?.text).toBe('npm')
    tracker.pressed(document.getElementById('plain'))
    expect(tracker.get()).toBeUndefined()
  })

  it('a selection in the prompt box is marked as the draft; one in another field is not', () => {
    const root = thread()
    root.insertAdjacentHTML('beforeend', '<div class="aui-composer-root"><textarea id="box">my token abc</textarea></div><textarea id="edit">edit me</textarea>')
    const tracker = new ModSelectionTracker(() => root, () => 7)
    const box = document.getElementById('box') as HTMLTextAreaElement
    box.focus()
    box.setSelectionRange(3, 8)
    tracker.selectionChanged(document.getSelection())
    expect(tracker.get()).toEqual({ text: 'token', at: 7, inPromptBox: true })
    const edit = document.getElementById('edit') as HTMLTextAreaElement
    edit.focus()
    edit.setSelectionRange(0, 4)
    tracker.selectionChanged(document.getSelection())
    expect(tracker.get()).toEqual({ text: 'edit', at: 7 })
  })

  it('a selection outside the thread is not held', () => {
    const root = thread()
    const tracker = new ModSelectionTracker(() => root)
    const outside = document.getElementById('outside')!.firstChild!
    tracker.selectionChanged(select(outside, 0, outside, 3))
    expect(tracker.get()).toBeUndefined()
  })
})

describe('the page answer', () => {
  it('answers the held selection, or none', async () => {
    const request = { requestId: 'p1', op: 'selection' as const }
    expect(isModsPageRequest(request)).toBe(true)
    const held = { get: () => ({ text: 'x', requestId: 'r1', at: 5 }) }
    const answer = await answerPageRequest(request, document, undefined, held)
    expect(answer).toEqual({ requestId: 'p1', op: 'selection', selection: { text: 'x', requestId: 'r1', at: 5 } })
    expect(isModsPageAnswerPayload({ ...answer, sessionId: 's' })).toBe(true)
    expect(await answerPageRequest(request, document, undefined, { get: () => undefined })).toEqual({ requestId: 'p1', op: 'selection' })
    expect(isModsPageAnswerPayload({ sessionId: 's', requestId: 'p1', op: 'selection', selection: { text: 'x' } })).toBe(false)
  })
})
