import { providerApiErrorKindLabel } from "@/components/assistant-ui/running-indicator";
import { Button } from "@/components/ui/button";
import { useAssistantState, useComposerRuntime } from "@assistant-ui/react";
import { type FC, useCallback, useState } from "react";
import { useLocale, useT } from "@/browser/webview/i18n";
import { useMessageActionsContext } from "@/components/assistant-ui/message-actions-context";
import { storedKeyProblemOf } from "@/utils/storedKeyProblem";
import { maskingRefusalOf } from "@/utils/maskingRefusal";
import { providerDeclaredMessage, providerErrorSummaryKey } from './composer-logic';

export const ProviderApiErrorCard: FC = () => {
  const t = useT();
  const composer = useComposerRuntime();
  const { onRetryProviderApiError } = useMessageActionsContext();
  const custom = useAssistantState((s) => s.message.metadata.custom ?? {});
  const retryPrompt =
    typeof custom.retryPrompt === "string" ? custom.retryPrompt : "";
  const kind = typeof custom.apiErrorKind === "string" ? custom.apiErrorKind : "unknown";
  const details =
    typeof custom.apiErrorDetails === "string" ? custom.apiErrorDetails : "";
  // The classification is a protocol slug (`ProviderApiErrorKind`); the label
  // beside "Issue:" is prose, so it goes through the catalog like the running
  // status line does — same helper, same vocabulary, one enum.
  const displayKind = providerApiErrorKindLabel(t, kind);
  // Only claim a retry when the transport actually ran one — non-retryable
  // classifications (and outright provider rejections) are surfaced on the
  // first failure without ever being resent.
  const retryCount =
    typeof custom.apiErrorRetryCount === "number" ? custom.apiErrorRetryCount : 0;
  // An out-of-credit rejection (HTTP 402) is terminal like any other, but the
  // generic "resending it unchanged would fail the same way" is wrong advice
  // there: once the user tops up, the unchanged resend is exactly the fix.
  const billingHint = kind === "billing_error";
  // The host refused to send for want of a usable stored key: the provider
  // never saw the request, so "the provider rejected it" would mislead.
  const storedKeyProblem = storedKeyProblemOf(details);
  // Model egress masking refused to send (F-39): the details are a marker,
  // so the card shows the localized reason instead of them.
  const maskingRefusal = maskingRefusalOf(details);
  const localLimitHint = kind === "local_stream_limit";
  const retrySummary = t(
    providerErrorSummaryKey({ kind, details, retryCount }),
    { count: retryCount },
  );
  // What the provider's own manifest says about this failure: shown in place
  // of the generic summary, in the person's locale.
  const locale = useLocale();
  const declaredMessage = providerDeclaredMessage(custom.apiErrorMessage, locale);
  const declaredCode = typeof custom.apiErrorCode === "string" ? custom.apiErrorCode : undefined;
  const loopGuardHint = kind === "repetitive_tool_calls";
  // A safety stop (`stop_reason: content_filter`): explain that the verdict
  // is about the request, not the transport, and name the provider's category
  // when it gave one. "Try again" stays live — after switching models in the
  // picker it resumes the turn on the new model, which is the recovery the
  // provider recommends.
  const refusalHint = kind === "refusal";
  const refusalCategory =
    typeof custom.apiErrorRefusalCategory === "string"
      ? custom.apiErrorRefusalCategory
      : "";

  // Disable the button the instant it's clicked: the retry resubmits the
  // prompt as a new turn, and a second click before that turn's state lands
  // would double-submit. No need to re-enable — once the retried turn
  // streams, this card is superseded and unmounts (the adapter renders only
  // the trailing API-error card), taking this state with it.
  const [retrying, setRetrying] = useState(false);

  const handleTryAgain = useCallback(() => {
    if (!retryPrompt || retrying) return;
    setRetrying(true);
    if (onRetryProviderApiError) {
      void onRetryProviderApiError(retryPrompt);
      return;
    }
    composer.setText(retryPrompt);
  }, [composer, onRetryProviderApiError, retryPrompt, retrying]);

  return (
    <div className="mx-auto w-full max-w-(--thread-max-width) py-3">
      <div
        className="aui-provider-api-error-card rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-foreground shadow-sm"
        data-testid="provider-api-error-card"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1.5">
            <div className="font-medium text-destructive">
              {t("thread.providerRequestFailed")}
            </div>
            {declaredMessage ? (
              <div
                className="text-muted-foreground"
                data-testid="provider-api-error-declared-message"
                data-code={declaredCode}
              >
                {declaredMessage}
              </div>
            ) : (
              <div className="text-muted-foreground" data-testid="provider-api-error-retry-summary">
                {retrySummary}
              </div>
            )}
            <div className="text-xs text-muted-foreground">
              {t("thread.issueLabel", { kind: displayKind })}
            </div>
            {loopGuardHint ? (
              <div
                className="text-xs text-muted-foreground"
                data-testid="provider-api-error-loop-guard-hint"
              >
                {t("thread.providerLoopGuardHint")}
              </div>
            ) : null}
            {storedKeyProblem ? (
              <div
                className="text-xs text-muted-foreground"
                data-testid="provider-api-error-stored-key-hint"
                data-problem={storedKeyProblem}
              >
                {t(
                  storedKeyProblem === "unreadable"
                    ? "providerIssue.storedKeyUnreadable.summary"
                    : "providerIssue.storedKeyUnavailable.summary",
                )}
              </div>
            ) : null}
            {maskingRefusal ? (
              <div
                className="text-xs text-muted-foreground"
                data-testid="provider-api-error-masking-hint"
                data-refusal={maskingRefusal.kind}
              >
                {maskingRefusal.kind === "residual"
                  ? t("providerIssue.maskingResidual.summary", {
                      rule: maskingRefusal.rule,
                      where: maskingRefusal.where,
                    })
                  : t(
                      maskingRefusal.kind === "broken"
                        ? "providerIssue.maskingBroken.summary"
                        : maskingRefusal.kind === "undecodable"
                          ? "providerIssue.maskingUndecodable.summary"
                          : "providerIssue.maskingUnknown.summary",
                    )}
              </div>
            ) : null}
            {localLimitHint ? (
              <div
                className="text-xs text-muted-foreground"
                data-testid="provider-api-error-local-limit-hint"
              >
                {t("providerIssue.localStreamLimit.summary")}
              </div>
            ) : null}
            {billingHint ? (
              <div
                className="text-xs text-muted-foreground"
                data-testid="provider-api-error-billing-hint"
              >
                {t("thread.providerBillingHint")}
              </div>
            ) : null}
            {refusalHint ? (
              <div
                className="text-xs text-muted-foreground"
                data-testid="provider-api-error-refusal-hint"
              >
                {refusalCategory
                  ? t("thread.providerRefusalHint", { category: refusalCategory })
                  : t("thread.providerRefusalHintUncategorized")}
              </div>
            ) : null}
            {details && !maskingRefusal ? (
              <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-background/70 p-2 text-xs text-muted-foreground">
                {details}
              </pre>
            ) : null}
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleTryAgain}
            disabled={!retryPrompt || retrying}
            data-testid="provider-api-error-try-again"
            className="shrink-0"
          >
            {retrying ? t("thread.retrying") : t("thread.tryAgain")}
          </Button>
        </div>
      </div>
    </div>
  );
};
