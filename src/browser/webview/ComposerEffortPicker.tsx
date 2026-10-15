import * as React from "react";
import { CircleHelpIcon } from "lucide-react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { useT, type TranslateFn } from "./i18n";
import { activeModelLabel, findActiveModel } from "./ModelQuickPicker";
import type {
  BrowserLlmCatalog,
  BrowserLlmModel,
  BrowserLlmSelection,
} from "../bridge/protocol/nexus_llm";

/**
 * The composer's effort control: the session's model (read-only) and a Faster ↔ Smarter
 * slider over its tiers. Scope (F-12): a pick changes THIS session only — never the default
 * new sessions start on, nor settings.json.
 */

export type SessionEffortContextValue = {
  /** The session's configured catalog (`createConfiguredModelCatalog`). */
  catalog: BrowserLlmCatalog | null | undefined;
  /** The session's current selection. */
  selection: BrowserLlmSelection | null | undefined;
  /** Shown but inert (a teammate keeps the effort its lead started it on). */
  disabled?: boolean;
  /** Why it is inert — the trigger's tooltip. */
  inertWhy?: string;
  /** Apply a selection to THIS session only. */
  onSelect: (selection: BrowserLlmSelection) => void;
};

const SessionEffortContext =
  React.createContext<SessionEffortContextValue | null>(null);

export const SessionEffortProvider = SessionEffortContext.Provider;

export type EffortStops = {
  /** The model's tiers, in its own order (least → most effort). */
  tiers: string[];
  /** Index of the tier the session runs on; -1 when no tier is in effect
   *  (none selected and the model names no default — no tier is sent, and
   *  the endpoint decides). */
  currentIndex: number;
  /** Index of the model's `defaultThinkingTier`, or -1 when it names none. */
  recommendedIndex: number;
};

/**
 * The slider's stops, or `null` with fewer than two tiers. A selection without a known tier
 * runs on the model's default; with no default it runs on no tier, so no stop is current (-1).
 */
export function resolveEffortStops(
  model: Pick<BrowserLlmModel, "availableThinkingTiers" | "defaultThinkingTier">,
  selectedTier: string | undefined,
): EffortStops | null {
  const tiers = model.availableThinkingTiers ?? [];
  if (tiers.length < 2) return null;
  const recommendedIndex = model.defaultThinkingTier
    ? tiers.indexOf(model.defaultThinkingTier)
    : -1;
  const selectedIndex = selectedTier ? tiers.indexOf(selectedTier) : -1;
  const currentIndex = selectedIndex >= 0 ? selectedIndex : recommendedIndex;
  return { tiers, currentIndex, recommendedIndex };
}

/**
 * Where stop `index` of `count` sits along the thumb's travel: 0 at the first
 * stop, 1 at the last. The travel is the track minus one thumb width, so the
 * first and last stops put the thumb flush with the track's ends — a stop at
 * its cell's centre left a gap that read as "can still slide further".
 */
export function effortStopFraction(index: number, count: number): number {
  return count > 1 ? index / (count - 1) : 0;
}

/** The thumb's width — the track's travel is its width minus this. */
const THUMB = "1rem";

/** Left edge of a thumb-sized box centred on stop `index`. */
const stopLeft = (index: number, count: number) =>
  `calc((100% - ${THUMB}) * ${effortStopFraction(index, count)})`;

/** The tier's full name ("Medium"); an unknown id shows as itself. */
export function effortTierName(t: TranslateFn, tier: string): string {
  switch (tier) {
    case "none":
      return t("composerEffort.tier.none");
    case "minimal":
    case "min":
      return t("composerEffort.tier.minimal");
    case "low":
      return t("composerEffort.tier.low");
    case "medium":
      return t("composerEffort.tier.medium");
    case "high":
      return t("composerEffort.tier.high");
    case "xhigh":
    case "extra-high":
      return t("composerEffort.tier.xhigh");
    case "max":
      return t("composerEffort.tier.max");
    default:
      return tier;
  }
}

export function ComposerEffortPicker({
  isForeground = true,
}: {
  /** False while this thread is mounted but hidden. The popover is portaled
   *  to <body>; left open behind a `display:none` anchor it would measure a
   *  zero rect and jump to the window's top-left corner. */
  isForeground?: boolean;
}) {
  const ctx = React.useContext(SessionEffortContext);
  const t = useT();
  const [open, setOpen] = React.useState(false);
  const stopRefs = React.useRef<(HTMLButtonElement | null)[]>([]);
  // The stop the keyboard last moved to. `currentIndex` only advances once the
  // worker re-publishes the snapshot, so a second arrow press before that must
  // step from here, not from the stale current stop.
  const keyTargetRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!isForeground) setOpen(false);
  }, [isForeground]);
  const active = ctx ? findActiveModel(ctx.catalog, ctx.selection) : null;
  const stops = active
    ? resolveEffortStops(active.model, ctx?.selection?.thinkingTier)
    : null;
  if (!ctx || !active) return null;

  const modelLabel = (
    <span
      className="max-w-[10rem] truncate text-xs text-muted-foreground"
      data-testid="composer-effort-model"
    >
      {activeModelLabel(active)}
    </span>
  );
  // A model with nothing to choose (fewer than two tiers) still names itself;
  // only the effort trigger is left out.
  if (!stops) {
    return (
      <div className="flex items-center gap-1" data-testid="composer-effort">
        {modelLabel}
      </div>
    );
  }

  const { tiers, currentIndex, recommendedIndex } = stops;
  // The snapshot caught up with the keyboard: step from the real stop again.
  if (keyTargetRef.current === currentIndex) keyTargetRef.current = null;
  const currentTier = currentIndex >= 0 ? tiers[currentIndex] : undefined;
  const currentName = currentTier
    ? effortTierName(t, currentTier)
    : t("composerEffort.tier.default");
  // The stop that takes focus / the roving tab stop: the current one, or the
  // first while no tier is in effect.
  const focusIndex = Math.max(currentIndex, 0);
  const disabled = !!ctx.disabled;

  const choose = (index: number) => {
    const tier = tiers[index];
    if (!tier || disabled) return;
    if (index === currentIndex && ctx.selection?.thinkingTier === tier) return;
    ctx.onSelect({
      providerId: active.provider.id,
      modelId: active.model.id,
      thinkingTier: tier,
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const base = keyTargetRef.current ?? currentIndex;
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = base + 1;
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = base - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tiers.length - 1;
    if (next === null) return;
    e.preventDefault();
    const target = Math.min(Math.max(next, 0), tiers.length - 1);
    choose(target);
    keyTargetRef.current = target;
    // Focus follows the selection (radio-group keyboard pattern).
    stopRefs.current[target]?.focus();
  };

  const count = tiers.length;

  // A click between stops picks the nearest one.
  const onTrackClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const thumb = stopRefs.current[0]?.offsetWidth ?? 0;
    const travel = rect.width - thumb;
    if (travel <= 0) return;
    const f = (e.clientX - rect.left - thumb / 2) / travel;
    choose(Math.min(Math.max(Math.round(f * (count - 1)), 0), count - 1));
  };

  return (
    <div className="flex items-center gap-1" data-testid="composer-effort">
      {modelLabel}
      <Popover
        open={open && !disabled && isForeground}
        onOpenChange={(o) => {
          if (disabled) return;
          keyTargetRef.current = null;
          setOpen(o);
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            title={disabled ? ctx.inertWhy : undefined}
            aria-label={t("composerEffort.triggerAria", { name: currentName })}
            data-testid="composer-effort-trigger"
            data-tier={currentTier}
            className="flex h-7 items-center rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
          >
            {currentName}
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          className="w-56 p-3"
          data-testid="composer-effort-popover"
          onOpenAutoFocus={(e) => {
            // Radix would focus the first focusable — the help button — and
            // focus opens its tooltip. Land on the current stop instead.
            e.preventDefault();
            stopRefs.current[focusIndex]?.focus();
          }}
        >
          <div className="flex items-center gap-1.5">
            <span className="text-body text-muted-foreground">
              {t("composerEffort.label")}
            </span>
            <span className="text-body font-medium" data-testid="composer-effort-current">
              {currentName}
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={t("composerEffort.helpAria")}
                  data-testid="composer-effort-help"
                  className="ml-auto rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <CircleHelpIcon className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-64">
                {t("composerEffort.help")}
              </TooltipContent>
            </Tooltip>
          </div>
          <div className="mt-3 flex justify-between text-caption text-muted-foreground">
            <span>{t("composerEffort.faster")}</span>
            <span>{t("composerEffort.smarter")}</span>
          </div>
          <div
            role="radiogroup"
            aria-label={t("composerEffort.label")}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            onClick={onTrackClick}
            data-testid="composer-effort-track"
            className="relative mt-1.5 h-5 cursor-pointer rounded-full bg-muted"
          >
            {/* Filled part of the track, up to the thumb's far edge. No
                thumb while no tier is in effect: no stop is current. */}
            {currentIndex >= 0 ? (
              <>
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0 left-0 rounded-full bg-foreground/15 transition-[width] duration-150"
                  style={{ width: `calc(${stopLeft(currentIndex, count)} + ${THUMB})` }}
                />
                <span
                  aria-hidden="true"
                  data-testid="composer-effort-thumb"
                  className="pointer-events-none absolute inset-y-0 rounded-full border bg-background shadow-sm transition-[left] duration-150"
                  style={{ left: stopLeft(currentIndex, count), width: THUMB }}
                />
              </>
            ) : null}
            {tiers.map((tier, index) => {
              const checked = index === currentIndex;
              const recommended = index === recommendedIndex;
              return (
                <button
                  key={tier}
                  ref={(el) => {
                    stopRefs.current[index] = el;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  aria-label={
                    recommended
                      ? t("composerEffort.stopRecommendedAria", {
                          name: effortTierName(t, tier),
                        })
                      : effortTierName(t, tier)
                  }
                  title={effortTierName(t, tier)}
                  tabIndex={index === focusIndex ? 0 : -1}
                  data-testid={`composer-effort-stop-${tier}`}
                  data-recommended={recommended ? "true" : undefined}
                  onClick={(e) => {
                    e.stopPropagation();
                    choose(index);
                  }}
                  className="absolute inset-y-0 z-10 flex items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  style={{ left: stopLeft(index, count), width: THUMB }}
                >
                  {checked ? null : recommended ? (
                    <span aria-hidden="true" className="h-2.5 w-0.5 rounded-full bg-foreground/50" />
                  ) : (
                    <span aria-hidden="true" className="size-1 rounded-full bg-foreground/40" />
                  )}
                </button>
              );
            })}
          </div>
          {recommendedIndex >= 0 ? (
            <div className="relative mt-1 h-4">
              <button
                type="button"
                data-testid="composer-effort-recommended"
                onClick={() => choose(recommendedIndex)}
                className="absolute -translate-x-1/2 whitespace-nowrap text-caption text-muted-foreground hover:text-foreground"
                style={{
                  // Under its stop, clamped so the label never leaves the card.
                  left: `clamp(2.25rem, calc(${stopLeft(recommendedIndex, count)} + ${THUMB} / 2), calc(100% - 2.25rem))`,
                }}
              >
                {t("composerEffort.recommended")}
              </button>
            </div>
          ) : null}
        </PopoverContent>
      </Popover>
    </div>
  );
}
