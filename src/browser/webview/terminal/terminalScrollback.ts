/**
 * Whether a terminal holds lines above its screen (F-31): the scrollbar
 * stays shown while it does. A full-screen program's alternate buffer has
 * no scrollback, so it never does.
 */
export function hasScrollback(buffer: { type: 'normal' | 'alternate'; length: number }, rows: number): boolean {
  return buffer.type === 'normal' && buffer.length > rows
}
