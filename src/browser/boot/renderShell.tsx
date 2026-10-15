/**
 * The single place a prepared boot becomes `<MultiSessionShell />`, for both the desktop and the
 * remote path (F-24); desktop-only steps come in through `extras`. Await order: React, react-dom and
 * the shell chunk, then the locale catalog (bounded), then createRoot + render.
 */

import type { AgentRuntimeWorkerInitPayload } from '../worker/workerProtocol'
import type { BrowserBridgeTransport } from '../bridge/browserBridgeProtocol'
import type { BrowserWorkerClientTransport } from '../webview/BrowserRuntimeClient'
import type { DrivenDesktop } from '../webview/remote/hostIdentity'
import type {
  RuntimeConnection,
  RuntimeFileAccess,
  SessionListChannel,
  SessionStatusChannel,
  SettingsBridge,
  ShellChannel,
} from '../runtimeClient'

/**
 * Everything `renderShell` needs that is NOT the JSX props themselves — the
 * in-flight imports the caller started at the top of boot.
 */
export type ShellBootFetches = {
  reactPromise: Promise<typeof import('react')>
  reactDomPromise: Promise<typeof import('react-dom/client')>
  shellPromise: Promise<typeof import('../webview/MultiSessionShell')>
  /** Resolves when the active locale's catalog is installed (or its fallback
   *  attempt finished). renderShell races it against the deadline below. */
  localePromise: Promise<void>
}

/**
 * The prepared context both paths render. This is `PreparedNexusBootContext`
 * minus the three members the REMOTE path has no answer to (`sharedWorkerPort`,
 * `hostWindow`, `hostOrigin` — a remote has neither a worker port nor an
 * embedding host page); nexusBoot.ts's own type carries them for its
 * desktop-only ceremony.
 */
export type RenderableBootContext = {
  transport: BrowserBridgeTransport
  files: RuntimeFileAccess
  sessionChannel: SessionListChannel
  sessionStatusChannel: SessionStatusChannel
  settingsBridge: SettingsBridge
  shellChannel: ShellChannel
  initPayload: AgentRuntimeWorkerInitPayload
  createWorkerTransport: () => BrowserWorkerClientTransport
  runtimeConnection: () => Promise<RuntimeConnection>
}

/** Desktop-only wiring around the shell; a remote boot passes none. */
export type RenderShellExtras = {
  title?: string
  /** `searchCapable` — the topbar button + Ctrl+K gate. The desktop reads it
   *  from the host manifest; a remote has no manifest and gets the default. */
  searchCapable?: boolean
  onGuestFullyReady?: () => void
  onBootStage?: (stage: 'rendering' | 'sessions' | 'opening' | 'finalizing') => void
  /** F-24: the desktop this page is driving, when this page is a remote
   *  client. The desktop boot passes neither this nor `onRemoteLogOut`. */
  remoteHost?: DrivenDesktop
  onRemoteLogOut?: () => void
}

/** Boot-instrumentation marks — the same `__nexusBootMarks` main.tsx's inline
 *  script starts; a remote page writes them too, so its boot can be read with
 *  the same tooling. First writer wins, matching nexusBoot. */
function markBoot(key: string): void {
  const marks = (globalThis as { __nexusBootMarks?: Record<string, number> })
    .__nexusBootMarks ?? {}
  if (marks[key] == null) {
    marks[key] = Date.now()
    ;(globalThis as { __nexusBootMarks?: Record<string, number> })
      .__nexusBootMarks = marks
  }
}

/**
 * How long boot waits for the active locale's catalog before rendering
 * anyway. A hung request must not hold the UI forever; past this the shell
 * renders in English, and the catalog still installs when it lands.
 */
const LOCALE_BOOT_DEADLINE_MS = 2_000

export async function renderShell(
  container: HTMLElement,
  ctx: RenderableBootContext,
  fetches: ShellBootFetches,
  extras: RenderShellExtras = {},
): Promise<{ unmount: () => void }> {
  const React = await fetches.reactPromise
  markBoot('reactImportResolvedMs')
  const { createRoot } = await fetches.reactDomPromise
  markBoot('reactDomImportResolvedMs')
  const root = createRoot(container)
  markBoot('createRootDoneMs')

  const { MultiSessionShell } = await fetches.shellPromise
  markBoot('shellImportResolvedMs')

  // The catalog must be installed BEFORE the first render, or a non-English
  // user sees a flash of English that re-renders a frame later. Bounded: a
  // hung fetch renders in English instead of hanging boot (the catalog still
  // installs if it arrives later — translators read the registry live).
  await Promise.race([
    fetches.localePromise,
    new Promise<void>((resolve) =>
      setTimeout(resolve, LOCALE_BOOT_DEADLINE_MS),
    ),
  ])
  markBoot('localeCatalogReadyMs')

  markBoot('renderCallStartMs')
  // Wrap the shell in the i18n provider, seeded by the boot locale (host
  // locale ?? navigator.language) so the UI chrome speaks the same language
  // the model is told to use.
  const { I18nProvider } = await import('../webview/i18n')
  root.render(
    React.createElement(
      I18nProvider,
      { locale: ctx.initPayload.locale },
      React.createElement(MultiSessionShell, {
        createWorkerTransport: ctx.createWorkerTransport,
        hostBridgeTransport: ctx.transport,
        files: ctx.files,
        createInitPayload: (sessionId: string) => ({
          ...ctx.initPayload,
          sessionId,
        }),
        openingSessionId: ctx.initPayload.sessionId,
        title: extras.title,
        sessionChannel: ctx.sessionChannel,
        sessionStatusChannel: ctx.sessionStatusChannel,
        settingsBridge: ctx.settingsBridge,
        runtimeConnection: ctx.runtimeConnection,
        shellChannel: ctx.shellChannel,
        // Gates the transcript-search dialog (topbar button + Ctrl+K).
        searchCapable: extras.searchCapable ?? false,
        onGuestFullyReady: extras.onGuestFullyReady,
        onBootStage: extras.onBootStage,
        remoteHost: extras.remoteHost,
        onRemoteLogOut: extras.onRemoteLogOut,
      }),
    ),
  )
  markBoot('renderCallReturnedMs')
  // The remote boot hands the container back to its connect screen when the
  // connection ends for good; the desktop never unmounts.
  return { unmount: () => root.unmount() }
}
