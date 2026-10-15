import { useState, type FC } from "react";
import {
  ChevronDownIcon,
  ChevronsRightIcon,
  ShieldAlertIcon,
  UsersIcon,
} from "lucide-react";

import { Card } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { StaticMarkdown } from "@/components/assistant-ui/static-markdown";
import { cn } from "@/lib/utils";
import { requestTeammateJump } from "@/browser/webview/teammateJumpRequests";
import { useT, type TranslateFn } from "@/browser/webview/i18n";
import type { ParsedTeamMessage } from "@/team/parseTeamFrame";

/**
 * The card for a message a teammate sent: the sender, the untrusted badge, and the
 * peer's own text as the body, collapsed to one line by default.
 * Security: the untrusted badge is the trust the renderer applied when it chose the
 * envelope, never re-derived here, and it stays visible on the collapsed row.
 */

function kindLabel(kind: ParsedTeamMessage["kind"], t: TranslateFn): string {
  switch (kind) {
    case "turn_end":
      return t("teamMessage.kindTurnEnd");
    case "shutdown":
      return t("teamMessage.kindShutdown");
    case "system":
      return t("teamMessage.kindSystem");
    default:
      return t("teamMessage.kindMessage");
  }
}

export const TeamMessageCard: FC<{ parsed: ParsedTeamMessage }> = ({
  parsed,
}) => {
  const t = useT();
  const [open, setOpen] = useState(false);
  const untrusted = parsed.trust === "untrusted";
  const jumpLabel = t("teamMessage.openTeammate", { name: parsed.fromDisplay });
  const expandLabel = t("teamMessage.expand");

  return (
    <div
      className="aui-team-message-card-root mx-auto w-full max-w-(--thread-max-width) px-2"
      data-role="team-message-card"
      data-trust={parsed.trust}
      data-from={parsed.from}
      data-from-display={parsed.fromDisplay}
      data-open={open ? "true" : "false"}
      data-testid="team-message-card"
    >
      <Card className="w-full gap-0 overflow-hidden py-0">
        {/* The accent rail: the card's whole visual signal that this text is
            not from this session. Amber for an untrusted peer. */}
        <div
          className={cn(
            "flex items-stretch",
            untrusted
              ? "border-l-2 border-l-warning/70"
              : "border-l-2 border-l-primary/50",
          )}
        >
          <Collapsible
            open={open}
            onOpenChange={setOpen}
            className="min-w-0 flex-1"
          >
            <div className="flex w-full min-w-0 items-center gap-2 px-4 py-2.5 text-sm">
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-label={expandLabel}
                aria-expanded={open}
                title={expandLabel}
                data-testid="team-message-expand"
                className="group flex min-w-0 flex-1 items-center gap-2 text-left transition-colors"
              >
                <span
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-full",
                    untrusted
                      ? "bg-warning/10 text-warning"
                      : "bg-primary/10 text-primary",
                  )}
                >
                  <UsersIcon className="size-3.5" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{parsed.fromDisplay}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {kindLabel(parsed.kind, t)}
                  </span>
                </span>
              </button>
              {untrusted && (
                <span
                  data-testid="team-message-untrusted-badge"
                  className="inline-flex shrink-0 items-center gap-1 rounded-full bg-warning/10 px-1.5 py-px text-[10px] font-medium text-warning"
                >
                  <ShieldAlertIcon className="size-3" aria-hidden="true" />
                  {t("teamMessage.untrusted")}
                </span>
              )}
              <button
                type="button"
                onClick={() =>
                  requestTeammateJump({ teammateName: parsed.fromDisplay })
                }
                aria-label={jumpLabel}
                title={jumpLabel}
                data-testid="team-message-open-teammate"
                className="group shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
              >
                <ChevronsRightIcon
                  className="size-3.5 transition-transform group-hover:translate-x-0.5"
                  aria-hidden="true"
                />
              </button>
              <ChevronDownIcon
                data-testid="team-message-expand-chevron"
                onClick={() => setOpen((v) => !v)}
                className={cn(
                  "size-3.5 shrink-0 cursor-pointer text-muted-foreground transition-transform duration-200",
                  open ? "rotate-0" : "-rotate-90",
                )}
                aria-hidden="true"
              />
            </div>
            <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
              <div
                className="max-h-96 overflow-auto px-4 pb-3 pl-12"
                data-testid="team-message-body"
              >
                <StaticMarkdown content={parsed.body} className="text-sm" />
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>
      </Card>
    </div>
  );
};
