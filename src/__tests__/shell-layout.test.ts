/**
 * The shell's drawn layout for a session-area width (F-9). Priority, highest
 * first: the chat, the Right Panel, the sidebar, the docked card stack — so as
 * the area narrows the stack goes first, then the panel's width, then the
 * sidebar, then the panel, and the chat keeps its 360 minimum throughout. The
 * panel's width is a share of the room it splits with the chat.
 */
import { describe, expect, it } from 'vitest'

import {
  resolveShellLayout,
  type ShellLayout,
  type ShellLayoutInput,
} from '@/browser/webview/layout/shellLayout'

type PanelInput = ShellLayoutInput['panel']

const CLOSED: PanelInput = {
  visible: false, maximized: false, share: 1 / 3, minWidth: 280, maxWidth: Infinity, floatWidth: null,
}
const open = (share: number, over: Partial<PanelInput> = {}): PanelInput => ({
  ...CLOSED, visible: true, share, ...over,
})
const DIFF = open(3 / 5)
const TASKS = open(1 / 3)

function input(over: Partial<ShellLayoutInput> & { areaW: number }): ShellLayoutInput {
  return { sidebar: { collapsed: false, width: 280 }, panel: CLOSED, browserW: 0, ...over }
}

function sweep(base: Omit<ShellLayoutInput, 'areaW'>, from: number, to: number): ShellLayout[] {
  const out: ShellLayout[] = []
  for (let w = from; w >= to; w--) out.push(resolveShellLayout({ ...base, areaW: w }))
  return out
}

describe('resolveShellLayout — priority order', () => {
  it('regions give way stack → panel width → sidebar → panel, one at a time', () => {
    const from = 2400
    const steps = sweep(input({ areaW: 0, panel: DIFF }), from, 360)
    const firstAt = (pred: (l: ShellLayout) => boolean) => from - steps.findIndex(pred)
    // The diff's share wants 3/5 of the room the panel splits with the chat.
    const wantOf = (l: ShellLayout) => Math.round(0.6 * (l.panelW + l.chatW))
    const stackGone = firstAt(l => l.stack === 'popover')
    const panelShrinks = firstAt(l => l.panel === 'beside' && l.panelW < wantOf(l))
    const sidebarGone = firstAt(l => l.sidebar === 'hidden')
    const panelGone = firstAt(l => l.panel === 'overlay')
    expect(stackGone).toBeGreaterThan(panelShrinks)
    expect(panelShrinks).toBeGreaterThan(sidebarGone)
    expect(sidebarGone).toBeGreaterThan(panelGone)
    // Splitters: 4px beside the expanded sidebar and beside the panel.
    expect(sidebarGone).toBe(284 + 284 + 360 - 1)
    expect(panelGone).toBe(284 + 360 - 1)
  })

  it('the chat never draws under its 360 minimum while the area has 360', () => {
    for (const panel of [DIFF, TASKS, CLOSED]) {
      for (const collapsed of [false, true]) {
        for (const l of sweep(input({ areaW: 0, panel, sidebar: { collapsed, width: 280 } }), 2000, 360)) {
          expect(l.chatW).toBeGreaterThanOrEqual(360)
          expect(l.chatClipped).toBe(false)
        }
      }
    }
  })

  it('the drawn regions always add up to the area', () => {
    for (let w = 2000; w >= 200; w--) {
      for (const panel of [DIFF, TASKS, CLOSED, open(1 / 3, { floatWidth: 300 })]) {
        const l = resolveShellLayout(input({ areaW: w, panel }))
        expect(l.sidebarW + l.panelW + (l.panel === 'beside' ? 4 : 0) + l.chatW).toBe(w)
      }
    }
  })
})

describe('resolveShellLayout — sidebar', () => {
  it('stays while the chat keeps 360 beside it, whatever its form; hiding never changes the preference', () => {
    expect(resolveShellLayout(input({ areaW: 644 }))).toMatchObject({ sidebar: 'expanded', sidebarW: 284 })
    expect(resolveShellLayout(input({ areaW: 643 }))).toMatchObject({ sidebar: 'hidden', sidebarW: 0, chatW: 643 })
    const rail = input({ areaW: 1200, sidebar: { collapsed: true, width: 280 } })
    expect(resolveShellLayout(rail)).toMatchObject({ sidebar: 'rail', sidebarW: 56 })
    expect(resolveShellLayout({ ...rail, areaW: 416 }).sidebar).toBe('rail')
    expect(resolveShellLayout({ ...rail, areaW: 415 }).sidebar).toBe('hidden')
  })

  it('with the panel open, stays while the chat and the panel at its minimum fit beside it', () => {
    expect(resolveShellLayout(input({ areaW: 928, panel: TASKS })).sidebar).toBe('expanded')
    expect(resolveShellLayout(input({ areaW: 927, panel: TASKS })).sidebar).toBe('hidden')
  })
})

describe('resolveShellLayout — Right Panel width', () => {
  it('is its share of the room it splits with the chat, so it scales with the window', () => {
    // Area 1600: room beside the sidebar 1316, less the panel splitter 1312.
    expect(resolveShellLayout(input({ areaW: 1600, panel: TASKS }))).toMatchObject({
      panel: 'beside', panelW: 437, chatW: 875,
    })
    expect(resolveShellLayout(input({ areaW: 2000, panel: TASKS }))).toMatchObject({
      panel: 'beside', panelW: 571, chatW: 1141,
    })
    expect(resolveShellLayout(input({ areaW: 1600, panel: DIFF }))).toMatchObject({
      panel: 'beside', panelW: 787, chatW: 525,
    })
  })

  it('keeps its minimum, and the compact maximum beside a docked browser', () => {
    expect(resolveShellLayout(input({ areaW: 1000, panel: TASKS }))).toMatchObject({ panelW: 280, chatW: 432 })
    const compact = open(3 / 5, { minWidth: 240, maxWidth: 360 })
    expect(resolveShellLayout(input({ areaW: 1600, panel: compact, browserW: 484 }))).toMatchObject({
      sidebarW: 284, panelW: 360, chatW: 468,
    })
  })

  it('narrows below its share to keep the chat 360, then to its minimum, then becomes an overlay', () => {
    expect(resolveShellLayout(input({ areaW: 1100, panel: DIFF }))).toMatchObject({
      sidebar: 'expanded', panel: 'beside', panelW: 452, chatW: 360,
    })
    expect(resolveShellLayout(input({ areaW: 700, panel: DIFF }))).toMatchObject({
      sidebar: 'hidden', panel: 'beside', panelW: 336, chatW: 360,
    })
    expect(resolveShellLayout(input({ areaW: 643, panel: DIFF }))).toMatchObject({
      sidebar: 'hidden', panel: 'overlay', panelW: 0, panelOffRowW: 383, chatW: 643, chatClipped: false,
    })
  })

  it('a maximized panel takes the whole room and hides the chat', () => {
    expect(resolveShellLayout(input({ areaW: 1200, panel: open(1 / 3, { maximized: true }) }))).toMatchObject({
      panel: 'maximized', chatW: 0, panelW: 916, chatClipped: false, stack: 'popover',
    })
  })

  it('a floating panel stays out of the row at its own width', () => {
    expect(resolveShellLayout(input({ areaW: 1600, panel: open(1 / 3, { floatWidth: 300 }) }))).toMatchObject({
      sidebar: 'expanded', panel: 'float', panelW: 0, panelOffRowW: 300, chatW: 1316,
    })
  })

  it('an area under 360 clips the chat rather than squeezing it', () => {
    expect(resolveShellLayout(input({ areaW: 300, panel: TASKS }))).toMatchObject({
      sidebar: 'hidden', panel: 'overlay', chatW: 300, chatClipped: true,
    })
  })
})

describe('resolveShellLayout — card stack', () => {
  it('docks when the chat is at least 651 wide, otherwise a popover', () => {
    expect(resolveShellLayout(input({ areaW: 935 })).stack).toBe('docked') // chat 651
    expect(resolveShellLayout(input({ areaW: 934 })).stack).toBe('popover')
    expect(resolveShellLayout(input({ areaW: 1300, panel: TASKS }))).toMatchObject({ chatW: 675, stack: 'docked' })
    expect(resolveShellLayout(input({ areaW: 1250, panel: TASKS }))).toMatchObject({ chatW: 641, stack: 'popover' })
  })

  it('a maximized panel leaves the stack where the chat beside the panel has it', () => {
    expect(resolveShellLayout(input({ areaW: 1300, panel: open(1 / 3, { maximized: true }) }))).toMatchObject({
      panel: 'maximized', chatW: 0, stack: 'docked',
    })
    expect(resolveShellLayout(input({ areaW: 1250, panel: open(1 / 3, { maximized: true }) })).stack).toBe('popover')
  })
})

describe('resolveShellLayout — sidebar drag limit', () => {
  it('is the widest expanded sidebar that stays docked', () => {
    // Beside the panel the others need the chat's 360 and the panel's 280 + splitter.
    const beside = resolveShellLayout(input({ areaW: 1000, panel: DIFF }))
    expect(beside.sidebarMaxW).toBe(1000 - 4 - 644)
    const at = (width: number) =>
      resolveShellLayout(input({ areaW: 1000, panel: DIFF, sidebar: { collapsed: false, width } })).sidebar
    expect(at(beside.sidebarMaxW)).toBe('expanded')
    expect(at(beside.sidebarMaxW + 1)).toBe('hidden')
    expect(resolveShellLayout(input({ areaW: 1600 })).sidebarMaxW).toBe(1600 - 4 - 360)
  })
})
