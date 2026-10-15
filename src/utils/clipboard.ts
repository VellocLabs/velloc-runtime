/**
 * Clipboard access with a hidden-textarea + `execCommand('copy')` fallback;
 * reports success honestly. The fallback must run inside the caller's gesture,
 * so `copy()` decides synchronously when `navigator.clipboard` is absent.
 * Reading has no fallback: render a Paste entry only when `canReadClipboard()`.
 * Client trees reach the clipboard only through here.
 */

/** The hidden-textarea + execCommand copy. Synchronous, so it keeps the
 *  caller's transient user activation; honest about the result. */
function legacyCopy(text: string): boolean {
  // The person's focus and caret are put back: a copy a mod asks for lands
  // while they type in the prompt box.
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const field = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active : null;
  const caret = field ? [field.selectionStart, field.selectionEnd] as const : null;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    ta.remove();
    if (active && active !== document.body) {
      active.focus({ preventScroll: true });
      if (field && caret && caret[0] !== null && caret[1] !== null) {
        try {
          field.setSelectionRange(caret[0], caret[1]);
        } catch {
          // An input type with no caret.
        }
      }
    }
  }
}

export function writeClipboard(text: string): Promise<boolean> {
  // No modern API (a non-secure context — the http:// remote page): go
  // straight to the textarea path, synchronously inside the gesture. Waiting
  // on a promise here would only risk the activation window.
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    return Promise.resolve(legacyCopy(text));
  }
  // Secure context: the modern API, with the textarea path as the fallback
  // when it rejects (the guest webview's missing permission / focus). The
  // fallback still lands in the same task as the rejection.
  return navigator.clipboard.writeText(text).then(
    () => true,
    () => legacyCopy(text),
  );
}

/**
 * The clipboard API once the document has the focus: `writeText` rejects in
 * a document without it, and a copy no gesture started (a mod's
 * `$.ui.copy`) can arrive while the person is in another window. Waits up to
 * `waitMs` for the focus, then writes; false when the focus never came or
 * the write failed. Never throws.
 */
export async function writeClipboardWhenFocused(text: string, waitMs: number): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText || typeof document === 'undefined') return false;
  if (!document.hasFocus()) {
    const focused = await new Promise<boolean>(resolve => {
      const done = (value: boolean) => {
        clearTimeout(timer);
        window.removeEventListener('focus', onFocus);
        resolve(value);
      };
      const onFocus = () => done(true);
      const timer = setTimeout(() => done(document.hasFocus()), waitMs);
      window.addEventListener('focus', onFocus);
    });
    if (!focused) return false;
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether reading the clipboard is possible at all. False off a secure
 * context (no `navigator.clipboard`) — callers hide the affected control
 * instead of offering one that always errors.
 */
export function canReadClipboard(): boolean {
  return typeof navigator !== 'undefined'
    && typeof navigator.clipboard?.readText === 'function';
}

/** Read the clipboard, or `null` when unavailable / denied. Never throws. */
export async function readClipboard(): Promise<string | null> {
  if (!canReadClipboard()) return null;
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}
