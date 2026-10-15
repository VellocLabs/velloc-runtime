import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import type { BrowserToolCallDetailRecord } from '../../utils/toolCallDetails'

type ToolCallDetailContextValue = {
  getCachedToolCallDetail: (
    toolCallId: string,
  ) => BrowserToolCallDetailRecord | null | undefined
  loadToolCallDetail: (
    toolCallId: string,
  ) => Promise<BrowserToolCallDetailRecord | null>
  clearCachedDetail: (toolCallId: string) => void
}

const ToolCallDetailContext =
  createContext<ToolCallDetailContextValue | null>(null)

export function ToolCallDetailProvider({
  loadToolCallDetail,
  children,
}: {
  loadToolCallDetail?: (
    toolCallId: string,
  ) => Promise<BrowserToolCallDetailRecord | null>
  children: ReactNode
}) {
  const cacheRef = useRef(new Map<string, BrowserToolCallDetailRecord | null>())
  const pendingRef = useRef(
    new Map<string, Promise<BrowserToolCallDetailRecord | null>>(),
  )
  const [cacheGeneration, setCacheGeneration] = useState(0)

  const getCachedToolCallDetail = useCallback(
    (toolCallId: string) => cacheRef.current.get(toolCallId),
    [],
  )

  const loadDetail = useCallback(
    async (toolCallId: string): Promise<BrowserToolCallDetailRecord | null> => {
      if (cacheRef.current.has(toolCallId)) {
        return cacheRef.current.get(toolCallId) ?? null
      }

      const pending = pendingRef.current.get(toolCallId)
      if (pending) {
        return await pending
      }

      const promise = (async () => {
        const detail = loadToolCallDetail
          ? await loadToolCallDetail(toolCallId)
          : null
        cacheRef.current.set(toolCallId, detail)
        pendingRef.current.delete(toolCallId)
        return detail
      })()

      pendingRef.current.set(toolCallId, promise)
      return await promise
    },
    [loadToolCallDetail],
  )

  const clearCachedDetail = useCallback(
    (toolCallId: string) => {
      if (cacheRef.current.get(toolCallId) === null) {
        cacheRef.current.delete(toolCallId)
        setCacheGeneration(g => g + 1)
      }
    },
    [],
  )

  const value = useMemo<ToolCallDetailContextValue>(
    () => ({
      getCachedToolCallDetail,
      loadToolCallDetail: loadDetail,
      clearCachedDetail,
    }),
    // cacheGeneration forces context consumers to re-read cache after invalidation
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [getCachedToolCallDetail, loadDetail, clearCachedDetail, cacheGeneration],
  )

  return (
    <ToolCallDetailContext.Provider value={value}>
      {children}
    </ToolCallDetailContext.Provider>
  )
}

export function useToolCallDetailContext(): ToolCallDetailContextValue | null {
  return useContext(ToolCallDetailContext)
}
