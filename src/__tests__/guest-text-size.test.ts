// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_GUEST_TEXT_SIZE,
  GUEST_TEXT_SIZES,
  GUEST_TEXT_SIZE_ATTR,
  GUEST_TEXT_SIZE_STORAGE_KEY,
  applyGuestTextSize,
  installGuestTextSize,
  parseGuestTextSize,
  readGuestTextSize,
  subscribeGuestTextSize,
  writeGuestTextSize,
} from '../browser/boot/guestTextSize'

/** A Map-backed Storage stand-in — this realm's `localStorage` is not a
 *  working Storage, and the module reads its storage at call time anyway. */
function memoryStorage(initial?: Record<string, string>) {
  const map = new Map(Object.entries(initial ?? {}))
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  }
}

const disposers: Array<() => void> = []
afterEach(() => {
  for (const d of disposers.splice(0)) d()
})

describe('guest text size', () => {
  it('parses only the five steps, from numbers and from the strings a select yields', () => {
    for (const s of GUEST_TEXT_SIZES) {
      expect(parseGuestTextSize(s)).toBe(s)
      expect(parseGuestTextSize(String(s))).toBe(s)
    }
    for (const bad of ['0', '6', '2.5', '', 'large', null, undefined, 0, 6, NaN]) {
      expect(parseGuestTextSize(bad)).toBeNull()
    }
  })

  it('reads the default when storage is empty, corrupt, missing, or throwing', () => {
    expect(DEFAULT_GUEST_TEXT_SIZE).toBe(2)
    expect(readGuestTextSize(memoryStorage())).toBe(2)
    expect(readGuestTextSize(memoryStorage({ [GUEST_TEXT_SIZE_STORAGE_KEY]: 'huge' }))).toBe(2)
    expect(readGuestTextSize(memoryStorage({ [GUEST_TEXT_SIZE_STORAGE_KEY]: '9' }))).toBe(2)
    expect(readGuestTextSize(null)).toBe(2)
    const throwing = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(readGuestTextSize(throwing)).toBe(2)
    // A write into a throwing storage still notifies — the choice applies for
    // this page's lifetime even when it cannot be remembered.
    const seen: number[] = []
    disposers.push(subscribeGuestTextSize((s) => seen.push(s)))
    expect(() => writeGuestTextSize(4, throwing)).not.toThrow()
    expect(seen).toEqual([4])
  })

  it('round-trips a write through storage', () => {
    const storage = memoryStorage()
    writeGuestTextSize(5, storage)
    expect(storage.map.get(GUEST_TEXT_SIZE_STORAGE_KEY)).toBe('5')
    expect(readGuestTextSize(storage)).toBe(5)
  })

  it('stamps the root at install time and re-stamps on every write', () => {
    const root = document.createElement('html')
    const storage = memoryStorage({ [GUEST_TEXT_SIZE_STORAGE_KEY]: '3' })
    const dispose = installGuestTextSize(root, storage)
    disposers.push(dispose)
    expect(root.getAttribute(GUEST_TEXT_SIZE_ATTR)).toBe('3')

    writeGuestTextSize(1, storage)
    expect(root.getAttribute(GUEST_TEXT_SIZE_ATTR)).toBe('1')

    // The default is stamped too — the attribute is always a readout of the
    // active step, never "absent means default".
    const fresh = document.createElement('html')
    disposers.push(installGuestTextSize(fresh, memoryStorage()))
    expect(fresh.getAttribute(GUEST_TEXT_SIZE_ATTR)).toBe(String(DEFAULT_GUEST_TEXT_SIZE))

    // Disposed roots stop following.
    dispose()
    writeGuestTextSize(5, storage)
    expect(root.getAttribute(GUEST_TEXT_SIZE_ATTR)).toBe('1')
    expect(fresh.getAttribute(GUEST_TEXT_SIZE_ATTR)).toBe('5')
  })

  it('re-stamps when another window writes the key (a storage event)', () => {
    const root = document.createElement('html')
    const storage = memoryStorage({ [GUEST_TEXT_SIZE_STORAGE_KEY]: '2' })
    const target = new EventTarget()
    const dispose = installGuestTextSize(root, storage, target as unknown as Window)
    disposers.push(dispose)
    const seen: number[] = []
    disposers.push(subscribeGuestTextSize((s) => seen.push(s)))

    // The other window's write lands in the shared storage; this realm only
    // hears about it through the event.
    storage.map.set(GUEST_TEXT_SIZE_STORAGE_KEY, '4')
    target.dispatchEvent(Object.assign(new Event('storage'), { key: GUEST_TEXT_SIZE_STORAGE_KEY }))
    expect(root.getAttribute(GUEST_TEXT_SIZE_ATTR)).toBe('4')
    expect(seen).toEqual([4])

    // Another key is not ours; a clear (key null) reads back the default.
    storage.map.set(GUEST_TEXT_SIZE_STORAGE_KEY, '5')
    target.dispatchEvent(Object.assign(new Event('storage'), { key: 'velloc.other' }))
    expect(root.getAttribute(GUEST_TEXT_SIZE_ATTR)).toBe('4')
    storage.map.clear()
    target.dispatchEvent(Object.assign(new Event('storage'), { key: null }))
    expect(root.getAttribute(GUEST_TEXT_SIZE_ATTR)).toBe(String(DEFAULT_GUEST_TEXT_SIZE))

    // Disposed: the listener is gone.
    dispose()
    storage.map.set(GUEST_TEXT_SIZE_STORAGE_KEY, '1')
    target.dispatchEvent(Object.assign(new Event('storage'), { key: GUEST_TEXT_SIZE_STORAGE_KEY }))
    expect(root.getAttribute(GUEST_TEXT_SIZE_ATTR)).toBe(String(DEFAULT_GUEST_TEXT_SIZE))
  })

  it('applyGuestTextSize is idempotent', () => {
    const root = document.createElement('div')
    applyGuestTextSize(root, 4)
    applyGuestTextSize(root, 4)
    expect(root.getAttribute(GUEST_TEXT_SIZE_ATTR)).toBe('4')
  })
})

/**
 * The CSS half of the contract. The module stamps an attribute; what it means
 * is decided in globals.css, and nothing else checks that every step defines
 * every token, or that the bare `:root` fallback IS the default step. A step
 * missing one token would inherit the fallback's value for that token only —
 * a prose size from one step and a line-height from another — and no
 * component test could see it.
 */
describe('globals.css type scale', () => {
  const css = readFileSync(join(__dirname, '..', 'styles', 'globals.css'), 'utf8')
  // The composer has no step tokens of its own: it reads the prose pair.
  const TOKENS = [
    'prose-size', 'prose-leading', 'body-size', 'body-leading',
    'caption-size', 'caption-leading', 'code-size', 'code-leading',
  ]

  /** The declarations of the block whose selector list contains `selector`. */
  function block(selector: string): Record<string, string> {
    const re = new RegExp(String.raw`(^|\n)([^{}]*${selector.replace(/[[\]"]/g, '\\$&')}[^{}]*)\{([^}]*)\}`)
    const m = css.match(re)
    if (!m) throw new Error(`no block for ${selector}`)
    const out: Record<string, string> = {}
    for (const line of m[3]!.split('\n')) {
      const d = line.match(/--nx-([a-z-]+):\s*([^;]+);/)
      if (d) out[d[1]!] = d[2]!.trim()
    }
    return out
  }

  it('defines every token at every step, with the bare :root as the default step', () => {
    const fallback = block(':root,')
    for (const t of TOKENS) expect(fallback[t], t).toBeTruthy()
    for (const step of GUEST_TEXT_SIZES) {
      const decls = block(`:root[data-text-size="${step}"]`)
      for (const t of TOKENS) expect(decls[t], `step ${step} ${t}`).toBeTruthy()
    }
    // `:root, :root[data-text-size="2"]` share one block: the default step is
    // literally the fallback, so they cannot drift apart.
    expect(css).toMatch(/:root,\s*\n:root\[data-text-size="2"\]\s*\{/)
  })

  it('is the compact scale at the default step, and grows monotonically', () => {
    const at = (step: number) => block(`:root[data-text-size="${step}"]`)
    // The default step's sizes/leadings: prose 14/20, body 13/19,
    // caption 11/17, code 12/17.
    expect(at(2)).toMatchObject({
      'prose-size': '14px', 'prose-leading': '20px',
      'body-size': '13px', 'body-leading': '19px',
      'caption-size': '11px', 'caption-leading': '17px',
      'code-size': '12px', 'code-leading': '17px',
    })
    const px = (v: string) => Number(v.replace('px', ''))
    for (const t of TOKENS) {
      for (let s = 2; s <= 5; s++) {
        expect(px(at(s)[t]!), `${t} step ${s} >= step ${s - 1}`)
          .toBeGreaterThanOrEqual(px(at(s - 1)[t]!))
      }
    }
  })

  it('exposes each token pair as a Tailwind font-size utility', () => {
    for (const name of ['prose', 'body', 'caption', 'code']) {
      expect(css).toContain(`--text-${name}: var(--nx-${name}-size);`)
      expect(css).toContain(`--text-${name}--line-height: var(--nx-${name}-leading);`)
    }
    // The composer follows prose, floored on touch screens.
    expect(css).toContain('--text-composer: max(var(--nx-entry-floor-size, 0px), var(--nx-prose-size));')
    expect(css).toContain(
      '--text-composer--line-height: max(var(--nx-entry-floor-leading, 0px), var(--nx-prose-leading));',
    )
  })
})
