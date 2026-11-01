// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'

import type { Message } from '../runtime/RuntimeTypes'
import {
  buildMenuChoices,
  codeTargetOf,
  contextMenuAnchor,
  createChoiceLedger,
  groupMenuChoices,
  messageRowOf,
  resolveAfterResponseCut,
  snapshotSelection,
  type MenuTargetFacts,
} from '../browser/webview/messageContextMenuModel'

/**
 * The message context menu's decisions (F-22): which choices show for a
 * selection, a code hit and the message, in which order and section; that
 * each carries its own frozen material; the target and selection rules; a
 * choice runs once; and where a fork after a reply cuts.
 */

afterEach(() => {
  document.body.innerHTML = ''
  document.getSelection()?.removeAllRanges()
})

const facts = (over: Partial<MenuTargetFacts> = {}): MenuTargetFacts => ({
  threadKey: 's1',
  entryKey: 'm1',
  role: 'assistant',
  selection: { kind: 'none' },
  code: null,
  entryText: 'The **reply**.',
  canAttach: true,
  fork: { kind: 'enabled', cut: { side: 'after-response', responseKey: 'm1', cutKey: 'm1' } },
  ...over,
})

const keys = (f: MenuTargetFacts) => buildMenuChoices(f).map(choice => choice.choiceKey)

describe('choices', () => {
  it('a prompt copies as the plain text it shows, with no Markdown copy', () => {
    const choices = buildMenuChoices(facts({ role: 'user', entryText: 'a **literal** prompt' }))
    expect(choices.map(c => c.choiceKey)).not.toContain('copy-message-markdown')
    const copy = choices.find(c => c.choiceKey === 'copy-message')
    expect(copy && 'operation' in copy ? copy.operation : null).toEqual({
      command: 'clipboard.write',
      material: { scope: 'entry', body: 'a **literal** prompt', output: 'plain' },
    })
  })

  it('without a selection: message copies, attach the message, fork', () => {
    expect(keys(facts())).toEqual(['copy-message', 'copy-message-markdown', 'attach-message', 'fork'])
  })

  it('with a selection: copy it and attach it, not the message', () => {
    const choices = buildMenuChoices(facts({ selection: { kind: 'inside', text: '  the reply ' } }))
    expect(choices.map(c => c.choiceKey)).toEqual([
      'copy-selection',
      'copy-message',
      'copy-message-markdown',
      'attach-selection',
      'fork',
    ])
    const copy = choices[0]
    const attach = choices[3]
    expect(copy?.availability === 'enabled' && copy.operation).toEqual({
      command: 'clipboard.write',
      material: { scope: 'range', body: '  the reply ' },
    })
    expect(attach?.availability === 'enabled' && attach.operation).toEqual({
      command: 'context.capture',
      material: { body: 'the reply', method: 'range', anchors: [{ threadKey: 's1', entryKey: 'm1' }] },
    })
    expect(attach?.shortcut).toBe('attachSelection')
  })

  it('copies the selection and the code under the pointer separately', () => {
    const choices = buildMenuChoices(
      facts({
        selection: { kind: 'inside', text: 'call foo() now' },
        code: { scope: 'inline-code', body: 'foo()' },
      }),
    )
    const materials = choices.flatMap(c =>
      c.availability === 'enabled' && c.operation.command === 'clipboard.write' ? [c.operation.material] : [],
    )
    expect(materials.slice(0, 2)).toEqual([
      { scope: 'range', body: 'call foo() now' },
      { scope: 'inline-code', body: 'foo()' },
    ])
  })

  it('a one-character selection copies but attaches the message instead', () => {
    expect(keys(facts({ selection: { kind: 'inside', text: '字' } }))).toEqual([
      'copy-selection',
      'copy-message',
      'copy-message-markdown',
      'attach-message',
      'fork',
    ])
  })

  it('a selection reaching outside the list offers no selection action', () => {
    expect(keys(facts({ selection: { kind: 'outside' } }))).toEqual([
      'copy-message',
      'copy-message-markdown',
      'attach-message',
      'fork',
    ])
  })

  it('rich and plain message copies carry the same source text', () => {
    const choices = buildMenuChoices(facts())
    const material = (key: string) => {
      const choice = choices.find(c => c.choiceKey === key)
      return choice?.availability === 'enabled' && choice.operation.command === 'clipboard.write'
        ? choice.operation.material
        : null
    }
    expect(material('copy-message')).toEqual({ scope: 'entry', body: 'The **reply**.', output: 'rich' })
    expect(material('copy-message-markdown')).toEqual({ scope: 'entry', body: 'The **reply**.', output: 'plain' })
  })

  it('a fork that cannot run yet is disabled with its reason; one that does not apply is hidden', () => {
    const disabled = buildMenuChoices(
      facts({ fork: { kind: 'disabled', explanationKey: 'messageMenu.forkStreaming' } }),
    ).find(c => c.choiceKey === 'fork')
    expect(disabled).toMatchObject({ availability: 'disabled', explanationKey: 'messageMenu.forkStreaming' })
    expect(disabled && 'operation' in disabled).toBe(false)
    expect(keys(facts({ fork: null }))).not.toContain('fork')
  })

  it('a read-only thread attaches nothing; a row without text offers only what applies', () => {
    expect(keys(facts({ canAttach: false }))).toEqual(['copy-message', 'copy-message-markdown', 'fork'])
    expect(keys(facts({ entryText: '  ', fork: null }))).toEqual([])
  })

  it('groups into sections in display order, dropping empty ones', () => {
    const groups = groupMenuChoices(buildMenuChoices(facts({ selection: { kind: 'inside', text: 'ab' } })))
    expect(groups.map(group => group[0]?.section)).toEqual(['target', 'entry', 'thread'])
    expect(groupMenuChoices(buildMenuChoices(facts())).map(group => group[0]?.section)).toEqual([
      'entry',
      'thread',
    ])
  })
})

describe('target and selection', () => {
  const mount = () => {
    document.body.innerHTML = `
      <div id="list">
        <div data-message-id="m1">
          <p id="para">Hello <code id="inline">foo()</code> world</p>
          <div><div>ts</div><pre id="block"><code>line 1
line 2
</code></pre></div>
          <a id="path" data-file-path="/repo/src/a.ts">a.ts</a>
          <textarea id="field">edit</textarea>
        </div>
        <div data-message-id="m2"><p id="para2">Second</p></div>
      </div>
      <p id="outside">Outside</p>`
    return document.getElementById('list')!
  }

  it('opens on a row, but not in a text field or outside the list', () => {
    const list = mount()
    expect(messageRowOf(document.getElementById('para'), list)?.getAttribute('data-message-id')).toBe('m1')
    expect(messageRowOf(document.getElementById('field'), list)).toBeNull()
    expect(messageRowOf(document.getElementById('outside'), list)).toBeNull()
  })

  it('finds the code block (code only), the inline code and the path under the pointer', () => {
    const list = mount()
    const row = list.querySelector('[data-message-id="m1"]')!
    expect(codeTargetOf(document.querySelector('#block code'), row)).toEqual({
      scope: 'code-block',
      body: 'line 1\nline 2',
    })
    expect(codeTargetOf(document.getElementById('inline'), row)).toEqual({ scope: 'inline-code', body: 'foo()' })
    expect(codeTargetOf(document.getElementById('path'), row)).toEqual({ scope: 'path', body: '/repo/src/a.ts' })
    expect(codeTargetOf(document.getElementById('para'), row)).toBeNull()
  })

  it('freezes a selection inside the list, across rows too; one reaching outside is outside', () => {
    const list = mount()
    const selection = document.getSelection()!
    const range = document.createRange()
    range.setStart(document.getElementById('para')!.firstChild!, 0)
    range.setEnd(document.getElementById('para2')!.firstChild!, 3)
    selection.addRange(range)
    const inside = snapshotSelection(selection, list)
    expect(inside.kind).toBe('inside')

    selection.removeAllRanges()
    const wide = document.createRange()
    wide.setStart(document.getElementById('para')!.firstChild!, 0)
    wide.setEnd(document.getElementById('outside')!.firstChild!, 3)
    selection.addRange(wide)
    expect(snapshotSelection(selection, list)).toEqual({ kind: 'outside' })

    selection.removeAllRanges()
    expect(snapshotSelection(selection, list)).toEqual({ kind: 'none' })
  })
})

describe('one run per choice', () => {
  it('claims a token and choice once', () => {
    const ledger = createChoiceLedger()
    expect(ledger.claim('menu-1', 'attach-selection')).toBe(true)
    expect(ledger.claim('menu-1', 'attach-selection')).toBe(false)
    expect(ledger.claim('menu-2', 'attach-selection')).toBe(true)
  })
})

describe('where the menu opens', () => {
  it('at the pointer for any pointer open, a macOS Control-click or a long-press included', () => {
    expect(contextMenuAnchor({ clientX: 120, clientY: 340 }, { left: 10, top: 20 })).toEqual({ x: 120, y: 340 })
  })

  it('on the visible top-left of the row for a keyboard open, even with its top scrolled away', () => {
    expect(contextMenuAnchor({ clientX: 0, clientY: 0 }, { left: 10, top: 20 })).toEqual({ x: 26, y: 36 })
    expect(contextMenuAnchor({ clientX: 0, clientY: 0 }, { left: 10, top: -900 })).toEqual({ x: 26, y: 16 })
  })
})

describe('fork after a reply', () => {
  const entry = (uuid: string, type: string) => ({ uuid, type }) as unknown as Message
  // U1 → A1 (text, tool use, tool result, text) → U2 → A2
  const transcript = [
    entry('u1', 'user'),
    entry('a1', 'assistant'),
    entry('a1-tool', 'assistant'),
    entry('a1-result', 'user'),
    entry('a1-end', 'assistant'),
    entry('u2', 'user'),
    entry('a2', 'assistant'),
  ]
  const rows = [
    { id: 'u1', role: 'user' },
    { id: 'a1', role: 'assistant' },
    { id: 'u2', role: 'user' },
    { id: 'turn:u2:assistant', role: 'assistant' },
  ]

  it('cuts after the whole turn, just before the next prompt', () => {
    expect(resolveAfterResponseCut(rows, transcript, 'a1')).toBe('a1-end')
  })

  it('cuts at the conversation end after the last reply', () => {
    expect(resolveAfterResponseCut(rows, transcript, 'turn:u2:assistant')).toBe('a2')
  })

  it('finds no cut for an unknown row or a prompt missing from the transcript', () => {
    expect(resolveAfterResponseCut(rows, transcript, 'nope')).toBeNull()
    expect(resolveAfterResponseCut([...rows.slice(0, 2), { id: 'pending', role: 'user' }], transcript, 'a1')).toBeNull()
  })

  it('a teammate message or background results open the next turn though drawn as replies', () => {
    const team = [
      entry('u1', 'user'),
      entry('a1', 'assistant'),
      entry('t1', 'user'),
      entry('a-t1', 'assistant'),
    ]
    const teamRows = [
      { id: 'u1', role: 'user' },
      { id: 'a1', role: 'assistant' },
      { id: 't1', role: 'assistant', sourceType: 'team_message' },
      { id: 'a-t1', role: 'assistant' },
    ]
    expect(resolveAfterResponseCut(teamRows, team, 'a1')).toBe('a1')
    const bgRows = teamRows.map(row => (row.id === 't1' ? { ...row, sourceType: 'background_results' } : row))
    expect(resolveAfterResponseCut(bgRows, team, 'a1')).toBe('a1')
  })

  it('finds the next turn by a landed message\'s stored entry and by a duplicate row\'s original', () => {
    const landed = [
      entry('u1', 'user'),
      entry('a1', 'assistant'),
      { uuid: 'att-1', type: 'attachment', attachment: { type: 'queued_command', source_uuid: 'bubble-1' } } as unknown as Message,
      entry('a2', 'assistant'),
    ]
    const landedRows = [
      { id: 'u1', role: 'user' },
      { id: 'a1', role: 'assistant' },
      { id: 'bubble-1', role: 'user' },
      { id: 'a2', role: 'assistant' },
    ]
    expect(resolveAfterResponseCut(landedRows, landed, 'a1')).toBe('a1')
    const dupRows = [...rows.slice(0, 2), { id: 'u2:duplicate-1', role: 'user' }]
    expect(resolveAfterResponseCut(dupRows, transcript, 'a1')).toBe('a1-end')
  })
})
