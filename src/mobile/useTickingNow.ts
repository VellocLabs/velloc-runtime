/** Ticks `intervalMs` while `live`, so time-dependent text moves; the timer is cleared when it stops. */
import { useEffect, useState } from 'react'

export function useTickingNow(live: boolean, intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return undefined
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [live, intervalMs])
  return now
}
