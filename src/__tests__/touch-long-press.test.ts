// @vitest-environment happy-dom
/**
 * The touch long-press that stands in for a right-click (F-24): a still finger
 * held `LONG_PRESS_MS` dispatches one `contextmenu` at the touch point; mouse,
 * movement, lifting early and a cancelled pointer do not; a browser's own
 * `contextmenu` for the same press is not doubled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  attachTouchLongPress,
  LONG_PRESS_MS,
  LONG_PRESS_SLOP_PX,
} from '../components/assistant-ui/touch-long-press'

function pointer(type: string, init: { pointerType?: string; x?: number; y?: number; isPrimary?: boolean } = {}) {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    pointerType: init.pointerType ?? 'touch',
    isPrimary: init.isPrimary ?? true,
    clientX: init.x ?? 40,
    clientY: init.y ?? 60,
  })
  return event
}

let list: HTMLElement
let row: HTMLElement
let menus: MouseEvent[]
let detach: () => void
const onMenu = (event: Event) => {
  menus.push(event as MouseEvent)
  event.preventDefault()
}

beforeEach(() => {
  vi.useFakeTimers()
  list = document.createElement('div')
  row = document.createElement('p')
  list.appendChild(row)
  document.body.appendChild(list)
  menus = []
  list.addEventListener('contextmenu', onMenu)
  detach = attachTouchLongPress(list)
})

afterEach(() => {
  detach()
  list.remove()
  vi.useRealTimers()
})

describe('attachTouchLongPress', () => {
  it('a held touch opens one menu at the touch point, on the pressed element', () => {
    row.dispatchEvent(pointer('pointerdown', { x: 33, y: 77 }))
    vi.advanceTimersByTime(LONG_PRESS_MS - 1)
    expect(menus).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(menus).toHaveLength(1)
    expect(menus[0].target).toBe(row)
    expect([menus[0].clientX, menus[0].clientY]).toEqual([33, 77])
  })

  it('a mouse or pen press never opens it', () => {
    for (const pointerType of ['mouse', 'pen']) {
      row.dispatchEvent(pointer('pointerdown', { pointerType }))
      vi.advanceTimersByTime(LONG_PRESS_MS * 2)
    }
    expect(menus).toHaveLength(0)
  })

  it('lifting, cancelling, or moving past the slop first ends the press', () => {
    row.dispatchEvent(pointer('pointerdown'))
    row.dispatchEvent(pointer('pointerup'))
    row.dispatchEvent(pointer('pointerdown'))
    row.dispatchEvent(pointer('pointercancel'))
    row.dispatchEvent(pointer('pointerdown', { x: 40 }))
    row.dispatchEvent(pointer('pointermove', { x: 40 + LONG_PRESS_SLOP_PX + 1 }))
    vi.advanceTimersByTime(LONG_PRESS_MS * 2)
    expect(menus).toHaveLength(0)
  })

  it('a small wobble inside the slop still opens it', () => {
    row.dispatchEvent(pointer('pointerdown', { x: 40 }))
    row.dispatchEvent(pointer('pointermove', { x: 40 + LONG_PRESS_SLOP_PX - 2 }))
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(menus).toHaveLength(1)
  })

  it("the browser's own menu for the same press opens once: before ours, or right after", () => {
    row.dispatchEvent(pointer('pointerdown'))
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    vi.advanceTimersByTime(LONG_PRESS_MS * 2)
    expect(menus).toHaveLength(1)

    row.dispatchEvent(pointer('pointerdown'))
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(menus).toHaveLength(2)
    const echo = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    row.dispatchEvent(echo)
    expect(menus).toHaveLength(2)
    expect(echo.defaultPrevented).toBe(true)
  })

  it('a real right-click after a long press still opens its own menu', () => {
    row.dispatchEvent(pointer('pointerdown'))
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(menus).toHaveLength(1)
    row.dispatchEvent(pointer('pointerup'))

    row.dispatchEvent(pointer('pointerdown', { pointerType: 'mouse' }))
    const right = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    row.dispatchEvent(right)
    expect(menus).toHaveLength(2)
  })

  it('the click that ends a long press is swallowed; a later tap clicks', () => {
    const clicks: Event[] = []
    row.addEventListener('click', event => clicks.push(event))
    row.dispatchEvent(pointer('pointerdown'))
    vi.advanceTimersByTime(LONG_PRESS_MS)
    row.dispatchEvent(pointer('pointerup'))
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(clicks).toHaveLength(0)

    row.dispatchEvent(pointer('pointerdown'))
    row.dispatchEvent(pointer('pointerup'))
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(clicks).toHaveLength(1)
  })
})
