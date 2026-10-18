/**
 * The shell's drawn layout for a session-area width (F-9). The side region
 * splits the room with the chat's slot by its share and keeps its minimum;
 * the slot gives way to 100 while the chat's content keeps 360 under the
 * region; below the two minimums both shrink in proportion to them. The
 * sidebar stays while the slot's and the region's minimums fit beside it, the
 * card stack docks beside a wide enough slot, and no width hides the region.
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
  return { sidebar: { collapsed: false, width: 280 }, panel: CLOSED, ...over }
}

function sweep(base: Omit<ShellLayoutInput, 'areaW'>, from: number, to: number): ShellLayout[] {
  const out: ShellLayout[] = []
  for (let w = from; w >= to; w--) out.push(resolveShellLayout({ ...base, areaW: w }))
  return out
}

describe('resolveShellLayout — slot and content', () => {
  it('the chat content never draws under 360, and is the slot whenever the slot is wider', () => {
    for (const panel of [DIFF, TASKS, CLOSED, open(1 / 3, { floatWidth: 300 })]) {
      for (const collapsed of [false, true]) {
        for (const l of sweep(input({ areaW: 0, panel, sidebar: { collapsed, width: 280 } }), 2000, 200)) {
          expect(l.chatContentW).toBe(Math.max(l.chatW, 360))
        }
      }
    }
  })

  it('no width hides the region or draws it off the row: an open panel stays beside', () => {
    for (const panel of [DIFF, TASKS, open(3 / 5, { minWidth: 480, gutter: 8 })]) {
      for (const l of sweep(input({ areaW: 0, panel }), 2000, 120)) {
        expect(l.panel).toBe('beside')
        expect(l.panelW).toBeGreaterThan(0)
        expect(l.panelOffRowW).toBe(0)
      }
    }
  })

  it('the panel keeps its minimum and the slot 100 while both fit; below, both shrink in proportion', () => {
    for (const l of sweep(input({ areaW: 0, panel: DIFF }), 2000, 120)) {
      const panelRoom = l.chatW + l.panelW
      if (panelRoom >= 100 + 280) {
        expect(l.panelW).toBeGreaterThanOrEqual(280)
        expect(l.chatW).toBeGreaterThanOrEqual(100)
      } else {
        expect(l.chatW).toBe(Math.round((100 * panelRoom) / 380))
        expect(l.chatW).toBeLessThanOrEqual(100)
        expect(l.panelW).toBeLessThan(280)
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

  it('narrowing gives way stack → the slot under the content → sidebar → both in proportion', () => {
    const from = 2400
    const steps = sweep(input({ areaW: 0, panel: DIFF }), from, 200)
    const firstAt = (pred: (l: ShellLayout) => boolean) => from - steps.findIndex(pred)
    const stackGone = firstAt(l => l.stack === 'popover')
    const covered = firstAt(l => l.chatContentW > l.chatW)
    const sidebarGone = firstAt(l => l.sidebar === 'hidden')
    const proportional = firstAt(l => l.panelW < 280)
    expect(stackGone).toBeGreaterThan(covered)
    expect(covered).toBeGreaterThan(sidebarGone)
    expect(sidebarGone).toBeGreaterThan(proportional)
    // The sidebar (280 + its 4px splitter) stays while slot 100 + splitter + panel 280 fit beside it.
    expect(sidebarGone).toBe(284 + 100 + 284 - 1)
    expect(proportional).toBe(100 + 284 - 1)
  })

  it('widening restores the share: the layout is a function of the width alone', () => {
    const narrow = resolveShellLayout(input({ areaW: 500, panel: DIFF }))
    const wide = resolveShellLayout(input({ areaW: 1600, panel: DIFF }))
    expect(narrow.chatContentW).toBeGreaterThan(narrow.chatW)
    expect(resolveShellLayout(input({ areaW: 1600, panel: DIFF }))).toEqual(wide)
    expect(wide).toMatchObject({ panelW: 787, chatW: 525, chatContentW: 525 })
  })
})

describe('resolveShellLayout — sidebar', () => {
  it('beside the chat alone, stays while the chat keeps 360; hiding never changes the preference', () => {
    expect(resolveShellLayout(input({ areaW: 644 }))).toMatchObject({ sidebar: 'expanded', sidebarW: 284 })
    expect(resolveShellLayout(input({ areaW: 643 }))).toMatchObject({ sidebar: 'hidden', sidebarW: 0, chatW: 643 })
    const rail = input({ areaW: 1200, sidebar: { collapsed: true, width: 280 } })
    expect(resolveShellLayout(rail)).toMatchObject({ sidebar: 'rail', sidebarW: 56 })
    expect(resolveShellLayout({ ...rail, areaW: 416 }).sidebar).toBe('rail')
    expect(resolveShellLayout({ ...rail, areaW: 415 }).sidebar).toBe('hidden')
  })

  it('with the panel open, stays while the chat slot minimum and the panel minimum fit beside it', () => {
    expect(resolveShellLayout(input({ areaW: 668, panel: TASKS })).sidebar).toBe('expanded')
    expect(resolveShellLayout(input({ areaW: 667, panel: TASKS })).sidebar).toBe('hidden')
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

  it('keeps its minimum', () => {
    expect(resolveShellLayout(input({ areaW: 1000, panel: TASKS }))).toMatchObject({ panelW: 280, chatW: 432 })
  })

  it('a slot under 360 leaves the content at 360, covered by the panel', () => {
    // Area 1100: room 816, less the splitter 812; 3/5 = 487, slot 325.
    expect(resolveShellLayout(input({ areaW: 1100, panel: DIFF }))).toMatchObject({
      sidebar: 'expanded', panel: 'beside', panelW: 487, chatW: 325, chatContentW: 360,
    })
    // Area 700: room 416, less the splitter 412; the panel at its 280, the slot 132.
    expect(resolveShellLayout(input({ areaW: 700, panel: DIFF }))).toMatchObject({
      sidebar: 'expanded', panel: 'beside', panelW: 280, chatW: 132, chatContentW: 360,
    })
    expect(resolveShellLayout(input({ areaW: 643, panel: DIFF }))).toMatchObject({
      sidebar: 'hidden', panel: 'beside', panelW: 383, chatW: 256, chatContentW: 360,
    })
  })

  it('a separator that set a large share pushes the slot to 100, never under it while both fit', () => {
    expect(resolveShellLayout(input({ areaW: 1600, panel: open(0.99) }))).toMatchObject({
      panelW: 1212, chatW: 100, chatContentW: 360,
    })
  })

  // The browser is a pane of the region: the region's minimum is the browser's
  // 480 and nothing is subtracted from the area before the cascade.
  it('a region holding the browser pane is one region of minimum 480, like any other', () => {
    const browser = open(3 / 5, { minWidth: 480, gutter: 8 })
    // Area 1600: room 1316, less the gutter 1308; 3/5 = 785.
    expect(resolveShellLayout(input({ areaW: 1600, panel: browser }))).toMatchObject({
      sidebar: 'expanded', panel: 'beside', panelW: 785, chatW: 523,
    })
    // Area 1000: the sidebar stays (716 ≥ 100 + 488); the browser at its 480, the slot 228.
    expect(resolveShellLayout(input({ areaW: 1000, panel: browser }))).toMatchObject({
      sidebar: 'expanded', panel: 'beside', panelW: 480, chatW: 228, chatContentW: 360,
    })
    // Area 840: the sidebar hides; room 840, less the gutter 832; 3/5 = 499.
    expect(resolveShellLayout(input({ areaW: 840, panel: browser }))).toMatchObject({
      sidebar: 'hidden', panel: 'beside', panelW: 499, chatW: 333, chatContentW: 360,
    })
    // Area 560: 552 < 100 + 480, so both shrink: the slot 100 × 552 / 580.
    expect(resolveShellLayout(input({ areaW: 560, panel: browser }))).toMatchObject({
      sidebar: 'hidden', panel: 'beside', panelW: 457, chatW: 95, chatContentW: 360,
    })
  })

  it('a maximized panel takes the whole room and hides the chat', () => {
    expect(resolveShellLayout(input({ areaW: 1200, panel: open(1 / 3, { maximized: true }) }))).toMatchObject({
      panel: 'maximized', chatW: 0, chatContentW: 0, panelW: 916, stack: 'popover',
    })
  })

  it('a floating panel stays out of the row at its own width', () => {
    expect(resolveShellLayout(input({ areaW: 1600, panel: open(1 / 3, { floatWidth: 300 }) }))).toMatchObject({
      sidebar: 'expanded', panel: 'float', panelW: 0, panelOffRowW: 300, chatW: 1316,
    })
  })

  it('an area under 360 keeps the content at 360: past the area\'s edge, under the panel', () => {
    expect(resolveShellLayout(input({ areaW: 300 }))).toMatchObject({
      sidebar: 'hidden', panel: 'none', chatW: 300, chatContentW: 360,
    })
    // Room 296 < 100 + 280: the slot 100 × 296 / 380.
    expect(resolveShellLayout(input({ areaW: 300, panel: TASKS }))).toMatchObject({
      sidebar: 'hidden', panel: 'beside', chatW: 78, panelW: 218, chatContentW: 360,
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
    // Beside the panel the others need the chat slot's 100 and the panel's 280 + splitter.
    const beside = resolveShellLayout(input({ areaW: 1000, panel: DIFF }))
    expect(beside.sidebarMaxW).toBe(1000 - 4 - 384)
    const at = (width: number) =>
      resolveShellLayout(input({ areaW: 1000, panel: DIFF, sidebar: { collapsed: false, width } })).sidebar
    expect(at(beside.sidebarMaxW)).toBe('expanded')
    expect(at(beside.sidebarMaxW + 1)).toBe('hidden')
    expect(resolveShellLayout(input({ areaW: 1600 })).sidebarMaxW).toBe(1600 - 4 - 360)
  })
})

describe('resolveShellLayout — the panel gap', () => {
  it('a gutter in place of the splitter takes its width from the room the panel splits', () => {
    const base = input({ areaW: 1600, panel: DIFF })
    const splitter = resolveShellLayout(base)
    const gutter = resolveShellLayout({ ...base, panel: { ...DIFF, gutter: 8 } })
    expect(splitter.panel).toBe('beside')
    expect(gutter.panel).toBe('beside')
    expect(gutter.chatW + gutter.panelW).toBe(splitter.chatW + splitter.panelW - 4)
  })
})
