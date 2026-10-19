// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'

/**
 * The virtualized list's wiring: a short transcript renders every row; a long one renders a window plus spacers of
 * the same total height; culled rows come back without their entry animation; a touched row keeps its DOM; a
 * backgrounded thread's window is frozen. Rows use a stubbed rect of `ESTIMATED_MESSAGE_HEIGHT_PX`.
 */

// `stubs`: rows assistant-ui currently holds as contentless stubs (see
// `historyContentWindow.ts`) — what the thread's windowing hands it.
const thread = { count: 0, stubs: new Set<number>() }

vi.mock('@assistant-ui/react', async () => {
  const { createElement: h } = await import('react')
  return {
    useAssistantState: (selector: (state: unknown) => unknown) =>
      selector({
        thread: {
          messages: Array.from({ length: thread.count }, (_, index) =>
            thread.stubs.has(index)
              ? { metadata: { custom: { contentWindowStub: true } } }
              : {},
          ),
        },
      }),
    ThreadPrimitive: {
      MessageByIndex: ({ index }: { index: number }) =>
        h('span', { 'data-testid': `msg-${index}` }, `message ${index}`),
    },
  }
})

const { VirtualizedThreadMessages } = await import(
  '../components/assistant-ui/virtualized-thread-messages'
)
const { ESTIMATED_MESSAGE_HEIGHT_PX, MAX_SYNC_REWINDOW_PASSES, MESSAGE_TAIL_KEEP } =
  await import(
  '../browser/webview/messageVirtualization'
)
const { HistoryContentWindowContext } = await import(
  '../browser/webview/historyContentWindow'
)

// Every row list the virtualizer published, in order.
let published: number[][] = []

const VIEWPORT_HEIGHT = 600
const ROW_HEIGHT = ESTIMATED_MESSAGE_HEIGHT_PX

let viewport: HTMLDivElement
const originalGetRect = Element.prototype.getBoundingClientRect

const rect = (top: number, height: number): DOMRect =>
  ({
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 0,
    width: 0,
    x: 0,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect

function mountList(
  count: number,
  isForeground = true,
  withContentWindow = false,
  compensateScroll: (deltaPx: number) => void = () => {},
): void {
  thread.count = count
  const viewportRef = { current: viewport }
  const list = createElement(VirtualizedThreadMessages, {
    viewportRef,
    isForeground,
    compensateScroll,
    components: {} as never,
  })
  act(() => {
    render(
      withContentWindow
        ? createElement(
            HistoryContentWindowContext.Provider,
            {
              value: {
                wanted: null,
                publish: rows => {
                  published.push([...rows])
                },
              },
            },
            list,
          )
        : list,
      { container: viewport, baseElement: document.body },
    )
  })
}

function scrollTo(top: number): void {
  act(() => {
    Object.defineProperty(viewport, 'scrollTop', {
      value: top,
      configurable: true,
      writable: true,
    })
    viewport.dispatchEvent(new Event('scroll'))
  })
}

const slots = (): HTMLElement[] =>
  Array.from(viewport.querySelectorAll<HTMLElement>('[data-message-index]'))

const renderedIndices = (): number[] =>
  slots().map(el => Number(el.dataset.messageIndex))

const spacerHeights = (): number[] =>
  Array.from(
    viewport.querySelectorAll<HTMLElement>('[data-slot="message-spacer"]'),
  ).map(el => Number.parseFloat(el.style.height))

beforeEach(() => {
  thread.stubs = new Set()
  published = []
  viewport = document.createElement('div')
  document.body.append(viewport)
  Object.defineProperty(viewport, 'clientHeight', {
    value: VIEWPORT_HEIGHT,
    configurable: true,
  })
  Object.defineProperty(viewport, 'scrollTop', {
    value: 0,
    configurable: true,
    writable: true,
  })
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const index = (this as HTMLElement).dataset?.messageIndex
    if (index === undefined) return rect(0, VIEWPORT_HEIGHT)
    return rect(Number(index) * ROW_HEIGHT - viewport.scrollTop, ROW_HEIGHT)
  }
})

afterEach(() => {
  cleanup()
  Element.prototype.getBoundingClientRect = originalGetRect
  viewport.remove()
})

describe('VirtualizedThreadMessages', () => {
  it('mounts every row of a short transcript — nothing is culled', () => {
    mountList(MESSAGE_TAIL_KEEP)
    expect(renderedIndices()).toEqual(
      Array.from({ length: MESSAGE_TAIL_KEEP }, (_, i) => i),
    )
    expect(spacerHeights()).toEqual([])
  })

  it('opts every slot out of flex shrinking', () => {
    // The viewport is a flex column. A spacer is an empty div, so its content
    // minimum is zero and `flex-shrink: 1` squeezes it flat — the whole
    // stand-in for the culled rows collapses, the DOM ends up thousands of
    // pixels shorter than the height table says, and the computed window lands
    // on the wrong rows entirely. (Observed: a 5591px spacer rendering at 0px.)
    mountList(100)
    const boxes = [
      ...viewport.querySelectorAll<HTMLElement>('[data-slot="message-slot"]'),
      ...viewport.querySelectorAll<HTMLElement>('[data-slot="message-spacer"]'),
    ]
    expect(boxes.length).toBeGreaterThan(1)
    for (const box of boxes) {
      expect(box.className.split(/\s+/)).toContain('shrink-0')
    }
  })

  it('renders nothing for an empty transcript', () => {
    mountList(0)
    expect(renderedIndices()).toEqual([])
    expect(spacerHeights()).toEqual([])
  })

  it('windows a long transcript and preserves total scroll height', () => {
    const count = 100
    mountList(count)
    // Opened at scrollTop 0, so the head is in the window and the middle is
    // culled.
    const indices = renderedIndices()
    expect(indices).toContain(0)
    expect(indices).not.toContain(50)
    expect(indices.length).toBeLessThan(count)

    const culled = count - indices.length
    const spacerTotal = spacerHeights().reduce((a, b) => a + b, 0)
    expect(spacerTotal).toBe(culled * ROW_HEIGHT)
  })

  it('keeps the tail mounted but occluded when the window is at the top', () => {
    const count = 100
    mountList(count)
    const dormant = slots()
      .filter(el => el.dataset.slotState === 'dormant')
      .map(el => Number(el.dataset.messageIndex))
    // Everything the window doesn't cover but the tail rule keeps.
    expect(dormant).toContain(count - 1)
    expect(dormant).toContain(count - MESSAGE_TAIL_KEEP)
    expect(dormant).not.toContain(0)

    // Occluded, not collapsed: the frozen height keeps its box.
    const last = viewport.querySelector<HTMLElement>(
      `[data-message-index="${count - 1}"]`,
    )
    expect(last?.style.contentVisibility).toBe('auto')
    expect(last?.style.minHeight).toBe(`${ROW_HEIGHT}px`)
  })

  it('brings culled rows back when the user scrolls to them', () => {
    mountList(100)
    expect(renderedIndices()).not.toContain(50)
    scrollTo(50 * ROW_HEIGHT)
    const indices = renderedIndices()
    expect(indices).toContain(50)
    expect(indices).not.toContain(0)
  })

  it('marks a restored row so it does not replay its entry animation', () => {
    mountList(100)
    // Row 0 was mounted (and measured) on open, then culled, then restored.
    expect(
      viewport.querySelector<HTMLElement>('[data-message-index="0"]')?.dataset
        .restored,
    ).toBe('true')
    scrollTo(50 * ROW_HEIGHT)
    expect(renderedIndices()).not.toContain(0)
    scrollTo(0)
    expect(
      viewport.querySelector<HTMLElement>('[data-message-index="0"]')?.dataset
        .restored,
    ).toBe('true')
  })

  it('keeps a row the user interacted with mounted after scrolling away', () => {
    mountList(100)
    const row = viewport.querySelector<HTMLElement>('[data-message-index="3"]')
    expect(row).not.toBeNull()

    act(() => {
      row!.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    scrollTo(80 * ROW_HEIGHT)

    const indices = renderedIndices()
    // Its unpinned neighbours are gone; it is not.
    expect(indices).not.toContain(2)
    expect(indices).not.toContain(4)
    expect(indices).toContain(3)
    expect(
      viewport.querySelector<HTMLElement>('[data-message-index="3"]')?.dataset
        .slotState,
    ).toBe('dormant')
  })

  it('freezes the window while the thread is in the background', () => {
    const count = 100
    // A hidden thread has no layout; its scroll position says nothing, so the
    // list keeps the initial tail window rather than re-deriving one.
    mountList(count, false)
    const indices = renderedIndices()
    expect(indices).toContain(count - 1)
    expect(indices).not.toContain(0)
    scrollTo(0)
    expect(renderedIndices()).not.toContain(0)
  })

  it('publishes the rows it keeps: window, tail and pins', () => {
    const count = 100
    mountList(count, true, true)
    scrollTo(0)
    const last = published.at(-1)!
    expect(last).toContain(0)
    expect(last).toContain(count - 1)
    expect(last).not.toContain(50)
    // Ascending, and no row twice.
    expect([...last].sort((a, b) => a - b)).toEqual(last)
    expect(new Set(last).size).toBe(last.length)
  })

  it('never mounts a row assistant-ui still holds as a stub', () => {
    const count = 100
    // The runtime applies new messages a commit behind the thread, so a row
    // can be in the window while assistant-ui still has its stub.
    thread.stubs = new Set(Array.from({ length: count - MESSAGE_TAIL_KEEP }, (_, i) => i))
    mountList(count, true, true)
    scrollTo(0)
    expect(renderedIndices()).not.toContain(0)
    // The stubbed rows still occupy their height, inside a spacer.
    const spacerTotal = spacerHeights().reduce((sum, h) => sum + h, 0)
    expect(spacerTotal + renderedIndices().length * ROW_HEIGHT).toBe(count * ROW_HEIGHT)
    // Content arrives (the mock state isn't reactive, so a scroll that moves
    // the window stands in for the store update's re-render): the row mounts.
    thread.stubs = new Set()
    scrollTo(2 * ROW_HEIGHT)
    expect(renderedIndices()).toContain(0)
  })

  it('spreads a re-measure loop over tasks instead of exceeding the nested-update limit', () => {
    // Rows whose measured height changes on every read, above the viewport so
    // each pass compensates the scroll position and moves the window: without
    // a per-task cap this chains commits until React throws.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const flipped = new WeakSet<Element>()
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      const index = (this as HTMLElement).dataset?.messageIndex
      if (index === undefined) return rect(0, VIEWPORT_HEIGHT)
      const short = !flipped.has(this)
      if (short) flipped.add(this)
      else flipped.delete(this)
      return rect(-100_000, short ? 20 : 2000)
    }
    const count = 3000
    viewport.scrollTop = count * ROW_HEIGHT - VIEWPORT_HEIGHT
    let compensations = 0
    const compensate = (delta: number): void => {
      compensations++
      viewport.scrollTop = Math.max(0, viewport.scrollTop + delta)
    }
    try {
      expect(() => mountList(count, true, false, compensate)).not.toThrow()
      const firstTask = compensations
      expect(firstTask).toBeGreaterThan(0)
      expect(firstTask).toBeLessThanOrEqual(MAX_SYNC_REWINDOW_PASSES)
      // The deferred passes continue on later tasks, each one capped too.
      for (let task = 0; task < 5; task++) {
        const before = compensations
        expect(() => {
          act(() => {
            vi.advanceTimersByTime(1)
          })
        }).not.toThrow()
        expect(compensations).toBeGreaterThan(before)
        expect(compensations - before).toBeLessThanOrEqual(MAX_SYNC_REWINDOW_PASSES)
      }
      expect(renderedIndices().length).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
