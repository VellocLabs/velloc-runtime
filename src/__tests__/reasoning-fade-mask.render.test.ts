// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { ReasoningText } from '../components/assistant-ui/reasoning'

// The fade must not paint a colour over the text: it is an alpha mask on the
// text itself, so it reads correctly on any theme surface.

function setScroll(el: HTMLElement, scrollHeight: number, clientHeight: number, scrollTop: number) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight })
  Object.defineProperty(el, 'scrollTop', { configurable: true, writable: true, value: scrollTop })
}

afterEach(cleanup)

describe('reasoning fade', () => {
  it('fades with a mask, never a background-coloured overlay', () => {
    const { container } = render(createElement(ReasoningText, null, 'thinking'))
    const el = container.querySelector('[data-slot="reasoning-text"]') as HTMLElement
    expect(el.className).toContain('[mask-image:linear-gradient(')
    expect(el.className).not.toContain('var(--color-background)')
    expect(container.querySelector('[data-slot="reasoning-fade"]')).toBeNull()
  })

  it('drops the fade once scrolled to the end, restores it when scrolled up', () => {
    const { container } = render(createElement(ReasoningText, null, 'thinking'))
    const el = container.querySelector('[data-slot="reasoning-text"]') as HTMLElement

    setScroll(el, 500, 256, 0)
    act(() => { fireEvent.scroll(el) })
    expect(el.hasAttribute('data-at-end')).toBe(false)

    setScroll(el, 500, 256, 244)
    act(() => { fireEvent.scroll(el) })
    expect(el.hasAttribute('data-at-end')).toBe(true)

    setScroll(el, 500, 256, 100)
    act(() => { fireEvent.scroll(el) })
    expect(el.hasAttribute('data-at-end')).toBe(false)
  })

  it('short content that does not scroll shows no fade', () => {
    const { container } = render(createElement(ReasoningText, null, 'short'))
    const el = container.querySelector('[data-slot="reasoning-text"]') as HTMLElement
    expect(el.hasAttribute('data-at-end')).toBe(true)
  })
})
