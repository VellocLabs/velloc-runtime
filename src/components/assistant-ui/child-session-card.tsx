import type { FC } from "react";
import { ArrowRightIcon, GitForkIcon, Loader2Icon, SplitIcon } from "lucide-react";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { requestTeammateJump } from "@/browser/webview/teammateJumpRequests";
import { useT } from "@/browser/webview/i18n";
import { useSessionStatus } from "@/browser/webview/sessionStatusStore";
import {
  childSessionStatus,
  childStateLabel,
  childStateTone,
  childStatusLine,
  type ChildSessionState,
  type ChildSessionStatus,
} from "@/browser/webview/childSessionStatus";
import {
  SPAWN_SESSION_TOOL_NAME,
  parseChildSessionAck,
  type ChildSessionSource,
} from "@/sessions/childSessionSpec";

/** What the card knows from the call itself: its arguments, then the runtime's acknowledgement. */
export type ChildSpawnView = {
  title: string;
  name: string;
  from: ChildSessionSource;
  /** Null until the acknowledgement says where the child works. */
  sharedCheckout: boolean | null;
  /** Null until the acknowledgement names the session. */
  sessionId: string | null;
};

const tidy = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/**
 * A `SpawnSession` call as a start card, or null when it is not one: a text
 * result that is not an acknowledgement (a refusal) renders as a tool row.
 */
export function classifyChildSpawn(
  toolName: string | undefined,
  args: unknown,
  result: unknown,
): ChildSpawnView | null {
  if (toolName !== SPAWN_SESSION_TOOL_NAME) return null;
  const input = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  const title = tidy(input.title);
  const from: ChildSessionSource = tidy(input.from) === "fork" ? "fork" : "fresh";
  const resultText = typeof result === "string" ? result.trim() : "";
  if (resultText.length > 0) {
    const ack = parseChildSessionAck(resultText);
    if (!ack) return null;
    return {
      title: title || ack.name,
      name: ack.name,
      from: ack.startFailed ? from : ack.from,
      sharedCheckout: ack.startFailed ? null : ack.sharedCheckout,
      sessionId: ack.sessionId,
    };
  }
  if (!title) return null;
  return { title, name: tidy(input.name), from, sharedCheckout: null, sessionId: null };
}

const TONE_CLASS: Record<ReturnType<typeof childStateTone>, string> = {
  busy: "bg-primary animate-pulse",
  attention: "bg-warning",
  ok: "bg-success",
  error: "bg-destructive",
  quiet: "bg-muted-foreground/50",
};

/** The state dot shared by the start card and the session link chip. */
export const ChildStateDot: FC<{ state: ChildSessionState; className?: string }> = ({
  state,
  className,
}) => {
  const t = useT();
  if (state === "starting") {
    return (
      <Loader2Icon
        className={cn("size-3 shrink-0 animate-spin text-muted-foreground", className)}
        aria-label={childStateLabel(state, t)}
        data-state-dot={state}
      />
    );
  }
  return (
    <span
      role="img"
      aria-label={childStateLabel(state, t)}
      data-state-dot={state}
      className={cn("inline-block size-2 shrink-0 rounded-full", TONE_CLASS[childStateTone(state)], className)}
    />
  );
};

/**
 * The start card: the child's title and short name, how it was started and
 * where it works, and a status line that follows the child's published
 * state. The whole card opens the child once the runtime has named it.
 */
export const ChildSessionCard: FC<{ spawn: ChildSpawnView }> = ({ spawn }) => {
  const t = useT();
  const entry = useSessionStatus(spawn.sessionId);
  const ready = spawn.sessionId !== null;
  const status: ChildSessionStatus = ready ? childSessionStatus(entry) : { state: "starting" };
  const openLabel = t("childSession.openAria", { title: spawn.title });
  const kind = [
    t(spawn.from === "fork" ? "childSession.kind.fork" : "childSession.kind.fresh"),
    ...(spawn.sharedCheckout === null
      ? []
      : [t(spawn.sharedCheckout ? "childSession.checkout.shared" : "childSession.checkout.worktree")]),
  ].join(" · ");
  const KindIcon = spawn.from === "fork" ? GitForkIcon : SplitIcon;

  const body = (
    <>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          <KindIcon className="size-3" aria-hidden="true" />
          {t("childSession.eyebrow")}
        </span>
        <span className="mt-0.5 flex min-w-0 items-baseline gap-2">
          <span className="truncate font-medium" data-testid="child-session-title">
            {spawn.title}
          </span>
          {spawn.name && (
            <span
              className="shrink-0 rounded bg-muted px-1.5 font-mono text-[11px] text-muted-foreground"
              data-testid="child-session-name"
            >
              {spawn.name}
            </span>
          )}
        </span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground" data-testid="child-session-kind">
          {kind}
        </span>
        <span
          className="mt-1 flex min-w-0 items-center gap-1.5 text-xs"
          data-testid="child-session-status"
          title={status.reason}
        >
          <ChildStateDot state={status.state} />
          <span className="shrink-0">{childStatusLine(status, t)}</span>
          {status.lastReply && (
            <span className="min-w-0 truncate text-muted-foreground" data-testid="child-session-last-reply">
              {status.lastReply}
            </span>
          )}
        </span>
      </span>
      {ready && (
        <span className="flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground transition-colors group-hover:bg-accent group-hover:text-foreground">
          {t("childSession.open")}
          <ArrowRightIcon
            className="size-3.5 transition-transform group-hover:translate-x-0.5"
            aria-hidden="true"
          />
        </span>
      )}
    </>
  );

  return (
    <div
      className="aui-child-session-card-root my-2 w-full"
      data-testid="child-session-card"
      data-status={status.state}
      data-session-id={spawn.sessionId ?? undefined}
    >
      <Card className="w-full gap-0 overflow-hidden py-0">
        {ready ? (
          <button
            type="button"
            onClick={() => requestTeammateJump({ sessionId: spawn.sessionId! })}
            aria-label={openLabel}
            title={openLabel}
            data-testid="child-session-open"
            className="group flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left text-sm transition-colors hover:bg-accent/40"
          >
            {body}
          </button>
        ) : (
          <div className="flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left text-sm">{body}</div>
        )}
      </Card>
    </div>
  );
};
