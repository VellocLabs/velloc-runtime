// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  PHONE_TYPE_SCALE_PROPERTY,
  installPhoneTypeScale,
  phoneTypeScale,
  readSystemBodyPx,
} from '../browser/boot/phoneTypeScale'

afterEach(() => {
  vi.restoreAllMocks()
  document.documentElement.style.removeProperty(PHONE_TYPE_SCALE_PROPERTY)
})

describe('phone type scale', () => {
  it('puts default-step prose (15px) at the phone body size', () => {
    // No platform size: the common 17px phone body.
    expect(phoneTypeScale(null) * 15).toBeCloseTo(17, 2)
    // The platform's own body size, e.g. a larger system text setting.
    expect(phoneTypeScale(21) * 15).toBeCloseTo(21, 2)
    expect(phoneTypeScale(15)).toBe(1)
  })

  it('bounds the system size and ignores unusable readings', () => {
    expect(phoneTypeScale(53) * 15).toBeCloseTo(30, 2)
    expect(phoneTypeScale(8) * 15).toBeCloseTo(14, 2)
    for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(phoneTypeScale(bad) * 15).toBeCloseTo(17, 2)
    }
  })

  it('reads no system size where the browser lacks the WebKit body font', () => {
    expect(readSystemBodyPx(document, () => false)).toBeNull()
  })

  it('reads the WebKit body font size and removes its probe', () => {
    const real = window.getComputedStyle.bind(window)
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) => {
      const style = real(el, pseudo)
      return (el as HTMLElement).textContent === 'x' && el.parentElement === document.documentElement
        ? ({ fontSize: '20px' } as CSSStyleDeclaration)
        : style
    })
    const before = document.documentElement.childElementCount
    expect(readSystemBodyPx(document, () => true)).toBe(20)
    expect(document.documentElement.childElementCount).toBe(before)
  })

  it('stamps the scale on the root, and only the phone entry installs it', () => {
    installPhoneTypeScale(document.documentElement, document, () => false)
    const value = Number(document.documentElement.style.getPropertyValue(PHONE_TYPE_SCALE_PROPERTY))
    expect(value * 15).toBeCloseTo(17, 2)
    const src = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8')
    expect(src('mobile/main.tsx')).toContain('installPhoneTypeScale(document.documentElement)')
    // The desktop entry keeps the desktop density.
    expect(src('glic/main.tsx')).not.toContain('installPhoneTypeScale')
  })
})
