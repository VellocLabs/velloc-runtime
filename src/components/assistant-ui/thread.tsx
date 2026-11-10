import { RunningBlob, RunningIndicator } from "@/components/assistant-ui/running-indicator";
import { COLLAPSE_ALL_OFFER_MS, resolveFloatingScrollButton, useRunStatusRow } from "@/components/assistant-ui/run-status-row";
import type { TurnDiffMeta } from "@/utils/turnDiffs";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { cn } from "@/lib/utils";
import {
  ComposerPrimitive,
  ThreadPrimitive,
  useAssistantState,
  useThreadViewport,
} from "@assistant-ui/react";
import { ArrowDownIcon, ListCollapseIcon, LockIcon } from "lucide-react";
import {
  type FC,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { MessageContextMenu } from "./message-context-menu";
import { useComposerPassages } from "./composer-passages";
import { ChapterRail } from "./chapter-marks";
import { registerAttachSelectionOwner } from "@/browser/webview/attachSelectionShortcut";
import { ComposerEffortPicker } from "@/browser/webview/ComposerEffortPicker";
import { PendingQuestionsContext, createPendingQuestionsStore, usePendingQuestionCount } from "@/browser/webview/pendingQuestionsStore";
import { useNexusSessionStatus, useSessionStatusChannel } from "@/browser/webview/topbar/useNexusSessionStatus";
import { PlanApprovalFooterControl } from "./plan-approval-footer-control";
import { PermissionAskFooterControl } from "./permission-ask-footer-control";
import {
  ModAsks,
  ModPageResponder,
  ModToasts,
  ModTurnNote,
} from "./mod-ui";
import { ModAbovePrompt, ModPanes } from "./mod-render";
import { EnterPlanModeFooterControl } from "./enter-plan-mode-footer-control";
import { BackgroundTasksFooterControl } from "./background-tasks-footer-control";
import { SessionCardStack } from "./session-card-stack";
import { NextMessageStrip } from "./next-message-strip";
import { PendingMessageProvider, PendingMessageEntriesProvider, ClearPendingMessageProvider } from "./next-message-strip";
import { InjectMessagesContext, type InjectRestore } from "./inject-message-context";
import { useT } from "@/browser/webview/i18n";
import { VirtualizedThreadMessages } from "@/components/assistant-ui/virtualized-thread-messages";
import {
  classifyConversationScrollEvent,
  classifyPendingQuestionTransition,
  collapseConversationCollapsibles,
  createConversationScrollWriter,
  engageConversationLockToBottom,
  snapConversationViewportToBottom,
  syncConversationLockOnUserScroll,
} from "@/browser/webview/conversationScrollLock";
import {
  ContinueConversationContext,
  IsResumableContext,
  LastTerminalReasonContext,
  SessionPhaseProvider,
} from './thread-contexts';
import { CurrentProjectFolderChip } from './project-folder-chip';
import { ThreadSuggestions } from './thread-welcome';
import { continueReasonMessageKey } from './composer-logic';
import { Composer, ComposerContextUsage } from './composer';
import { ReplySelectionToolbar } from './selection-reply';
import { TRANSCRIPT_MESSAGE_COMPONENTS } from './transcript-rows';

export {
  ComposerCancelStateProvider,
  SnapshotNeedsAnswerProvider,
  SnapshotBlocksComposerInputProvider,
  SessionPhaseProvider,
  ContinueConversationProvider,
  IsResumableProvider,
  LastTerminalReasonProvider,
  SlashCommandsProvider,
  PermissionModeProvider,
  ProjectFolderProvider,
} from './thread-contexts';
export type { ProjectFolderControls } from './thread-contexts';
export { CurrentProjectFolderChip } from './project-folder-chip';
export { ThreadWelcome } from './thread-welcome';
export {
  canCompactSession,
  sendCompactCommand,
  providerErrorSummaryKey,
  continueReasonMessageKey,
  shouldSendOnRunningEnter,
  resolveComposerActionVisibility,
  resolveComposerActionDisabled,
} from './composer-logic';
export { Composer } from './composer';
export { ComposerModePicker } from './composer-mode-picker';
export { ComposerSendTooltip, ComposerInputHintLine, ComposerAction } from './composer-action';
export {
  holdSelectionForReply,
  placeReplyBox,
  selectionInside,
  useSelectionOwned,
  ReplySelectionToolbar,
  SelectionReplyBox,
} from './selection-reply';
export type { PendingReply } from './selection-reply';
export { TRANSCRIPT_MESSAGE_COMPONENTS } from './transcript-rows';

/**
 * Bridges THIS thread's unanswered-question count (from PendingQuestionsContext)
 * up to the shell, so a background session halted on an AskUserQuestion lights
 * the session-list "needs your response" dot. Renders nothing. Must live inside
 * the thread's PendingQuestionsContext.Provider. Reports `false` on unmount so an
 * evicted/switched-away thread never leaves the indicator stuck on.
 */
const PendingQuestionsReporter: FC<{
  sessionId?: string;
  onChange?: (sessionId: string, hasPending: boolean) => void;
}> = ({ sessionId, onChange }) => {
  const hasPending = usePendingQuestionCount() > 0;
  useEffect(() => {
    if (!sessionId || !onChange) return;
    onChange(sessionId, hasPending);
  }, [sessionId, hasPending, onChange]);
  // Separate unmount-only cleanup: clear the flag when this thread is evicted
  // from the mount LRU, without flapping false→true on each hasPending change.
  useEffect(() => {
    if (!sessionId || !onChange) return;
    return () => onChange(sessionId, false);
  }, [sessionId, onChange]);
  return null;
};

export const Thread: FC<{
  templateType?: string;
  sessionId?: string;
  isForeground?: boolean;
  lockToBottomRef?: { current: boolean };
  /**
   * Worker-computed turn-diff history metadata (newest-first), summarised by
   * the session card stack's Changes card. Null/empty → no Changes card.
   */
  turnDiffHistory?: TurnDiffMeta[] | null;
  /** Report this session's unanswered-question state upward (to the shell's
   *  session-list "needs your response" indicator). The pending count lives in
   *  this thread's PendingQuestionsContext, so a reporter inside that provider
   *  forwards it. */
  onPendingQuestionsChange?: (sessionId: string, hasPending: boolean) => void;
  /** The session's saved "next message" (see PendingMessageContext). */
  pendingMessage?: string | null;
  /** The same batch, one entry per parked submit (see
   *  PendingMessageEntriesContext). Absent ⇒ the strip counts by splitting
   *  `pendingMessage`, which over-counts multi-line submits. */
  pendingMessageEntries?: string[] | null;
  /** Clear the saved "next message" (NextMessageStrip ×). */
  onClearPendingMessage?: () => void;
  /** Inject texts Stop dropped, to hand back to this composer once. */
  injectRestore?: InjectRestore | null;
  /** Remove one pending bubble (its ×); resolves with the worker's verdict. */
  onRemoveInjectMessage?: (
    uuid: string,
  ) => Promise<{ ok: boolean; text?: string }>;
}> = ({
  templateType,
  sessionId,
  isForeground,
  lockToBottomRef,
  turnDiffHistory,
  onPendingQuestionsChange,
  pendingMessage,
  pendingMessageEntries,
  onClearPendingMessage,
  injectRestore,
  onRemoveInjectMessage,
}) => {
  // Boot marks after each commit: `auiThreadFirstCommitMs` (first commit after a
  // non-empty transcript) and `auiThreadCommitCount` (commits until welcome unmount).
  useLayoutEffect(() => {
    const m = (globalThis as { __nexusBootMarks?: Record<string, number> })
      .__nexusBootMarks ?? {};
    if (m.transcriptConvertEndMs == null) return;
    if (m.threadWelcomeRealUnmountedMs != null) return;
    if (m.auiThreadFirstCommitMs == null) {
      m.auiThreadFirstCommitMs = Date.now();
    }
    m.auiThreadCommitCount = (m.auiThreadCommitCount ?? 0) + 1;
    (globalThis as { __nexusBootMarks?: Record<string, number> })
      .__nexusBootMarks = m;
  });

  // Empty (no messages) → render the per-type welcome page in the viewport.
  const isEmpty = useAssistantState((s) => s.thread.isEmpty);

  // Per-session pending-questions counter. MultiSessionShell keeps several
  // sessions mounted at once (inactive ones hidden, not unmounted), so a
  // module-global counter would let a background session's unanswered question
  // disable THIS session's composer (e.g. a new code project opens disabled).
  // A store scoped to this Thread isolates the count to this session.
  const pendingQuestionsStore = useMemo(
    () => createPendingQuestionsStore(),
    [sessionId],
  );

  const viewportRef = useRef<HTMLDivElement | null>(null);
  // The message rows only (not the footer): the context menu's and the
  // attach shortcut's notion of "inside the conversation".
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const passages = useComposerPassages();
  const passagesRef = useRef(passages);
  passagesRef.current = passages;
  const takesPassages = passages !== null;
  useEffect(() => {
    if (!takesPassages) return;
    return registerAttachSelectionOwner(document, {
      list: () => messageListRef.current,
      attach: (text) =>
        passagesRef.current?.capture(
          { body: text, method: "range", anchors: [] },
          messageListRef.current,
        ) ?? false,
    });
  }, [takesPassages]);
  const userScrollIntentRef = useRef(false);
  // The one owner of every programmatic scrollTop write (lock snaps + the
  // virtualizer's height repair) and of the guard that keeps those writes from
  // masquerading as user scrolls — see `createConversationScrollWriter` for
  // the contract. One instance per mounted Thread, shared by the scroll
  // observer, the post-commit snap, and the virtualizer's compensate callback.
  const scrollWriter = useMemo(() => createConversationScrollWriter(), []);
  const snapViewportProgrammatically = useCallback(
    (viewport: HTMLElement) => {
      scrollWriter.snapToBottom(viewport);
    },
    [scrollWriter],
  );
  // Scroll repair for the virtualized message list: when a row that sits
  // ABOVE the viewport turns out to be taller (or shorter) than the height its
  // spacer was standing in for, the visible content would shift by the
  // difference. The virtualizer hands the delta here rather than writing
  // scrollTop itself, so the write goes through the same guarded writer as the
  // snaps and the scroll handler can't read it as the user scrolling.
  const compensateScroll = useCallback(
    (deltaPx: number) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      scrollWriter.adjustBy(viewport, deltaPx);
    },
    [scrollWriter],
  );
  const setViewportRef = useCallback((element: HTMLDivElement | null) => {
    viewportRef.current = element;
  }, []);
  const [lockToBottomEnabled, setLockToBottomEnabled] = useState(
    () => lockToBottomRef?.current ?? true,
  );

  useEffect(() => {
    setLockToBottomEnabled(lockToBottomRef?.current ?? true);
  }, [lockToBottomRef]);

  // Pending AskUserQuestion cards in THIS thread. Reads this thread's own
  // `pendingQuestionsStore`, not `usePendingQuestionCount()`: this component provides
  // that context, so `useContext` here would read the parent's store and report 0.
  const pendingQuestionCount = useSyncExternalStore(
    pendingQuestionsStore.subscribe,
    pendingQuestionsStore.getSnapshot,
    () => 0,
  );
  // Mirror of the count in a ref so the scroll-controller closures (installed
  // once, below) can read the LIVE value without re-installing their listeners
  // on every count change. While a question is pending the viewport must not be
  // force-scrolled — the user is reading it and may scroll away to consult prior
  // context — so every programmatic snap site checks this and stands down. The
  // ONE-TIME reveal snap (in the effect below) is the sole exception: it calls
  // `snapConversationViewportToBottom` directly, not through these guarded sites.
  const pendingQuestionRef = useRef(pendingQuestionCount);
  pendingQuestionRef.current = pendingQuestionCount;

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !lockToBottomRef) return;

    // Start clean so a guard armed by a torn-down instance can't swallow this
    // instance's first real scroll.
    scrollWriter.reset();

    let intentTimer: number | null = null;
    // A programmatic snap queues an async scroll event that `onScroll` could misread as
    // the user scrolling to the bottom; `scrollWriter` tags our writes so exactly one
    // resulting event is ignored.
    const snapIfLocked = () => {
      // Never snap during an active user scroll gesture (it fights wheel momentum);
      // snaps resume once intent clears. Never snap while a question is pending.
      if (
        isForeground &&
        lockToBottomRef.current &&
        !userScrollIntentRef.current &&
        pendingQuestionRef.current === 0
      ) {
        snapViewportProgrammatically(viewport);
      }
    };
    const resizeObserver = new ResizeObserver(() => {
      snapIfLocked();
    });
    resizeObserver.observe(viewport);
    const footer = viewport.querySelector<HTMLElement>('.aui-thread-viewport-footer');
    if (footer) resizeObserver.observe(footer);
    const mutationObserver = new MutationObserver(() => {
      snapIfLocked();
    });
    mutationObserver.observe(viewport, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });

    const clearIntentSoon = () => {
      if (intentTimer !== null) window.clearTimeout(intentTimer);
      intentTimer = window.setTimeout(() => {
        userScrollIntentRef.current = false;
        intentTimer = null;
      }, 250);
    };
    const markIntent = () => {
      userScrollIntentRef.current = true;
      clearIntentSoon();
    };
    const onWheel = (event: WheelEvent) => {
      markIntent();
      if (event.deltaY < 0) {
        lockToBottomRef.current = false;
        setLockToBottomEnabled(false);
      }
    };
    // Direction tracking for the intent branch below: an upward user scroll
    // may only RELEASE the lock (see syncConversationLockOnUserScroll).
    let lastScrollTop = viewport.scrollTop;
    const onScroll = () => {
      const previousScrollTop = lastScrollTop;
      lastScrollTop = viewport.scrollTop;
      const action = classifyConversationScrollEvent({
        programmaticPending: scrollWriter.hasPending(),
        lockActive: lockToBottomRef.current,
        intentActive: userScrollIntentRef.current,
      });
      if (action === 'consumeProgrammatic') {
        // Swallow the scroll event produced by our own write — consumes
        // exactly one event, matching one armed write (or the single coalesced
        // event of several). Never flips the lock.
        scrollWriter.consumePending();
        return;
      }
      if (action === 'repinLocked') {
        // Never re-pin while a question is pending — the user owns the viewport
        // then (see pendingQuestionRef). The lock flag may transiently read true
        // (a race with the reveal effect's release); this guard makes the
        // behavior correct regardless of that ordering.
        if (isForeground && pendingQuestionRef.current === 0) {
          snapViewportProgrammatically(viewport);
          lastScrollTop = viewport.scrollTop;
          setLockToBottomEnabled(true);
        }
        return;
      }
      if (action === 'syncUser') {
        const locked = syncConversationLockOnUserScroll(
          lockToBottomRef,
          viewport,
          previousScrollTop,
        );
        setLockToBottomEnabled(locked);
      }
    };
    const onPointerDown = () => {
      userScrollIntentRef.current = true;
      if (intentTimer !== null) {
        window.clearTimeout(intentTimer);
        intentTimer = null;
      }
    };
    const onPointerUp = () => {
      if (userScrollIntentRef.current) clearIntentSoon();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        [
          'ArrowUp',
          'ArrowDown',
          'PageUp',
          'PageDown',
          'Home',
          'End',
          ' ',
        ].includes(event.key)
      ) {
        markIntent();
      }
    };

    viewport.addEventListener('wheel', onWheel, { passive: true });
    viewport.addEventListener('scroll', onScroll, { passive: true });
    viewport.addEventListener('pointerdown', onPointerDown, { passive: true });
    viewport.addEventListener('pointerup', onPointerUp, { passive: true });
    viewport.addEventListener('keydown', onKeyDown);
    return () => {
      if (intentTimer !== null) window.clearTimeout(intentTimer);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      viewport.removeEventListener('wheel', onWheel);
      viewport.removeEventListener('scroll', onScroll);
      viewport.removeEventListener('pointerdown', onPointerDown);
      viewport.removeEventListener('pointerup', onPointerUp);
      viewport.removeEventListener('keydown', onKeyDown);
    };
  }, [isForeground, lockToBottomRef, scrollWriter, snapViewportProgrammatically]);

  // The parent owns the per-session lock state, but this component owns the
  // actual viewport element and commits after assistant-ui has rendered message
  // rows. Snap here on every commit while locked, so session open/switch cannot
  // race transcript hydration and land at scrollTop=0.
  useLayoutEffect(() => {
    if (!isForeground || lockToBottomRef?.current !== true) return;
    // Never force-scroll while a question is pending — the user owns the
    // viewport then (see pendingQuestionRef). This effect runs on EVERY commit,
    // so without this gate it would re-pin to the bottom on each render while a
    // question is up, fighting the user's scroll position.
    if (pendingQuestionRef.current > 0) return;
    // Don't snap while the user is actively scrolling (wheel/scroll-key intent).
    // Reaching the bottom via the wheel engages the lock, which commits this
    // effect; snapping here would fight the wheel's momentum animation and make
    // the footer/composer jump. Its real job — re-pinning on session
    // open/switch so hydration can't land at scrollTop=0 — runs with no active
    // intent, so this gate doesn't affect it.
    if (userScrollIntentRef.current) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    // Guarded like the observer snaps — this post-commit snap also fires an
    // async scroll event that must not be read as a user scroll-to-bottom.
    snapViewportProgrammatically(viewport);
  });

  // Pending AskUserQuestion: snap to the bottom once on the 0 → >0 edge; keep the
  // lock-to-bottom released on every render while any question is pending (level-
  // triggered, since an edge can be missed); re-engage the lock when it returns to 0.
  const prevPendingQuestionCountRef = useRef(pendingQuestionCount);
  useEffect(() => {
    const prev = prevPendingQuestionCountRef.current;
    prevPendingQuestionCountRef.current = pendingQuestionCount;
    if (!lockToBottomRef) return;

    const action = classifyPendingQuestionTransition(prev, pendingQuestionCount);
    if (action === 'reveal') {
      // Reveal: snap once so the user sees the question.
      if (viewportRef.current) {
        snapConversationViewportToBottom(viewportRef.current);
      }
    }
    if (pendingQuestionCount > 0) {
      // Level-triggered: keep the lock released for as long as a question is
      // pending, regardless of how the count transitioned into the positive
      // range. This is what actually hands the viewport back to the user.
      lockToBottomRef.current = false;
      setLockToBottomEnabled(false);
    } else if (action === 'resume') {
      // Answered: resume tracking new content.
      engageConversationLockToBottom(lockToBottomRef, viewportRef.current);
      setLockToBottomEnabled(true);
    }
  }, [pendingQuestionCount, lockToBottomRef]);

  const handleCollapseAll = useCallback(() => {
    collapseConversationCollapsibles(viewportRef.current ?? document);
  }, []);

  // Unified execution-phase enum for the composer gate. The worker broadcasts
  // this only for the foreground session; off-foreground it stays the idle
  // default (background threads are display:none anyway, and their composers
  // aren't the active input target).
  const statusChannel = useSessionStatusChannel();
  const { sessionPhase } = useNexusSessionStatus(statusChannel, sessionId);
  const injectContext = useMemo(
    () => ({
      restore: injectRestore ?? null,
      ...(onRemoveInjectMessage
        ? { removeInjectMessage: onRemoveInjectMessage }
        : {}),
    }),
    [injectRestore, onRemoveInjectMessage],
  );

  return (
    <InjectMessagesContext.Provider value={injectContext}>
    <SessionPhaseProvider value={sessionPhase}>
    <PendingQuestionsContext.Provider value={pendingQuestionsStore}>
    <PendingMessageProvider value={pendingMessage ?? null}>
    <PendingMessageEntriesProvider value={pendingMessageEntries ?? null}>
    <ClearPendingMessageProvider value={onClearPendingMessage ?? null}>
    <PendingQuestionsReporter
      sessionId={sessionId}
      onChange={onPendingQuestionsChange}
    />
    <ThreadPrimitive.Root
      data-thread-session={sessionId}
      className="aui-root aui-thread-root @container relative flex h-full flex-col bg-background has-[[data-slot=session-card-stack]]:[--thread-end-reserve:clamp(24px,calc(var(--thread-max-width)+654px-100cqw),315px)]"
      style={{
        ["--thread-max-width" as string]: "48rem",
        ["--composer-radius" as string]: "24px",
        ["--composer-padding" as string]: "10px",
      }}
    >
      {/* The transcript's top right corner: the session card stack (F-9; the
          mods' docked panes are its last cards, F-25), then the mods' toasts
          (`$.ui.toast`) beneath it. While the stack shows, the column keeps
          clear of it: centred when there is room, else moved left (and then
          narrowed) so its end stays 24px short of the 280px stack. */}
      <div
        data-slot="thread-top-right"
        className="pointer-events-none absolute top-3 right-[11px] z-20 flex max-h-[calc(100%-1.5rem)] w-[280px] max-w-[calc(100%-1.5rem)] flex-col gap-2.5"
      >
        <SessionCardStack history={turnDiffHistory ?? null} />
        <ModToasts />
      </div>
      {/* The page's clipboard, focus ring and windows, for `$.ui.copy` / `.focus` / `.scroll`. */}
      <ModPageResponder />
      <ReplySelectionToolbar listRef={messageListRef} isForeground={isForeground} />
      <MessageContextMenu listRef={messageListRef} sessionId={sessionId} isForeground={isForeground} />
      {/* Whole-pane drop target. The composer has its own dropzone, but the
          conversation area is the larger, more natural place to drop a file —
          dropping anywhere here adds it as a composer attachment (resolves the
          thread composer, same as the composer's dropzone). A subtle inset ring
          shows while dragging. */}
      <ComposerPrimitive.AttachmentDropzone asChild>
      <div className="aui-thread-dropzone relative flex min-h-0 flex-1 flex-col transition-shadow data-[dragging=true]:rounded-lg data-[dragging=true]:ring-2 data-[dragging=true]:ring-inset data-[dragging=true]:ring-ring/50">
      {/* `autoScroll={false}` and the assistant-ui scroll triggers are disabled:
          AssistantUiThread's controller owns lock-to-bottom (locks on first foreground
          entry, send and manual bottom scroll; releases when the user scrolls away). */}
      <ChapterRail viewportRef={viewportRef} isForeground={isForeground !== false} />
      <ThreadPrimitive.Viewport
        ref={setViewportRef}
        autoScroll={false}
        scrollToBottomOnRunStart={false}
        scrollToBottomOnInitialize={false}
        scrollToBottomOnThreadSwitch={false}
        className="aui-thread-viewport relative flex flex-1 flex-col overflow-x-auto overflow-y-auto ps-6 pe-(--thread-end-reserve,24px) pt-4 [overflow-anchor:none]"
      >
        {/*
          ThreadWelcome rendering moved to AssistantUiThread level so the
          welcome overlay can cover the entire right panel (header,
          conversation viewport, composer). The component is exported
          and rendered there inside an <AuiIf> + absolute-positioned
          overlay.
        */}

        {/* Windowed message list. Renders only the rows near the viewport
            (plus the always-kept tail and any row the user has interacted
            with) and stands in for the rest with exactly-sized spacers —
            see `virtualized-thread-messages.tsx`. Row routing itself is
            unchanged: `TRANSCRIPT_MESSAGE_COMPONENTS` decides which
            component renders a message, exactly as the former
            `ThreadPrimitive.Messages` render prop did. */}
        <div ref={messageListRef} data-slot="message-list" className="contents">
          <VirtualizedThreadMessages
            viewportRef={viewportRef}
            isForeground={isForeground === true}
            compensateScroll={compensateScroll}
            components={TRANSCRIPT_MESSAGE_COMPONENTS}
          />
        </div>

        {/* The live run status (blob + progress text), or why the composer offers
            Continue, as the conversation's last row. Scrolled out of view, the
            status shows on the session tab instead. */}
        <ConversationRunStatus sessionId={sessionId} isForeground={isForeground} />

        {/* A mod's note on the turn just ended (F-25 `turn.complete`), right
            under the last answer, until the next turn starts. */}
        <ModTurnNote />

        {isEmpty && <ThreadSuggestions templateType={templateType} />}

        {/* Room below the last message for its `absolute top-full` action bar, so it
            does not overlap the composer. Static height: the footer is sticky-in-flow. */}
        <div className="aui-scroll-anchor h-8 shrink-0" aria-hidden="true" />

        <ThreadPrimitive.ViewportFooter className="aui-thread-viewport-footer sticky bottom-0 mx-auto mt-auto flex w-full max-w-(--thread-max-width) flex-col gap-1.5 overflow-visible rounded-t-(--composer-radius) bg-background pb-4 md:pb-6">
          <ThreadLockToBottom
            sessionId={sessionId}
            lockToBottomRef={lockToBottomRef}
            viewportRef={viewportRef}
            lockToBottomEnabled={lockToBottomEnabled}
            onLockToBottom={() => setLockToBottomEnabled(true)}
            canCollapseAll={!isEmpty}
            onCollapseAll={handleCollapseAll}
          />
          {/* The session's saved "next message" (a submit made while the agent
              was busy). Right-aligned, sized to its text (capped at 40% of the
              footer width), on the TOP row of the composer footer. × clears it
              (restoring text into this WebView's composer). */}
          <NextMessageStrip />
          {/* Permission ask + plan-approval controls, each on its own line above the
              composer. */}
          <PermissionAskFooterControl />
          <PlanApprovalFooterControl />
          <EnterPlanModeFooterControl />
          {/* "Turn settled but background tasks still running" indicator —
              the session will receive more (task-notification) messages, so
              it must not read as fully done. */}
          <BackgroundTasksFooterControl />
          {/* The mods' panes (F-25 `$.ui.open`, drawn by `ui.render` on
              `Pane`) and the band they draw above the prompt (`AbovePrompt`).
              Velloc seats them inline here, the LAST rows before the
              composer: the engine's own bars (status, asks, background
              tasks) stack above, never between a plugin's rows and the
              prompt they sit on. Their status lines (`$.ui.status`) are not
              here: they are the prompt box's top row (`ModComposerStatus`). */}
          <ModPanes />
          <ModAbovePrompt />
          {/* A mod's questions (F-25 `$.ui.ask`), one card each until the
              person answers or dismisses it. */}
          <ModAsks />
          <Composer />
          {/* Folder chip (left) and context ring (right) on one line below the
              composer; the negative bottom margin cancels the footer's padding so
              the row hugs its bottom edge. */}
          <div className="flex items-center gap-1.5 pr-1 -mb-2.5 md:-mb-[18px]">
            <CurrentProjectFolderChip />
            <div className="ml-auto flex items-center gap-1">
              {/* This session's model (read-only) + effort — a pick here is
                  per-session; the topbar sets the global default. */}
              <ComposerEffortPicker isForeground={isForeground !== false} />
              <ComposerContextUsage isForeground={isForeground !== false} />
            </div>
          </div>
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
      </div>
      </ComposerPrimitive.AttachmentDropzone>
    </ThreadPrimitive.Root>
    </ClearPendingMessageProvider>
    </PendingMessageEntriesProvider>
    </PendingMessageProvider>
    </PendingQuestionsContext.Provider>
    </SessionPhaseProvider>
    </InjectMessagesContext.Provider>
  );
};

// Circular floating button above the composer. While the last row is out of
// view it is the "lock to bottom" control: clicking re-engages the lock and
// snaps to the bottom (a pin while locked, a down-arrow once released; during
// a run, the run animation until hovered). After that click it briefly becomes
// Collapse all, which closes every open card in the conversation.
const ThreadLockToBottom: FC<{
  sessionId?: string;
  lockToBottomRef?: { current: boolean };
  viewportRef: { current: HTMLDivElement | null };
  lockToBottomEnabled: boolean;
  onLockToBottom: () => void;
  canCollapseAll: boolean;
  onCollapseAll: () => void;
}> = ({
  sessionId,
  lockToBottomRef,
  viewportRef,
  lockToBottomEnabled,
  onLockToBottom,
  canCollapseAll,
  onCollapseAll,
}) => {
  const t = useT();
  const isAtBottom = useThreadViewport((s) => s.isAtBottom);
  const runRow = useRunStatusRow(sessionId);
  const [collapseOffer, setCollapseOffer] = useState(0);
  useEffect(() => {
    if (collapseOffer === 0) return;
    const id = setTimeout(() => setCollapseOffer(0), COLLAPSE_ALL_OFFER_MS);
    return () => clearTimeout(id);
  }, [collapseOffer]);
  const mode = resolveFloatingScrollButton({
    runRowInView: runRow ? runRow.inView : null,
    isAtBottom,
    collapseOffered: collapseOffer !== 0,
    canCollapseAll,
  });
  const buttonClassName =
    "absolute -top-12 z-10 self-center rounded-full p-4 dark:border-border dark:bg-background dark:hover:bg-accent";
  if (mode === null) return null;
  if (mode === "collapse") {
    return (
      <TooltipIconButton
        tooltip={t("statusBar.collapseAll")}
        aria-label={t("statusBar.collapseAll")}
        variant="outline"
        data-testid="thread-collapse-all"
        onClick={onCollapseAll}
        className={cn("aui-thread-collapse-all", buttonClassName)}
      >
        <ListCollapseIcon />
      </TooltipIconButton>
    );
  }
  const scrollIcon = lockToBottomEnabled ? <LockIcon /> : <ArrowDownIcon />;
  return (
    <ThreadPrimitive.ScrollToBottom behavior="instant" asChild>
      <TooltipIconButton
        tooltip={t('statusBar.lockToBottom')}
        aria-label={t('statusBar.lockToBottom')}
        variant="outline"
        data-testid="thread-scroll-to-bottom"
        data-active={lockToBottomEnabled ? "true" : undefined}
        data-run-status={mode === "run" ? "true" : undefined}
        onClick={() => {
          if (lockToBottomRef) {
            engageConversationLockToBottom(lockToBottomRef, viewportRef.current);
          }
          onLockToBottom();
          setCollapseOffer((n) => n + 1);
        }}
        className={cn(
          "aui-thread-scroll-to-bottom group disabled:invisible",
          buttonClassName,
        )}
      >
        {mode === "run" ? (
          <>
            {/* The run animation; hover or keyboard focus shows the action. */}
            <span
              data-slot="thread-scroll-run-status"
              className="contents group-hover:hidden group-focus-visible:hidden"
            >
              <RunningBlob compact />
            </span>
            <span
              data-slot="thread-scroll-action-icon"
              className="hidden group-hover:contents group-focus-visible:contents"
            >
              {scrollIcon}
            </span>
          </>
        ) : (
          scrollIcon
        )}
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
};

/**
 * The conversation's run-status row, plus why the composer offers Continue. Subscribes
 * to the continue-conversation contexts so only this row re-renders; the sentence
 * follows resumability alone, not composer content.
 */
const ConversationRunStatus: FC<{
  sessionId?: string;
  isForeground?: boolean;
}> = ({ sessionId, isForeground }) => {
  const t = useT();
  const { onContinueConversation } = useContext(ContinueConversationContext);
  const isResumable = useContext(IsResumableContext);
  const lastTerminalReason = useContext(LastTerminalReasonContext);
  const idleNotice =
    isResumable && onContinueConversation
      ? t(continueReasonMessageKey(lastTerminalReason))
      : undefined;
  return (
    <RunningIndicator
      sessionId={sessionId}
      isForeground={isForeground}
      idleNotice={idleNotice}
    />
  );
};
