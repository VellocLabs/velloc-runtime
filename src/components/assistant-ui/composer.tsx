import { ComposerAttachments, useComposerModelCapabilities } from "@/components/assistant-ui/attachment";
import {
  ComposerPrimitive,
  useAssistantState,
  useComposerRuntime,
  useThreadRuntime,
} from "@assistant-ui/react";
import {
  type FC,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useContext,
  useEffect,
  useRef,
} from "react";
import { useModComposer } from "./use-mod-composer";
import { ComposerPassageStrip } from "./composer-passages";
import { ModPromptVirtualText } from "./mod-prompt-virtual-text";
import { ComposerTokenUsage } from "@/browser/webview/TokenUsageIndicator";
import { interceptLargeTextPaste } from "@/browser/webview/pastedTextAttachment";
import { usePendingQuestionCount } from "@/browser/webview/pendingQuestionsStore";
import { useRuntimeReady } from "@/browser/webview/RuntimeConnectionBanner";
import { ModComposerStatus } from "./mod-ui";
import { PendingMessageContext, restoreNextMessageIntoComposer } from "./next-message-strip";
import {
  applyInjectRestore,
  ComposerDeliveryContext,
  InjectMessagesContext,
  shouldQueueOnRunningModEnter,
} from "./inject-message-context";
import { shouldSendInForkOnModAltEnter } from "./composer-send-shortcuts";
import { useComposerHistory } from "./composer-history";
import { useT } from "@/browser/webview/i18n";
import { SlashCommandPicker } from "@/components/assistant-ui/slash-command-picker";
import {
  ComposerCancelStateContext,
  SlashCommandsContext,
  SnapshotBlocksComposerInputContext,
  SnapshotNeedsAnswerContext,
} from './thread-contexts';
import { canCompactSession, sendCompactCommand, shouldSendOnRunningEnter } from './composer-logic';
import { useComposerSend } from './use-composer-send';
import { PlanModeBanner } from './composer-mode-picker';
import { ComposerAction } from './composer-action';

/**
 * The composer context ring, wired to the thread: its popover's Compact
 * session button runs `/compact` (see `sendCompactCommand`) and is enabled
 * only while a send would be accepted (see `canCompactSession`).
 */
export const ComposerContextUsage: FC<{ isForeground?: boolean }> = ({ isForeground }) => {
  const threadRuntime = useThreadRuntime();
  const isRunning = useAssistantState((s) => s.thread.isRunning);
  const snapshotNeedsAnswer = useContext(SnapshotNeedsAnswerContext);
  const sendBlocked = usePendingQuestionCount() > 0 || snapshotNeedsAnswer;
  const { isStopping } = useContext(ComposerCancelStateContext);
  const runtimeReady = useRuntimeReady();
  const handleCompact = useCallback(() => {
    sendCompactCommand(threadRuntime);
  }, [threadRuntime]);
  return (
    <ComposerTokenUsage
      canCompact={canCompactSession({
        isRunning,
        sendBlocked,
        isStopping,
        runtimeReady,
      })}
      onCompact={handleCompact}
      isForeground={isForeground}
    />
  );
};

// Exported for `remote-client-can-trimming.render.test.ts`, which mounts it to
// pin that the runtime gate EXPLAINS itself (`remote.composer.disabled`) rather
// than just going inert. Not part of the public surface — Thread renders it.
export const Composer: FC = () => {  const t = useT();
  const slashCommands = useContext(SlashCommandsContext);
  // Per-model gate for image paste. When the ACTIVE model is text-only
  // (`supportsImageInput: false` in the curated catalog) the library's
  // paste-to-attachment path is switched off entirely — dropzones stay
  // enabled for the `@"path"` file route, with image files rejected at
  // the adapter chokepoint (BrowserComposerAttachmentAdapter.add).
  const { supportsImageInput } = useComposerModelCapabilities();
  // Block input while an AskUserQuestion awaits an answer: the union of the per-thread
  // pending count and the worker snapshot's `pendingUserInteraction` (available at once
  // on re-attach). Plan approval and permission asks are excluded from this gate.
  const snapshotBlocksInput = useContext(SnapshotBlocksComposerInputContext);
  const awaitingAnswer = usePendingQuestionCount() > 0 || snapshotBlocksInput;
  // The wire to the runtime is down (remote only): a message typed
  // now could not be delivered, and letting it look sent would be worse than
  // a disabled box next to a banner that says why. Always true on the desktop
  // — `RuntimeReadyContext` defaults to true and a MessagePort connection
  // never leaves `ready`.
  const runtimeReady = useRuntimeReady();
  // The composer stays editable while the agent runs (a running-session submit becomes
  // the "next message"); the only input gates are `awaitingAnswer` and `runtimeReady`.
  const composerDisabled = awaitingAnswer || !runtimeReady;

  // Enter while the agent is RUNNING. `ComposerPrimitive.Input` refuses to
  // submit on Enter whenever `thread.isRunning` unless the runtime declares
  // `capabilities.queue` — and `useExternalStoreRuntime` hardcodes that false.
  // So without this handler the whole next-message feature was mouse-only:
  // ComposerAction was deliberately hand-rolled to bypass the same block for
  // the send button (see its comment), but Enter still silently did nothing.
  // Mirrors the button's gate exactly, and only fires in the case assistant-ui
  // declines to handle — idle Enter still goes through the primitive.
  const composer = useComposerRuntime();
  const { hasPassages, send: sendComposer, passages } = useComposerSend();
  const snapshotNeedsAnswer = useContext(SnapshotNeedsAnswerContext);
  const sendBlocked = usePendingQuestionCount() > 0 || snapshotNeedsAnswer;
  const isRunning = useAssistantState((s) => s.thread.isRunning);
  const hasMessages = useAssistantState((s) => s.thread.messages.length > 0);
  const { setNextDelivery } = useContext(ComposerDeliveryContext);
  const { restore: injectRestore } = useContext(InjectMessagesContext);
  const pendingMessage = useContext(PendingMessageContext);
  const { isStopping, onCancel } = useContext(ComposerCancelStateContext);
  // Stop / Esc hand back only the inject texts the WORKER actually dropped
  // (`injectMessagesCleared`) — one drained into the model in the same
  // instant must not also return to the composer.
  useEffect(() => {
    const next = applyInjectRestore(composer.getState().text, injectRestore, passages);
    if (next !== null) composer.setText(next);
  }, [composer, injectRestore, passages]);
  // The session's mods read, fill and suggest into this box (F-25):
  // `$.prompt.read` / `.fill` / `.suggest`. A suggestion shows dim in the
  // empty box; Tab or → takes it.
  const composerInput = useRef<HTMLTextAreaElement | null>(null);
  const { suggestion: modSuggestion, takeSuggestion, virtualText: modVirtualText } = useModComposer({
    composer,
    input: composerInput,
    isRunning,
    isBlocked: awaitingAnswer,
  });
  const history = useComposerHistory();
  const handleComposerKeyDown = (
    e: ReactKeyboardEvent<HTMLTextAreaElement>,
  ) => {
    const state = composer.getState();
    const plainKey =
      !e.shiftKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !e.defaultPrevented &&
      !e.nativeEvent.isComposing;
    if (
      plainKey &&
      history.onKey(e.key, {
        start: e.currentTarget.selectionStart,
        end: e.currentTarget.selectionEnd,
      })
    ) {
      e.preventDefault();
      return;
    }
    if (
      (e.key === "Tab" || e.key === "ArrowRight") &&
      modSuggestion !== null &&
      plainKey &&
      takeSuggestion()
    ) {
      e.preventDefault();
      return;
    }
    const keyParams = {
      key: e.key,
      shiftKey: e.shiftKey,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      altKey: e.altKey,
      isComposing: e.nativeEvent.isComposing,
      defaultPrevented: e.defaultPrevented,
      isRunning,
      sendBlocked,
      hasContent: state.text.trim().length > 0 || state.attachments.length > 0 || hasPassages,
    };
    // Esc while running stops the turn like the Stop button, never via assistant-ui's
    // cancelRun (`cancelOnEscape` is off below), which deletes the trailing user message.
    if (
      e.key === "Escape" &&
      isRunning &&
      !isStopping &&
      !e.defaultPrevented &&
      !e.nativeEvent.isComposing &&
      onCancel
    ) {
      e.preventDefault();
      restoreNextMessageIntoComposer(composer, pendingMessage, passages);
      onCancel();
      return;
    }
    // Ctrl/Cmd+Alt+Enter (idle or running) → send in a forked session. Claimed
    // before the primitive, which would otherwise send it into THIS session.
    if (shouldSendInForkOnModAltEnter(keyParams)) {
      e.preventDefault();
      setNextDelivery("fork");
      sendComposer();
      return;
    }
    // Ctrl/Cmd+Enter while running → queue for the NEXT turn (the strip).
    if (shouldQueueOnRunningModEnter(keyParams)) {
      e.preventDefault();
      setNextDelivery("next");
      sendComposer();
      return;
    }
    if (!shouldSendOnRunningEnter(keyParams)) return;
    // Claim the key so the primitive's own (no-op while running) handler is
    // skipped, then send — plain Enter adds the message to the RUNNING turn.
    e.preventDefault();
    setNextDelivery("inject");
    sendComposer();
  };
  return (
    <ComposerPrimitive.Root
      className="aui-composer-root relative flex w-full flex-col"
      // Every submit the primitive makes (idle Enter, a halt's Enter) goes
      // through the composer's send while there are cards: the library send
      // neither carries them nor sends a box holding only cards (F-22).
      onSubmit={(e) => {
        if (!hasPassages) return;
        e.preventDefault();
        sendComposer();
      }}
    >
      <PlanModeBanner />
      <SlashCommandPicker
        commands={slashCommands}
        quietText={history.state?.shownText ?? null}
      >
        <ComposerPrimitive.AttachmentDropzone asChild>
          <div
            data-slot="composer-shell"
            data-awaiting-answer={awaitingAnswer ? "true" : undefined}
            className={
              "flex w-full flex-col gap-2 rounded-(--composer-radius) border bg-base-surface p-(--composer-padding) transition-shadow focus-within:border-ring/75 focus-within:ring-2 focus-within:ring-ring/20 data-[dragging=true]:border-ring data-[dragging=true]:border-dashed data-[dragging=true]:bg-accent/50" +
              // Visibly inert while a question is pending so attention goes to
              // the (top-level, auto-revealed) question card instead.
              (awaitingAnswer ? " opacity-60 [&_*]:cursor-not-allowed" : "")
            }
          >
            {/* The mods' status lines (F-25 `$.ui.status`): one row on the
                box's top edge, passive text that belongs to the prompt —
                apart from the interactive band outside the box above. */}
            <ModComposerStatus />
            {history.state !== null && (
              <div
                data-testid="composer-history-label"
                className="px-1.75 text-xs text-muted-foreground"
              >
                {t("composer.historyPosition", {
                  index: String(history.state.index),
                  total: String(history.state.entries.length),
                })}
              </div>
            )}
            <ComposerPassageStrip />
            <ComposerAttachments />
            <ComposerPrimitive.Input
              ref={composerInput}
              data-testid="composer-input"
              data-mod-suggestion={modSuggestion !== null ? "true" : undefined}
              disabled={composerDisabled}
              // Say WHY the box is dead. `awaitingAnswer` explains itself on
              // screen (the question card is auto-revealed above); a wire that
              // is down does not, so the runtime gate carries the sentence the
              // banner's headline leaves out. Undefined otherwise — the desktop
              // must not grow a tooltip it never had.
              title={
                !runtimeReady && !awaitingAnswer
                  ? t("remote.composer.disabled")
                  : undefined
              }
              addAttachmentOnPaste={supportsImageInput}
              // A large plain-text paste becomes a "Pasted text" card, whatever
              // the model's image support. Runs before the primitive's own
              // paste handler, which a claimed (defaultPrevented) event skips.
              onPaste={(e) => {
                interceptLargeTextPaste(e, composer);
              }}
              onKeyDown={handleComposerKeyDown}
              cancelOnEscape={false}
              // The send shortcuts live in the Send button's tooltip and the
              // hint line; the empty composer invites a first task in a new
              // thread and points at slash commands after that.
              // A mod's suggestion (`$.prompt.suggest`) shows dim in its place.
              placeholder={
                modVirtualText !== null
                  ? undefined
                  : (modSuggestion ??
                    (hasMessages
                      ? t('composer.placeholder')
                      : t('composer.placeholderEmptyThread')))
              }
              className="aui-composer-input max-h-32 min-h-10 w-full resize-none bg-transparent px-1.75 py-1 text-composer outline-none placeholder:text-muted-foreground/80 disabled:cursor-not-allowed"
              rows={1}
              autoFocus
              aria-label={t('composer.inputAria')}
            />
            {/* The mods' virtual text (F-25), drawn over the box after the
                draft; the box holds and sends the draft alone. */}
            <ModPromptVirtualText input={composerInput} shown={modVirtualText} />
            <ComposerAction />
          </div>
        </ComposerPrimitive.AttachmentDropzone>
      </SlashCommandPicker>
    </ComposerPrimitive.Root>
  );
};
