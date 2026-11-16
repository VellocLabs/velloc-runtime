/**
 * The phone shell's `--thread-bottom-inset` (F-24): the keyboard's height
 * while it covers the page, else the bottom safe area.
 */
import { describe, expect, it } from 'vitest'
import { keyboardInsetPx, threadBottomInset } from '../mobile/threadBottomInset'

describe('keyboardInsetPx', () => {
  it('is the layout height the visual viewport leaves uncovered at the bottom', () => {
    expect(keyboardInsetPx(844, { height: 508, offsetTop: 0 })).toBe(336)
  })

  it('counts a visual viewport the browser scrolled down to the input', () => {
    expect(keyboardInsetPx(844, { height: 508, offsetTop: 120 })).toBe(216)
  })

  it('is 0 when the browser already shrank the layout, or without a visual viewport', () => {
    expect(keyboardInsetPx(508, { height: 508, offsetTop: 0 })).toBe(0)
    expect(keyboardInsetPx(844, null)).toBe(0)
  })

  it('is never negative and rounds to whole px', () => {
    expect(keyboardInsetPx(800, { height: 812.4, offsetTop: 0 })).toBe(0)
    expect(keyboardInsetPx(844, { height: 507.6, offsetTop: 0 })).toBe(336)
  })
})

describe('threadBottomInset', () => {
  it('is the keyboard height while it is up, else the bottom safe area', () => {
    expect(threadBottomInset(336)).toBe('336px')
    expect(threadBottomInset(0)).toBe('env(safe-area-inset-bottom, 0px)')
  })
})
