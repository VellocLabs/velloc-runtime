/**
 * The page's half of `$.ui.copy`, `$.ui.focus` and `$.ui.scroll` (F-25): the latest
 * responder mounted for the session answers (`mods.pageAnswer`). `focus` acts only
 * while the site holds the keys. Sites are found by the `data-mod-*` attributes
 * `mod-render.tsx` draws.
 */
import { useEffect, useRef } from 'react'

import type {
  ModsPageAnswer,
  ModsPageComponent,
  ModsPageRequest,
  ModsScrollBlock,
  ModsScrollMeasured,
} from '@/browser/runtimeProtocol'
import { writeClipboard, writeClipboardWhenFocused } from '@/utils/clipboard'

import { useModUi } from './mod-ui-context'

/** How long an element not yet drawn is waited for ("awaited, bounded"). */
export const MOD_PAGE_ELEMENT_WAIT_MS = 1_000
/** How long a copy no path took waits for the page's focus to come back. */
export const MOD_PAGE_FOCUS_WAIT_MS = 2_500
/** A row's height where none can be measured: `1.5em` of the trees' 12px. */
const FALLBACK_ROW_PX = 18

export type ModPageDeps = {
  /** The clipboard API, then the textarea path. */
  copy: (text: string) => Promise<boolean>
  /** The clipboard API once the page has the focus, within `waitMs`. */
  copyWhenFocused: (text: string, waitMs: number) => Promise<boolean>
  waitMs: number
  focusWaitMs: number
}

const DEFAULT_DEPS: ModPageDeps = {
  copy: writeClipboard,
  copyWhenFocused: writeClipboardWhenFocused,
  waitMs: MOD_PAGE_ELEMENT_WAIT_MS,
  focusWaitMs: MOD_PAGE_FOCUS_WAIT_MS,
}

const esc = (value: string): string =>
  typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&')

/** A site's window: the band, or a pane of `plugin`'s (any pane when no
 *  plugin is named). Only the shown pane is drawn. */
function siteWindow(root: ParentNode, component: ModsPageComponent | undefined, site: string, plugin?: string): HTMLElement | null {
  const all = Array.from(root.querySelectorAll<HTMLElement>(`[data-mod-site="${esc(site)}"][data-mod-component]`))
  return (
    all.find(
      element =>
        (component === undefined || element.dataset.modComponent === component) &&
        (element.dataset.modComponent !== 'Pane' || plugin === undefined || element.dataset.modOwner === plugin),
    ) ?? null
  )
}

function drawnBy(scope: ParentNode, plugin: string, key: string): HTMLElement | null {
  return scope.querySelector<HTMLElement>(`[data-mod-key="${esc(key)}"][data-mod-plugin="${esc(plugin)}"]`)
}

/** Wait, bounded, for `find` to see something: a tree is drawn a render
 *  round trip after the call that asked for it. */
async function waitFor<T>(find: () => T | null, waitMs: number): Promise<T | null> {
  const found = find()
  if (found || waitMs <= 0) return found
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50))
    const next = find()
    if (next) return next
  }
  return null
}

function rowPxOf(box: HTMLElement): number {
  const tree = box.querySelector<HTMLElement>('[data-mod-tree]') ?? box
  // A laid-out page computes the line height in px; anything else is not a
  // measurement.
  const lineHeight = getComputedStyle(tree).lineHeight
  const px = lineHeight.endsWith('px') ? parseFloat(lineHeight) : NaN
  return Number.isFinite(px) && px > 0 ? px : FALLBACK_ROW_PX
}

/** The window as it stands, in rows. */
function measureWindow(box: HTMLElement): { rowPx: number; current: number; bodyRows: number; contentRows: number } {
  const rowPx = rowPxOf(box)
  const bodyRows = Math.max(1, Math.floor(box.clientHeight / rowPx))
  const contentRows = Math.max(bodyRows, Math.ceil(box.scrollHeight / rowPx))
  return { rowPx, current: Math.round(box.scrollTop / rowPx), bodyRows, contentRows }
}

/** Where `block` puts an element of `rows` rows at row `top`, as
 *  `scrollIntoView` would. */
export function offsetForBlock(
  block: ModsScrollBlock,
  top: number,
  rows: number,
  box: { current: number; bodyRows: number },
): number {
  switch (block) {
    case 'start':
      return top
    case 'end':
      return top + rows - box.bodyRows
    case 'center':
      return Math.round(top - (box.bodyRows - rows) / 2)
    case 'nearest':
      if (top >= box.current && top + rows <= box.current + box.bodyRows) return box.current
      if (top < box.current || rows > box.bodyRows) return top
      return top + rows - box.bodyRows
  }
}

/** The windows held at their end, and what lets each go. */
const stuck = new WeakMap<HTMLElement, () => void>()

function release(box: HTMLElement): void {
  stuck.get(box)?.()
}

function stickToEnd(box: HTMLElement): void {
  release(box)
  const toEnd = () => {
    box.scrollTop = box.scrollHeight
  }
  const observer = typeof MutationObserver !== 'undefined' ? new MutationObserver(toEnd) : null
  observer?.observe(box, { childList: true, subtree: true, characterData: true })
  const events = ['wheel', 'keydown', 'pointerdown', 'touchstart'] as const
  const stop = () => {
    observer?.disconnect()
    for (const name of events) box.removeEventListener(name, stop)
    stuck.delete(box)
  }
  // "… until anything next moves it": the person's own scrolling.
  for (const name of events) box.addEventListener(name, stop, { passive: true })
  stuck.set(box, stop)
}

function isFocusable(element: HTMLElement): boolean {
  return element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLSelectElement
}

/** The answer to one `page` request, from the DOM under `root`. */
export async function answerPageRequest(
  request: ModsPageRequest,
  root: ParentNode,
  deps: ModPageDeps = DEFAULT_DEPS,
): Promise<ModsPageAnswer> {
  const { requestId } = request
  switch (request.op) {
    case 'copy': {
      let isCopied = false
      try {
        isCopied = await deps.copy(request.text)
      } catch {
        isCopied = false
      }
      // Neither path took it here, nor the host's: the clipboard API needs
      // the page focused, so wait for the focus to come back and try again.
      // Not when the host took it — a late write could clobber the person's
      // own copy made in between.
      if (!isCopied && !request.hostCopied) {
        try {
          isCopied = await deps.copyWhenFocused(request.text, deps.focusWaitMs)
        } catch {
          isCopied = false
        }
      }
      return { requestId, op: 'copy', isCopied }
    }
    case 'focus': {
      const box = siteWindow(root, request.component, request.site, request.plugin)
      if (!box) return { requestId, op: 'focus', deny: 'the site is not shown' }
      const active = typeof document !== 'undefined' ? document.activeElement : null
      if (!request.holdsKeys && !(active && box.contains(active))) {
        return { requestId, op: 'focus', deny: 'the site does not hold the keys' }
      }
      const element = await waitFor(() => drawnBy(box, request.plugin, request.key), deps.waitMs)
      if (!element) return { requestId, op: 'focus', deny: `nothing drawn under key "${request.key}"` }
      if (!isFocusable(element)) return { requestId, op: 'focus', deny: `"${request.key}" cannot take the focus` }
      element.focus({ preventScroll: false })
      if (document.activeElement !== element) return { requestId, op: 'focus', deny: 'the page did not take the focus' }
      return { requestId, op: 'focus' }
    }
    case 'scrollMeasure': {
      const { to, plugin, block } = request
      let box: HTMLElement | null
      let element: HTMLElement | null = null
      if (typeof to === 'object' && 'key' in to) {
        const found = await waitFor(() => {
          const scopes = request.in !== undefined
            ? [siteWindow(root, undefined, request.in, plugin)]
            : Array.from(root.querySelectorAll<HTMLElement>('[data-mod-site][data-mod-component]'))
          for (const scope of scopes) {
            const hit = scope ? drawnBy(scope, plugin, to.key) : null
            if (scope && hit) return { scope, hit }
          }
          return null
        }, deps.waitMs)
        if (!found) return { requestId, op: 'scrollMeasure', deny: `nothing drawn under key "${to.key}"` }
        box = found.scope
        element = found.hit
      } else if (typeof to === 'object') {
        return { requestId, op: 'scrollMeasure', deny: 'a render instance is scrolled with scrollRow' }
      } else {
        box = siteWindow(root, undefined, request.in ?? '', plugin)
        if (!box) return { requestId, op: 'scrollMeasure', deny: 'the site is not shown' }
      }
      const at = measureWindow(box)
      const last = Math.max(0, at.contentRows - at.bodyRows)
      let offset: number
      if (to === 'start') offset = 0
      else if (to === 'end') offset = last
      else {
        const top = Math.max(
          0,
          Math.floor((element!.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop) / at.rowPx),
        )
        const rows = Math.max(1, Math.ceil(element!.getBoundingClientRect().height / at.rowPx))
        offset = offsetForBlock(block, top, rows, at)
      }
      const measured: ModsScrollMeasured = {
        component: box.dataset.modComponent as ModsPageComponent,
        site: box.dataset.modSite ?? '',
        current: at.current,
        offset: Math.max(0, Math.min(offset, last)),
        bodyRows: at.bodyRows,
        contentRows: at.contentRows,
      }
      return { requestId, op: 'scrollMeasure', measured }
    }
    case 'scrollApply': {
      const box = siteWindow(root, request.component, request.site)
      if (!box) return { requestId, op: 'scrollApply', deny: 'the site is not shown' }
      release(box)
      box.scrollTop = request.offset * rowPxOf(box)
      if (request.stickToEnd) stickToEnd(box)
      return { requestId, op: 'scrollApply' }
    }
    case 'scrollRow': {
      const row = await waitFor(
        () =>
          root.querySelector<HTMLElement>(`[data-mod-request-id="${esc(request.row)}"]`) ??
          siteWindow(root, undefined, request.row),
        deps.waitMs,
      )
      // The transcript draws the rows near the view alone.
      if (!row) return { requestId, op: 'scrollRow', deny: 'the row is not drawn' }
      row.scrollIntoView({ block: request.block })
      return { requestId, op: 'scrollRow' }
    }
  }
}

/** Answer the session's `page` requests from the thread `anchor` sits in. */
export function useModPage(anchor: { current: HTMLElement | null }, deps?: ModPageDeps): void {
  const { onPageRequest, answerPage } = useModUi()
  const held = useRef(deps)
  held.current = deps
  useEffect(() => {
    if (!onPageRequest || !answerPage) return
    return onPageRequest(request => {
      const root: ParentNode = anchor.current?.closest('.aui-thread-root') ?? document
      void answerPageRequest(request, root, held.current)
        .then(answer => answerPage(answer))
        .catch(() => {
          // The runtime times the request out.
        })
    })
  }, [onPageRequest, answerPage, anchor])
}
