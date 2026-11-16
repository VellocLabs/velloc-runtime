import * as React from 'react'
import qrcode from 'qrcode-generator'

/**
 * A QR code drawn as inline SVG, generated locally (no network service).
 * Security: callers pass secrets here (the remote-access share link); the
 * text is encoded into modules only and never rendered as text.
 */

/** Quiet zone around the code, in modules (the QR spec asks for four). */
const QUIET_ZONE = 4

/** The dark modules of `text`'s QR code: `size` modules a side, row-major. */
export function qrModules(text: string): { size: number; dark: boolean[] } {
  // Type 0 picks the smallest version that fits; level M survives a slightly
  // blurred phone-camera read.
  const code = qrcode(0, 'M')
  code.addData(text, 'Byte')
  code.make()
  const size = code.getModuleCount()
  const dark: boolean[] = []
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) dark.push(code.isDark(row, col))
  }
  return { size, dark }
}

/** One path for every dark module, offset by the quiet zone. */
export function qrPath(modules: { size: number; dark: boolean[] }): string {
  const parts: string[] = []
  modules.dark.forEach((on, i) => {
    if (!on) return
    const x = (i % modules.size) + QUIET_ZONE
    const y = Math.floor(i / modules.size) + QUIET_ZONE
    parts.push(`M${x} ${y}h1v1h-1z`)
  })
  return parts.join('')
}

export function QrCodeSvg({
  text,
  label,
  className,
  testId,
}: {
  text: string
  /** The accessible name; never the encoded text. */
  label: string
  className?: string
  testId?: string
}) {
  const modules = React.useMemo(() => qrModules(text), [text])
  const extent = modules.size + QUIET_ZONE * 2
  return (
    <svg
      role="img"
      aria-label={label}
      data-testid={testId}
      viewBox={`0 0 ${extent} ${extent}`}
      shapeRendering="crispEdges"
      className={className}
    >
      {/* Always dark on light, whatever the theme: scanners expect it. */}
      <rect width={extent} height={extent} fill="#ffffff" />
      <path d={qrPath(modules)} fill="#000000" />
    </svg>
  )
}
