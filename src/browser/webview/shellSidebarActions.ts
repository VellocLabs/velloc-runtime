import { type RefObject, type Dispatch, type SetStateAction } from 'react'
import type { BootSession } from './bootSessionPointer'
import type { BrowserLlmCatalog, BrowserLlmSelection } from '../bridge/browserBridgeProtocol'
import type { AgentRuntimeWorkerInitPayload } from '../worker/workerProtocol'
import type { RuntimeFileAccess } from '../runtimeClient/fileAccess'
import { SIDEBAR_DEFAULT_WIDTH_PX } from './layout/layoutConstants'
import { writeSidebarCollapsed } from './sidebarCollapsedPref'
import { clampSidebarWidth } from './layout/computeLayout'
import type { SessionTabEntry } from '../bridge/protocol/session'
import { isRestoredSessionPointer } from './bootSessionPointer'

/** Two tab lists the strip would draw identically. */
export function sameTabList(a: readonly SessionTabEntry[], b: readonly SessionTabEntry[]): boolean {
  if (a.length !== b.length) return false
  return a.every((tab, i) => {
    const other = b[i]
    return (
      tab.id === other.id &&
      tab.title === other.title &&
      tab.url === other.url &&
      tab.active === other.active
    )
  })
}
// Wide-mode sidebar width (px). Persists across reloads; mirrors the
// collapse pref's behavior — only written when the splitter is actually
// usable (i.e. wide viewport + sidebar expanded). Narrow-mode auto-
// collapses hide the splitter entirely, so the saved width survives a
// resize round-trip.
export const SIDEBAR_WIDTH_STORAGE_KEY = 'shift-sidebar-width'
export function readSavedSidebarWidth(): number {
  try {
    const raw = globalThis.localStorage?.getItem(SIDEBAR_WIDTH_STORAGE_KEY)
    if (raw == null) return SIDEBAR_DEFAULT_WIDTH_PX
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return SIDEBAR_DEFAULT_WIDTH_PX
    return clampSidebarWidth(parsed)
  } catch {
    return SIDEBAR_DEFAULT_WIDTH_PX
  }
}
export function writeSavedSidebarWidth(width: number): void {
  try {
    globalThis.localStorage?.setItem(
      SIDEBAR_WIDTH_STORAGE_KEY,
      String(Math.round(width)),
    )
  } catch {
    // localStorage may be unavailable; persistence is best-effort.
  }
}
export function createShellHandleToggleSidebar(
  sidebarHiddenRef: RefObject<boolean>,
  setSidebarPeek: Dispatch<SetStateAction<boolean>>,
  sidebarCollapsedRef: RefObject<boolean>,
) {
  return () => {
    if (sidebarHiddenRef.current) {
      setSidebarPeek(open => !open)
      return
    }
    setSidebarPeek(false)
    writeSidebarCollapsed(!sidebarCollapsedRef.current)
  }
}
export function createShellSessionAreaRef(
  sessionAreaObserverRef: RefObject<ResizeObserver | null>,
  setSessionAreaWidth: Dispatch<SetStateAction<number>>,
) {
  return (node: HTMLDivElement | null) => {
    sessionAreaObserverRef.current?.disconnect()
    sessionAreaObserverRef.current = null
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => {
      const width = Math.round(entries[entries.length - 1]?.contentRect.width ?? 0)
      if (width > 0) setSessionAreaWidth(width)
    })
    observer.observe(node)
    sessionAreaObserverRef.current = observer
  }
}
export function createShellHandleSidebarResize(
  setSidebarWidth: Dispatch<SetStateAction<number>>,
  isResizingSidebarRef: RefObject<boolean>,
) {
  return (width: number) => {
    setSidebarWidth(width)
    // Pointer-drag path: skip storage writes mid-drag — drag-end
    // persists the final value. Keyboard path: persist every step
    // (cheap; one localStorage write per ArrowLeft/Right is fine).
    if (!isResizingSidebarRef.current) {
      writeSavedSidebarWidth(width)
    }
  }
}
export function createShellHandleSidebarResizeStart(
  setIsResizingSidebar: Dispatch<SetStateAction<boolean>>,
) {
  return () => {
    setIsResizingSidebar(true)
  }
}
export function createShellHandleSidebarResizeEnd(
  setIsResizingSidebar: Dispatch<SetStateAction<boolean>>,
  sidebarWidth: number,
) {
  return () => {
    setIsResizingSidebar(false)
    writeSavedSidebarWidth(sidebarWidth)
  }
}
export function createShellMergeSessionTabCounts(
  setSessionTabCounts: Dispatch<SetStateAction<ReadonlyMap<string, { nexus: number; total: number; }>>>,
) {
  return (sessionId: string, nexus: number, total: number) => {
    setSessionTabCounts(prev => {
      const existing = prev.get(sessionId)
      if (existing && existing.nexus === nexus && existing.total === total) {
        return prev
      }
      const next = new Map(prev)
      next.set(sessionId, { nexus, total })
      return next
    })
  }
}
export function createShellSetSessionTabList(
  setSessionTabLists: Dispatch<SetStateAction<ReadonlyMap<string, readonly SessionTabEntry[]>>>,
) {
  return (sessionId: string, tabs: SessionTabEntry[]) => {
    setSessionTabLists(prev => {
      const existing = prev.get(sessionId)
      if (existing && sameTabList(existing, tabs)) return prev
      const next = new Map(prev)
      if (tabs.length === 0) next.delete(sessionId)
      else next.set(sessionId, tabs)
      return next
    })
  }
}
export function createShellResolveSearchHomeDir(
  files: RuntimeFileAccess | undefined,
) {
  return (): Promise<string> =>
      files
        ? files.userHome()
        : Promise.reject(new Error('fsx: the shell was built without file access'))
}
export function createShellCreateSessionInitPayload(
  createInitPayload: (sessionId: string) => AgentRuntimeWorkerInitPayload,
  globalDefaultSelectionRef: RefObject<BrowserLlmSelection | null>,
  defaultSelectionRef: RefObject<BrowserLlmSelection | null>,
  activeSelectionRef: RefObject<BrowserLlmSelection | null | undefined>,
  getSessionTemplateType: (sessionId: string) => string | undefined,
  getSessionProjectRoot: (sessionId: string) => string | undefined,
  sharedModelCatalogRef: RefObject<BrowserLlmCatalog | null>,
  bootSession: BootSession,
) {
  return (sessionId: string) => {
    const payload = createInitPayload(sessionId)
    // Seed from the GLOBAL default (the last topbar pick, model + effort),
    // then the catalog default, then — early boot only — the active
    // session's selection. NOT the active session first: its effort may be
    // a per-session composer override that must not leak into new
    // sessions. An existing session reopened with this payload keeps its
    // own persisted model + effort (`resolveSelection` /
    // `mergeRequestedTier`).
    const defaultSelection =
      globalDefaultSelectionRef.current ??
      defaultSelectionRef.current ??
      activeSelectionRef.current
    const effectiveTemplateType =
      getSessionTemplateType(sessionId) ?? payload.templateType
    // The folder this page KNOWS for the session (one it persisted, or one it
    // was just created bound to). With none, the runtime decides at
    // `session.open`: a forced-folder type (`code`/`safe_code`) inherits the
    // user's last folder of that type, every other type opens in its per-type
    // shared workspace (`worker/sessionOpenComposer.ts`).
    const autoProjectRoot = getSessionProjectRoot(sessionId)
    return {
      ...payload,
      ...(defaultSelection
        ? {
            userSpecifiedProviderId: defaultSelection.providerId,
            userSpecifiedModel: defaultSelection.modelId,
            // Carry the user's current reasoning-effort over so a brand-
            // new session inherits the same tier instead of resetting to
            // the model's catalog default (or no tier at all).
            ...(defaultSelection.thinkingTier
              ? {
                  userSpecifiedThinkingTier: defaultSelection.thinkingTier,
                }
              : {}),
          }
        : {}),
      initialModelCatalog:
        sharedModelCatalogRef.current ?? payload.initialModelCatalog,
      // Per-session agent template chosen by the thread launcher (selects
      // the prompt + tools). Falls back to the boot-default templateType.
      templateType: effectiveTemplateType,
      ...(autoProjectRoot ? { projectRoot: autoProjectRoot } : {}),
      // ONLY the session restored from the persisted pointer carries this.
      // Every other id in this document was minted here — by `openNewSession`
      // or by the boot fallback — so an absent record genuinely means "new"
      // and must still be created at bind. Narrow here is not enough on its
      // own: the worker replays this payload under minted ids for every
      // background spawn, so `commitInitTemplate` scrubs the flag out of
      // `lastInitTemplate` (F-17).
      ...(isRestoredSessionPointer(bootSession, sessionId)
        ? { restoredSessionId: true }
        : {}),
    }
  }
}
