import { useEffect, useRef } from 'react'
import type { BrowserRuntimeClientState } from './BrowserRuntimeClient'
import type { LocalSessionEntry } from './useSessionManager'
import { signalFirstScreen } from '../boot/firstScreenSignal'
import { shouldDismissBootWelcome } from './assistantUiAdapter'
import { getBootDiagnosticTraceId, installSessionTracer } from '../../utils/sessionTrace'

export type GuestReadySignalInput = {
  activeState: BrowserRuntimeClientState
  threadWelcomeUnmounted: boolean
  bodyHydrated: boolean
  activeSessionId: string
  sessions: readonly LocalSessionEntry[]
  onGuestFullyReady?: () => void
}

// Contract: calls `onGuestFullyReady` at most once per mount, after the shown session's content has painted.
export function useGuestReadySignal({
  activeState,
  threadWelcomeUnmounted,
  bodyHydrated,
  activeSessionId,
  sessions,
  onGuestFullyReady,
}: GuestReadySignalInput): void {
  const guestReadyFiredRef = useRef(false)
  useEffect(() => {
    if (guestReadyFiredRef.current) return
    // The status / snapshot preconditions belong to `shouldDismissBootWelcome` alone. Hold the
    // host overlay until painted content shows; event-driven, no wall-clock cap.
    if (
      !shouldDismissBootWelcome(activeState, {
        threadWelcomeUnmounted,
        bodyHydrated,
      })
    ) {
      return
    }

    guestReadyFiredRef.current = true
    if (typeof window !== 'undefined') signalFirstScreen(window)
    // E2e seam (a one-shot global write): record the active session's state at the instant
    // the host boot splash is dismissed, read after the boot completes.
    ;(globalThis as { __NEXUS_E2E_BOOT_DISMISS__?: unknown }).__NEXUS_E2E_BOOT_DISMISS__ = {
      status: activeState.status,
      initialized: activeState.snapshot?.initialized ?? null,
      // UI-ready split: with the provisional dismiss the snapshot at hand-off
      // is EXPECTED to be uninitialized-but-uiReady (the MCP connect + engine
      // build are still running). The e2e asserts initialized OR uiReady —
      // never the bare pre-runtime snapshot.
      uiReady: activeState.snapshot?.uiReady ?? null,
      messageCount: activeState.snapshot?.messageCount ?? null,
      transcriptLength: activeState.transcriptMessages.length,
      threadWelcomeUnmounted,
      bodyHydrated,
    }
    // Boot instrumentation: absolute marks from earlier layers (C++ and JS) combined into
    // per-transition sub-deltas in one trace event.
    const marks = (globalThis as { __nexusBootMarks?: Record<string, number> })
      .__nexusBootMarks ?? {}
    const signalAtMs = Date.now()
    const cppStart = marks.nexusViewContainerFirstCreatedMs ?? null
    const cppLoadUrl = marks.loadInitialUrlReturnedMs ?? null
    const cppGlicNav = marks.glicNavigationCommittedMs ?? null
    // chrome://glic intermediate marks, passed via URL search params on the webview navigation.
    const glicMainStarted = marks.glicMainStartedMs ?? null
    const webviewSrcSet = marks.webviewSrcSetMs ?? null
    const html = marks.htmlParsedMs ?? null
    const dcl = marks.domContentLoadedMs ?? null
    const reactModule = marks.reactModuleStartMs ?? null
    const transportReady = marks.transportReadyMs ?? null
    const reactImported = marks.reactImportResolvedMs ?? null
    const reactDomImported = marks.reactDomImportResolvedMs ?? null
    const createRootDone = marks.createRootDoneMs ?? null
    const shellImported = marks.shellImportResolvedMs ?? null
    const renderStart = marks.renderCallStartMs ?? null
    const renderReturned = marks.renderCallReturnedMs ?? null
    const twMount = marks.threadWelcomeMountedMs ?? null
    const snapshotReady = marks.workerSnapshotReadyMs ?? null
    const firstMsgs = marks.firstWorkerMessagesReceivedMs ?? null
    const transcriptMerged = marks.transcriptMergedMs ?? null
    // Use the "real" unmount captured by the shell's gated listener —
    // threadWelcomeFirstUnmountedMs would catch the loading→ready
    // transient unmount that fires before snapshot is loaded.
    const twUnmount = marks.threadWelcomeRealUnmountedMs ?? null
    // Keep the "first" unmount available for diagnostic purposes (so we
    // can see if the transient unmount happened at all and when).
    const twFirstUnmount = marks.threadWelcomeFirstUnmountedMs ?? null
    // Direction B3: subdivide ms_merged_to_unmount (~1087 ms) across
    // assistant-ui's render pipeline. Marks captured in:
    //   AssistantUiThread.tsx (useMemo for `messages`)
    //   components/assistant-ui/thread.tsx (Thread + first-message useEffect)
    const transcriptConvertStart = marks.transcriptConvertStartMs ?? null
    const transcriptConvertEnd = marks.transcriptConvertEndMs ?? null
    const transcriptConvertResultLength =
      marks.transcriptConvertResultLength ?? null
    const auiThreadFirstCommit = marks.auiThreadFirstCommitMs ?? null
    const auiThreadCommitCount = marks.auiThreadCommitCount ?? null
    const firstMessageRenderProp = marks.firstMessageRenderPropMs ?? null
    const lastMessageRenderProp = marks.lastMessageRenderPropMs ?? null
    const firstMessageMounted = marks.firstMessageMountedMs ?? null
    const firstMessageRole =
      (marks as { firstMessageMountedRole?: string })
        .firstMessageMountedRole ?? null
    const delta = (a: number | null, b: number | null) =>
      a != null && b != null ? a - b : null
    installSessionTracer({ context: 'ui' }).event('boot.guestReady.signaled', {
      traceId: getBootDiagnosticTraceId(),
      attrs: {
        sessionId: activeSessionId,
        sessionsCount: sessions.length,
        transcriptLength: activeState.transcriptMessages.length,
        threadWelcomeUnmounted,
        snapshotMessageCount: activeState.snapshot?.messageCount ?? null,
        // Absolute marks (ms since Unix epoch).
        nexusViewContainerFirstCreatedMs: cppStart,
        loadInitialUrlReturnedMs: cppLoadUrl,
        glicNavigationCommittedMs: cppGlicNav,
        glicMainStartedMs: glicMainStarted,
        webviewSrcSetMs: webviewSrcSet,
        htmlParsedMs: html,
        domContentLoadedMs: dcl,
        reactModuleStartMs: reactModule,
        transportReadyMs: transportReady,
        reactImportResolvedMs: reactImported,
        reactDomImportResolvedMs: reactDomImported,
        createRootDoneMs: createRootDone,
        shellImportResolvedMs: shellImported,
        renderCallStartMs: renderStart,
        renderCallReturnedMs: renderReturned,
        threadWelcomeMountedMs: twMount,
        workerSnapshotReadyMs: snapshotReady,
        firstWorkerMessagesReceivedMs: firstMsgs,
        transcriptMergedMs: transcriptMerged,
        threadWelcomeRealUnmountedMs: twUnmount,
        threadWelcomeFirstUnmountedMs: twFirstUnmount,
        // Direction B3 absolute marks.
        transcriptConvertStartMs: transcriptConvertStart,
        transcriptConvertEndMs: transcriptConvertEnd,
        transcriptConvertResultLength,
        auiThreadFirstCommitMs: auiThreadFirstCommit,
        auiThreadCommitCount,
        firstMessageRenderPropMs: firstMessageRenderProp,
        lastMessageRenderPropMs: lastMessageRenderProp,
        firstMessageMountedMs: firstMessageMounted,
        firstMessageRole,
        signalAtMs,
        bootTimingsRoundTripMs: marks.bootTimingsRoundTripMs ?? null,
        // Macro deltas — same as before, for at-a-glance.
        ms_pre_react_layer: delta(html, cppStart),
        ms_bundle_parse: delta(reactModule, html),
        ms_react_init: delta(transportReady, reactModule),
        ms_react_mount_to_ready: delta(signalAtMs, transportReady),
        ms_total_observable_boot: delta(signalAtMs, cppStart),
        // Fine-grained sub-deltas (pre-React layer).
        ms_cpp_setup: delta(cppLoadUrl, cppStart),
        ms_glic_load: delta(cppGlicNav, cppLoadUrl),
        ms_inner_webview_spawn_and_fetch: delta(html, cppGlicNav),
        // Subdivide ms_inner_webview_spawn_and_fetch: glic page parse + script start; glic JS
        // top-level work before navigating; Chromium guest spawn + Vite serve.
        ms_glic_committed_to_main_script:
          delta(glicMainStarted, cppGlicNav),
        ms_main_script_to_webview_src:
          delta(webviewSrcSet, glicMainStarted),
        ms_webview_src_to_html_parsed:
          delta(html, webviewSrcSet),
        ms_html_parse_to_module: delta(reactModule, html),
        ms_module_to_dcl: delta(dcl, reactModule),
        // Fine-grained sub-deltas — Direction B (React mount → ready).
        ms_mount_to_first_paint: delta(twMount, transportReady),
        // Sub-deltas inside ms_mount_to_first_paint (5 segments):
        ms_transport_to_react_import:
          delta(reactImported, transportReady),
        ms_react_to_reactdom_import:
          delta(reactDomImported, reactImported),
        ms_reactdom_to_create_root:
          delta(createRootDone, reactDomImported),
        ms_create_root_to_shell_import:
          delta(shellImported, createRootDone),
        ms_shell_import_to_render_start:
          delta(renderStart, shellImported),
        ms_render_call_duration:
          delta(renderReturned, renderStart),
        ms_render_returned_to_first_paint:
          delta(twMount, renderReturned),
        ms_first_paint_to_snapshot: delta(snapshotReady, twMount),
        ms_snapshot_to_messages: delta(firstMsgs, snapshotReady),
        ms_messages_to_merged: delta(transcriptMerged, firstMsgs),
        ms_merged_to_unmount: delta(twUnmount, transcriptMerged),
        ms_unmount_to_signal: delta(signalAtMs, twUnmount),
        // Direction B3 — subdivide ms_merged_to_unmount across assistant-ui's
        // pipeline. Note: transcriptConvertStartMs is captured during render
        // (inside useMemo), while transcriptMergedMs is captured in a useEffect
        // AFTER the commit that produced the merged transcript — so
        // ms_merged_to_convert_start can be NEGATIVE (convert ran first within
        // the same render cycle) by ~ a few ms. That's expected; the absolute
        // value is the post-commit→post-effect lag for that render cycle.
        ms_merged_to_convert_start:
          delta(transcriptConvertStart, transcriptMerged),
        ms_convert_duration:
          delta(transcriptConvertEnd, transcriptConvertStart),
        ms_convert_to_aui_committed:
          delta(auiThreadFirstCommit, transcriptConvertEnd),
        ms_aui_committed_to_first_message:
          delta(firstMessageMounted, auiThreadFirstCommit),
        // Inside ms_aui_committed_to_first_message: split into the gap
        // assistant-ui takes to start iterating its message list (store
        // propagation + render kickoff), the iteration time itself
        // (rendering 65 message subtrees), and the post-iteration
        // commit + paint + effect-queue tail.
        ms_aui_committed_to_render_prop:
          delta(firstMessageRenderProp, auiThreadFirstCommit),
        ms_render_prop_iteration:
          delta(lastMessageRenderProp, firstMessageRenderProp),
        ms_render_prop_to_first_message_mount:
          delta(firstMessageMounted, lastMessageRenderProp),
        ms_first_message_to_unmount:
          delta(twUnmount, firstMessageMounted),
      },
    })
    onGuestFullyReady?.()
  }, [
    sessions.length,
    activeState.status,
    activeState.snapshot,
    activeState.transcriptMessages.length,
    activeSessionId,
    threadWelcomeUnmounted,
    bodyHydrated,
    onGuestFullyReady,
  ])
}
