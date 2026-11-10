import { cn } from "@/lib/utils";
import type { TranslateFn } from "../../../i18n";
import type { ModPluginSummary } from "../../../mods/modsStateView";

/**
 * What a plugin's hooks module (a MOD, F-25) came to in the running sessions:
 * the row's key and the state the badge shows. `loadedSessions` names how
 * many sessions run it; `reason` is the engine's words, shown as is.
 */
function modStateKey(
  state: ModPluginSummary["worst"],
):
  | "settings.plugins.mods.loaded"
  | "settings.plugins.mods.refused"
  | "settings.plugins.mods.failed"
  | "settings.plugins.mods.crashed"
  | "settings.plugins.mods.dead" {
  switch (state) {
    case "loaded":
      return "settings.plugins.mods.loaded";
    case "refused":
      return "settings.plugins.mods.refused";
    case "failed":
      return "settings.plugins.mods.failed";
    case "crashed":
      return "settings.plugins.mods.crashed";
    case "dead":
      return "settings.plugins.mods.dead";
  }
}

function modDotClass(state: ModPluginSummary["worst"]): string {
  if (state === "loaded") return "bg-success";
  if (state === "crashed") return "bg-warning";
  return "bg-destructive";
}

/**
 * One plugin's mod state, between the description and the hooks. Loaded is
 * the quiet case — a dot and the session count, and nothing at all when no
 * session has it loaded. Anything else is what the person has to read: the
 * state and its reason.
 */
export function ModStatus({
  summary,
  t,
  testId,
}: {
  summary: ModPluginSummary;
  t: TranslateFn;
  testId: string;
}) {
  const dot = (
    <span
      aria-hidden
      className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", modDotClass(summary.worst))}
    />
  );
  if (summary.worst === "loaded") {
    if (summary.loadedSessions === 0) return null;
    return (
      <div
        data-testid={testId}
        data-mod-state={summary.worst}
        className="mt-3 flex items-start gap-1.5 text-muted-foreground text-xs"
      >
        {dot}
        <span>{t("settings.plugins.mods.activeInSessions", { n: summary.loadedSessions })}</span>
      </div>
    );
  }
  return (
    <div
      data-testid={testId}
      data-mod-state={summary.worst}
      className="mt-3 flex items-start gap-1.5 text-xs"
    >
      {dot}
      <div className="flex min-w-0 flex-wrap gap-x-1.5">
        <span
          className={cn(
            "font-medium",
            summary.worst === "crashed" ? "text-warning" : "text-destructive",
          )}
        >
          {t(modStateKey(summary.worst))}
        </span>
        {summary.reason ? (
          <span className="break-words text-muted-foreground">{summary.reason}</span>
        ) : null}
      </div>
    </div>
  );
}

/** How many hooks the line names before the rest fold into `+N`. */
const HOOKS_SHOWN = 4;

/** The hooks a mod's modules registered — developer metadata, so the card's
 *  quietest line, below the description it must not drown. Only the first few
 *  are named; the rest fold into `+N`, so the line stays a glance rather than
 *  a list that grows with every hook a mod adds. */
export function ModHooksLine({ mod, t }: { mod: ModPluginSummary; t: TranslateFn }) {
  if (mod.events.length === 0) return null;
  const shown = mod.events.slice(0, HOOKS_SHOWN);
  const rest = mod.events.length - shown.length;
  const events = [
    ...shown,
    ...(rest > 0 ? [t("settings.plugins.mods.hooksMore", { n: rest })] : []),
  ].join(" · ");
  return (
    <div
      data-testid={`mod-hooks-${mod.plugin}`}
      className="mt-3 break-words font-mono text-muted-foreground/80 text-xs"
    >
      {t("settings.plugins.mods.hooks", { events })}
    </div>
  );
}
