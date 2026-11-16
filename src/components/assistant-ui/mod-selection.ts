/**
 * The page's half of `$.ui.selection` (F-25): the person's last selection in a
 * thread, held past the click or key that takes the highlight down, so a press
 * or a command still reads it. A new selection replaces it; Escape, or a click on
 * anything that is not a control, dismisses it. The runtime drops one made before
 * the person's last prompt or command ran.
 */
import type { ModsPageSelection } from '@/browser/runtimeProtocol'

/** What a press lands on that keeps the held selection: a control. */
const CONTROL = 'button, [role="button"], a, input, textarea, select, label, [data-mod-key]'

function elementOf(node: Node | null): Element | null {
  if (!node) return null
  return node.nodeType === 1 ? (node as Element) : node.parentElement
}

/** The transcript row a node lies in: the id its render hook reads. */
function rowOf(node: Node | null): string | undefined {
  const row = elementOf(node)?.closest<HTMLElement>('[data-mod-request-id]')
  const id = row?.dataset.modRequestId
  return id ? id : undefined
}

export class ModSelectionTracker {
  private held: ModsPageSelection | undefined

  constructor(
    private readonly root: () => ParentNode | null,
    private readonly now: () => number = Date.now,
  ) {}

  /** The selection the page holds; none once dismissed. */
  get(): ModsPageSelection | undefined {
    return this.held
  }

  /** `selectionchange`: a selection made in the thread replaces the held one;
   *  one taken down is kept. */
  selectionChanged(selection: Pick<Selection, 'isCollapsed' | 'rangeCount' | 'toString' | 'getRangeAt'> | null): void {
    const field = this.selectedField()
    if (field) {
      this.held = { text: field, at: this.now() }
      return
    }
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return
    const text = selection.toString()
    if (text === '') return
    const range = selection.getRangeAt(0)
    const root = this.root()
    const within = elementOf(range.commonAncestorContainer)
    if (!root || !within || !(root as Node).contains(within)) return
    const requestId = rowOf(range.commonAncestorContainer)
    this.held = { text, ...(requestId !== undefined ? { requestId } : {}), at: this.now() }
  }

  /** A press: on a control it keeps the selection, anywhere else in the
   *  thread it dismisses it. */
  pressed(target: EventTarget | null): void {
    const element = target instanceof Element ? target : null
    if (element?.closest(CONTROL)) return
    const root = this.root()
    if (element && root && !(root as Node).contains(element)) return
    this.held = undefined
  }

  /** A key: Escape dismisses it. */
  keyed(key: string): void {
    if (key === 'Escape') this.held = undefined
  }

  /** The text selected in the thread's focused text field, if any. */
  private selectedField(): string | undefined {
    if (typeof document === 'undefined') return undefined
    const active = document.activeElement
    if (!(active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement)) return undefined
    const root = this.root()
    if (!root || !(root as Node).contains(active)) return undefined
    const { selectionStart, selectionEnd, value } = active
    if (selectionStart === null || selectionEnd === null || selectionStart === selectionEnd) return undefined
    return value.slice(selectionStart, selectionEnd)
  }
}
