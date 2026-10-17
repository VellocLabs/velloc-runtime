/**
 * `prompt.autocomplete`, `prompt.change` and `virtualText` (F-25): the token at the caret and the rows the mods add
 * for it; the box changing without a typed edit — a page's clear or undo, a plugin's fill; and the virtual text a
 * fill or an edit's answer draws, carried to the page apart from the draft. Real `ModRuntime`; the page's half is
 * `mod-prompt-box-page`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isModsComposerRequest,
  isModsPromptAutocompletePayload,
  isModsPromptChangePayload,
  isModsUiState,
} from '../browser/runtimeProtocol'
import { RAISED_EVENTS } from '../mods/modAdmission'
import { fillBox, virtualTextRunsOf, type ModComposerAnswer, type ModComposerRequest, type PromptBox } from '../mods/modComposer'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import type { ModUiEvent } from '../mods/modUi'
import { autocompleteTokenAt, takeAutocompleteRow } from '../mods/promptBoxEvents'

const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
})

let uniq = 0
/** A world whose page holds `box` and fills it as asked. */
function world(modules: Record<string, string>, box: PromptBox = { text: '', cursor: 0 }) {
  const reports: string[] = []
  const requests: ModComposerRequest[] = []
  let runtime!: ModRuntime
  const refs: ModModuleRef[] = Object.keys(modules).map(plugin => ({ plugin, path: `/plugins/${plugin}/hooks/register.js` }))
  runtime = new ModRuntime({
    modules: refs,
    readModule: async path => `export function register(on) {\n${modules[path.split('/')[2]!]}\n}\n// load ${++uniq}`,
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
    drawsComposer: true,
    composerTimeoutMs: 200,
    onUiChanged: (event: ModUiEvent) => {
      if (event.kind !== 'composer') return
      const request = event.composer
      requests.push(request)
      const { requestId } = request
      const answer: ModComposerAnswer =
        request.op === 'fill'
          ? { requestId, op: 'fill', isFilled: true, box: fillBox(box, request.text, request.mode) }
          : request.op === 'read'
            ? { requestId, op: 'read', box }
            : { requestId, op: 'suggest', isShown: false }
      runtime.composerAnswer(answer)
    },
  })
  runtimes.push(runtime)
  const logged = (plugin: string) =>
    reports.filter(line => line.startsWith(`${plugin}: {`)).map(line => JSON.parse(line.slice(plugin.length + 2)) as Record<string, unknown>)
  return { runtime, reports, requests, logged }
}

describe('admission', () => {
  it('raises prompt.autocomplete and prompt.change', () => {
    expect(RAISED_EVENTS).toEqual(expect.arrayContaining(['prompt.autocomplete', 'prompt.change']))
  })
})

describe('prompt.autocomplete', () => {
  it('the token is the run of non-whitespace ending at the caret, never empty; taking a row puts the caret after it', () => {
    expect(autocompleteTokenAt('see #ab', 7)).toEqual({ token: '#ab', start: 4 })
    expect(autocompleteTokenAt('see #ab', 5)).toEqual({ token: '#', start: 4 })
    expect(autocompleteTokenAt('see ', 4)).toBeNull()
    expect(autocompleteTokenAt('', 0)).toBeNull()
    expect(autocompleteTokenAt('a\nb', 3)).toEqual({ token: 'b', start: 2 })
    expect(takeAutocompleteRow({ text: 'see #ab later', cursor: 7, start: 4 }, { text: '#abc' })).toEqual({
      text: 'see #abc later',
      cursor: 8,
    })
  })

  it('the hooks add rows in order, one matching the token alone; a hook answering a bad row is skipped', async () => {
    const { runtime, reports, logged } = world({
      issues: `on('prompt.autocomplete', { token: /^#/ }, async ($, e, next) => {
        await $.ui.log(JSON.stringify(e))
        const r = await next(e)
        return { suggestions: [...r.suggestions, { text: '#abc', description: 'the issue' }] }
      })`,
      first: `on('prompt.autocomplete', async ($, e, next) => {
        const r = await next(e)
        return { suggestions: [{ text: e.token + '!', label: 'shout' }, ...r.suggestions] }
      })`,
      broken: `on('prompt.autocomplete', () => ({ suggestions: [{ text: '' }] }))`,
    })
    await runtime.ready
    expect(runtime.hasPromptAutocompleteHooks()).toBe(true)
    expect(runtime.uiSnapshot().autocompleteHooked).toBe(true)

    const rows = await runtime.promptAutocomplete({ text: 'see #ab', cursor: 7, token: '#ab', start: 4 })
    expect(rows).toEqual([{ text: '#ab!', label: 'shout' }, { text: '#abc', description: 'the issue' }])
    expect(logged('issues')).toEqual([{ text: 'see #ab', cursor: 7, token: '#ab', start: 4 }])
    expect(reports.some(line => line.includes('broken'))).toBe(true)

    const plain = await runtime.promptAutocomplete({ text: 'go', cursor: 2, token: 'go', start: 0 })
    expect(plain).toEqual([{ text: 'go!', label: 'shout' }])
  })

  it('costs nothing unhooked, and a failing chain adds no rows', async () => {
    const { runtime: quiet } = world({ other: `on('prompt.submit', ($, e, next) => next(e))` })
    await quiet.ready
    expect(quiet.uiSnapshot().autocompleteHooked).toBeUndefined()
    await expect(quiet.promptAutocomplete({ text: 'x', cursor: 1, token: 'x', start: 0 })).resolves.toEqual([])
    const { runtime, reports } = world({ boom: `on('prompt.autocomplete', () => { throw new Error('kaboom') })` })
    await runtime.ready
    await expect(runtime.promptAutocomplete({ text: 'x', cursor: 1, token: 'x', start: 0 })).resolves.toEqual([])
    expect(reports.some(line => line.includes('kaboom'))).toBe(true)
  })
})

describe('prompt.change', () => {
  it("a page's clear or undo is heard with the box after it; a hook's answer changes nothing", async () => {
    const { runtime, logged } = world({
      watch: `on('prompt.change', async ($, e, next) => {
        const got = await next(e)
        await $.ui.log(JSON.stringify({ e, got }))
        return { text: 'forged', cursor: 0 }
      })`,
    })
    await runtime.ready
    expect(runtime.uiSnapshot().changeHooked).toBe(true)
    await runtime.promptChange({ text: '', cursor: 0, cause: 'clear' })
    await runtime.promptChange({ text: 'draft', cursor: 3, cause: 'undo' })
    expect(logged('watch')).toEqual([
      { e: { text: '', cursor: 0, cause: 'clear' }, got: { text: '', cursor: 0 } },
      { e: { text: 'draft', cursor: 3, cause: 'undo' }, got: { text: 'draft', cursor: 3 } },
    ])
  })

  it("a plugin's fill that lands raises it with cause fill and the box the page holds", async () => {
    const { runtime, logged } = world(
      {
        filler: `on('session.start', async ($, e, next) => {
          await $.prompt.fill({ text: 'hello', mode: 'append' })
          return next(e)
        })`,
        watch: `on('prompt.change', async ($, e, next) => { await $.ui.log(JSON.stringify(e)); return next(e) })`,
      },
      { text: 'say ', cursor: 4 },
    )
    await runtime.ready
    await vi.waitFor(() => expect(logged('watch')).toEqual([{ text: 'say hello', cursor: 9, cause: 'fill' }]))
  })

  it('the page may tell a clear or an undo, never a fill or a recall', () => {
    expect(isModsPromptChangePayload({ sessionId: 's', change: { text: '', cursor: 0, cause: 'clear' } })).toBe(true)
    expect(isModsPromptChangePayload({ sessionId: 's', change: { text: 'ab', cursor: 2, cause: 'undo' } })).toBe(true)
    expect(isModsPromptChangePayload({ sessionId: 's', change: { text: 'ab', cursor: 2, cause: 'fill' } })).toBe(false)
    expect(isModsPromptChangePayload({ sessionId: 's', change: { text: 'ab', cursor: 2, cause: 'history' } })).toBe(false)
    expect(isModsPromptChangePayload({ sessionId: 's', change: { text: 'ab', cursor: 3, cause: 'undo' } })).toBe(false)
  })
})

describe('virtualText', () => {
  it("a fill's runs carrying virtual text reach the page; the rest of the paint, and a run a hook strips, do not", async () => {
    const { runtime, requests } = world({
      filler: `on('session.start', async ($, e, next) => {
        await $.prompt.fill({ text: 'deploy', decorations: [{ start: 0, end: 6, virtualText: ' to staging', italic: true }, { start: 0, end: 1, bold: true }] })
        await $.prompt.fill({ text: 'plain', decorations: [{ start: 0, end: 5, virtualText: ' stripped' }] })
        return next(e)
      })`,
      strip: `on('prompt.fill', ($, e, next) => (e.text === 'plain' ? next({ ...e, decorations: [] }) : next(e)))`,
    })
    await runtime.ready
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[0]).toMatchObject({ op: 'fill', text: 'deploy', decorations: [{ start: 0, end: 6, virtualText: ' to staging' }] })
    expect(requests[1]).toMatchObject({ op: 'fill', text: 'plain' })
    expect(requests[1]).not.toHaveProperty('decorations')
  })

  it("an edit's answer hands the page the virtual text it drew", async () => {
    const { runtime } = world({
      hint: `on('prompt.edit', async ($, e, next) => {
        const r = await next(e)
        return { ...r, decorations: [{ start: r.text.length, end: r.text.length, virtualText: ' ⏎ to send' }, { start: 0, end: 1, underline: true }] }
      })`,
    })
    await runtime.ready
    const box = await runtime.promptEdit({ text: 'h', cursor: 1, start: 1, end: 1, inputText: 'i' })
    expect(box).toEqual({ text: 'hi', cursor: 2, decorations: [{ start: 2, end: 2, virtualText: ' ⏎ to send' }] })
  })

  it('a virtualText that is not a string is no decoration', () => {
    expect(virtualTextRunsOf([{ start: 0, end: 1, virtualText: 7 }])).toEqual([])
    expect(virtualTextRunsOf([{ start: 0, end: 1, virtualText: '' }, { start: 1, end: 1, virtualText: 'x' }])).toEqual([
      { start: 1, end: 1, virtualText: 'x' },
    ])
  })
})

describe('the wire', () => {
  it('guards the typeahead query, a fill carrying virtual text, and the two hooked flags', () => {
    expect(isModsPromptAutocompletePayload({ sessionId: 's', query: { text: 'see #ab', cursor: 7, token: '#ab', start: 4 } })).toBe(true)
    expect(isModsPromptAutocompletePayload({ sessionId: 's', query: { text: 'see #ab', cursor: 7, token: '#a', start: 4 } })).toBe(false)
    expect(isModsPromptAutocompletePayload({ sessionId: 's', query: { text: 'ab', cursor: 0, token: '', start: 0 } })).toBe(false)
    expect(
      isModsComposerRequest({ requestId: 'c1', op: 'fill', text: 'x', mode: 'replace', decorations: [{ start: 0, end: 1, virtualText: 'y' }] }),
    ).toBe(true)
    expect(isModsComposerRequest({ requestId: 'c1', op: 'fill', text: 'x', mode: 'replace', decorations: [{ start: 0, end: 1 }] })).toBe(false)
    expect(isModsUiState({ status: [], notices: [], autocompleteHooked: true, changeHooked: true })).toBe(true)
    expect(isModsUiState({ status: [], notices: [], changeHooked: false })).toBe(false)
  })
})
