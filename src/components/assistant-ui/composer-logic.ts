import { type ThreadRuntime } from "@assistant-ui/react";
import type { MessageKey } from "@/browser/webview/i18n/messages/en";
import { storedKeyProblemOf } from "@/utils/storedKeyProblem";
import { maskingRefusalOf } from "@/utils/maskingRefusal";
import { isLocalizedText, resolveLocalizedText } from "@/config/localizedText";

/**
 * Whether the context ring's Compact session may run. Pure, so the gate is
 * unit-tested without mounting the assistant-ui tree. `/compact` is a submit
 * like any other, so it honours the composer's own send gates: the session
 * is stopped, no question card waits for an answer (an AskUserQuestion halt
 * is not running, yet the send button and Enter refuse there), no stop is in
 * flight, and the runtime wire is up.
 */
export function canCompactSession(params: {
  isRunning: boolean;
  /** An unanswered question blocks sending (the send button's gate). */
  sendBlocked: boolean;
  isStopping: boolean;
  runtimeReady: boolean;
}): boolean {
  return (
    !params.isRunning &&
    !params.sendBlocked &&
    !params.isStopping &&
    params.runtimeReady
  );
}

/**
 * Submits `/compact` as a message of its own, exactly as if typed — through
 * the thread's `onNew`, so the slash dispatcher handles it. It does not go
 * through the composer: `composer.send()` takes the draft's attachments and
 * quote along and clears them, so the draft (text, attachments, quote) would
 * be lost or sent with the command. Appending leaves the composer untouched.
 */
export function sendCompactCommand(thread: Pick<ThreadRuntime, "append">): void {
  thread.append("/compact");
}

/**
 * The card's opening sentence. A refusal the host made before sending (no
 * usable stored key, too many open model requests) must not say the provider
 * rejected the request: the provider never saw it.
 */
export function providerErrorSummaryKey(params: {
  kind: string;
  details: string;
  retryCount: number;
}): MessageKey {
  const { kind, details, retryCount } = params;
  if (retryCount > 0) {
    return retryCount === 1
      ? "thread.providerRetriedSummaryOne"
      : "thread.providerRetriedSummary";
  }
  if (storedKeyProblemOf(details)) return "thread.providerStoredKeyNoRetrySummary";
  if (maskingRefusalOf(details)) return "thread.providerMaskingNoRetrySummary";
  if (kind === "local_stream_limit") return "thread.providerLocalLimitNoRetrySummary";
  if (kind === "billing_error") return "thread.providerBillingNoRetrySummary";
  return "thread.providerNoRetrySummary";
}

/**
 * The sentence a provider's manifest declares for a failure, in `locale`; ''
 * when the failure carries none (the card then shows its own summary).
 */
export function providerDeclaredMessage(value: unknown, locale: string | undefined): string {
  return isLocalizedText(value) ? resolveLocalizedText(value, locale) : "";
}

/**
 * Why the composer offers "Continue" instead of "Send": maps `lastTerminalReason` to
 * the Continue button tooltip's catalog key. Unknown reasons fall back to the generic
 * "interrupted" line.
 */
export function continueReasonMessageKey(
  lastTerminalReason: string | undefined,
):
  | 'thread.conversationCancelled'
  | 'thread.hitTokenLimit'
  | 'thread.addFollowUp'
  | 'thread.conversationInterrupted' {
  switch (lastTerminalReason) {
    case "aborted_streaming":
      return "thread.conversationCancelled";
    case "max_output_tokens":
      return "thread.hitTokenLimit";
    case "completed":
      return "thread.addFollowUp";
    default:
      return "thread.conversationInterrupted";
  }
}

/**
 * Whether Enter should submit while the agent is RUNNING. `ComposerPrimitive.Input`
 * refuses then (`useExternalStoreRuntime` reports no `capabilities.queue`), so this
 * covers only that case; idle Enter goes through the primitive untouched.
 */
export function shouldSendOnRunningEnter(params: {
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  isComposing: boolean
  /**
   * The slash-command picker intercepts Enter on the document in the CAPTURE
   * phase (so it runs before the composer's own handler) and calls
   * preventDefault when it consumes the key — never send out from under it.
   */
  defaultPrevented: boolean
  isRunning: boolean
  /** Mirrors the send button's gate: an unanswered question blocks sending. */
  sendBlocked: boolean
  hasContent: boolean
}): boolean {
  if (params.defaultPrevented) return false;
  if (!params.isRunning) return false;
  if (params.sendBlocked) return false;
  if (params.key !== "Enter") return false;
  if (params.shiftKey || params.ctrlKey || params.metaKey || params.altKey) {
    return false;
  }
  if (params.isComposing) return false;
  return params.hasContent;
}

/**
 * Which composer action button (Send / Stop / Continue) is visible:
 *   idle    + empty    → Send (disabled), or Continue when `canContinue`
 *   idle    + has text → Send
 *   running + empty    → Stop only
 *   running + has text → Send only (→ next message)
 * Send and Stop never render side by side.
 */
export function resolveComposerActionVisibility(params: {
  isRunning: boolean;
  hasContent: boolean;
  /** Session is resumable AND a continue handler is wired. Defaults to false
   *  so existing callers (and tests) keep the plain Send/Stop contract. */
  canContinue?: boolean;
}): { showSend: boolean; showStop: boolean; showContinue: boolean } {
  const { isRunning, hasContent, canContinue = false } = params;
  const showContinue = canContinue && !isRunning && !hasContent;
  // Send shows whenever there is something to send OR the turn is idle (the
  // disabled-but-present idle affordance). Hidden only mid-turn + empty,
  // where Stop takes its place — or when Continue has claimed the slot.
  const showSend = (!isRunning || hasContent) && !showContinue;
  const showStop = isRunning && !hasContent;
  return { showSend, showStop, showContinue };
}

/**
 * Whether each composer action button is inert: one click, one action. After a click
 * the button stays inert until the state its work produces arrives (composer empties /
 * `isStopping` drops / the resumed turn runs).
 */
export function resolveComposerActionDisabled(params: {
  hasContent: boolean;
  /** An AskUserQuestion card is unanswered — the only valid input is the card. */
  awaitingAnswer: boolean;
  pendingSend: boolean;
  pendingCancel: boolean;
  /** The worker has acknowledged the abort and is tearing the turn down. */
  isStopping: boolean;
  continuePending: boolean;
}): {
  sendDisabled: boolean;
  cancelDisabled: boolean;
  continueDisabled: boolean;
} {
  return {
    sendDisabled:
      !params.hasContent || params.awaitingAnswer || params.pendingSend,
    cancelDisabled: params.pendingCancel || params.isStopping,
    continueDisabled: params.continuePending,
  };
}
