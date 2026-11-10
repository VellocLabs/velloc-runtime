import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { PluginAvailableUiEntry } from "../../../../bridge/protocol/plugins";
import { useT } from "../../../i18n";

/**
 * One marketplace plugin, rendered as a card. The description is clamped to two
 * lines; the full text is offered in a hover tooltip ONLY when the clamp
 * actually truncated it (measured via scrollHeight vs clientHeight) — if the
 * whole description already fits, no tooltip. The hover delay comes from the
 * enclosing `TooltipProvider`.
 */
export function PluginCard({
  plugin,
  installing,
  onInstall,
}: {
  plugin: PluginAvailableUiEntry;
  installing: boolean;
  /** Omitted when the connection may not install: the card is a listing. */
  onInstall?: () => void;
}) {
  const t = useT();
  const descRef = React.useRef<HTMLDivElement>(null);
  const [truncated, setTruncated] = React.useState(false);
  const description = plugin.description ?? t("settings.plugins.noDescription");

  React.useLayoutEffect(() => {
    const el = descRef.current;
    if (!el) return;
    // +1 guards against sub-pixel rounding.
    setTruncated(el.scrollHeight > el.clientHeight + 1);
  }, [description]);

  const body = (
    <div className="min-w-0 flex-1 cursor-default">
      <div className="flex items-center gap-2 text-sm">
        <span className="truncate font-medium">{plugin.name}</span>
        {plugin.version ? (
          <span className="shrink-0 font-mono text-muted-foreground text-xs">
            v{plugin.version}
          </span>
        ) : null}
        {plugin.installed ? (
          <Badge
            variant="success"
            size="sm"
            data-testid={`plugin-installed-${plugin.name}`}
          >
            {t("settings.plugins.pluginInstalled")}
          </Badge>
        ) : null}
      </div>
      <div
        ref={descRef}
        className="mt-0.5 line-clamp-2 min-h-[2.25rem] text-muted-foreground text-xs"
      >
        {description}
      </div>
    </div>
  );

  return (
    <div
      data-testid={`marketplace-plugin-card-${plugin.name}`}
      className="flex items-start justify-between gap-3 rounded-xl border border-border/70 bg-card p-3 transition-colors hover:bg-accent/40"
    >
      {truncated ? (
        <Tooltip>
          <TooltipTrigger asChild>{body}</TooltipTrigger>
          <TooltipContent side="bottom" align="start" className="max-w-xs">
            <div className="font-medium">{plugin.name}</div>
            {plugin.description ? (
              <div className="mt-0.5">{plugin.description}</div>
            ) : null}
          </TooltipContent>
        </Tooltip>
      ) : (
        body
      )}
      {!plugin.installed && onInstall ? (
        <Button
          variant="outline"
          size="xs"
          data-testid={`plugin-install-${plugin.name}`}
          className="shrink-0"
          disabled={installing}
          onClick={onInstall}
        >
          {installing
            ? t("settings.plugins.installing")
            : t("settings.plugins.install")}
        </Button>
      ) : null}
    </div>
  );
}
