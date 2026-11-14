// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * A sweeping element paints its glyphs through a clipped background, so its
 * descendants go transparent. Anything with a box or paint of its own keeps a
 * solid colour, or it would vanish while the run is live (F-22).
 */

const here = dirname(fileURLToPath(import.meta.url))
const GLOBALS_CSS = readFileSync(join(here, '..', 'styles', 'globals.css'), 'utf8')

/** The `.nexus-sheen` rules, from the base rule up to its keyframes. */
function sheenRules(css: string): string {
  const start = css.indexOf('.nexus-sheen {')
  const end = css.indexOf('@keyframes nexus-sheen-sweep')
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return css.slice(start, end)
}

function mount(markup: string): void {
  const style = document.createElement('style')
  style.textContent = `:root { --muted-foreground: rgb(1, 2, 3); }\n${sheenRules(GLOBALS_CSS)}`
  document.head.appendChild(style)
  document.body.innerHTML = `<div class="nexus-sheen">${markup}</div>`
}

const colorOf = (id: string) => getComputedStyle(document.getElementById(id)!).color

afterEach(() => {
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

describe('.nexus-sheen descendants', () => {
  it('plain prose takes the clipped paint', () => {
    mount('<p id="p">Checking <strong id="b">the</strong> tips.</p>')
    expect(colorOf('p')).toBe('transparent')
    expect(colorOf('b')).toBe('transparent')
  })

  it('code, links and table headers keep a solid colour, and so does what they hold', () => {
    mount(
      '<code id="c"><span id="tok">x</span></code>' +
        '<a id="a">link</a>' +
        '<table><tr><th id="th"><span id="ths">Name</span></th></tr></table>',
    )
    for (const id of ['c', 'tok', 'a', 'th', 'ths']) {
      expect(colorOf(id), id).not.toBe('transparent')
    }
  })

  it('icons, buttons, code headers and shell cards stay visible', () => {
    mount(
      '<div class="aui-code-header-root"><span id="lang">bash</span>' +
        '<button id="copy"><svg id="icon"><path id="path" /></svg></button></div>' +
        '<div data-shell-command=""><p role="alert" id="alert">Failed</p></div>',
    )
    for (const id of ['lang', 'copy', 'icon', 'path', 'alert']) {
      expect(colorOf(id), id).not.toBe('transparent')
    }
  })
})
