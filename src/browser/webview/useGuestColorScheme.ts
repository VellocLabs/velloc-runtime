import { useCallback, useEffect, useState } from 'react'

import {
  readGuestColorScheme,
  subscribeGuestColorScheme,
  writeGuestColorScheme,
  type GuestColorScheme,
} from '../boot/guestColorScheme'

/**
 * This client's colour mode, kept current across every control that sets it
 * (Settings → Appearance, the conversation's theme menu), and its setter. A
 * choice holds for the page's lifetime even where storage refuses it.
 */
export function useGuestColorScheme(): readonly [GuestColorScheme, (scheme: GuestColorScheme) => void] {
  const [scheme, setScheme] = useState<GuestColorScheme>(() => readGuestColorScheme())
  useEffect(() => subscribeGuestColorScheme(setScheme), [])
  const set = useCallback((next: GuestColorScheme) => writeGuestColorScheme(next), [])
  return [scheme, set] as const
}
