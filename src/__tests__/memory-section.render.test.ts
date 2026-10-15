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

import { MemorySection } from '../browser/webview/settings/sections/MemorySection'
import {
  SettingsBridgeContext,
  SettingsHostActionsContext,
} from '../browser/webview/nexusSettingsBridge'
import type { NexusSettingsBridge } from '../browser/webview/nexusSettingsBridge'
import {
  RuntimeCapabilitiesContext,
  type CapabilityQuery,
} from '../browser/webview/useCan'
import { queryFor } from './_helpers/capabilityQuery'

/**
 * MemorySection render — proves through the rendered component that:
 *  • the master Enable toggle gates Recall + Background-save (they disable
 *    when the master is off),
 *  • flipping a toggle calls `memory.setField` with the right patch, and
 *  • a setField rejection rolls the optimistic toggle back to disk state.
 */

type MemoryValues = {
  autoMemoryEnabled: boolean
  autoMemoryDirectory: string
  memoryMaintenance: 'off' | 'periodic' | 'dailyLog'
  autoExtractEnabled: boolean
  memoryRecallEnabled: boolean
}

// Per-key defaults: master + recall ON; background mode OFF, capture OFF.
const DEFAULT_VALUES: MemoryValues = {
  autoMemoryEnabled: true,
  autoMemoryDirectory: '',
  memoryMaintenance: 'off',
  autoExtractEnabled: false,
  memoryRecallEnabled: true,
}

function makeBridge(
  initial: MemoryValues = DEFAULT_VALUES,
  opts: { failSetField?: boolean } = {},
) {
  let values: MemoryValues = { ...initial }
  // Two projects so the list proves the multi-project view + per-project clear.
  type FileRow = { name: string; bytes: number; type?: string }
  // Realistic slug labels (sanitized full paths). The UI shows just the last
  // token, capitalized — `…-agent` → "Agent", `…-tools` → "Tools".
  const projects: Array<{ label: string; dir: string; files: FileRow[] }> = [
    {
      label: 'home-alice--velloc-shared-workspace-agent',
      dir: '/resolved/proj-a/memory',
      files: [
        { name: 'MEMORY.md', bytes: 12 },
        { name: 'user_role.md', bytes: 30, type: 'user' },
        { name: 'feedback_tests.md', bytes: 20, type: 'feedback' },
      ],
    },
    {
      label: 'home-alice--velloc-shared-workspace-tools',
      dir: '/resolved/proj-b/memory',
      files: [{ name: 'MEMORY.md', bytes: 5 }],
    },
  ]
  const setFieldCalls: Array<Record<string, unknown>> = []
  const bridge = {
    request: vi.fn(
      async (route: { action: string }, payload: { patch?: Record<string, unknown> }) => {
        if (route.action === 'snapshot') {
          return { values: { ...values }, source: 'default' }
        }
        if (route.action === 'list') {
          return {
            projects: projects.map((p) => ({ ...p, files: [...p.files] })),
          }
        }
        if (route.action === 'clear') {
          const target = (payload as { dir?: string }).dir
          const p = projects.find((x) => x.dir === target)
          const cleared = p ? p.files.length : 0
          if (p) p.files = []
          return { ok: true, cleared, dir: p ? p.dir : null }
        }
        // setField
        setFieldCalls.push(payload.patch ?? {})
        if (opts.failSetField) throw new Error('memory_handler_error: disk full')
        const patch = payload.patch ?? {}
        for (const k of [
          'autoMemoryEnabled',
          'autoExtractEnabled',
          'memoryRecallEnabled',
        ] as const) {
          if (k in patch) {
            const v = patch[k]
            // null reverts to the per-key default; a boolean sets it.
            values[k] = v === null ? DEFAULT_VALUES[k] : Boolean(v)
          }
        }
        if ('memoryMaintenance' in patch) {
          const v = patch.memoryMaintenance
          values.memoryMaintenance =
            v === null
              ? DEFAULT_VALUES.memoryMaintenance
              : (v as MemoryValues['memoryMaintenance'])
        }
        if ('autoMemoryDirectory' in patch) {
          const v = patch.autoMemoryDirectory
          values.autoMemoryDirectory = v === null || v === '' ? '' : String(v)
        }
        return { ok: true, values: { ...values } }
      },
    ),
    subscribeEvents: () => () => {},
  } as unknown as NexusSettingsBridge
  return { bridge, setFieldCalls, getValues: () => values }
}

/** `capabilities` omitted = no provider, the desktop tree every case above uses. */
function renderSection(
  bridge: NexusSettingsBridge,
  capabilities?: CapabilityQuery,
) {
  const revealFolder = vi.fn(async () => {})
  const section = createElement(
    SettingsBridgeContext.Provider,
    { value: bridge },
    createElement(
      SettingsHostActionsContext.Provider,
      { value: { revealFolder } },
      createElement(MemorySection),
    ),
  )
  const view = render(
    capabilities
      ? createElement(
          RuntimeCapabilitiesContext.Provider,
          { value: capabilities },
          section,
        )
      : section,
  )
  return { ...view, revealFolder }
}

/** Every `memory.<action>` the page asked the settings bridge for. */
function requestedActions(bridge: NexusSettingsBridge): string[] {
  return (
    bridge.request as unknown as {
      mock: { calls: Array<[{ action: string }, unknown]> }
    }
  ).mock.calls.map(([route]) => route.action)
}

afterEach(() => {
  cleanup()
})

describe('MemorySection', () => {
  it('enables Recall + periodic tidy when the master toggle is on', async () => {
    const { bridge } = makeBridge()
    renderSection(bridge)

    const recall = await screen.findByTestId('memory-recall')
    const maintenance = await screen.findByTestId('memory-maintenance')
    expect(recall.hasAttribute('disabled')).toBe(false)
    expect(maintenance.hasAttribute('disabled')).toBe(false)
  })

  it('renders the background-mode select, enabled, on the default snapshot', async () => {
    const { bridge } = makeBridge()
    renderSection(bridge)

    const maintenance = await screen.findByTestId('memory-maintenance')
    expect(maintenance.hasAttribute('disabled')).toBe(false)
    // master + recall default on
    expect(
      (await screen.findByTestId('memory-recall')).getAttribute('aria-checked'),
    ).toBe('true')
  })

  it('disables Recall + periodic tidy when the master toggle is off', async () => {
    const { bridge } = makeBridge({
      autoMemoryEnabled: false,
      autoMemoryDirectory: '',
      memoryMaintenance: 'off',
      autoExtractEnabled: false,
      memoryRecallEnabled: true,
    })
    renderSection(bridge)

    const recall = await screen.findByTestId('memory-recall')
    const autoextract = await screen.findByTestId('memory-autoextract')
    const maintenance = await screen.findByTestId('memory-maintenance')
    expect(recall.hasAttribute('disabled')).toBe(true)
    expect(autoextract.hasAttribute('disabled')).toBe(true)
    expect(maintenance.hasAttribute('disabled')).toBe(true)
  })

  it('never renders the memory-directory override — the option is hidden', async () => {
    // The `autoMemoryDirectory` key is settings.json-only (the bridge neither
    // returns nor sets it); the UI input + hint were hidden.
    const { bridge } = makeBridge()
    renderSection(bridge)
    await screen.findByTestId('memory-enable')
    expect(screen.queryByTestId('memory-directory')).toBeNull()
    expect(screen.queryByTestId('memory-directory-hint')).toBeNull()
  })

  it('flipping the master toggle calls setField and live-disables the sub-toggles', async () => {
    const { bridge, setFieldCalls } = makeBridge()
    renderSection(bridge)

    const enable = await screen.findByTestId('memory-enable')
    fireEvent.click(enable)

    await waitFor(() => {
      expect(setFieldCalls).toContainEqual({ autoMemoryEnabled: false })
    })
    // Optimistic + persisted: the sub-toggles become disabled.
    await waitFor(() => {
      expect(screen.getByTestId('memory-recall').hasAttribute('disabled')).toBe(
        true,
      )
    })
  })

  it('selecting a background mode calls setField with memoryMaintenance', async () => {
    const { bridge, setFieldCalls } = makeBridge()
    renderSection(bridge)

    const trigger = await screen.findByTestId('memory-maintenance')
    // Radix opens the listbox on pointerdown; the option is portaled.
    fireEvent.pointerDown(trigger)
    fireEvent.click(trigger)
    const option = await screen.findByTestId('memory-maintenance-option-dailyLog')
    fireEvent.click(option)

    await waitFor(() => {
      expect(setFieldCalls).toContainEqual({ memoryMaintenance: 'dailyLog' })
    })
  })

  it('opting into background extraction calls setField with autoExtractEnabled: true', async () => {
    const { bridge, setFieldCalls } = makeBridge()
    renderSection(bridge)

    const autoextract = await screen.findByTestId('memory-autoextract')
    // Independent gate: flipping extraction must NOT touch memoryMaintenance.
    fireEvent.click(autoextract)

    await waitFor(() => {
      expect(setFieldCalls).toContainEqual({ autoExtractEnabled: true })
    })
    expect(setFieldCalls).not.toContainEqual({ memoryMaintenance: 'dailyLog' })
  })

  it('always shows the privacy note (do-not-store-secrets)', async () => {
    const { bridge } = makeBridge()
    renderSection(bridge)
    const note = await screen.findByTestId('memory-privacy-note')
    expect(note.textContent ?? '').toMatch(/secret|password|API key|token/i)
  })

  it('shows the master-off explanation only when auto-memory is disabled', async () => {
    const { bridge } = makeBridge()
    renderSection(bridge)
    // Master ON by default → no disabled note.
    await screen.findByTestId('memory-enable')
    expect(screen.queryByTestId('memory-disabled-note')).toBeNull()
    // Flip the master off → the explanation appears.
    fireEvent.click(screen.getByTestId('memory-enable'))
    const note = await screen.findByTestId('memory-disabled-note')
    expect(note.textContent ?? '').toMatch(/saved|recalled|extracted|consolidated/i)
  })

  it('renders the master-off explanation on an initially-disabled snapshot', async () => {
    const { bridge } = makeBridge({
      autoMemoryEnabled: false,
      autoMemoryDirectory: '',
      memoryMaintenance: 'off',
      autoExtractEnabled: false,
      memoryRecallEnabled: true,
    })
    renderSection(bridge)
    expect(
      (await screen.findByTestId('memory-disabled-note')).textContent ?? '',
    ).not.toBe('')
  })

  it('auto-loads ALL project memory groups (no View button), each with its dir + files', async () => {
    const { bridge } = makeBridge()
    renderSection(bridge)
    // No "View" button — the list mounts and loads on its own.
    expect(screen.queryByTestId('memory-view')).toBeNull()
    const list = await screen.findByTestId('memory-list')
    // Wait for the CARDS, not just the list. findByTestId resolves the moment
    // the container mounts, which is before the async project load fills it —
    // so asserting on textContent here reads '' on any machine slower than the
    // one the test was written on. It passed locally and on CI for weeks, then
    // failed a release build with `expected '' to contain 'Agent'`.
    // This is also the "one card per project" assertion, so it costs nothing.
    expect(await screen.findAllByTestId('memory-project')).toHaveLength(2)
    // Titles show the prettified LAST token, not the raw sanitized slug.
    expect(list.textContent ?? '').toContain('Agent')
    expect(list.textContent ?? '').toContain('Tools')
    expect(list.textContent ?? '').not.toContain('shared-workspace-agent')
    // Each project's dir + files still render in full.
    expect(list.textContent ?? '').toContain('/resolved/proj-a/memory')
    expect(list.textContent ?? '').toContain('user_role.md')
    expect(list.textContent ?? '').toContain('feedback_tests.md')
    expect(list.textContent ?? '').toContain('/resolved/proj-b/memory')
  })

  it("Open folder reveals a project's memory dir in the OS file manager", async () => {
    const { bridge } = makeBridge()
    const { revealFolder } = renderSection(bridge)
    await screen.findByTestId('memory-list')
    // One Open button per project; the first is proj-a (mock returns it first).
    const open = await screen.findAllByTestId('memory-open-folder')
    expect(open).toHaveLength(2)
    fireEvent.click(open[0]!)
    expect(revealFolder).toHaveBeenCalledWith('/resolved/proj-a/memory')
  })

  it('per-project Clear requires an explicit confirm; cancel backs out without clearing', async () => {
    const { bridge } = makeBridge()
    renderSection(bridge)
    await screen.findByTestId('memory-list')
    // Arm the first project's clear → the confirm/cancel pair appears (no
    // destructive call yet).
    fireEvent.click((await screen.findAllByTestId('memory-clear'))[0]!)
    await screen.findByTestId('memory-clear-confirm')
    fireEvent.click(screen.getByTestId('memory-clear-cancel'))
    await waitFor(() => {
      expect(screen.queryByTestId('memory-clear-confirm')).toBeNull()
    })
    expect(screen.getByTestId('memory-list').textContent ?? '').toContain(
      'user_role.md',
    )
  })

  it("confirming a project's Clear calls memory.clear with THAT project's dir", async () => {
    const { bridge } = makeBridge()
    renderSection(bridge)
    await screen.findByTestId('memory-list')
    // Arm + confirm the first project's (proj-a) clear.
    fireEvent.click((await screen.findAllByTestId('memory-clear'))[0]!)
    fireEvent.click(await screen.findByTestId('memory-clear-confirm'))
    await waitFor(() => {
      const calls = (
        bridge.request as unknown as {
          mock: { calls: Array<[{ action: string }, { dir?: string }]> }
        }
      ).mock.calls
      expect(
        calls.some(
          ([route, payload]) =>
            route.action === 'clear' &&
            payload?.dir === '/resolved/proj-a/memory',
        ),
      ).toBe(true)
    })
    // proj-a's files are gone; proj-b's remain (per-project, not global).
    await waitFor(() => {
      const cards = screen.getAllByTestId('memory-project')
      expect(cards[0]!.textContent ?? '').not.toContain('user_role.md')
    })
    expect(screen.getByTestId('memory-list').textContent ?? '').toContain(
      'proj-b',
    )
  })

  it('rolls back the optimistic toggle when setField rejects', async () => {
    const { bridge } = makeBridge(DEFAULT_VALUES, { failSetField: true })
    renderSection(bridge)

    const recall = await screen.findByTestId('memory-recall')
    expect(recall.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(recall)

    // After the failed write re-reads disk state, the toggle returns to true.
    await waitFor(() => {
      expect(
        screen.getByTestId('memory-recall').getAttribute('aria-checked'),
      ).toBe('true')
    })
  })
})


/**
 * A connection holding less than `full`: the toggles (`memory.snapshot` / `setField`, `observe` / `control`)
 * stay; Saved memories (`memory.list` / `clear`) and Open folder (`ui.revealProjectFolder`) are `full` and go.
 */
describe('MemorySection under a scoped grant', () => {
  it('keeps the toggles and drops Saved memories, without reading the list', async () => {
    const { bridge } = makeBridge()
    renderSection(
      bridge,
      queryFor([{ cap: 'memory', acts: ['snapshot', 'setField'] }]),
    )

    expect(await screen.findByTestId('memory-enable')).toBeTruthy()
    expect(screen.getByTestId('memory-recall')).toBeTruthy()
    expect(screen.queryByText('Saved memories')).toBeNull()
    expect(screen.queryByTestId('memory-list')).toBeNull()
    expect(screen.queryByTestId('memory-empty')).toBeNull()
    expect(requestedActions(bridge)).toContain('snapshot')
    expect(requestedActions(bridge)).not.toContain('list')
  })

  it('lists memories without Clear or Open folder when only the list is granted', async () => {
    // Each row control gates on its own action, not on the list's.
    const { bridge } = makeBridge()
    renderSection(
      bridge,
      queryFor([{ cap: 'memory', acts: ['snapshot', 'setField', 'list'] }]),
    )

    expect(await screen.findAllByTestId('memory-project')).toHaveLength(2)
    expect(screen.queryByTestId('memory-clear')).toBeNull()
    expect(screen.queryByTestId('memory-open-folder')).toBeNull()
  })

  it('renders every Saved memories control for a full grant', async () => {
    const { bridge } = makeBridge()
    renderSection(
      bridge,
      queryFor([
        { cap: 'memory', acts: ['snapshot', 'setField', 'list', 'clear'] },
        { cap: 'ui', acts: ['revealProjectFolder'] },
      ]),
    )

    expect(await screen.findAllByTestId('memory-project')).toHaveLength(2)
    expect(screen.getAllByTestId('memory-clear')).toHaveLength(2)
    expect(screen.getAllByTestId('memory-open-folder')).toHaveLength(2)
  })
})
