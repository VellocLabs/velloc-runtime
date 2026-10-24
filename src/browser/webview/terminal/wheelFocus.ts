/**
 * Whether a wheel turned over a terminal gives it keyboard focus first
 * (F-34): a CLI acts on the wheel only while its terminal is focused. Focus
 * stays where the person is typing or choosing: a text field, a menu, a
 * dialog. Free of xterm.js.
 */
export function takesFocusOnWheel(active: Element | null, host: Element): boolean {
  if (!active || active === active.ownerDocument.body) return true
  if (host.contains(active)) return false
  if (active.closest('[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"]')) return false
  return !isEditable(active)
}

const NON_TEXT_INPUTS = new Set(['button', 'checkbox', 'radio', 'submit', 'reset', 'image', 'file', 'range', 'color'])

function isEditable(el: Element): boolean {
  const tag = el.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') return !NON_TEXT_INPUTS.has(((el as HTMLInputElement).type || 'text').toLowerCase())
  return (el as HTMLElement).isContentEditable === true || el.getAttribute('contenteditable') === 'true'
}
