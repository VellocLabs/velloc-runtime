import * as React from "react";
import {
  ChevronRightIcon,
  InfoIcon,
  TriangleAlertIcon,
  Undo2Icon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

import { useT } from "../../i18n";
import { useSettingsBridge } from "../../nexusSettingsBridge";
import {
  sessionModelsSetField,
  sessionModelsAutoTiers,
  sessionModelsSnapshot,
} from "../clients";
import type { SessionModelsFieldPatch } from "../clients";
import {
  SettingsCard,
  SettingsGroupLabel,
  SettingsSection,
  SettingsSubpageLayout,
} from "../SettingsSubpageLayout";
import {
  ModelQuickPicker,
  findActiveModel,
  tierLabel,
} from "../../ModelQuickPicker";
import type { ModelQuickPickerLeadingOption } from "../../ModelQuickPicker";
import type {
  BrowserLlmCatalog,
  BrowserLlmSelection,
} from "../../../bridge/protocol/nexus_llm";
import type { SessionModelsFieldValues } from "../../../bridge/protocol/sessionModels";
import type {
  PinFailureRecord,
  SessionModelsPinHealth,
} from "../../../../models/pinFailureLog";
import type {
  ModelTierSlot,
  SessionModelPolicy,
  SessionModelPolicyType,
  TierModelPin,
} from "../../../../settings/settingsTypes";
import {
  autoTierThinkingTier,
  getSessionTypeTier,
  getTierModelForProvider,
} from "../../../../engine/contextWindow";

/**
 * Session models — the `modelTiers` + `sessionModelPolicy` sections of settings.json
 * via the worker `sessionModels` bridge. Tiers first; per-feature routing under
 * "Advanced options", expanded when an override exists. Rows show the RESOLVED
 * result. Options come from the live configured catalog; writes apply LIVE.
 */

const TIER_SLOTS: ModelTierSlot[] = ["fast", "balanced", "best"];

const POLICY_KINDS: SessionModelPolicyType[] = [
  "agent_tool",
  "memory_extract",
  "memory_consolidate",
  "memory_recall",
  "compact",
  "session_title",
  "web_fetch",
  "prompt_hook",
  "skill_fork",
  "hook_agent",
];

const KIND_GROUPS: Array<{
  groupKey:
    | "settings.sessionModels.group.agents"
    | "settings.sessionModels.group.memory"
    | "settings.sessionModels.group.conversation"
    | "settings.sessionModels.group.toolsHooks";
  kinds: SessionModelPolicyType[];
}> = [
  {
    groupKey: "settings.sessionModels.group.agents",
    kinds: ["agent_tool", "skill_fork"],
  },
  {
    groupKey: "settings.sessionModels.group.memory",
    kinds: ["memory_extract", "memory_consolidate", "memory_recall"],
  },
  {
    groupKey: "settings.sessionModels.group.conversation",
    kinds: ["compact", "session_title"],
  },
  {
    groupKey: "settings.sessionModels.group.toolsHooks",
    kinds: ["web_fetch", "prompt_hook", "hook_agent"],
  },
];

/** Kinds whose Default DELEGATES to something outside this page (the
 *  assistant's per-task pick, a skill's or hook's own `model:`), so the row
 *  cannot name one resolved model — it shows "Per task" / "Per hook" and the
 *  Default option spells out the fallback chain. */
const DELEGATING_KINDS = new Set<SessionModelPolicyType>([
  "agent_tool",
  "skill_fork",
  "prompt_hook",
  "hook_agent",
]);

/** Tiers below what a quality-sensitive feature is tuned for. Routing a
 *  feature onto one of these is allowed, but its row says what it costs. */
const WEAK_TIERS: Partial<Record<SessionModelPolicyType, ModelTierSlot[]>> = {
  compact: ["fast"],
  memory_recall: ["fast"],
};

type Translate = ReturnType<typeof useT>;
type TranslationKey = Parameters<Translate>[0];

const pinToSelection = (pin: TierModelPin): BrowserLlmSelection => ({
  providerId: pin.providerId,
  modelId: pin.modelId,
  ...(pin.thinkingTier ? { thinkingTier: pin.thinkingTier } : {}),
});

const selectionToPin = (sel: BrowserLlmSelection): TierModelPin => ({
  providerId: sel.providerId,
  modelId: sel.modelId,
  ...(sel.thinkingTier ? { thinkingTier: sel.thinkingTier } : {}),
});

/** A stored policy that actually overrides anything. `{mode:'default'}` is
 *  specified as "same as absent". */
function isOverride(policy: SessionModelPolicy | undefined): boolean {
  return !!policy && policy.mode !== "default";
}

/** A model's display label from the catalog (listed even when disabled, so a
 *  stale pin still reads as a name), else its raw id. A concrete id no row
 *  carries reads as the model an entry resolves it to (a tier's
 *  `claude-haiku-4-5` → `Claude Haiku 4.5`). */
function modelLabelOf(
  catalog: BrowserLlmCatalog | null | undefined,
  providerId: string | undefined,
  modelId: string,
): string {
  const provider = catalog?.providers.find((p) => p.id === providerId);
  const all = catalog?.providers.flatMap((p) => p.models) ?? [];
  const model =
    provider?.models.find((m) => m.id === modelId) ??
    all.find((m) => m.id === modelId);
  // A Latest entry reads as the model it runs today, as the topbar trigger does.
  if (model) {
    return model.entry?.kind === "latest" && model.entry.resolvedLabel
      ? model.entry.resolvedLabel
      : model.label;
  }
  const entry =
    provider?.models.find((m) => m.entry?.resolvedId === modelId) ??
    all.find((m) => m.entry?.resolvedId === modelId);
  return entry?.entry?.resolvedLabel ?? entry?.label ?? modelId;
}

/** The tier a kind runs on without an explicit model choice — the stored
 *  `tier` route, else its built-in census tier when it has one. `null` for
 *  kinds that inherit the session model or are hard-pinned. */
function effectiveTierOf(
  kind: SessionModelPolicyType,
  policy: SessionModelPolicy | undefined,
): ModelTierSlot | null {
  if (isOverride(policy)) return policy!.mode === "tier" ? policy!.tier : null;
  const tier = getSessionTypeTier(kind);
  return tier === "inherit" ? null : tier;
}

/** The trigger text of a row: muted while untouched, foreground + a dot once
 *  modified, and a muted "· model" tail naming what a tier resolves to. */
function RouteValue({
  label,
  detail,
  modified,
  modifiedLabel,
}: {
  label: string;
  detail?: string;
  modified: boolean;
  modifiedLabel: string;
}) {
  return (
    <span
      className={cn(
        "flex min-w-0 flex-1 items-center gap-1.5 truncate text-left",
        modified ? "text-foreground" : "text-muted-foreground",
      )}
    >
      {modified ? (
        <span
          role="img"
          aria-label={modifiedLabel}
          className="size-1.5 shrink-0 rounded-full bg-primary"
        />
      ) : null}
      <span className="truncate">
        {label}
        {detail ? (
          <span className="text-muted-foreground"> · {detail}</span>
        ) : null}
      </span>
    </span>
  );
}

/** One flat row inside a `SettingsCard`: label + description on the left,
 *  the single control (plus a reset while modified) on the right, and any
 *  contextual notes full-width below. */
function RouteRow({
  testId,
  modified,
  label,
  description,
  control,
  onReset,
  resetLabel,
  notes,
}: {
  testId: string;
  modified: boolean;
  label: string;
  description: React.ReactNode;
  control: React.ReactNode;
  onReset: () => void;
  resetLabel: string;
  notes?: React.ReactNode;
}) {
  return (
    <div
      className="flex flex-col gap-2 px-4 py-3"
      data-testid={testId}
      data-modified={modified ? "true" : "false"}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-sm">{label}</div>
          <div className="mt-0.5 text-muted-foreground text-xs">
            {description}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {modified ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground"
              aria-label={resetLabel}
              title={resetLabel}
              onClick={onReset}
              data-testid={`${testId}-reset`}
            >
              <Undo2Icon className="size-3.5" />
            </Button>
          ) : null}
          {control}
        </div>
      </div>
      {notes}
    </div>
  );
}

/** A one-line contextual note under a row. `danger`/`warning` carry an
 *  action; `info` is explanatory only. */
function RowNote({
  tone,
  testId,
  children,
  actionLabel,
  onAction,
}: {
  tone: "info" | "warning" | "danger";
  testId: string;
  children: React.ReactNode;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const Icon = tone === "info" ? InfoIcon : TriangleAlertIcon;
  return (
    <div
      className={cn(
        "flex items-start gap-1.5 text-xs",
        tone === "info" && "text-muted-foreground",
        tone === "warning" && "text-warning",
        tone === "danger" && "text-destructive",
      )}
      data-testid={testId}
    >
      <Icon className="mt-px size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{children}</span>
      {actionLabel && onAction ? (
        <button
          type="button"
          className="shrink-0 underline underline-offset-2 hover:text-foreground"
          onClick={onAction}
        >
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

/** Trigger styling for the row controls: a quiet, fixed-width select that
 *  reads as a value, not a button, until hovered — and stays highlighted
 *  while its menu is open, so the menu visibly belongs to this row. */
const ROW_TRIGGER =
  "w-64 border-transparent bg-transparent font-normal hover:border-border data-[state=open]:border-border data-[state=open]:bg-accent";

export function SessionModelsSection({
  catalog,
  embedded = false,
  scrollIntoViewOnMount = false,
}: {
  catalog: BrowserLlmCatalog | null | undefined;
  /**
   * Rendered as the second group of the Models page, under the provider list,
   * instead of as a page of its own: no scroll frame, and nothing at all until
   * the snapshot lands — a "Loading" line under a finished provider list only
   * flickers. The standalone page survives for connections that cannot list
   * providers (see settingsNav's `onlyWithout`).
   */
  embedded?: boolean;
  /** Embedded only: scroll the group into view when it first renders. */
  scrollIntoViewOnMount?: boolean;
}) {
  const t = useT();
  const bridge = useSettingsBridge();
  const [values, setValues] = React.useState<SessionModelsFieldValues | null>(
    null,
  );
  const [pinHealth, setPinHealth] =
    React.useState<SessionModelsPinHealth | null>(null);
  const [resetOpen, setResetOpen] = React.useState(false);
  // `null` until the first snapshot lands, then seeded ONCE: open when a
  // routing override already exists, so nothing that changes behavior hides
  // behind a collapsed disclosure. After that it is the user's.
  const [advancedOpen, setAdvancedOpen] = React.useState<boolean | null>(
    null,
  );

  React.useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    void (async () => {
      try {
        const snap = await sessionModelsSnapshot(bridge);
        if (!cancelled) {
          setValues(snap.values);
          setPinHealth(snap.pinHealth ?? null);
          setAdvancedOpen(
            (prev) =>
              prev ??
              Object.values(snap.values.sessionModelPolicy).some(isOverride),
          );
        }
      } catch {
        // Leave null → the loading note stays.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  // (A hook: it stays above the early returns below.)
  // What Auto means per tier for the default selection, as the RUNTIME
  // resolves it: the provider's own ladder, or — a gateway, a custom
  // endpoint — the ladder of the session model's vendor looked up in that
  // provider's whole listing, which only the runtime holds. Until it
  // answers (and for a tier it leaves out) the local reading below stands.
  const autoProviderId = catalog?.defaultSelection?.providerId;
  const autoModelId = catalog?.defaultSelection?.modelId;
  const [autoTiers, setAutoTiers] = React.useState<
    Partial<Record<ModelTierSlot, { modelId: string; label?: string }>>
  >({});
  React.useEffect(() => {
    if (!bridge || !autoProviderId || !autoModelId) {
      setAutoTiers({});
      return;
    }
    let cancelled = false;
    sessionModelsAutoTiers(bridge, {
      providerId: autoProviderId,
      modelId: autoModelId,
    })
      .then((result) => {
        if (!cancelled) setAutoTiers(result.tiers ?? {});
      })
      .catch(() => {
        // An older runtime has no such action: the local reading stands.
        if (!cancelled) setAutoTiers({});
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, autoProviderId, autoModelId, catalog]);


  // Persist a sparse patch; the optimistic update happens at the call sites.
  // Write-through replaces state with disk truth; rollback re-snapshots. On
  // success, MIRROR the adapter's health clearing for every patched key so
  // a stale "failing" note never survives the edit that addressed it.
  const persist = React.useCallback(
    async (patch: SessionModelsFieldPatch) => {
      if (!bridge) return;
      try {
        const result = await sessionModelsSetField(bridge, patch);
        setValues(result.values);
        setPinHealth((prev) => {
          if (!prev) return prev;
          const next: SessionModelsPinHealth = {
            modelTiers: { ...prev.modelTiers },
            sessionModelPolicy: { ...prev.sessionModelPolicy },
          };
          for (const slot of Object.keys(patch.modelTiers ?? {})) {
            delete next.modelTiers[slot as keyof typeof next.modelTiers];
          }
          for (const kind of Object.keys(patch.sessionModelPolicy ?? {})) {
            delete next.sessionModelPolicy[
              kind as keyof typeof next.sessionModelPolicy
            ];
          }
          return next;
        });
      } catch {
        const snap = await sessionModelsSnapshot(bridge).catch(() => null);
        if (snap) {
          setValues(snap.values);
          setPinHealth(snap.pinHealth ?? null);
        }
      }
    },
    [bridge],
  );

  if (!bridge) {
    if (embedded) return null;
    return (
      <SettingsSubpageLayout title={t("settings.sessionModels.title")}>
        <p className="text-muted-foreground text-sm">
          {t("settings.bridgeUnavailable")}
        </p>
      </SettingsSubpageLayout>
    );
  }

  if (!values) {
    if (embedded) return null;
    return (
      <SettingsSubpageLayout title={t("settings.sessionModels.title")}>
        <p className="text-muted-foreground text-sm">{t("settings.loading")}</p>
      </SettingsSubpageLayout>
    );
  }

  // --- Derived state ------------------------------------------------------

  const tierPinCount = TIER_SLOTS.filter((s) => values.modelTiers[s]).length;
  const routeOverrideCount = POLICY_KINDS.filter((k) =>
    isOverride(values.sessionModelPolicy[k]),
  ).length;
  const modifiedCount = tierPinCount + routeOverrideCount;

  // The provider new sessions start on — what "Auto" and "Session model"
  // resolve against on this page. A running session on another provider
  // resolves Auto against ITS provider; the label is the common case.
  const baseProviderId = catalog?.defaultSelection?.providerId;

  const tierLabelOf = (slot: ModelTierSlot) =>
    t(`settings.sessionModels.tier.${slot}` as TranslationKey);

  /** What Auto resolves to for a tier: the model the runtime names for it
   *  (the base provider's ladder, or one borrowed from the session model's
   *  vendor), or the session model — at the tier's effort when the default
   *  model states efforts — when no model is named for the tier. */
  const autoModelLabel = (slot: ModelTierSlot) => {
    const resolved = autoTiers[slot];
    if (resolved) {
      const label = modelLabelOf(catalog, baseProviderId, resolved.modelId);
      return label !== resolved.modelId ? label : (resolved.label ?? label);
    }
    const ladderId = getTierModelForProvider(baseProviderId, slot);
    if (ladderId) return modelLabelOf(catalog, baseProviderId, ladderId);
    const defaultModelId = catalog?.defaultSelection?.modelId;
    const effort = autoTierThinkingTier(
      slot,
      catalog?.providers
        .find((p) => p.id === baseProviderId)
        ?.models.find((m) => m.id === defaultModelId)?.availableThinkingTiers,
    );
    return effort
      ? t("settings.sessionModels.sessionModelAtEffort", {
          effort: tierLabel(effort),
        })
      : t("settings.sessionModels.sessionModel");
  };

  /** The model a tier is pinned to, or undefined while it is on Auto. Auto
   *  deliberately names no model here: it follows whichever provider the
   *  session runs on, so a model name would read as a fixed choice and go
   *  stale the moment the user switches providers in a session. Only the
   *  Auto option's own description names the default provider's model. */
  const tierModelLabel = (slot: ModelTierSlot) => {
    const pin = values.modelTiers[slot];
    return pin ? modelLabelOf(catalog, pin.providerId, pin.modelId) : undefined;
  };

  const usedByCount = (slot: ModelTierSlot) =>
    POLICY_KINDS.filter(
      (kind) => effectiveTierOf(kind, values.sessionModelPolicy[kind]) === slot,
    ).length;

  const kindLabel = (kind: SessionModelPolicyType) =>
    t(`settings.sessionModels.kind.${kind}` as TranslationKey);

  const kindDescription = (kind: SessionModelPolicyType) =>
    t(`settings.sessionModels.kindDesc.${kind}` as TranslationKey);

  /** A stored pin that is no longer enabled in the live catalog. */
  const pinUnavailable = (pin: { providerId: string; modelId: string }) =>
    !findActiveModel(catalog, {
      providerId: pin.providerId,
      modelId: pin.modelId,
    });

  /** A pin on another provider than the session's cannot reuse its prompt
   *  cache in forked features. Only said when the base provider is known. */
  const crossProvider = (pin: { providerId: string }) =>
    !!baseProviderId && pin.providerId !== baseProviderId;

  // --- Writers ------------------------------------------------------------

  const setTierPin = (slot: ModelTierSlot, pin: TierModelPin | null) => {
    setValues((prev) => {
      if (!prev) return prev;
      const modelTiers = { ...prev.modelTiers };
      if (pin) modelTiers[slot] = pin;
      else delete modelTiers[slot];
      return { ...prev, modelTiers };
    });
    void persist({ modelTiers: { [slot]: pin } });
  };

  const setPolicy = (
    kind: SessionModelPolicyType,
    policy: SessionModelPolicy | null,
  ) => {
    setValues((prev) => {
      if (!prev) return prev;
      const sessionModelPolicy = { ...prev.sessionModelPolicy };
      if (policy) sessionModelPolicy[kind] = policy;
      else delete sessionModelPolicy[kind];
      return { ...prev, sessionModelPolicy };
    });
    void persist({ sessionModelPolicy: { [kind]: policy } });
  };

  const resetAll = () => {
    const modelTiers = Object.fromEntries(
      TIER_SLOTS.map((slot) => [slot, null]),
    ) as SessionModelsFieldPatch["modelTiers"];
    const sessionModelPolicy = Object.fromEntries(
      POLICY_KINDS.map((kind) => [kind, null]),
    ) as SessionModelsFieldPatch["sessionModelPolicy"];
    setValues((prev) =>
      prev ? { ...prev, modelTiers: {}, sessionModelPolicy: {} } : prev,
    );
    void persist({ modelTiers, sessionModelPolicy });
    setResetOpen(false);
  };

  // --- Shared note builders -----------------------------------------------

  const resetLabel = t("settings.sessionModels.reset");
  const modifiedLabel = t("settings.sessionModels.modified");

  const pinNotes = (
    testIdBase: string,
    pin: TierModelPin | undefined,
    health: PinFailureRecord | undefined,
    onReset: () => void,
  ) => {
    if (!pin) return null;
    if (pinUnavailable(pin)) {
      return (
        <RowNote
          tone="danger"
          testId={`${testIdBase}-unavailable`}
          actionLabel={resetLabel}
          onAction={onReset}
        >
          {t("settings.sessionModels.unavailableNote")}
        </RowNote>
      );
    }
    return (
      <>
        {health ? (
          <RowNote
            tone="danger"
            testId={`${testIdBase}-failing`}
            actionLabel={resetLabel}
            onAction={onReset}
          >
            {t("settings.sessionModels.pinFailingNote", {
              count: String(health.count),
              error: health.lastError,
            })}
          </RowNote>
        ) : null}
        {crossProvider(pin) ? (
          <RowNote tone="info" testId={`${testIdBase}-cache-hint`}>
            {t("settings.sessionModels.cacheHint")}
          </RowNote>
        ) : null}
      </>
    );
  };

  // --- Tier rows ------------------------------------------------------------

  const tierRow = (slot: ModelTierSlot) => {
    const pin = values.modelTiers[slot];
    const testId = `session-models-tier-${slot}`;
    const leading: ModelQuickPickerLeadingOption[] = [
      {
        id: "auto",
        label: t("settings.sessionModels.auto"),
        description: t("settings.sessionModels.autoDescription", {
          model: autoModelLabel(slot),
        }),
        checked: !pin,
        onSelect: () => setTierPin(slot, null),
        testId: `${testId}-auto`,
      },
    ];
    return (
      <RouteRow
        key={slot}
        testId={testId}
        modified={!!pin}
        label={tierLabelOf(slot)}
        description={
          <>
            {t(`settings.sessionModels.tierDesc.${slot}` as TranslationKey)}
            {usedByCount(slot) > 0 ? (
              <>
                {" "}
                <span data-testid={`${testId}-used-by`}>
                  {t("settings.sessionModels.tierUsedBy", {
                    count: String(usedByCount(slot)),
                  })}
                </span>
              </>
            ) : null}
          </>
        }
        onReset={() => setTierPin(slot, null)}
        resetLabel={resetLabel}
        control={
          <ModelQuickPicker
            catalog={catalog}
            selection={pin ? pinToSelection(pin) : null}
            explicitTierOnly
            triggerClassName={ROW_TRIGGER}
            testIdPrefix={testId}
            leadingOptions={leading}
            modelsHeading={t("settings.sessionModels.modeSpecific")}
            triggerContent={
              <RouteValue
                modified={!!pin}
                modifiedLabel={modifiedLabel}
                label={
                  pin
                    ? modelLabelOf(catalog, pin.providerId, pin.modelId)
                    : t("settings.sessionModels.auto")
                }
                detail={
                  pin ? undefined : t("settings.sessionModels.autoFollows")
                }
              />
            }
            onSelect={(sel) => setTierPin(slot, selectionToPin(sel))}
          />
        }
        notes={pinNotes(
          testId,
          pin,
          pinHealth?.modelTiers[slot],
          () => setTierPin(slot, null),
        )}
      />
    );
  };

  // --- Feature rows -----------------------------------------------------------

  /** Label + detail of what Default resolves to for a kind. */
  const defaultValueOf = (
    kind: SessionModelPolicyType,
  ): { label: string; detail?: string } => {
    if (DELEGATING_KINDS.has(kind)) {
      return {
        label: t(`settings.sessionModels.defaultValue.${kind}` as TranslationKey),
      };
    }
    const tier = getSessionTypeTier(kind);
    if (tier === "inherit") {
      return { label: t("settings.sessionModels.sessionModel") };
    }
    return { label: tierLabelOf(tier), detail: tierModelLabel(tier) };
  };

  const routeRow = (kind: SessionModelPolicyType) => {
    const stored = values.sessionModelPolicy[kind];
    const policy = isOverride(stored) ? stored : undefined;
    const testId = `session-models-route-${kind}`;
    const specificPin =
      policy?.mode === "specific"
        ? {
            providerId: policy.providerId,
            modelId: policy.modelId,
            ...(policy.thinkingTier
              ? { thinkingTier: policy.thinkingTier }
              : {}),
          }
        : undefined;

    const def = defaultValueOf(kind);
    const defaultInherits =
      !DELEGATING_KINDS.has(kind) && getSessionTypeTier(kind) === "inherit";
    let value: { label: string; detail?: string } = def;
    if (policy?.mode === "same-as-parent") {
      value = { label: t("settings.sessionModels.modeSameAsParent") };
    } else if (policy?.mode === "tier") {
      value = {
        label: tierLabelOf(policy.tier),
        detail: tierModelLabel(policy.tier),
      };
    } else if (specificPin) {
      value = {
        label: modelLabelOf(
          catalog,
          specificPin.providerId,
          specificPin.modelId,
        ),
      };
    }

    const leading: ModelQuickPickerLeadingOption[] = [
      {
        id: "default",
        label: `${t("settings.sessionModels.modeDefault")} · ${def.label}`,
        description: DELEGATING_KINDS.has(kind)
          ? t(`settings.sessionModels.defaultHint.${kind}` as TranslationKey)
          : t("settings.sessionModels.defaultRecommended"),
        checked: !policy,
        onSelect: () => setPolicy(kind, null),
        testId: `${testId}-option-default`,
      },
      // "Same as session" only where it differs from Default: a kind whose
      // Default already inherits the session model would list it twice.
      ...(defaultInherits && policy?.mode !== "same-as-parent"
        ? []
        : [
            {
              id: "same-as-parent",
              label: t("settings.sessionModels.modeSameAsParent"),
              checked: policy?.mode === "same-as-parent",
              onSelect: () => setPolicy(kind, { mode: "same-as-parent" }),
              testId: `${testId}-option-same-as-parent`,
            },
          ]),
      ...TIER_SLOTS.map(
        (slot, i): ModelQuickPickerLeadingOption => ({
          id: `tier-${slot}`,
          label: tierLabelOf(slot),
          description: tierModelLabel(slot) ?? t("settings.sessionModels.auto"),
          checked: policy?.mode === "tier" && policy.tier === slot,
          onSelect: () => setPolicy(kind, { mode: "tier", tier: slot }),
          testId: `${testId}-option-tier-${slot}`,
          ...(i === 0
            ? { groupHeading: t("settings.sessionModels.sectionTiers") }
            : {}),
        }),
      ),
    ];

    const weak =
      policy?.mode === "tier" && WEAK_TIERS[kind]?.includes(policy.tier);

    return (
      <RouteRow
        key={kind}
        testId={testId}
        modified={!!policy}
        label={kindLabel(kind)}
        description={kindDescription(kind)}
        onReset={() => setPolicy(kind, null)}
        resetLabel={resetLabel}
        control={
          <ModelQuickPicker
            catalog={catalog}
            selection={specificPin ? pinToSelection(specificPin) : null}
            explicitTierOnly
            triggerClassName={ROW_TRIGGER}
            testIdPrefix={testId}
            leadingOptions={leading}
            modelsHeading={t("settings.sessionModels.modeSpecific")}
            triggerContent={
              <RouteValue
                modified={!!policy}
                modifiedLabel={modifiedLabel}
                label={value.label}
                detail={value.detail}
              />
            }
            onSelect={(sel) =>
              setPolicy(kind, { mode: "specific", ...selectionToPin(sel) })
            }
          />
        }
        notes={
          <>
            {weak ? (
              <RowNote tone="warning" testId={`${testId}-weak-tier`}>
                {t(`settings.sessionModels.weakTier.${kind}` as TranslationKey)}
              </RowNote>
            ) : null}
            {pinNotes(
              testId,
              specificPin,
              pinHealth?.sessionModelPolicy[kind],
              () => setPolicy(kind, null),
            )}
          </>
        }
      />
    );
  };

  const advancedIsOpen = advancedOpen ?? false;

  // The page header's pieces. Standalone they go to the page layout's
  // page-title header; embedded under the provider list they head a section —
  // either way the shared components draw them, never a local `<header>`.
  const headerActions =
    modifiedCount > 0 ? (
      <>
        <span
          className="text-muted-foreground text-xs"
          data-testid="session-models-modified-count"
        >
          {t("settings.sessionModels.modifiedCount", {
            count: String(modifiedCount),
          })}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setResetOpen(true)}
          data-testid="session-models-reset-all"
        >
          {t("settings.sessionModels.resetAll")}
        </Button>
      </>
    ) : null;
  const headerDescription = (
    <>
      <p>{t("settings.sessionModels.description")}</p>
      <p
        className="mt-1 flex items-center gap-1.5"
        data-testid="session-models-hint"
      >
        <InfoIcon className="size-3.5 shrink-0" />
        {t("settings.sessionModels.hint")}
      </p>
    </>
  );

  const content = (
    <>
      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent data-testid="session-models-reset-dialog">
          <DialogHeader>
            <DialogTitle>
              {t("settings.sessionModels.resetDialogTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("settings.sessionModels.resetDialogBody")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">
                {t("settings.sessionModels.resetDialogCancel")}
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={resetAll}
              data-testid="session-models-reset-confirm"
            >
              {t("settings.sessionModels.resetDialogConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SettingsSection
        title={t("settings.sessionModels.tiersTitle")}
        description={t("settings.sessionModels.tiersDescription")}
        testId="session-models-tiers"
      >
        <SettingsCard>{TIER_SLOTS.map(tierRow)}</SettingsCard>
      </SettingsSection>

      <Collapsible
        open={advancedIsOpen}
        onOpenChange={setAdvancedOpen}
        className="rounded-xl border border-border/70 bg-card"
      >
        <CollapsibleTrigger
          className="flex w-full items-center gap-3 px-4 py-3 text-left outline-none hover:bg-accent/40 focus-visible:bg-accent/40"
          data-testid="session-models-advanced-toggle"
        >
          <ChevronRightIcon
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              advancedIsOpen && "rotate-90",
            )}
          />
          <span className="min-w-0 flex-1">
            <span className="block font-medium text-sm">
              {t("settings.sessionModels.advancedTitle")}
            </span>
            <span
              className="block text-muted-foreground text-xs"
              data-testid="session-models-advanced-summary"
            >
              {routeOverrideCount > 0
                ? t("settings.sessionModels.advancedSummaryModified", {
                    count: String(routeOverrideCount),
                  })
                : t("settings.sessionModels.advancedSummary")}
            </span>
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent data-testid="session-models-advanced">
          {KIND_GROUPS.map(({ groupKey, kinds }) => (
            <div key={groupKey} className="border-border/60 border-t">
              <SettingsGroupLabel className="px-4 pt-3.5 pb-1.5">
                {t(groupKey)}
              </SettingsGroupLabel>
              <div className="divide-y divide-border/40">
                {kinds.map(routeRow)}
              </div>
            </div>
          ))}
        </CollapsibleContent>
      </Collapsible>
    </>
  );

  return embedded ? (
    <EmbeddedFrame
      scrollIntoViewOnMount={scrollIntoViewOnMount}
      title={t("settings.sessionModels.title")}
      description={headerDescription}
      actions={headerActions}
    >
      {content}
    </EmbeddedFrame>
  ) : (
    <SettingsSubpageLayout
      title={t("settings.sessionModels.title")}
      description={headerDescription}
      actions={headerActions}
    >
      {content}
    </SettingsSubpageLayout>
  );
}

/** The embedded frame: a section under the provider list, headed and spaced
 *  exactly like every other settings section. */
function EmbeddedFrame({
  children,
  scrollIntoViewOnMount,
  title,
  description,
  actions,
}: {
  children: React.ReactNode;
  scrollIntoViewOnMount: boolean;
  title: string;
  description: React.ReactNode;
  actions: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (scrollIntoViewOnMount) ref.current?.scrollIntoView?.({ block: "start" });
    // Mount only: a later re-render must not yank the page back here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div ref={ref} data-testid="session-models-embedded" className="mt-6">
      <SettingsSection title={title} description={description} actions={actions}>
        {children}
      </SettingsSection>
    </div>
  );
}
