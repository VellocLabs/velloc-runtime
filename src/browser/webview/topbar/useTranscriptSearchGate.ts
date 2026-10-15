import { useEffect, useState } from 'react'

import type { CapabilityQuery } from '../useCan'

/**
 * Global transcript search (topbar control + Ctrl+K): whether this page has it.
 * Security: needs the host's `search` capability AND the grant — every query is
 * `search.queryTranscripts`, which is `full`; without it the control is not
 * rendered. An unknown grant renders it (`useCan`'s rule).
 */
export function useTranscriptSearchGate(
  searchCapable: boolean,
  capabilities: CapabilityQuery,
): { enabled: boolean; openToken: number } {
  const enabled = searchCapable && capabilities.can('search', 'queryTranscripts')
  const [openToken, setOpenToken] = useState(0)

  useEffect(() => {
    if (!enabled) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.shiftKey &&
        !event.altKey &&
        (event.key === 'k' || event.key === 'K')
      ) {
        if (event.defaultPrevented) return
        event.preventDefault()
        setOpenToken(token => token + 1)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled])

  return { enabled, openToken }
}
