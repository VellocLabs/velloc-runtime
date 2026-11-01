import { useState, type FC } from "react";
import { ArrowRightIcon, Loader2Icon, SplitIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { requestTeammateJump } from "@/browser/webview/teammateJumpRequests";
import { useT, type TranslateFn } from "@/browser/webview/i18n";
import type { ProposalMode, ProposalView } from "@/sessions/childProposals";
import { useSessionProposalsContext } from "@/components/assistant-ui/session-proposals-context";

const TASK_ID_IN_TEXT = /\btask_[a-z0-9]{8}\b/;

function taskIdOfResult(result: unknown): string | null {
  if (result === undefined || result === null) return null;
  const text = typeof result === "string" ? result : JSON.stringify(result);
  return TASK_ID_IN_TEXT.exec(text ?? "")?.[0] ?? null;
}

function stringArg(args: unknown, key: string): string {
  if (typeof args !== "object" || args === null) return "";
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

/** The record this tool call proposed: by its call id, else by the task id
 *  its result names. */
export function findProposalForCall(
  proposals: readonly ProposalView[] | null,
  toolCallId: string | undefined,
  result: unknown,
): ProposalView | null {
  if (!proposals) return null;
  if (toolCallId) {
    const byCall = proposals.find((p) => p.toolCallId === toolCallId);
    if (byCall) return byCall;
  }
  const taskId = taskIdOfResult(result);
  return taskId ? (proposals.find((p) => p.taskId === taskId) ?? null) : null;
}

function statusText(t: TranslateFn, view: ProposalView): string {
  switch (view.state) {
    case "proposed":
      return view.mode === "offer"
        ? t("proposalCard.offerAsk")
        : t("proposalCard.suggestWaiting");
    case "accepted_awaiting_brief":
      return t("proposalCard.preparing");
    case "starting":
      return t("proposalCard.starting");
    case "started":
      return t("proposalCard.started");
    case "dismissed":
      return view.keptHere
        ? t("proposalCard.keptHere")
        : t("proposalCard.dismissed");
    case "expired":
      return t("proposalCard.expired");
    case "superseded":
      return t("proposalCard.superseded");
  }
}

type CardProps = {
  toolCallId?: string;
  args?: unknown;
  result?: unknown;
};

/**
 * The transcript card for a `ProposeSession` call (F-36): what the model
 * proposed, its live state, and the person's answer. A suggestion offers
 * Start / Dismiss; an offer asks New session / Do it here; a started one
 * opens the child. Buttons appear only while the state takes them and the
 * thread may answer.
 */
export const SessionProposalCard: FC<CardProps> = ({
  toolCallId,
  args,
  result,
}) => {
  const t = useT();
  const { proposals, start, dismiss, choose } = useSessionProposalsContext();
  const [busy, setBusy] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  const view = findProposalForCall(proposals, toolCallId, result);
  const mode: ProposalMode =
    view?.mode ?? (stringArg(args, "mode") === "offer" ? "offer" : "suggest");
  const title = view?.title || stringArg(args, "title");

  const run = (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setActionFailed(false);
    action().then(
      () => setBusy(false),
      () => {
        setBusy(false);
        setActionFailed(true);
      },
    );
  };

  const status = view
    ? statusText(t, view)
    : proposals === null
      ? t("proposalCard.loading")
      : t("proposalCard.unavailable");
  const open = view?.state === "proposed";
  const taskId = view?.taskId;
  const childSessionId =
    view?.state === "started" ? view.childSessionId : undefined;
  const openLabel = t("proposalCard.openAria", {
    name: view?.childName || title,
  });

  return (
    <div
      className="aui-session-proposal-card-root my-2 w-full"
      data-testid="session-proposal-card"
      data-mode={mode}
      data-state={view?.state ?? "unknown"}
    >
      <Card className="w-full gap-0 overflow-hidden py-0">
        <div className="flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left text-sm">
          <span
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
            aria-hidden="true"
          >
            {view?.state === "starting" ||
            view?.state === "accepted_awaiting_brief" ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : (
              <SplitIcon className="size-4" />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {mode === "offer"
                ? t("proposalCard.offerEyebrow")
                : t("proposalCard.suggestEyebrow")}
            </span>
            <span
              className="mt-0.5 block truncate font-medium"
              data-testid="session-proposal-title"
            >
              {title}
            </span>
            <span
              className="mt-0.5 block truncate text-xs text-muted-foreground"
              data-testid="session-proposal-status"
            >
              {status}
            </span>
            {view?.failure && open && (
              <span
                className="mt-0.5 block truncate text-xs text-destructive"
                title={view.failure}
                data-testid="session-proposal-failure"
              >
                {t("proposalCard.startFailed")}
              </span>
            )}
            {actionFailed && (
              <span
                className="mt-0.5 block truncate text-xs text-destructive"
                role="alert"
              >
                {t("proposalCard.actionFailed")}
              </span>
            )}
          </span>
          {open && taskId && mode === "suggest" && start && dismiss && (
            <span className="flex shrink-0 items-center gap-1.5">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => run(() => dismiss(taskId))}
                data-testid="session-proposal-dismiss"
              >
                {t("proposalCard.dismiss")}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => run(() => start(taskId))}
                data-testid="session-proposal-start"
              >
                {t("proposalCard.start")}
              </Button>
            </span>
          )}
          {open && taskId && mode === "offer" && choose && (
            <span className="flex shrink-0 items-center gap-1.5">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => run(() => choose(taskId, "here"))}
                data-testid="session-proposal-here"
              >
                {t("proposalCard.doItHere")}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => run(() => choose(taskId, "new"))}
                data-testid="session-proposal-new"
              >
                {t("proposalCard.newSession")}
              </Button>
            </span>
          )}
          {childSessionId && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => requestTeammateJump({ sessionId: childSessionId })}
              aria-label={openLabel}
              title={openLabel}
              data-testid="session-proposal-open"
            >
              {t("proposalCard.open")}
              <ArrowRightIcon className="size-3.5" aria-hidden="true" />
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
};
