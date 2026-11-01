import { isAttachableSelection } from './capturedPassages'
import { snapshotSelection } from './messageContextMenuModel'

/**
 * Ctrl+Shift+L (Command+Shift+L on macOS): attach the transcript selection to
 * the composer as a passage (F-22). One keydown listener per document; each
 * mounted thread registers its message list, and the thread whose list holds
 * the whole selection takes it — never simply the last active one.
 */

export function isMacPlatform(platform: string | undefined): boolean {
  return !!platform && /Mac|iPhone|iPad/.test(platform)
}

export type AttachShortcutKey = {
  code: string
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
  repeat: boolean
  isComposing: boolean
  defaultPrevented: boolean
}

/** The exact chord for `mac` / not `mac`; a repeat, an IME composition or a claimed event never matches. */
export function isAttachSelectionChord(event: AttachShortcutKey, mac: boolean): boolean {
  if (event.repeat || event.isComposing || event.defaultPrevented) return false
  if (event.code !== 'KeyL' && (event.key ?? '').toLowerCase() !== 'l') return false
  if (!event.shiftKey || event.altKey) return false
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}

const OWN_KEYS_SELECTOR =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], canvas, iframe, embed, object, ' +
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]'

/**
 * A field, embedded content, or a dialog / menu / list box holding the key's
 * target or the focus keeps the keys to itself, as does an open modal anywhere.
 * A list box merely mounted elsewhere in the document does not.
 */
export function attachShortcutBlocked(target: EventTarget | null, doc: Document): boolean {
  if (target instanceof Element && target.closest(OWN_KEYS_SELECTOR)) return true
  if (doc.activeElement?.closest(OWN_KEYS_SELECTOR)) return true
  return Array.from(doc.querySelectorAll('[aria-modal="true"]')).some(
    modal => !modal.closest('[hidden], [inert], [aria-hidden="true"]'),
  )
}

export type AttachSelectionOwner = {
  /** The thread's message list; null while not mounted. */
  list: () => Element | null
  /** Adds the trimmed selection as a passage; false when refused. */
  attach: (text: string) => boolean
}

type DocumentRegistration = { owners: Set<AttachSelectionOwner>; dispose: () => void }

const registrations = new WeakMap<Document, DocumentRegistration>()

function handleKeydown(doc: Document, owners: ReadonlySet<AttachSelectionOwner>, event: KeyboardEvent): void {
  const platform = doc.defaultView?.navigator?.platform
  if (!isAttachSelectionChord(event, isMacPlatform(platform))) return
  if (attachShortcutBlocked(event.target, doc)) return
  const selection = doc.getSelection()
  for (const owner of owners) {
    const list = owner.list()
    if (!list) continue
    const snapshot = snapshotSelection(selection, list)
    if (snapshot.kind !== 'inside') continue
    if (!isAttachableSelection(snapshot.text)) return
    event.preventDefault()
    if (owner.attach(snapshot.text.trim())) selection?.removeAllRanges()
    return
  }
}

/** Registers a thread on `doc`; the returned function unregisters it (and the listener with the last one). */
export function registerAttachSelectionOwner(doc: Document, owner: AttachSelectionOwner): () => void {
  let registration = registrations.get(doc)
  if (!registration) {
    const owners = new Set<AttachSelectionOwner>()
    const listener = (event: KeyboardEvent) => handleKeydown(doc, owners, event)
    doc.addEventListener('keydown', listener)
    registration = { owners, dispose: () => doc.removeEventListener('keydown', listener) }
    registrations.set(doc, registration)
  }
  const current = registration
  current.owners.add(owner)
  return () => {
    current.owners.delete(owner)
    if (current.owners.size === 0) {
      current.dispose()
      registrations.delete(doc)
    }
  }
}
