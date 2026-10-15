// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'

import { InstructionsSection } from '../browser/webview/settings/sections/InstructionsSection'
import {
  SettingsBridgeContext,
  SettingsHostActionsContext,
} from '../browser/webview/nexusSettingsBridge'
import type { NexusSettingsBridge } from '../browser/webview/nexusSettingsBridge'
import { hasUnsavedEdits } from '../glic/unsavedEditsGate'

/**
 * The "Instructions" page: the field loads from the user instruction file (`memory.userInstructions`); blur commits
 * the text verbatim via `memory.writeUserInstructions` with the loaded baseline as `expected`; a blank commit
 * empties the file; an unchanged blur writes nothing; a conflict does not clobber; the file list auto-loads
 * (`memory.instructions`), grouped by tier, with "Open" revealing the containing folder.
 */

const USER_INSTRUCTIONS_PATH = '/home/u/.velloc/VELLOC.md'

type BridgeOptions = {
  /** Initial file contents. */
  initial?: string
  /**
   * When set, the FIRST write is answered as a conflict carrying this text —
   * simulating the file changing on disk while the page sat open.
   */
  conflictWith?: string
}

function makeBridge(options: BridgeOptions = {}) {
  const { initial = 'Be terse.', conflictWith } = options
  let content = initial
  let conflictPending = conflictWith !== undefined
  const instrFiles = [
    { path: USER_INSTRUCTIONS_PATH, tier: 'User' as const, bytes: 40 },
    { path: '/repo/VELLOC.md', tier: 'Project' as const, bytes: 80 },
  ]
  const writes: Array<{ content: string; expected?: string | null }> = []
  const bridge = {
    request: vi.fn(
      async (
        route: { action: string },
        payload: { content?: string; expected?: string | null },
      ) => {
        // Action names are distinct across the actions the page uses
        // (memory.userInstructions / memory.writeUserInstructions /
        // memory.instructions), so the mock routes on `action` alone.
        if (route.action === 'userInstructions') {
          return {
            path: USER_INSTRUCTIONS_PATH,
            content,
            exists: true,
            readable: true,
          }
        }
        if (route.action === 'instructions') {
          return { files: instrFiles }
        }
        // memory.writeUserInstructions
        writes.push({
          content: payload.content ?? '',
          expected: payload.expected,
        })
        if (conflictPending) {
          conflictPending = false
          content = conflictWith!
          return {
            ok: false,
            path: USER_INSTRUCTIONS_PATH,
            content,
            conflict: true,
          }
        }
        content = payload.content ?? ''
        return { ok: true, path: USER_INSTRUCTIONS_PATH, content }
      },
    ),
    subscribeEvents: () => () => {},
  } as unknown as NexusSettingsBridge
  return { bridge, writes, getContent: () => content }
}

function renderSection(bridge: NexusSettingsBridge) {
  const revealFolder = vi.fn(async () => {})
  const view = render(
    createElement(
      SettingsBridgeContext.Provider,
      { value: bridge },
      createElement(
        SettingsHostActionsContext.Provider,
        { value: { revealFolder } },
        createElement(InstructionsSection),
      ),
    ),
  )
  return { ...view, revealFolder }
}

afterEach(() => {
  cleanup()
})

describe('InstructionsSection', () => {
  it('loads the Instructions field from the user instruction file', async () => {
    renderSection(makeBridge({ initial: 'Prefer TypeScript.' }).bridge)
    const field = (await screen.findByTestId(
      'user-instructions',
    )) as HTMLTextAreaElement
    expect(field.value).toBe('Prefer TypeScript.')
  })

  it('shows which file the text is stored in', async () => {
    renderSection(makeBridge().bridge)
    const path = await screen.findByTestId('user-instructions-path')
    expect(path.textContent).toBe(USER_INSTRUCTIONS_PATH)
  })

  it('commits the edited text VERBATIM (untrimmed) on blur, with the loaded baseline as `expected`', async () => {
    const { bridge, writes } = makeBridge({ initial: 'old' })
    renderSection(bridge)
    const field = (await screen.findByTestId(
      'user-instructions',
    )) as HTMLTextAreaElement
    // Leading/inner whitespace + line breaks must survive (instructions rely on
    // them) — the field commits the draft verbatim, NOT trimmed.
    fireEvent.change(field, { target: { value: '  Keep   spacing.\nLine two.' } })
    fireEvent.blur(field)
    await waitFor(() => {
      expect(writes).toContainEqual({
        content: '  Keep   spacing.\nLine two.',
        // The conflict check is only meaningful if the baseline actually
        // travels with the write.
        expected: 'old',
      })
    })
  })

  it('empties the file on a blank commit (never deletes it)', async () => {
    const { bridge, writes, getContent } = makeBridge({ initial: 'something' })
    renderSection(bridge)
    const field = (await screen.findByTestId(
      'user-instructions',
    )) as HTMLTextAreaElement
    fireEvent.change(field, { target: { value: '' } })
    fireEvent.blur(field)
    await waitFor(() => {
      expect(writes).toContainEqual({ content: '', expected: 'something' })
    })
    expect(getContent()).toBe('')
  })

  it('does NOT write when the text is unchanged (self-compare guard)', async () => {
    const { bridge, writes } = makeBridge({ initial: 'unchanged' })
    renderSection(bridge)
    const field = await screen.findByTestId('user-instructions')
    fireEvent.blur(field)
    await new Promise((r) => setTimeout(r, 0))
    expect(writes).toHaveLength(0)
  })

  /**
   * A blur over a file changed on disk since load is refused and the user is told; the draft is kept and the
   * on-disk text is shown beside it.
   */
  it('warns and keeps both versions when the file changed on disk', async () => {
    const { bridge } = makeBridge({
      initial: 'loaded',
      conflictWith: 'written by someone else',
    })
    renderSection(bridge)
    const field = (await screen.findByTestId(
      'user-instructions',
    )) as HTMLTextAreaElement
    fireEvent.change(field, { target: { value: 'my edit' } })
    fireEvent.blur(field)
    await waitFor(() => {
      expect(screen.getByTestId('user-instructions-conflict')).toBeTruthy()
    })
    // The user's draft SURVIVES — it is the only copy that exists.
    expect(
      (screen.getByTestId('user-instructions') as HTMLTextAreaElement).value,
    ).toBe('my edit')
    // ...and the on-disk text is shown alongside it, so they can merge.
    expect(
      (screen.getByTestId('user-instructions-disk') as HTMLTextAreaElement)
        .value,
    ).toBe('written by someone else')
  })

  it('clears the conflict notice once a later write succeeds', async () => {
    const { bridge } = makeBridge({ initial: 'loaded', conflictWith: 'theirs' })
    renderSection(bridge)
    const field = (await screen.findByTestId(
      'user-instructions',
    )) as HTMLTextAreaElement
    fireEvent.change(field, { target: { value: 'my edit' } })
    fireEvent.blur(field)
    await waitFor(() => {
      expect(screen.getByTestId('user-instructions-conflict')).toBeTruthy()
    })
    // Re-apply on top of the now-synced baseline: the second write goes through.
    fireEvent.change(screen.getByTestId('user-instructions'), {
      target: { value: 'theirs + mine' },
    })
    fireEvent.blur(screen.getByTestId('user-instructions'))
    await waitFor(() => {
      expect(screen.queryByTestId('user-instructions-conflict')).toBeNull()
    })
  })

  /**
   * A blur while a write is in flight was dropped by the
   * serialization guard, and the first write's response then put ITS text
   * back into the box over what the user had typed since — lost, unsaved.
   */
  it('keeps text typed during an in-flight save and saves it once that write settles', async () => {
    let content = 'v0'
    const writes: Array<{ content: string; expected?: string | null }> = []
    const pending: Array<() => void> = []
    const bridge = {
      request: vi.fn(
        async (
          route: { action: string },
          payload: { content?: string; expected?: string | null },
        ) => {
          if (route.action === 'userInstructions') {
            return { path: USER_INSTRUCTIONS_PATH, content, exists: true, readable: true }
          }
          if (route.action === 'instructions') return { files: [] }
          writes.push({ content: payload.content ?? '', expected: payload.expected })
          // Each write is held until the test releases it.
          await new Promise<void>((resolve) => pending.push(resolve))
          content = payload.content ?? ''
          return { ok: true, path: USER_INSTRUCTIONS_PATH, content }
        },
      ),
      subscribeEvents: () => () => {},
    } as unknown as NexusSettingsBridge
    renderSection(bridge)
    const field = () => screen.getByTestId('user-instructions') as HTMLTextAreaElement
    await screen.findByTestId('user-instructions')

    fireEvent.change(field(), { target: { value: 'v1' } })
    fireEvent.blur(field())
    await waitFor(() => expect(writes).toHaveLength(1))
    // Typed on, and left the field again, while the first write is in flight.
    fireEvent.change(field(), { target: { value: 'v2' } })
    fireEvent.blur(field())

    pending.shift()!()
    // The newer text is still in the box…
    await waitFor(() => expect(writes).toHaveLength(2))
    expect(field().value).toBe('v2')
    // …and its write goes against the baseline the first one stored.
    expect(writes[1]).toEqual({ content: 'v2', expected: 'v1' })
    pending.shift()!()
    await waitFor(() => expect(content).toBe('v2'))
    expect(field().value).toBe('v2')
  })

  /** A failed write looked exactly like a saved one. */
  it('says so when a write fails, keeps the draft, and clears the notice on the next good write', async () => {
    let content = 'loaded'
    let failNext = true
    const bridge = {
      request: vi.fn(
        async (route: { action: string }, payload: { content?: string }) => {
          if (route.action === 'userInstructions') {
            return { path: USER_INSTRUCTIONS_PATH, content, exists: true, readable: true }
          }
          if (route.action === 'instructions') return { files: [] }
          if (failNext) {
            failNext = false
            throw new Error('worker gone')
          }
          content = payload.content ?? ''
          return { ok: true, path: USER_INSTRUCTIONS_PATH, content }
        },
      ),
      subscribeEvents: () => () => {},
    } as unknown as NexusSettingsBridge
    renderSection(bridge)
    const field = (await screen.findByTestId('user-instructions')) as HTMLTextAreaElement
    fireEvent.change(field, { target: { value: 'my edit' } })
    fireEvent.blur(field)
    const notice = await screen.findByTestId('user-instructions-save-failed')
    expect(notice.textContent).toContain("Couldn't save your instructions")
    expect(field.value).toBe('my edit')
    expect(content).toBe('loaded')

    // Leaving the field again retries, and a good write clears the notice.
    fireEvent.blur(field)
    await waitFor(() => expect(content).toBe('my edit'))
    await waitFor(() =>
      expect(screen.queryByTestId('user-instructions-save-failed')).toBeNull(),
    )
  })

  it('auto-loads the read-only instruction files, grouped by tier, with per-file Open', async () => {
    const { revealFolder } = renderSection(makeBridge().bridge)
    const instr = await screen.findByTestId('memory-instructions')
    expect(instr.textContent ?? '').toContain(USER_INSTRUCTIONS_PATH)
    expect(instr.textContent ?? '').toContain('/repo/VELLOC.md')
    expect(instr.textContent ?? '').toMatch(/user/i)
    expect(instr.textContent ?? '').toMatch(/project/i)
    // Open reveals the file's CONTAINING folder (not the file itself).
    const openButtons = await screen.findAllByTestId('memory-instruction-open')
    fireEvent.click(openButtons[0]!)
    expect(revealFolder).toHaveBeenCalledWith('/home/u/.velloc')
  })

  it('holds the updater reload gate while the draft is not on disk', async () => {
    const { bridge } = makeBridge({ initial: 'old' })
    renderSection(bridge)
    const field = (await screen.findByTestId(
      'user-instructions',
    )) as HTMLTextAreaElement
    expect(hasUnsavedEdits()).toBe(false)
    fireEvent.change(field, { target: { value: 'new text' } })
    expect(hasUnsavedEdits()).toBe(true)
    fireEvent.blur(field)
    // Saved: the draft is on disk now, nothing left to lose.
    await waitFor(() => expect(hasUnsavedEdits()).toBe(false))
  })
})
