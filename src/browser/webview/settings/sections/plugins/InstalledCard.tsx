import * as React from "react";
import { MoreHorizontalIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { TranslateFn } from "../../../i18n";
import type { ModPluginSummary } from "../../../mods/modsStateView";
import { ModHooksLine, ModStatus } from "./ModStatus";

/** One overflow-menu action on an installed card. */
export type CardAction = { label: string; testId: string; destructive?: boolean; onSelect: () => void };

/**
 * One card of the installed list — a settings row, not a store tile. The
 * first line is the name with its Mod and version chips, the enable toggle
 * and overflow menu at its right end; below, where it comes from (when the
 * group heading does not already say), what it does (the description, the
 * line a person decides by), then the mod's state and hooks.
 */
export function InstalledCard({
  rowProps,
  flashing,
  name,
  version,
  versionTestId,
  offeredVersion,
  updateControl,
  source,
  isMod,
  description,
  location,
  notices,
  mod,
  stateTestId,
  enabledControl,
  actions,
  menuTestId,
  options,
  t,
}: {
  rowProps: React.HTMLAttributes<HTMLDivElement> & {
    ref: (element: HTMLDivElement | null) => void;
    [data: `data-${string}`]: string | undefined;
  };
  flashing: boolean;
  name: string;
  version?: string;
  versionTestId?: string;
  /** A newer version waiting: the chip reads `v<old> → v<new>`. */
  offeredVersion?: string;
  /** The Update button, before the enable switch. */
  updateControl?: React.ReactNode;
  /** Where it comes from, when its group heading does not already say. */
  source?: string;
  /** Has a hooks module: a `Mod` chip before the version. */
  isMod?: boolean;
  description?: string;
  /** Where it lives on disk, for a person's own mod. */
  location?: { text: string | undefined; testId: string };
  /** Warning lines under the location, e.g. a local copy loading instead. */
  notices?: { text: string; testId: string }[];
  mod?: ModPluginSummary;
  stateTestId: string;
  enabledControl?: React.ReactNode;
  actions: CardAction[];
  menuTestId: string;
  options: React.ReactNode;
  t: TranslateFn;
}) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const chip = "shrink-0 rounded-md bg-muted px-1.5 py-0.5 font-mono text-muted-foreground text-xs";
  return (
    <div
      {...rowProps}
      className={cn(
        "rounded-xl border border-border/70 bg-card p-4",
        flashing && "nexus-plugin-flash",
      )}
    >
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <span className="truncate font-semibold text-base">{name}</span>
          {isMod ? (
            <span data-testid={`mod-badge-${name}`} className={chip}>
              {t("settings.plugins.mods.badge")}
            </span>
          ) : null}
          {version ? (
            <span data-testid={versionTestId} className={chip}>
              v{version}
              {offeredVersion ? ` → v${offeredVersion}` : null}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {updateControl}
          {enabledControl}
          {actions.length > 0 ? (
            <Popover open={menuOpen} onOpenChange={setMenuOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={t("settings.plugins.moreAria", { name })}
                  data-testid={menuTestId}
                >
                  <MoreHorizontalIcon className="size-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-40">
                {actions.map((action) => (
                  <button
                    key={action.testId}
                    type="button"
                    data-testid={action.testId}
                    className={cn(
                      "flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent",
                      action.destructive && "text-destructive",
                    )}
                    onClick={() => {
                      setMenuOpen(false);
                      action.onSelect();
                    }}
                  >
                    {action.label}
                  </button>
                ))}
              </PopoverContent>
            </Popover>
          ) : null}
        </div>
      </div>
      {source ? <div className="mt-0.5 truncate text-muted-foreground text-sm">{source}</div> : null}
      {description ? (
        <p
          data-testid={`plugin-description-${name}`}
          title={description}
          className="mt-2 line-clamp-2 text-foreground/90 text-sm"
        >
          {description}
        </p>
      ) : null}
      {location ? (
        <div
          data-testid={location.testId}
          className="mt-1.5 truncate font-mono text-muted-foreground text-xs"
        >
          {location.text}
        </div>
      ) : null}
      {notices?.map((notice) => (
        <div
          key={notice.testId}
          data-testid={notice.testId}
          title={notice.text}
          className="mt-1.5 break-all text-warning text-xs"
        >
          {notice.text}
        </div>
      ))}
      {mod ? <ModStatus summary={mod} t={t} testId={stateTestId} /> : null}
      {mod ? <ModHooksLine mod={mod} t={t} /> : null}
      {options}
    </div>
  );
}
