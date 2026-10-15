/**
 * `prompt.edit` (F-25): the runtime raising it for an edit the page asks about, the
 * wire payload, and the page's pump that holds each edit through the runtime — one
 * ask at a time, a burst folded, a slow ask landing as typed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isModsPromptEditPayload, isModsUiState, type ModsPromptEdit } from '../browser/runtimeProtocol'
import { modsComposerControls } from '../browser/webview/mods/modsUiView'
import type { RuntimeConnection } from '../browser/runtimeClient/RuntimeConnection'
import {
  PromptEditPump,
  foldEdits,
  spliceOf,
  type EditorState,
  type PromptEditBox,
} from '../components/assistant-ui/mod-prompt-edit'
import { pageEditOf, promptEditKeyOf } from '../components/assistant-ui/use-mod-composer'
import { applyPromptEdit } from '../mods/modPromptEdit'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'

const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
  vi.useRealTimers()
})

function world(modules: Record<string, string>) {
  const reports: string[] = []
  const refs: ModModuleRef[] = Object.keys(modules).map(plugin => ({ plugin, path: `/plugins/${plugin}/hooks/register.js` }))
  const runtime = new ModRuntime({
    modules: refs,
    readModule: async path => modules[path.split('/')[2]!]!,
    openWorker: async (): Promise<ModWorkerHandle> => {
      const channel = new MessageChannel()
      open.push(channel.port1, channel.port2)
      installModWorkerHost(channel.port2)
      let settle!: (closed: { reason: 'closed' | 'crashed' }) => void
      const closed = new Promise<{ reason: 'closed' | 'crashed' }>(resolve => {
        settle = resolve
      })
      return { port: channel.port1, closed, close: () => settle({ reason: 'closed' }) }
    },
    session: { id: () => 's', cwd: () => '/work/project' },
    report: line => reports.push(line),
  })
  runtimes.push(runtime)
  return { runtime, reports }
}

const typed = (text: string, at: number, inputText: string, key?: string): ModsPromptEdit => ({
  ...(key !== undefined ? { key: { key } } : {}),
  text,
  cursor: at,
  start: at,
  end: at,
  inputText,
})

/** A digit typed into an empty box picks a draft; `0` is consumed. */
const PICKER = `
  export function register(on) {
    on('prompt.edit', async ($, e, next) => {
      if (!e.key || e.text !== '' || !/^[0-9]$/.test(e.inputText)) return next(e)
      if (e.inputText === '0') return { text: '', cursor: 0 }
      return next({ ...e, inputText: 'draft ' + e.inputText })
    })
  }
`

describe('the runtime raises prompt.edit', () => {
  it('a module hooking it loads, and the ui state says edits are hooked', async () => {
    const { runtime } = world({ picker: PICKER })
    await runtime.ready
    expect(runtime.status()[0]).toMatchObject({ state: 'loaded' })
    expect(runtime.uiSnapshot().editHooked).toBe(true)
    expect(isModsUiState(runtime.uiSnapshot())).toBe(true)
  })

  it('no module hooks it: the ui state leaves it out and an edit lands as typed', async () => {
    const { runtime } = world({})
    await runtime.ready
    expect(runtime.uiSnapshot().editHooked).toBeUndefined()
    await expect(runtime.promptEdit(typed('ab', 1, 'x', 'x'))).resolves.toEqual({ text: 'axb', cursor: 2 })
  })

  it('a hook rewrites what goes in, or consumes the key; other edits pass', async () => {
    const { runtime } = world({ picker: PICKER })
    await runtime.ready
    await expect(runtime.promptEdit(typed('', 0, '2', '2'))).resolves.toEqual({ text: 'draft 2', cursor: 7 })
    await expect(runtime.promptEdit(typed('', 0, '0', '0'))).resolves.toEqual({ text: '', cursor: 0 })
    await expect(runtime.promptEdit(typed('fix ', 4, '1', '1'))).resolves.toEqual({ text: 'fix 1', cursor: 5 })
    // A paste carries no key: a pasted digit lands as pasted.
    await expect(runtime.promptEdit(typed('', 0, '1'))).resolves.toEqual({ text: '1', cursor: 1 })
    // A deletion.
    await expect(
      runtime.promptEdit({ key: { key: 'backspace' }, text: 'abc', cursor: 3, start: 2, end: 3, inputText: '' }),
    ).resolves.toEqual({ text: 'ab', cursor: 2 })
  })

  it('the key and the origin are pinned: a hook rewriting either is refused and the edit lands as typed', async () => {
    const { runtime, reports } = world({
      liar: `
        export function register(on) {
          on('prompt.edit', ($, e, next) => next({ ...e, key: { key: 'z' }, inputText: 'zz' }))
        }
      `,
    })
    await runtime.ready
    await expect(runtime.promptEdit(typed('', 0, 'a', 'a'))).resolves.toEqual({ text: 'a', cursor: 1 })
    expect(reports.some(line => line.includes('prompt.edit failed') && line.includes('key is pinned'))).toBe(true)
  })

  it('a hook answering something not a box is refused; the edit lands as typed', async () => {
    const { runtime } = world({
      broken: `
        export function register(on) {
          on('prompt.edit', () => ({ text: 'x', cursor: 9 }))
        }
      `,
    })
    await runtime.ready
    await expect(runtime.promptEdit(typed('', 0, 'a', 'a'))).resolves.toEqual({ text: 'a', cursor: 1 })
  })
})

describe('the wire', () => {
  it('takes an edit whose offsets lie within its text', () => {
    expect(isModsPromptEditPayload({ sessionId: 's', edit: typed('ab', 1, 'x', 'x') })).toBe(true)
    expect(isModsPromptEditPayload({ sessionId: 's', edit: { text: 'ab', cursor: 1, start: 2, end: 1, inputText: '' } })).toBe(false)
    expect(isModsPromptEditPayload({ sessionId: 's', edit: { text: 'ab', cursor: 3, start: 0, end: 0, inputText: '' } })).toBe(false)
    expect(isModsPromptEditPayload({ sessionId: 's', edit: { ...typed('', 0, 'a'), key: { key: 'a', alt: 1 } } })).toBe(true)
    expect(isModsPromptEditPayload({ sessionId: 's', edit: { ...typed('', 0, 'a'), key: { key: '' } } })).toBe(false)
    expect(isModsPromptEditPayload({ sessionId: '', edit: typed('', 0, 'a') })).toBe(false)
  })

  it('a connection that may ask gets promptEdit, which posts mods.promptEdit and returns the box', async () => {
    const request = vi.fn(async () => ({ box: { text: 'x', cursor: 1 } }))
    const connection = {
      can: (_cap: string, action: string) => action === 'promptEdit',
      request,
      subscribe: () => () => {},
    } as unknown as Pick<RuntimeConnection, 'subscribe' | 'request' | 'can'>
    const controls = modsComposerControls(connection, 's1')
    expect(controls.onComposerRequest).toBeUndefined()
    await expect(controls.promptEdit!(typed('', 0, 'x', 'x'))).resolves.toEqual({ text: 'x', cursor: 1 })
    expect(request).toHaveBeenCalledWith('mods.promptEdit', { sessionId: 's1', edit: typed('', 0, 'x', 'x') })
    const none = { ...connection, can: () => false } as typeof connection
    expect(modsComposerControls(none, 's1').promptEdit).toBeUndefined()
  })
})

describe('the page reads the editor', () => {
  it('a key: a special key by name, a character as typed, each held modifier', () => {
    expect(promptEditKeyOf({ key: 'Backspace', ctrlKey: false, shiftKey: false, metaKey: false })).toEqual({ key: 'backspace' })
    expect(promptEditKeyOf({ key: 'A', ctrlKey: false, shiftKey: true, metaKey: false })).toEqual({ key: 'A', shift: true })
    expect(promptEditKeyOf({ key: 'ArrowUp', ctrlKey: true, shiftKey: false, metaKey: false })).toEqual({ key: 'arrowup', ctrl: true })
  })

  it('an input event: typing keeps its key only when the key typed it; a paste has none; others land natively', () => {
    const one = { key: '1' }
    expect(pageEditOf({ inputType: 'insertText', data: '1' }, one)).toEqual({ op: 'insert', text: '1', key: one })
    expect(pageEditOf({ inputType: 'insertText', data: 'hello' }, one)).toEqual({ op: 'insert', text: 'hello' })
    expect(
      pageEditOf({ inputType: 'insertFromPaste', data: null, dataTransfer: { getData: () => '1' } }, one),
    ).toEqual({ op: 'insert', text: '1' })
    expect(pageEditOf({ inputType: 'insertLineBreak', data: null }, { key: 'return', shift: true })).toEqual({
      op: 'insert',
      text: '\n',
      key: { key: 'return', shift: true },
    })
    expect(pageEditOf({ inputType: 'deleteContentBackward', data: null }, { key: 'backspace' })).toEqual({
      op: 'deleteBackward',
      key: { key: 'backspace' },
    })
    expect(pageEditOf({ inputType: 'deleteWordBackward', data: null }, undefined)).toBeNull()
    expect(pageEditOf({ inputType: 'historyUndo', data: null }, undefined)).toBeNull()
  })

  it('a splice of the editor: a selection is replaced; a delete takes one code point; nothing to delete asks nothing', () => {
    expect(spliceOf({ text: 'abcd', start: 1, end: 3 }, { op: 'insert', text: 'X' })).toMatchObject({ start: 1, end: 3, inputText: 'X' })
    expect(spliceOf({ text: 'a\u{1F600}', start: 3, end: 3 }, { op: 'deleteBackward' })).toMatchObject({ start: 1, end: 3, inputText: '' })
    expect(spliceOf({ text: 'ab', start: 0, end: 0 }, { op: 'deleteBackward' })).toBeNull()
    expect(spliceOf({ text: 'ab', start: 2, end: 2 }, { op: 'deleteForward' })).toBeNull()
    expect(spliceOf({ text: 'ab', start: 0, end: 0 }, { op: 'deleteForward' })).toMatchObject({ start: 0, end: 1 })
  })

  it('a burst folds into one edit at the caret, with no key; one queued edit keeps its key', () => {
    const box = { text: 'ab', cursor: 2 }
    expect(
      foldEdits(box, [
        { op: 'insert', text: 'c', key: { key: 'c' } },
        { op: 'insert', text: 'd', key: { key: 'd' } },
        { op: 'deleteBackward', key: { key: 'backspace' } },
        { op: 'insert', text: 'e' },
      ]),
    ).toEqual({ text: 'ab', cursor: 2, start: 2, end: 2, inputText: 'ce' })
    expect(foldEdits(box, [{ op: 'deleteBackward' }, { op: 'deleteBackward' }])).toEqual({
      text: 'ab',
      cursor: 2,
      start: 0,
      end: 2,
      inputText: '',
    })
    expect(foldEdits(box, [{ op: 'insert', text: 'c', key: { key: 'c' } }])).toEqual({
      key: { key: 'c' },
      text: 'ab',
      cursor: 2,
      start: 2,
      end: 2,
      inputText: 'c',
    })
  })
})

describe('the pump', () => {
  /** An editor whose box the pump writes, and a runtime whose answers the
   *  test releases. */
  function rig(timeoutMs = 100) {
    let state: EditorState = { text: '', start: 0, end: 0 }
    const asks: Array<{ edit: ModsPromptEdit; answer: (box: PromptEditBox | null) => void }> = []
    const pump = new PromptEditPump({
      read: () => state,
      write: box => {
        state = { text: box.text, start: box.cursor, end: box.cursor }
      },
      ask: edit => new Promise(resolve => asks.push({ edit, answer: resolve })),
      timeoutMs,
    })
    return {
      pump,
      asks,
      box: () => state,
      set: (next: EditorState) => {
        state = next
      },
    }
  }
  const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))

  it('an edit is held until the runtime answers, and the answer is shown', async () => {
    const { pump, asks, box } = rig()
    pump.edit({ op: 'insert', text: '1', key: { key: '1' } })
    expect(box().text).toBe('')
    expect(asks[0]!.edit).toEqual(typed('', 0, '1', '1'))
    asks[0]!.answer({ text: 'draft 1', cursor: 7 })
    await flush()
    expect(box()).toEqual({ text: 'draft 1', start: 7, end: 7 })
    expect(pump.busy).toBe(false)
  })

  it('keys typed while an ask is out are one edit after it, on the box it answered', async () => {
    const { pump, asks, box } = rig()
    pump.edit({ op: 'insert', text: 'a', key: { key: 'a' } })
    pump.edit({ op: 'insert', text: 'b', key: { key: 'b' } })
    pump.edit({ op: 'insert', text: 'c', key: { key: 'c' } })
    expect(asks).toHaveLength(1)
    asks[0]!.answer({ text: 'A', cursor: 1 })
    await flush()
    expect(asks).toHaveLength(2)
    expect(asks[1]!.edit).toEqual({ text: 'A', cursor: 1, start: 1, end: 1, inputText: 'bc' })
    asks[1]!.answer(null)
    await flush()
    expect(box().text).toBe('Abc')
  })

  it('an ask unanswered past the timeout lands as typed; its late answer is dropped', async () => {
    vi.useFakeTimers()
    const { pump, asks, box } = rig(100)
    pump.edit({ op: 'insert', text: 'x', key: { key: 'x' } })
    await vi.advanceTimersByTimeAsync(99)
    expect(box().text).toBe('')
    await vi.advanceTimersByTimeAsync(1)
    expect(box().text).toBe('x')
    asks[0]!.answer({ text: 'late', cursor: 4 })
    await vi.advanceTimersByTimeAsync(0)
    expect(box().text).toBe('x')
  })

  it('a box changed under the ask (a send, a fill) is not overwritten by its answer', async () => {
    const { pump, asks, box, set } = rig()
    pump.edit({ op: 'insert', text: '1', key: { key: '1' } })
    set({ text: 'filled', start: 6, end: 6 })
    asks[0]!.answer({ text: 'draft 1', cursor: 7 })
    await flush()
    expect(box().text).toBe('filled')
  })

  it('dispose while an ask is out: the held edit and the queued keys land as typed, the late answer is dropped', async () => {
    const { pump, asks, box } = rig()
    pump.edit({ op: 'insert', text: 'a', key: { key: 'a' } })
    pump.edit({ op: 'insert', text: 'b', key: { key: 'b' } })
    pump.edit({ op: 'insert', text: 'c', key: { key: 'c' } })
    pump.dispose()
    expect(box()).toEqual({ text: 'abc', start: 3, end: 3 })
    asks[0]!.answer({ text: 'late', cursor: 4 })
    await flush()
    expect(box().text).toBe('abc')
    expect(asks).toHaveLength(1)
  })

  it('dispose after the box moved under the ask: the move stands, the queued keys land at its caret', () => {
    const { pump, box, set } = rig()
    pump.edit({ op: 'insert', text: 'a', key: { key: 'a' } })
    pump.edit({ op: 'insert', text: 'b', key: { key: 'b' } })
    set({ text: 'filled', start: 6, end: 6 })
    pump.dispose()
    expect(box()).toEqual({ text: 'filledb', start: 7, end: 7 })
  })

  it('an input method\'s commit is asked after it landed, and the answer replaces it', async () => {
    const { pump, asks, box, set } = rig()
    set({ text: '你好', start: 2, end: 2 })
    const splice = { text: '', cursor: 0, start: 0, end: 0, inputText: '你好' }
    pump.landed(splice)
    expect(asks[0]!.edit).toEqual(splice)
    expect(applyPromptEdit(splice).text).toBe('你好')
    asks[0]!.answer({ text: '你好!', cursor: 3 })
    await flush()
    expect(box().text).toBe('你好!')
  })
})
