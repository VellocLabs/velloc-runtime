import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ComposerAddAttachment } from "@/components/assistant-ui/attachment";
import { Button } from "@/components/ui/button";
import { AuiIf, useAssistantState, useComposerRuntime } from "@assistant-ui/react";
import { ArrowUpIcon, SquareIcon } from "lucide-react";
import {
  type FC,
  Fragment,
  useContext,
  useEffect,
  useState,
} from "react";
import { usePendingQuestionCount } from "@/browser/webview/pendingQuestionsStore";
import { ModPromptHintSite } from "./mod-render";
import { PendingMessageContext, restoreNextMessageIntoComposer } from "./next-message-strip";
import { ComposerDeliveryContext } from "./inject-message-context";
import { composerShortcutModifiers, resolveComposerInputHint, resolveComposerSendShortcuts } from "./composer-send-shortcuts";
import { useT } from "@/browser/webview/i18n";
import { slashCommandDescription } from "@/components/assistant-ui/slash-command-picker";
import {
  ComposerCancelStateContext,
  ContinueConversationContext,
  IsResumableContext,
  LastTerminalReasonContext,
  SlashCommandsContext,
  SnapshotNeedsAnswerContext,
} from './thread-contexts';
import { continueReasonMessageKey, resolveComposerActionDisabled, resolveComposerActionVisibility } from './composer-logic';
import { useComposerSend } from './use-composer-send';
import { ComposerModePicker } from './composer-mode-picker';

// The Send button's tooltip: one row per send mode, label on the left and its
// shortcut on the right. "Queue for later" only while the turn runs — see
// `resolveComposerSendShortcuts`.
export const ComposerSendTooltip: FC<{ isRunning: boolean }> = ({ isRunning }) => {
  const t = useT();
  // An empty session has nothing to fork, so the fork row is left out — see
  // `resolveComposerSendShortcuts`.
  const hasMessages = useAssistantState((s) => s.thread.messages.length > 0);
  const glyphs = composerShortcutModifiers(
    typeof navigator !== "undefined" ? navigator.platform : undefined,
  );
  return (
    <div
      data-testid="composer-send-tooltip"
      className="grid grid-cols-[auto_auto] items-center gap-x-4 gap-y-1"
    >
      {resolveComposerSendShortcuts({ isRunning, hasMessages }).map((shortcut) => (
        <Fragment key={shortcut.id}>
          <span data-shortcut={shortcut.id}>{t(shortcut.labelKey)}</span>
          <kbd className="justify-self-end font-sans opacity-70">
            {t(shortcut.keysKey, glyphs)}
          </kbd>
        </Fragment>
      ))}
    </div>
  );
};

// The hint line after the attachment button: teaches how to write what is
// being typed (`resolveComposerInputHint`). Same size and colour as the input's
// placeholder, which covers the empty state on its own — so nothing renders
// here until the user types. It is the mods' `PromptHint` site (F-25): a hook
// rewrites the line, adds a dim `tail` after it, or draws its own tree in its
// place — raised for the empty prompt too (`hint: ""`), so a mod may fill the
// line where the engine draws nothing.
export const ComposerInputHintLine: FC = () => {
  const t = useT();
  const text = useAssistantState((s) => s.composer.text);
  const isRunning = useAssistantState((s) => s.thread.isRunning);
  const hasMessages = useAssistantState((s) => s.thread.messages.length > 0);
  const commands = useContext(SlashCommandsContext);
  const hint = resolveComposerInputHint({ text, isRunning, hasMessages, commands });
  const glyphs = composerShortcutModifiers(
    typeof navigator !== "undefined" ? navigator.platform : undefined,
  );
  let line = "";
  switch (hint?.kind) {
    case "send":
      // An empty session has nothing to fork, so the fork shortcut is left
      // out of the hint — the Empty variants carry no fork clause.
      line = hint.isRunning
        ? t(
            hint.hasMessages
              ? "composer.hint.sendRunning"
              : "composer.hint.sendRunningEmpty",
            glyphs,
          )
        : t(
            hint.hasMessages ? "composer.hint.send" : "composer.hint.sendEmpty",
            glyphs,
          );
      break;
    case "command-pick":
      line = t("composer.hint.commandPick");
      break;
    case "command-usage": {
      const description = slashCommandDescription(hint.command, t);
      line = t("composer.hint.commandUsage", { usage: hint.usage });
      if (description) line = `${line} — ${description}`;
      break;
    }
    case "command-unknown":
      line = t("composer.hint.commandUnknown", { name: hint.name });
      break;
  }
  // The line as the engine draws it, or as a hook rewrote it: `hint` in the
  // line's place, `tail` dim after it. Nothing to draw draws nothing.
  const drawLine = (rewrite?: { hint: string; tail?: string }) => {
    const shown = rewrite ? rewrite.hint : line;
    const tail = rewrite?.tail;
    if (!shown && !tail) return null;
    return (
      <span
        data-testid="composer-input-hint"
        data-hint-kind={hint?.kind}
        title={[shown, tail].filter(Boolean).join(" ")}
        className="aui-composer-input-hint min-w-0 flex-1 truncate px-1.75 text-muted-foreground/80 text-body"
      >
        {shown}
        {tail ? (
          <span data-testid="composer-input-hint-tail" className="opacity-70">
            {shown ? ` ${tail}` : tail}
          </span>
        ) : null}
      </span>
    );
  };
  return (
    <ModPromptHintSite
      props={{ isDraft: text !== "", isWorking: isRunning, hint: line }}
      drawEngine={drawLine}
    />
  );
};

// Exported for `composer-stop-cancel.render.test.ts`, which mounts it against a
// real `useExternalStoreRuntime` to pin that Stop does NOT route through
// `ComposerPrimitive.Cancel` (see `handleCancelClick`). Not part of the public
// surface — Thread renders it.
export const ComposerAction: FC = () => {
  const t = useT();
  const { isStopping, onCancel } = useContext(ComposerCancelStateContext);
  // Track the click locally so the disable lands on the click's frame, before the worker
  // flips `isStopping`; cleared when `isStopping` drops.
  const [pendingCancel, setPendingCancel] = useState(false);
  useEffect(() => {
    if (!isStopping) {
      setPendingCancel(false);
    }
  }, [isStopping]);
  // Mirror the composer-input gate: no sending an ordinary message while the
  // agent is blocked on an AskUserQuestion answer (it wouldn't unblock the
  // turn). Re-arms when the question is answered. Union the durable snapshot
  // signal (see Composer above) so the send button stays disabled across an
  // LRU eviction + re-attach gap.
  const snapshotNeedsAnswer = useContext(SnapshotNeedsAnswerContext);
  const awaitingAnswer = usePendingQuestionCount() > 0 || snapshotNeedsAnswer;
  // A custom button, not `ComposerPrimitive.Send` (disabled whenever `thread.isRunning`),
  // so a running-session submit reaches the worker's "next message".
  // Visibility: `resolveComposerActionVisibility`.
  const hasText = useAssistantState((s) => !s.composer.isEmpty);
  const hasAttachments = useAssistantState((s) => s.composer.attachments.length > 0);
  const isRunning = useAssistantState((s) => s.thread.isRunning);
  const composer = useComposerRuntime();
  const { hasPassages, send: sendComposer, passages } = useComposerSend();
  const pendingMessage = useContext(PendingMessageContext);
  const hasContent = hasText || hasAttachments || hasPassages;
  // Resume affordance. When the session stopped in a resumable state (aborted
  // mid-stream, hit the output-token cap, or simply settled), the empty-idle
  // composer shows "Continue" in place of the disabled Send button instead of
  // a separate banner above the composer. `awaitingAnswer` suppresses it for
  // the same reason it disables Send: the only valid input is the question card.
  const { onContinueConversation } = useContext(ContinueConversationContext);
  const isResumable = useContext(IsResumableContext);
  const lastTerminalReason = useContext(LastTerminalReasonContext);
  const canContinue = isResumable && !!onContinueConversation && !awaitingAnswer;
  const { showSend, showStop, showContinue } = resolveComposerActionVisibility({
    isRunning,
    hasContent,
    canContinue,
  });

  // One click, one action: each pending flag holds its button inert until the state it
  // waits for arrives (Send: composer empties; Stop: `isStopping` drops; Continue: the
  // resumed turn runs or the session stops being resumable).
  const [pendingSend, setPendingSend] = useState(false);
  useEffect(() => {
    if (!hasContent) setPendingSend(false);
  }, [hasContent]);
  const [continuePending, setContinuePending] = useState(false);
  useEffect(() => {
    if (isRunning || !isResumable) setContinuePending(false);
  }, [isRunning, isResumable]);

  const { sendDisabled, cancelDisabled, continueDisabled } =
    resolveComposerActionDisabled({
      hasContent,
      awaitingAnswer,
      pendingSend,
      pendingCancel,
      isStopping,
      continuePending,
    });

  const { setNextDelivery } = useContext(ComposerDeliveryContext);
  const handleSend = () => {
    if (sendDisabled) return;
    const text = composer.getState().text;
    if (!text.trim() && composer.getState().attachments.length === 0 && !hasPassages) return;
    setPendingSend(true);
    // The send button is plain Enter: while running it adds to this turn.
    if (isRunning) setNextDelivery("inject");
    sendComposer();
  };

  // Stop drops the session's saved next message, so hand that text back to this
  // composer. `onCancel` is called directly, not via `ComposerPrimitive.Cancel`, whose
  // `cancelRun()` undoes the last user message; the worker persists it instead, so
  // taking both duplicates the message.
  const handleCancelClick = () => {
    if (cancelDisabled) return;
    // Inject texts come back via the worker's `injectMessagesCleared`
    // (applied by the Composer), not from local bubbles.
    restoreNextMessageIntoComposer(composer, pendingMessage, passages);
    setPendingCancel(true);
    onCancel?.();
  };

  return (
    <div className="aui-composer-action-wrapper relative flex items-center gap-1">
      {/* While a question is pending, the ONLY valid input is the question
          card — make the other composer affordances (permission-mode picker,
          attachment paperclip / drop) inert too, mirroring the input+send gate.
          Send/Cancel stay outside this guard so the user can still stop the
          turn. Re-arms when the question is answered. */}
      <div
        data-testid="composer-secondary-actions"
        data-awaiting-answer={awaitingAnswer ? "true" : undefined}
        className={
          "flex items-center gap-1" +
          (awaitingAnswer ? " pointer-events-none" : "")
        }
      >
        <ComposerModePicker />
        <AuiIf condition={(s) => !s.thread.isRunning}>
          <ComposerAddAttachment />
        </AuiIf>
      </div>
      {!awaitingAnswer && <ComposerInputHintLine />}
      <div className="ml-auto flex items-center gap-1">
        {showContinue && (
          <TooltipIconButton
            data-testid="composer-continue"
            // The reason the conversation stopped, shown on hover.
            tooltip={t(continueReasonMessageKey(lastTerminalReason))}
            side="bottom"
            type="button"
            variant="default"
            // Same height and shape as Send/Stop (h-8, rounded-full); only the
            // width grows to fit the label, so the composer's action row keeps
            // its exact vertical rhythm when the button swaps.
            className="aui-composer-continue h-8 w-auto gap-1.5 rounded-full px-3.5 text-body"
            aria-label={t('thread.continueConversation')}
            // Inert from the click until the state settles — one click, one
            // resume.
            disabled={continueDisabled}
            onClick={() => {
              if (continueDisabled) return;
              setContinuePending(true);
              // If the resume never actually submits (the handler threw, or the
              // transcript's last message was nothing it knows how to resume),
              // re-arm — the click accomplished nothing, and a permanently dead
              // button would be worse than a re-clickable one.
              Promise.resolve(onContinueConversation?.()).catch(() => {
                setContinuePending(false);
              });
            }}
          >
            <ArrowUpIcon className="aui-composer-continue-icon size-4" />
            <span>{t('thread.continueConversation')}</span>
          </TooltipIconButton>
        )}
        {showSend && (
          // Not a TooltipIconButton: its tooltip is a single string, and this
          // one lists every send mode with its shortcut (ComposerSendTooltip).
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                data-testid="composer-send"
                type="button"
                variant="default"
                size="icon"
                disabled={sendDisabled}
                onClick={handleSend}
                className="aui-composer-send size-8 rounded-full"
                aria-label={t('action.send')}
              >
                <ArrowUpIcon className="aui-composer-send-icon size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <ComposerSendTooltip isRunning={isRunning} />
            </TooltipContent>
          </Tooltip>
        )}
        {showStop && (
          // NOT wrapped in `ComposerPrimitive.Cancel` — see `handleCancelClick`.
          <Button
            data-testid="composer-cancel"
            type="button"
            variant="default"
            size="icon"
            className="aui-composer-cancel size-8 rounded-full"
            aria-label={t('action.stop')}
            disabled={cancelDisabled}
            onClick={handleCancelClick}
          >
            <SquareIcon className="aui-composer-cancel-icon size-3 fill-current" />
          </Button>
        )}
      </div>
    </div>
  );
};
