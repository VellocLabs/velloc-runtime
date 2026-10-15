import type { FC } from "react";
import { ArrowRightIcon, Loader2Icon, UserPlusIcon } from "lucide-react";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { requestTeammateJump } from "@/browser/webview/teammateJumpRequests";
import { useT } from "@/browser/webview/i18n";
import type { TeammateSpawnView } from "@/components/assistant-ui/tool-fallback";

/**
 * The top-level card for the `Agent` call that starts a teammate; the whole card jumps
 * to the new session. Inert, with a spinner, until the spawn acks with a session id.
 */
export const TeammateSpawnCard: FC<{ spawn: TeammateSpawnView }> = ({
  spawn,
}) => {
  const t = useT();
  const ready = spawn.sessionId !== null;
  const label = t("teamMessage.openTeammate", { name: spawn.name });
  const initial = spawn.name.trim().charAt(0).toUpperCase() || "?";

  const body = (
    <>
      <span
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
          ready
            ? "bg-primary/10 text-primary"
            : "bg-muted text-muted-foreground",
        )}
        aria-hidden="true"
      >
        {ready ? initial : <Loader2Icon className="size-4 animate-spin" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          <UserPlusIcon className="size-3" aria-hidden="true" />
          {t("teamMessage.spawnEyebrow")}
        </span>
        <span className="mt-0.5 block truncate font-medium">{spawn.name}</span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          {ready
            ? t("teamMessage.spawnRunning")
            : t("teamMessage.spawnStarting")}
        </span>
      </span>
      {ready && (
        <span className="flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground transition-colors group-hover:bg-accent group-hover:text-foreground">
          {t("teamMessage.spawnOpen")}
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
      className="aui-teammate-spawn-card-root my-2 w-full"
      data-role="teammate-spawn-card"
      data-ready={ready ? "true" : "false"}
      data-testid="teammate-spawn-card"
    >
      <Card className="w-full gap-0 overflow-hidden py-0">
        {ready ? (
          <button
            type="button"
            onClick={() =>
              requestTeammateJump({ sessionId: spawn.sessionId! })
            }
            aria-label={label}
            title={label}
            data-testid="teammate-open-session"
            className="group flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left text-sm transition-colors hover:bg-accent/40"
          >
            {body}
          </button>
        ) : (
          <div className="flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left text-sm">
            {body}
          </div>
        )}
      </Card>
    </div>
  );
};
