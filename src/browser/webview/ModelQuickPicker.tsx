import * as React from "react";
import {
  ChevronDownIcon,
  CheckIcon,
  CircleDollarSignIcon,
  LayersIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PinIcon,
  SettingsIcon,
} from "lucide-react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

import { useLocale, useT } from "./i18n";
import { FreeModelIcon } from "./FreeModelIcon";
import { contextFigure, priceFigure } from "./modelFigures";
import { formatTokenCount } from "./settings/customProviderHelpers";
import { displayModelLabel, usageForModel, usageSummary } from "../../config/nexusModelConfig/modelDisplay";
import {
  amountLabelKey,
  balanceNoteKey,
  compactAmountLabelKey,
  compactWindowLabelKey,
  useFormatAmount,
  windowLabelKey,
} from "./planUsageLabels";
import { useProviderUsage } from "./providerUsageStore";
import { ProviderIcon } from "./ProviderIcon";
import { CUSTOM_PROVIDER_ID_PREFIX } from "../../config/customProviderRegistry";
import type {
  BrowserLlmCatalog,
  BrowserLlmModel,
  BrowserLlmProvider,
  BrowserLlmSelection,
} from "../bridge/protocol/nexus_llm";

/**
 * The quick model picker, shared by the topbar and Settings → Session models. Only set-up
 * providers and enabled non-alias models of the `BrowserLlmCatalog` are pickable.
 */

export type ModelQuickPickerProps = {
  catalog: BrowserLlmCatalog | null | undefined;
  selection: BrowserLlmSelection | null | undefined;
  /**
   * The global default new sessions start on (topbar). Its effort pill gets
   * a "default" mark, so a per-session effort override (the composer's
   * effort control) never hides what a new session will get. A selection
   * with no tier marks the model's own `defaultThinkingTier`.
   */
  defaultSelection?: BrowserLlmSelection | null;
  onSelect: (selection: BrowserLlmSelection) => void;
  /** Renders the "Provider settings" footer row when provided (topbar). */
  onOpenSettings?: () => void;
  /** Programmatic-open signal: increment to open the popover. Used by the
   *  send gate when it adopts the catalog default for a session whose pinned
   *  model went away — the user must SEE the pick to be able to change it.
   *  `0`/`undefined` is inert (initial mount never auto-opens). */
  openToken?: number;
  /** Grey out + block the trigger (settings rows whose radio isn't active). */
  disabled?: boolean;
  /** Why the trigger is disabled — the trigger's tooltip and accessible
   *  description. Only read while `disabled`. */
  inertWhy?: string;
  /**
   * Test-id prefix. Default `"nexus"` reproduces the topbar's historical ids
   * verbatim (`nexus-model-picker-trigger`, `nexus-model-option-…`,
   * `nexus-tier-…`); settings rows pass their own prefix so each picker is
   * addressable.
   */
  testIdPrefix?: string;
  /**
   * Publish the `__NEXUS_PICKER_E2E__` global (see below). ONLY the topbar
   * instance sets this — a second publisher (settings rows render several
   * pickers at once) would clobber the harness's read surface.
   */
  publishE2eSurface?: boolean;
  /**
   * When true, picking a model row WITHOUT clicking a tier pill emits no
   * `thinkingTier` (the consumer treats absence as "model default") instead
   * of resolving `model.defaultThinkingTier`. Settings pins use this so an
   * un-pinned effort stays "default" rather than freezing today's default.
   */
  explicitTierOnly?: boolean;
  /**
   * Extra classes for the trigger button. Settings rows pass a FIXED width
   * (e.g. `w-56`) so enabling the picker / a label change never reflows the
   * controls around it; the topbar keeps the intrinsic width.
   */
  triggerClassName?: string;
  /**
   * Replaces the trigger's default content (provider icon + model label +
   * badges). Settings rows use it to show the RESOLVED route ("Auto · Haiku
   * 4.5", "Session model") when no model is pinned. The chevron stays.
   */
  triggerContent?: React.ReactNode;
  /**
   * Non-model choices listed ABOVE the search box (Settings: "Auto",
   * "Default", "Same as session", the tiers). Picking one calls its
   * `onSelect` and closes the popover — the model list below then reads as
   * the "specific model" choice under `modelsHeading`.
   */
  leadingOptions?: ModelQuickPickerLeadingOption[];
  /** Small heading over the search + model list when `leadingOptions` is set. */
  modelsHeading?: string;
  /**
   * The `⋯` menu on each provider's heading (topbar): add a pinned version
   * of one of the provider's families as a row of its own, and open the
   * provider's settings page. Absent = no menu; each half is offered only
   * when its callback is.
   */
  providerMenu?: ModelQuickPickerProviderMenu;
};

export type ModelQuickPickerProviderMenu = {
  /** Add `family@version` to the provider's entries (and select it). */
  onAddVersion?: (
    provider: BrowserLlmProvider,
    family: string,
    version: { versionLabel: string; id: string },
  ) => void | Promise<void>;
  /** Open the provider's settings page. */
  onEditProvider?: (providerId: string) => void;
};

/** Room (px) below a row picker's trigger that is always enough to open
 *  downward; with less, the popover opens toward the roomier side. */
const ANCHORED_MIN_ROOM_PX = 320;

export type ModelQuickPickerLeadingOption = {
  id: string;
  label: string;
  /** Muted second line — what the choice resolves to. */
  description?: string;
  checked: boolean;
  onSelect: () => void;
  testId: string;
  /** Starts a new group; the heading renders above this option. */
  groupHeading?: string;
};

/** One pickable option, mirroring the retired Lit `<nexus-quick-settings>`
 *  `options_` entries — exposed on `__NEXUS_PICKER_E2E__` for e2e. */
export type PickerE2eOption = {
  providerId: string;
  modelId: string;
  /** An entry row's concrete model today (`claude-opus-*@latest` →
   *  `claude-opus-5-5`); absent for a plain row. */
  resolvedModelId?: string;
  /** That model's own name — what the trigger shows once it is chosen. */
  resolvedModelLabel?: string;
  modelLabel: string;
  defaultThinkingTier?: string;
  availableThinkingTiers?: string[];
};

declare global {
  // E2E read-surface replacing the Lit picker internals (`options_` /
  // `status_.selection`). Published by the mounted TOPBAR picker so the
  // Playwright `quickSettings` harness can read the catalog + active selection
  // WITHOUT opening the popover (picks still click the option/tier testids).
  // eslint-disable-next-line no-var
  var __NEXUS_PICKER_E2E__:
    | {
        selection: BrowserLlmSelection | null
        /** Pickable (enabled) options — what the popover renders. */
        options: PickerE2eOption[]
        /** ALL provider ids in the catalog, incl. the ones the user never set
         *  up that `options` filters out — lets e2e wait for a catalog
         *  broadcast to land before asserting the filter. */
        providerIds: string[]
      }
    | undefined;
}

/** Short tier badge label, matching the Lit popup's pill abbreviations. */
export function tierLabel(tier: string): string {
  switch (tier) {
    case "minimal":
    case "min":
      return "MIN";
    case "low":
      return "L";
    case "medium":
      return "M";
    case "high":
      return "H";
    case "extra-high":
    case "xhigh":
      return "X";
    case "max":
      return "MAX";
    default:
      return tier.slice(0, 3).toUpperCase();
  }
}

/**
 * True for a USER-CREATED custom provider (Settings → Provider connection →
 * "+ Add custom provider…"). Every such id starts with `custom-` — minted by
 * `generateCustomProviderId`, which also reserves the two backend slot ids
 * (`custom-openai` / `custom-anthropic`) under the same prefix — so the prefix
 * test matches both a generated provider and a legacy "Custom endpoint" slot.
 * Built-in provider ids never carry the prefix.
 */
export function isCustomProviderId(id: string | undefined): boolean {
  return !!id && id.startsWith(CUSTOM_PROVIDER_ID_PREFIX);
}


export function findActiveModel(
  catalog: BrowserLlmCatalog | null | undefined,
  selection: BrowserLlmSelection | null | undefined,
): { provider: BrowserLlmProvider; model: BrowserLlmModel } | null {
  if (!catalog || !selection) return null;
  const provider = catalog.providers.find((p) => p.id === selection.providerId);
  const model = provider?.models.find((m) => m.id === selection.modelId);
  // A disabled provider/model is not a usable selection — the curated catalog
  // still lists e.g. openai's models after its provider config is reset, but
  // with `enabled: false`. Treat that as "no active model" so the trigger shows
  // "Select model" rather than a model the user can't actually use.
  if (!provider || !model || !provider.enabled || !model.enabled) return null;
  return { provider, model };
}

/**
 * What a trigger names for the active model. A Latest entry names the model
 * it runs today ("Claude Opus 5.5"): the trigger says what is answering, the
 * row says it follows upgrades. Shared with the composer's effort control.
 */
export function activeModelLabel(active: {
  provider: BrowserLlmProvider;
  model: BrowserLlmModel;
}): string {
  const latest = active.model.entry?.kind === "latest" ? active.model.entry : undefined;
  return displayModelLabel(
    active.provider.id,
    latest
      ? latest.resolvedLabel ??
          (latest.resolvedVersion ? `${active.model.label} ${latest.resolvedVersion}` : active.model.label)
      : active.model.label,
    active.model,
  );
}

function ModelQuickPickerImpl({
  catalog,
  selection,
  defaultSelection,
  onSelect,
  onOpenSettings,
  openToken,
  disabled,
  inertWhy,
  testIdPrefix = "nexus",
  publishE2eSurface,
  explicitTierOnly,
  triggerClassName,
  triggerContent,
  leadingOptions,
  modelsHeading,
  providerMenu,
}: ModelQuickPickerProps) {
  const t = useT();
  const [open, setOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  // Row pickers (the ones with `leadingOptions`, i.e. Settings rows) are
  // tall and live mid-page. Radix's collision flip let such a popover slide
  // over neighbouring rows, reading as another row's menu. Instead pick the
  // side ONCE at open — below unless there is clearly more room above — pin
  // the popover's edge to the trigger's, and cap its height to that side's
  // room (the model list scrolls). The trigger is never covered.
  const anchored = !!leadingOptions?.length;
  const [side, setSide] = React.useState<"top" | "bottom">("bottom");
  const openPopover = (next: boolean) => {
    if (next && anchored && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom;
      const above = rect.top;
      setSide(below >= ANCHORED_MIN_ROOM_PX || below >= above ? "bottom" : "top");
    }
    setOpen(next);
  };
  const [query, setQuery] = React.useState("");
  // The row under the pointer (or keyboard focus): the footer describes it,
  // else the active model.
  const [hovered, setHovered] = React.useState<{
    provider: BrowserLlmProvider;
    model: BrowserLlmModel;
  } | null>(null);
  React.useEffect(() => {
    if (!open) setHovered(null);
  }, [open]);

  React.useEffect(() => {
    if (openToken) openPopover(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openToken]);

  // Scroll the selected row into view on open, and again when `selection` lands after
  // opening (adopt-default send-gate path). The rAF defers past Radix's positioning.
  const activeRowRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      activeRowRef.current?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, selection]);

  const active = findActiveModel(catalog, selection);
  const triggerLabel = active ? activeModelLabel(active) : t("modelPicker.selectModel");
  // When the active selection is an alias-hidden snapshot row (e.g. a
  // persisted `claude-haiku-4-5-20251001`), the popover renders only its
  // curated twin — mark THAT row as active so the checkmark doesn't vanish.
  const activeAliasId = active?.model.pickerAliasId;

  const groups = React.useMemo(() => {
    const providers = (catalog?.providers ?? []).filter((p) => p.enabled);
    const q = query.trim().toLowerCase();
    return providers
      .map((provider) => ({
        provider,
        models: provider.models.filter((model) => {
          // `pickerAliasId` rows duplicate their curated alias row's label
          // (see createConfiguredProvider) — selectable, but never listed.
          if (!model.enabled || model.pickerAliasId) return false;
          if (!q) return true;
          return (
            model.label.toLowerCase().includes(q) ||
            model.id.toLowerCase().includes(q) ||
            (model.entry?.resolvedId ?? "").toLowerCase().includes(q) ||
            provider.label.toLowerCase().includes(q)
          );
        }),
      }))
      .filter((group) => group.models.length > 0);
  }, [catalog, query]);

  // Full enabled option set (NOT search-filtered), mirroring the Lit picker's
  // `options_`. Published to `__NEXUS_PICKER_E2E__` for the e2e harness —
  // TOPBAR instance only (see `publishE2eSurface`).
  const allOptions = React.useMemo<PickerE2eOption[]>(() => {
    if (!publishE2eSurface) return [];
    const out: PickerE2eOption[] = [];
    for (const provider of catalog?.providers ?? []) {
      if (!provider.enabled) continue;
      for (const model of provider.models) {
        // Same visibility rule as `groups`: alias-hidden rows are not options.
        if (!model.enabled || model.pickerAliasId) continue;
        out.push({
          providerId: provider.id,
          modelId: model.id,
          modelLabel: model.label,
          ...(model.entry?.resolvedId ? { resolvedModelId: model.entry.resolvedId } : {}),
          ...(model.entry?.resolvedLabel ? { resolvedModelLabel: model.entry.resolvedLabel } : {}),
          defaultThinkingTier: model.defaultThinkingTier,
          availableThinkingTiers: model.availableThinkingTiers,
        });
      }
    }
    return out;
  }, [catalog, publishE2eSurface]);

  const allProviderIds = React.useMemo(
    () =>
      publishE2eSurface ? (catalog?.providers ?? []).map((p) => p.id) : [],
    [catalog, publishE2eSurface],
  );

  React.useEffect(() => {
    if (!publishE2eSurface) return;
    globalThis.__NEXUS_PICKER_E2E__ = {
      selection: selection ?? null,
      options: allOptions,
      providerIds: allProviderIds,
    };
    return () => {
      if (globalThis.__NEXUS_PICKER_E2E__?.options === allOptions) {
        globalThis.__NEXUS_PICKER_E2E__ = undefined;
      }
    };
  }, [publishE2eSurface, selection, allOptions, allProviderIds]);

  const pick = (
    provider: BrowserLlmProvider,
    model: BrowserLlmModel,
    tier?: string,
  ) => {
    const next: BrowserLlmSelection = { providerId: provider.id, modelId: model.id };
    const resolvedTier =
      tier ?? (explicitTierOnly ? undefined : model.defaultThinkingTier);
    if (resolvedTier) next.thinkingTier = resolvedTier;
    onSelect(next);
    setOpen(false);
  };

  return (
    <Popover open={open && !disabled} onOpenChange={(o) => !disabled && openPopover(o)}>
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          disabled={disabled}
          title={disabled && inertWhy ? inertWhy : undefined}
          aria-description={disabled && inertWhy ? inertWhy : undefined}
          data-slot="model-picker-trigger"
          data-testid={`${testIdPrefix}-model-picker-trigger`}
          className={cn(
            "inline-flex h-8 max-w-[16rem] items-center gap-1.5 rounded-md border bg-background px-2.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-background",
            triggerClassName,
          )}
        >
          {triggerContent !== undefined ? (
            triggerContent
          ) : (
            <>
              {active ? <ProviderIcon svg={active.provider.iconSvg} /> : null}
              {/* flex-1 + text-left: inert at intrinsic width (topbar), but
                  under a caller-fixed width it pushes the chevron to the
                  right edge so the trigger reads as a stable select control. */}
              <span className="min-w-0 flex-1 truncate text-left font-medium">
                {triggerLabel}
              </span>
              {active?.model.free ? <FreeModelIcon /> : null}
              {active && isCustomProviderId(active.provider.id) ? (
                <Badge
                  variant="muted"
                  size="sm"
                  data-testid={`${testIdPrefix}-model-picker-custom-badge`}
                >
                  {t("settings.models.customBadge")}
                </Badge>
              ) : null}
              {selection?.thinkingTier ? (
                <Badge variant="muted" size="sm">
                  {tierLabel(selection.thinkingTier)}
                </Badge>
              ) : null}
            </>
          )}
          <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      {/* 26rem (416px): wide enough that a model label ("GPT-5.6 Terra")
          and a full six-pill tier row (NON L M H X MAX) fit side by side
          without truncating — at the old w-80 (320px) six pills left the
          label only ~90px. `truncate` on the label stays as the safety
          valve for longer future names. */}
      <PopoverContent
        align={anchored ? "end" : "start"}
        {...(anchored ? { side, avoidCollisions: false } : {})}
        className={cn(
          "w-[26rem] max-w-[calc(100vw-2rem)] p-0",
          anchored &&
            "flex max-h-[calc(var(--radix-popover-content-available-height)-8px)] flex-col",
        )}
        data-side-anchored={anchored ? side : undefined}
      >
        {leadingOptions?.length ? (
          <div className="shrink-0 border-b p-1">
            {leadingOptions.map((option) => (
              <React.Fragment key={option.id}>
                {option.groupHeading ? (
                  <div className="px-2 pt-2 pb-1 text-muted-foreground text-xs">
                    {option.groupHeading}
                  </div>
                ) : null}
                <button
                  type="button"
                  data-testid={option.testId}
                  data-state={option.checked ? "checked" : "unchecked"}
                  className={cn(
                    "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent/60 focus-visible:bg-accent/60",
                    option.checked && "bg-accent",
                  )}
                  onClick={() => {
                    option.onSelect();
                    setOpen(false);
                  }}
                >
                  <CheckIcon
                    className={cn(
                      "mt-0.5 size-3.5 shrink-0",
                      option.checked ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{option.label}</span>
                    {option.description ? (
                      <span className="block text-muted-foreground text-xs">
                        {option.description}
                      </span>
                    ) : null}
                  </span>
                </button>
              </React.Fragment>
            ))}
          </div>
        ) : null}
        {leadingOptions?.length && modelsHeading ? (
          <div className="shrink-0 px-3 pt-2 text-muted-foreground text-xs">
            {modelsHeading}
          </div>
        ) : null}
        <div className={cn("shrink-0 p-2", anchored ? "" : "border-b")}>
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("modelPicker.search")}
            className="h-8"
          />
        </div>
        <div
          className={cn(
            "max-h-80 overflow-y-auto p-1",
            anchored && "min-h-0 flex-1",
          )}
          onMouseLeave={() => setHovered(null)}
        >
          {groups.length === 0 ? (
            <div className="px-2 py-6 text-center text-muted-foreground text-sm">
              {t("modelPicker.noModels")}
            </div>
          ) : (
            groups.map(({ provider, models }) => (
              <div key={provider.id} className="mb-1">
                <div className="flex items-center gap-1.5 px-2 py-1 text-muted-foreground text-xs">
                  <ProviderIcon svg={provider.iconSvg} />
                  <span className="font-medium">{provider.label}</span>
                  {isCustomProviderId(provider.id) ? (
                    <Badge
                      variant="muted"
                      size="sm"
                      data-testid={`${testIdPrefix}-provider-custom-badge-${provider.id}`}
                    >
                      {t("settings.models.customBadge")}
                    </Badge>
                  ) : null}
                  {providerMenu ? (
                    <ProviderHeaderMenu
                      provider={provider}
                      menu={providerMenu}
                      testIdPrefix={testIdPrefix}
                      onDone={() => setOpen(false)}
                    />
                  ) : null}
                </div>
                {models.map((model) => {
                  const isActiveModel =
                    selection?.providerId === provider.id &&
                    (selection?.modelId === model.id ||
                      activeAliasId === model.id);
                  const tiers = model.availableThinkingTiers ?? [];
                  return (
                    <div
                      key={model.id}
                      ref={isActiveModel ? activeRowRef : undefined}
                      onMouseEnter={() => setHovered({ provider, model })}
                      onFocus={() => setHovered({ provider, model })}
                      className={cn(
                        "flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-accent/60",
                        isActiveModel && "bg-accent",
                      )}
                    >
                      <button
                        type="button"
                        data-testid={`${testIdPrefix}-model-option-${provider.id}-${model.id}`}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm outline-none"
                        onClick={() => pick(provider, model)}
                      >
                        <CheckIcon
                          className={cn(
                            "size-3.5 shrink-0",
                            isActiveModel ? "opacity-100" : "opacity-0",
                          )}
                        />
                        <span className="truncate">{displayModelLabel(provider.id, model.label, model)}</span>
                        {model.free ? <FreeModelIcon /> : null}
                        <EntryMarks model={model} />
                      </button>
                      {/* No per-model "Custom" badge — the provider group
                          header above already carries it; repeating it on
                          every child row was noise. */}
                      {tiers.length > 0 ? (
                        <div className="flex shrink-0 items-center gap-1">
                          {tiers.map((tier) => {
                            const tierActive =
                              isActiveModel && selection?.thinkingTier === tier;
                            const tierIsDefault =
                              defaultSelection?.providerId === provider.id &&
                              defaultSelection.modelId === model.id &&
                              (defaultSelection.thinkingTier ?? model.defaultThinkingTier) === tier;
                            return (
                              <button
                                key={tier}
                                type="button"
                                data-testid={`${testIdPrefix}-tier-${provider.id}-${model.id}-${tier}`}
                                data-default={tierIsDefault ? "true" : undefined}
                                title={tierIsDefault ? t("modelPicker.defaultForNewSessions") : undefined}
                                onClick={() => pick(provider, model, tier)}
                                className="relative rounded-md outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
                              >
                                <Badge
                                  variant={tierActive ? "info" : "outline"}
                                  size="sm"
                                  className="cursor-pointer"
                                >
                                  {tierLabel(tier)}
                                </Badge>
                                {/* The global default's mark: a dot under
                                    the pill, so it reads alongside the
                                    session's (filled) pick. */}
                                {tierIsDefault ? (
                                  <span
                                    aria-hidden="true"
                                    className="absolute -bottom-0.5 left-1/2 size-1 -translate-x-1/2 rounded-full bg-foreground/60"
                                  />
                                ) : null}
                              </button>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
        {onOpenSettings || hovered || active ? (
          <div
            className="flex shrink-0 items-center gap-2 border-t p-1"
            data-testid={`${testIdPrefix}-model-picker-footer`}
          >
            {onOpenSettings ? (
              <Button
                variant="ghost"
                size="icon-sm"
                data-testid={`${testIdPrefix}-model-picker-provider-settings`}
                aria-label={t("modelPicker.providerSettings")}
                title={t("modelPicker.providerSettings")}
                className="shrink-0"
                onClick={() => {
                  setOpen(false);
                  onOpenSettings();
                }}
              >
                <SettingsIcon className="size-4" />
              </Button>
            ) : null}
            {hovered ?? active ? (
              <ModelDetail
                provider={(hovered ?? active)!.provider}
                model={(hovered ?? active)!.model}
                testIdPrefix={testIdPrefix}
              />
            ) : null}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Footer description of the hovered (else active) model: name, context window and price,
 * then its provider's quota. Unknowns are left out; only provider usage is fetched.
 */
function ModelDetail({
  provider,
  model,
  testIdPrefix,
}: {
  provider: BrowserLlmProvider;
  model: BrowserLlmModel;
  testIdPrefix: string;
}) {
  const t = useT();
  const locale = useLocale();
  const formatAmount = useFormatAmount();
  const providerUsage = useProviderUsage(provider.id)?.usage;
  // The provider says which part of its usage meters this model, and how it
  // reads on one line (OpenRouter folds balance and key limit into Available).
  const usage = providerUsage
    ? usageSummary(provider.id, usageForModel(provider.id, providerUsage, model))
    : undefined;
  const label = displayModelLabel(provider.id, model.entry?.resolvedLabel ?? model.label, model);
  const price = model.free ? undefined : priceFigure(model, t, locale, true);
  // The quota as short `label value` items (`Month 25%`, `Balance $95.50`),
  // read from the snapshot's uniform kinds — every provider's the same way.
  // The full wording is each item's tooltip.
  const quota = [
    ...(usage?.windows ?? []).map((w) => ({
      label: t(compactWindowLabelKey(w)),
      value: `${w.usedPercent.toFixed(0)}%`,
      full: t("tokenUsage.planSummary", {
        pct: w.usedPercent.toFixed(0),
        window: t(windowLabelKey(w, true)),
      }),
    })),
    // An unreadable account balance holds the balance's place, its reason
    // in the tooltip — a key's cap must not be the only money figure.
    ...(usage?.balanceNote
      ? [{
          label: t("modelPicker.quota.balance"),
          value: t("tokenUsage.notAvailable"),
          full: t(balanceNoteKey(usage.balanceNote)),
        }]
      : []),
    ...(usage?.amounts ?? []).map((a) => ({
      label: t(compactAmountLabelKey(a)),
      value: formatAmount(a),
      full: t("tokenUsage.amountSummary", { label: t(amountLabelKey(a)), amount: formatAmount(a) }),
    })),
  ];
  return (
    <div
      // Two lines tall whatever is known — the name and its figures, then the
      // provider's quota — so hovering rows never resizes the popover; with
      // no quota, the one line sits in the middle.
      className="flex min-h-10 min-w-0 flex-1 flex-col justify-center gap-1 px-1 py-1 text-left text-xs leading-snug"
      data-testid={`${testIdPrefix}-model-detail`}
      title={model.entry?.resolvedId ?? model.id}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="min-w-0 truncate font-medium" data-testid={`${testIdPrefix}-model-detail-label`}>
          {label}
        </span>
        {/* The figures beside the name, words spared: an icon says what
            each is, its tooltip says it in full. */}
        {model.contextWindow ? (
          <span
            className="flex shrink-0 items-center gap-1 text-muted-foreground tabular-nums"
            title={contextFigure(model, t)}
            data-testid={`${testIdPrefix}-model-detail-context`}
          >
            <LayersIcon className="size-3" aria-label={t("tokenUsage.contextWindow")} />
            {formatTokenCount(model.contextWindow)}
          </span>
        ) : null}
        {model.free ? (
          <FreeModelIcon className="size-3.5" />
        ) : price ? (
          <span
            className="flex shrink-0 items-center gap-1 text-muted-foreground tabular-nums"
            title={priceFigure(model, t, locale)}
            data-testid={`${testIdPrefix}-model-detail-price`}
          >
            <CircleDollarSignIcon className="size-3" aria-label={priceFigure(model, t, locale)} />
            {price}
          </span>
        ) : null}
      </div>
      {quota.length > 0 ? (
        <div
          className="flex min-w-0 items-center gap-3 overflow-hidden whitespace-nowrap tabular-nums"
          data-testid={`${testIdPrefix}-model-detail-quota`}
        >
          {quota.map((item) => (
            <span key={item.full} className="flex shrink-0 items-baseline gap-1" title={item.full}>
              <span className="text-muted-foreground">{item.label}</span>
              <span>{item.value}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * What an entry row says beside its label: a family's Latest names the
 * version it resolves to today ("Latest · 5.1"); a pinned version carries a
 * pin; a preview carries a badge (never Latest; may be withdrawn).
 */
function EntryMarks({ model }: { model: BrowserLlmModel }) {
  const t = useT();
  const entry = model.entry;
  if (!entry) return null;
  return (
    <>
      {entry.kind === "latest" ? (
        <span className="shrink-0 text-muted-foreground text-xs">
          {entry.resolvedVersion
            ? t("modelPicker.latestVersion", { version: entry.resolvedVersion })
            : t("modelPicker.latest")}
        </span>
      ) : (
        <PinIcon
          className="size-3 shrink-0 text-muted-foreground"
          aria-label={t("modelPicker.pinned")}
        />
      )}
      {entry.preview ? (
        <Badge variant="muted" size="sm" title={t("modelPicker.previewHint")}>
          {t("modelPicker.preview")}
        </Badge>
      ) : null}
    </>
  );
}

const MENU_ITEM_CLASS =
  "flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-start text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-muted data-[state=open]:bg-muted";
const MENU_CONTENT_CLASS =
  "z-50 max-h-80 min-w-[12rem] overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md";

/**
 * A provider heading's `⋯` menu: its families, each opening onto its
 * versions (stable newest first, then a separate Previews section), any of
 * which becomes a pinned row; and "Edit…", the provider's settings page. No
 * removal here — that is the settings page's.
 */
function ProviderHeaderMenu({
  provider,
  menu,
  testIdPrefix,
  onDone,
}: {
  provider: BrowserLlmProvider;
  menu: ModelQuickPickerProviderMenu;
  testIdPrefix: string;
  onDone: () => void;
}) {
  const t = useT();
  const families = menu.onAddVersion ? (provider.entryFamilies ?? []).filter((f) => f.versions.length > 0) : [];
  if (families.length === 0 && !menu.onEditProvider) return null;
  const versionItem = (
    family: string,
    familyLabel: string,
    version: { versionLabel: string; id: string; preview: boolean; pinned: boolean },
  ) => (
    <DropdownMenuPrimitive.Item
      key={version.versionLabel}
      className={MENU_ITEM_CLASS}
      disabled={version.pinned}
      title={version.preview ? t("modelPicker.previewHint") : undefined}
      data-testid={`${testIdPrefix}-pin-version-${provider.id}-${family}@${version.versionLabel}`}
      onSelect={() => {
        onDone();
        void menu.onAddVersion?.(provider, family, version);
      }}
    >
      <span className="min-w-0 flex-1 truncate">
        {familyLabel} {version.versionLabel}
      </span>
      {version.preview ? (
        <Badge variant="muted" size="sm">
          {t("modelPicker.preview")}
        </Badge>
      ) : null}
      {version.pinned ? (
        <span className="flex shrink-0 items-center gap-1 text-muted-foreground text-xs">
          <CheckIcon className="size-3" />
          {t("modelPicker.alreadyAdded")}
        </span>
      ) : null}
    </DropdownMenuPrimitive.Item>
  );
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <button
          type="button"
          className="ml-auto rounded-sm p-0.5 text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent"
          aria-label={t("modelPicker.providerMenu", { name: provider.label })}
          title={t("modelPicker.providerMenu", { name: provider.label })}
          data-testid={`${testIdPrefix}-provider-menu-${provider.id}`}
        >
          <MoreHorizontalIcon className="size-3.5" />
        </button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content align="end" sideOffset={4} className={MENU_CONTENT_CLASS}>
          {families.length > 0 ? (
            <>
              <DropdownMenuPrimitive.Label className="px-2 py-1 text-muted-foreground text-xs">
                {t("modelPicker.addPinned")}
              </DropdownMenuPrimitive.Label>
              {families.map((family) => {
                const stable = family.versions.filter((v) => !v.preview);
                const previews = family.versions.filter((v) => v.preview);
                return (
                  <DropdownMenuPrimitive.Sub key={family.family}>
                    <DropdownMenuPrimitive.SubTrigger
                      className={MENU_ITEM_CLASS}
                      data-testid={`${testIdPrefix}-pin-family-${provider.id}-${family.family}`}
                    >
                      <span className="min-w-0 flex-1 truncate">{family.familyLabel}</span>
                      <ChevronDownIcon className="size-3.5 -rotate-90 opacity-60" />
                    </DropdownMenuPrimitive.SubTrigger>
                    <DropdownMenuPrimitive.Portal>
                      <DropdownMenuPrimitive.SubContent sideOffset={4} className={MENU_CONTENT_CLASS}>
                        {stable.map((v) => versionItem(family.family, family.familyLabel, v))}
                        {previews.length > 0 ? (
                          <>
                            {stable.length > 0 ? (
                              <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />
                            ) : null}
                            <DropdownMenuPrimitive.Label className="px-2 py-1 text-muted-foreground text-xs">
                              {t("modelPicker.previewSection")}
                            </DropdownMenuPrimitive.Label>
                            {previews.map((v) => versionItem(family.family, family.familyLabel, v))}
                          </>
                        ) : null}
                      </DropdownMenuPrimitive.SubContent>
                    </DropdownMenuPrimitive.Portal>
                  </DropdownMenuPrimitive.Sub>
                );
              })}
            </>
          ) : null}
          {families.length > 0 && menu.onEditProvider ? (
            <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />
          ) : null}
          {menu.onEditProvider ? (
            <DropdownMenuPrimitive.Item
              className={MENU_ITEM_CLASS}
              data-testid={`${testIdPrefix}-provider-edit-${provider.id}`}
              onSelect={() => {
                onDone();
                menu.onEditProvider?.(provider.id);
              }}
            >
              <PencilIcon className="size-3.5" />
              {t("modelPicker.editProvider")}
            </DropdownMenuPrimitive.Item>
          ) : null}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

// Memoized so the picker subtree (including the open popover's option rows)
// does NOT re-render on every parent render. During a streaming turn the shell
// re-renders per token, but the picker's props (`catalog`, `selection`,
// `onSelect`, `onOpenSettings`) are referentially stable token-to-token
// (the snapshot — and thus the configured catalog / selection — only changes at
// turn boundaries, and the callbacks are `useCallback`-stable). Without this,
// each token reconciled the entire option list while the popover was open,
// which is what made clicking the model selector feel like it "hangs" mid-turn.
export const ModelQuickPicker = React.memo(ModelQuickPickerImpl);
ModelQuickPicker.displayName = "ModelQuickPicker";
