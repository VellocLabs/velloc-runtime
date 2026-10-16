/**
 * The shell's drawn layout for a session-area width (F-9). Priority, highest
 * first: the chat, the Right Panel, the sidebar, the docked card stack — so as
 * the area narrows the stack goes first, then the panel's width, then the
 * sidebar, then the panel, and the chat keeps its 360 minimum throughout.
 */
import { describe, expect, it } from 'vitest'

import {
  resolveShellLayout,
  type ShellLayout,
  type ShellLayoutInput,
} from '@/browser/webview/layout/shellLayout'

const OPEN = { visible: true, maximized: false, width: 442, minWidth: 280 }

function input(over: Partial<ShellLayoutInput> & { areaW: number }): ShellLayoutInput {
  return {
    sidebar: { collapsed: false, width: 280 },
    panel: { visible: false, maximized: false, width: 442, minWidth: 280 },
    browserW: 0,
    ...over,
  }
}

function sweep(base: Omit<ShellLayoutInput, 'areaW'>, from: number, to: number): ShellLayout[] {
  const out: ShellLayout[] = []
  for (let w = from; w >= to; w--) out.push(resolveShellLayout({ ...base, areaW: w }))
  return out
}

describe('resolveShellLayout — priority order', () => {
  it('with the panel open, regions give way stack → panel width → sidebar → panel, one at a time', () => {
    const steps = sweep(input({ areaW: 0, panel: OPEN }), 1800, 320)
    const firstAt = (pred: (l: ShellLayout) => boolean) => 1800 - steps.findIndex(pred)
    const stackGone = firstAt(l => l.stack === 'popover')
    const panelShrinks = firstAt(l => l.panel === 'beside' && l.panelW < 442)
    const sidebarGone = firstAt(l => l.sidebar === 'hidden')
    const panelGone = firstAt(l => l.panel === 'overlay')
    // Splitters: 4px beside the expanded sidebar and beside the panel.
    expect(stackGone).toBe(284 + 446 + 651 - 1)
    expect(panelShrinks).toBe(284 + 446 + 360 - 1)
    expect(sidebarGone).toBe(284 + 284 + 360 - 1)
    expect(panelGone).toBe(284 + 360 - 1)
    expect(stackGone).toBeGreaterThan(panelShrinks)
    expect(panelShrinks).toBeGreaterThan(sidebarGone)
    expect(sidebarGone).toBeGreaterThan(panelGone)
  })

  it('the chat never draws under its 360 minimum while the area has 360', () => {
    for (const panel of [OPEN, { ...OPEN, visible: false }]) {
      for (const collapsed of [false, true]) {
        for (const l of sweep(input({ areaW: 0, panel, sidebar: { collapsed, width: 280 } }), 1800, 360)) {
          expect(l.chatW).toBeGreaterThanOrEqual(360)
          expect(l.chatClipped).toBe(false)
        }
      }
    }
  })

  it('the drawn regions always add up to the area', () => {
    for (let w = 1600; w >= 200; w--) {
      for (const panel of [OPEN, { ...OPEN, visible: false }]) {
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
})

describe('resolveShellLayout — Right Panel', () => {
  it('keeps its width while the chat has 360 beside it, then shrinks to its minimum, then becomes an overlay', () => {
    expect(resolveShellLayout(input({ areaW: 1100, panel: OPEN }))).toMatchObject({
      panel: 'beside', panelW: 442, chatW: 370,
    })
    expect(resolveShellLayout(input({ areaW: 950, panel: OPEN }))).toMatchObject({
      sidebar: 'expanded', panel: 'beside', panelW: 302, chatW: 360,
    })
    expect(resolveShellLayout(input({ areaW: 700, panel: OPEN }))).toMatchObject({
      sidebar: 'hidden', panel: 'beside', panelW: 336, chatW: 360,
    })
    expect(resolveShellLayout(input({ areaW: 643, panel: OPEN }))).toMatchObject({
      sidebar: 'hidden', panel: 'overlay', panelW: 0, chatW: 643, chatClipped: false,
    })
  })

  it('subtracts the docked browser first', () => {
    const out = resolveShellLayout(input({ areaW: 1600, panel: OPEN, browserW: 484 }))
    expect(out).toMatchObject({ sidebarW: 284, panelW: 442, chatW: 386 })
  })

  it('a maximized panel takes the whole room and hides the chat', () => {
    const max = { ...OPEN, maximized: true }
    expect(resolveShellLayout(input({ areaW: 1200, panel: max }))).toMatchObject({
      panel: 'maximized', chatW: 0, panelW: 916, chatClipped: false, stack: 'popover',
    })
  })

  it('an area under 360 clips the chat rather than squeezing it', () => {
    expect(resolveShellLayout(input({ areaW: 300, panel: OPEN }))).toMatchObject({
      sidebar: 'hidden', panel: 'overlay', chatW: 300, chatClipped: true,
    })
  })
})

describe('resolveShellLayout — card stack', () => {
  it('docks when the chat is at least 651 wide, otherwise a popover', () => {
    expect(resolveShellLayout(input({ areaW: 935 })).stack).toBe('docked') // chat 651
    expect(resolveShellLayout(input({ areaW: 934 })).stack).toBe('popover')
    expect(resolveShellLayout(input({ areaW: 1381, panel: OPEN })).stack).toBe('docked')
    expect(resolveShellLayout(input({ areaW: 1380, panel: OPEN })).stack).toBe('popover')
  })
})
