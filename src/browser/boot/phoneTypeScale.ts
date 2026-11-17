/**
 * Phone type scale (F-22): the phone entry multiplies every type token by `--nx-type-scale` on
 * `<html>`, so conversation text matches the platform's body text instead of the desktop's
 * density. The default step's 15px prose becomes the platform body size: the WebKit system body
 * font (`-apple-system-body`, which follows the user's text-size setting) where the browser
 * exposes it, else the common 17px phone body size.
 */

/** The phone body size when the platform does not expose its own. */
export const PHONE_BODY_PX = 17

/** The default step's prose size (`--nx-step-prose-size` at step 2 in globals.css). */
const DEFAULT_PROSE_PX = 15

/** Bounds on the system body size: past them interface text no longer fits a phone row. */
const MIN_BODY_PX = 14
const MAX_BODY_PX = 30

export const PHONE_TYPE_SCALE_PROPERTY = '--nx-type-scale'

/** The scale that puts default-step prose at `systemBodyPx` (or the phone default). */
export function phoneTypeScale(systemBodyPx: number | null): number {
  const body =
    systemBodyPx !== null && Number.isFinite(systemBodyPx) && systemBodyPx > 0
      ? Math.min(MAX_BODY_PX, Math.max(MIN_BODY_PX, systemBodyPx))
      : PHONE_BODY_PX
  return Math.round((body / DEFAULT_PROSE_PX) * 1e6) / 1e6
}

/** The WebKit system body font size in px, or null where the browser does not support it. */
export function readSystemBodyPx(
  doc: Document = document,
  supports: (property: string, value: string) => boolean = (property, value) =>
    doc.defaultView?.CSS?.supports?.(property, value) ?? false,
): number | null {
  if (!supports('font', '-apple-system-body')) return null
  const probe = doc.createElement('span')
  probe.style.font = '-apple-system-body'
  probe.style.position = 'absolute'
  probe.style.visibility = 'hidden'
  probe.textContent = 'x'
  doc.documentElement.appendChild(probe)
  try {
    const px = parseFloat(doc.defaultView!.getComputedStyle(probe).fontSize)
    return Number.isFinite(px) && px > 0 ? px : null
  } finally {
    probe.remove()
  }
}

/** Set the phone scale on `root`. Called once by the phone entry, before the shell renders. */
export function installPhoneTypeScale(
  root: HTMLElement,
  doc: Document = document,
  supports?: (property: string, value: string) => boolean,
): void {
  root.style.setProperty(
    PHONE_TYPE_SCALE_PROPERTY,
    String(phoneTypeScale(readSystemBodyPx(doc, supports))),
  )
}
