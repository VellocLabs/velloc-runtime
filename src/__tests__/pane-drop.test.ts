/**
 * The drop zones of a pane drag (F-9): the area's edge strips, the gutters
 * between siblings, each other pane's outer strips, the chat's left and
 * right strips only; nothing at the source's own slot; and the pick of a
 * zone for a point.
 */
import { describe, expect, it } from 'vitest'

import { paneDropTargetAt, paneDropTargets, type PaneDropZone } from '@/browser/webview/layout/paneDrop'
import { resolveAreaGeometry } from '@/browser/webview/layout/paneGeometry'
import {
  defaultPaneLayout,
  placePane,
  type PaneDropTarget,
  type PaneLayout,
  type SidePaneKind,
} from '@/browser/webview/layout/paneLayout'

const chatColumn = () =>
  placePane(placePane(defaultPaneLayout(), 'diff', { weight: 3 }), 'tasks', { weight: 1 })
const threeInRow = (): PaneLayout => ({
  root: {
    id: 'root',
    axis: 'row',
    weight: 1,
    children: [
      { pane: 'chat', weight: 2 },
      { pane: 'diff', weight: 3 },
      { pane: 'tasks', weight: 1 },
    ],
  },
})

function zonesFor(layout: PaneLayout, source: SidePaneKind): PaneDropZone[] {
  const geometry = resolveAreaGeometry({
    layout,
    maximized: null,
    form: 'beside',
    width: 1508,
    height: 600,
    chatWidth: 600,
    seatWidth: 0,
    gutter: 8,
  })
  return paneDropTargets({
    layout,
    source,
    width: 1508,
    height: 600,
    chat: geometry.chat,
    panes: geometry.panes,
    separators: geometry.separators,
  })
}

const targetAt = (zones: PaneDropZone[], x: number, y: number): PaneDropTarget | null =>
  paneDropTargetAt(zones, x, y)?.target ?? null

describe('paneDropTargets', () => {
  // Tasks below Diff in a column beside the chat: chat 0..600, the cards at
  // 608..1500, Diff 8..296, Tasks 304..592.
  it('offers the edges, the gutters, the other panes’ strips and the chat’s two strips', () => {
    const zones = zonesFor(chatColumn(), 'tasks')
    expect(zones.map(zone => zone.target)).toEqual([
      { type: 'edge', side: 'start' },
      { type: 'edge', side: 'end' },
      { type: 'insert', groupId: 'root', index: 1 },
      { type: 'wrap', pane: 'diff', side: 'left' },
      { type: 'wrap', pane: 'diff', side: 'right' },
      { type: 'wrap', pane: 'diff', side: 'top' },
      { type: 'edge', side: 'start' },
      { type: 'insert', groupId: 'root', index: 1 },
    ])
    // The edge strips are 24px; a gutter's hit area is the separator's 12px and its indicator 24px.
    expect(zones[0].hit).toEqual({ left: 0, top: 0, width: 24, height: 600 })
    expect(zones[1].hit).toEqual({ left: 1484, top: 0, width: 24, height: 600 })
    expect(zones[2].hit).toEqual({ left: 598, top: 0, width: 12, height: 600 })
    expect(zones[2].indicator).toEqual({ left: 592, top: 0, width: 24, height: 600 })
    // A wrap strip is a quarter of the card; its indicator the half the pane would get.
    expect(zones[3].hit).toEqual({ left: 608, top: 8, width: 223, height: 288 })
    expect(zones[3].indicator).toEqual({ left: 608, top: 8, width: 446, height: 288 })
    expect(zones[5].hit).toEqual({ left: 831, top: 8, width: 446, height: 72 })
    expect(zones[5].indicator).toEqual({ left: 608, top: 8, width: 892, height: 144 })
    // The chat's strips: a quarter of its width each, the left one to the area's edge strip.
    expect(zones[6].hit).toEqual({ left: 0, top: 0, width: 150, height: 600 })
    expect(zones[6].indicator).toEqual({ left: 0, top: 0, width: 24, height: 600 })
    expect(zones[7].hit).toEqual({ left: 450, top: 0, width: 150, height: 600 })
    expect(zones[7].indicator).toEqual({ left: 592, top: 0, width: 24, height: 600 })
  })

  it('the source’s own slot offers nothing: its gutters, the end it sits at, a wrap that faces it', () => {
    // Tasks last in the root row: no end edge, no gutter beside it, no wrap right of Diff.
    const tasks = zonesFor(threeInRow(), 'tasks').map(zone => zone.target)
    expect(tasks).toEqual([
      { type: 'edge', side: 'start' },
      { type: 'insert', groupId: 'root', index: 1 },
      { type: 'wrap', pane: 'diff', side: 'left' },
      { type: 'wrap', pane: 'diff', side: 'top' },
      { type: 'wrap', pane: 'diff', side: 'bottom' },
      { type: 'edge', side: 'start' },
      { type: 'insert', groupId: 'root', index: 1 },
    ])
    // Diff right after the chat: the chat's right strip is its own slot, as is both gutters.
    const diff = zonesFor(threeInRow(), 'diff').map(zone => zone.target)
    expect(diff).toEqual([
      { type: 'edge', side: 'start' },
      { type: 'edge', side: 'end' },
      { type: 'wrap', pane: 'tasks', side: 'right' },
      { type: 'wrap', pane: 'tasks', side: 'top' },
      { type: 'wrap', pane: 'tasks', side: 'bottom' },
      { type: 'edge', side: 'start' },
    ])
  })

  it('the chat is never wrapped: its top and bottom are inert, its sides stand for the row’s ends', () => {
    const zones = zonesFor(chatColumn(), 'tasks')
    expect(targetAt(zones, 300, 10)).toBeNull()
    expect(targetAt(zones, 300, 590)).toBeNull()
    expect(targetAt(zones, 100, 300)).toEqual({ type: 'edge', side: 'start' })
    expect(targetAt(zones, 500, 300)).toEqual({ type: 'insert', groupId: 'root', index: 1 })
    expect(zones.some(zone => zone.target.type === 'wrap' && (zone.target.pane as string) === 'chat')).toBe(false)
  })

  it('a pane first in the root row has no start edge and no left strip of the chat', () => {
    const layout: PaneLayout = {
      root: {
        id: 'root',
        axis: 'row',
        weight: 1,
        children: [
          { pane: 'tasks', weight: 1 },
          { pane: 'chat', weight: 2 },
          { pane: 'diff', weight: 3 },
        ],
      },
    }
    const targets = zonesFor(layout, 'tasks').map(zone => zone.target)
    expect(targets.filter(target => target.type === 'edge')).toEqual([{ type: 'edge', side: 'end' }])
    expect(targets).toContainEqual({ type: 'insert', groupId: 'root', index: 2 })
  })

  it('an absent source offers nothing', () => {
    expect(zonesFor(chatColumn(), 'plan')).toEqual([])
  })
})

describe('paneDropTargetAt', () => {
  it('picks the first zone under the point: edges, then gutters, then strips; nothing elsewhere', () => {
    const zones = zonesFor(chatColumn(), 'tasks')
    expect(targetAt(zones, 10, 300)).toEqual({ type: 'edge', side: 'start' })
    expect(targetAt(zones, 1490, 300)).toEqual({ type: 'edge', side: 'end' })
    expect(targetAt(zones, 604, 300)).toEqual({ type: 'insert', groupId: 'root', index: 1 })
    expect(targetAt(zones, 620, 100)).toEqual({ type: 'wrap', pane: 'diff', side: 'left' })
    expect(targetAt(zones, 1400, 100)).toEqual({ type: 'wrap', pane: 'diff', side: 'right' })
    expect(targetAt(zones, 1000, 50)).toEqual({ type: 'wrap', pane: 'diff', side: 'top' })
    // Diff's bottom strip faces the source; Diff's middle, the gutter beside
    // the source and the source's own card are inert.
    expect(targetAt(zones, 1000, 250)).toBeNull()
    expect(targetAt(zones, 1000, 150)).toBeNull()
    expect(targetAt(zones, 1000, 300)).toBeNull()
    expect(targetAt(zones, 1000, 400)).toBeNull()
    expect(targetAt(zones, -5, 300)).toBeNull()
  })
})
