import * as React from "react";
import {
  ArrowLeftIcon,
  CheckIcon,
  GripVerticalIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SettingsIcon,
  StarIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ProviderIcon } from "../../ProviderIcon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useUnsavedEditsGate } from "@/glic/unsavedEditsGate";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { RadioGroup, RadioOption } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectRoot,
  SelectSeparator,
  SelectTrigger,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

import type { BrowserBridgeTransport } from "../../../bridge/browserBridgeProtocol";
import type {
  BrowserLlmCatalog,
  BrowserLlmProvider,
} from "../../../bridge/protocol/nexus_llm";
import type {
  CustomModelDef,
  NexusProviderConfig,
} from "../../../../settings/settingsTypes";
import type { ProviderAuthProviderInfo } from "../../../bridge/protocol/providerAuth";
import { useLocale, useT } from "../../i18n";
import { useSettingsBridge } from "../../nexusSettingsBridge";
import {
  providerAuthBeginOAuth,
  providerAuthList,
  providerAuthOAuthStatus,
  providerAuthRefresh,
  providerAuthReset,
  providerAuthVerify,
} from "../../nexusBridgeActions";
import {
  createProvidersReadGate,
  isProvidersChangedEvent,
  providersRemove,
  providersSetActive,
  providersFreshModelIds,
  providersSetOrder,
  providersUpsert,
  providersVerify,
} from "../clients";
import {
  modelAvailability,
  pickerModelIds,
  type FreshModelIds,
} from "../providerModelAvailability";
import {
  isRuntimeOnlyProvider,
  providerSecretFields,
  verifiesInRuntime,
} from "../../../../models/drivers/driverRegistry";
import { getProviderUsageStore } from "../../providerUsageStore";
import { ProviderSecretFields } from "./ProviderSecretFields";
import { mapErrorCode } from "../verifyErrorText";
import { ModProviderEditor, modProviderName } from "./ModProviderEditor";
import { isModProviderAdded, isModProviderConnected } from "../modProviderForm";
import { runtimeProviderDefaultBaseUrl } from "../../../../models/drivers/runtimeProviders";
import {
  ProviderModelEntries,
  RuntimeProviderUsageLine,
} from "./ProviderModelEntries";
import { usesModelEntries } from "../../../../models/drivers/modelEntryCatalog";
import { orderByProviderIds } from "../../modelCatalog";
import { mergeProviderConfigForSave } from "../providerConfigMerge";
import type { ProviderTrust } from "../../../../settings/providerTrust";
import {
  defaultProviderTrust,
  resolveProviderTrust,
} from "../../../../settings/providerTrust";
import {
  deriveProviderGating,
  isBuiltInProviderAdded,
  isBuiltInProviderConnected,
  isProviderFormDirty,
  providerBaseUrlPlaceholder,
  providerConnectionKind,
  type ProviderConnectionKind,
  shouldAutoConnect,
} from "../providerFormHelpers";
import {
  backendIdForCompatibility,
  canSubmitCustomProvider,
  configFromDraft,
  draftFromRecord,
  emptyCustomProviderDraft,
  formatTokenCount,
  generateCustomProviderId,
  isCustomBackendId,
  isCustomDraftDirty,
  isModelComplete,
  isValidBaseUrl,
  listCustomProviderRecords,
  modelCapabilityBadges,
  modelLabel,
  normaliseBaseUrl,
  isProviderNameTaken,
  PROVIDER_ICON_KEYS,
  PROVIDER_ICON_LABELS,
  resolveCustomProviderIconSvg,
  type ProviderIconKey,
  type CustomApiCompatibility,
  type CustomProviderDraft,
  type CustomProviderRecord,
} from "../customProviderHelpers";
import {
  isOpencodeZenBaseUrl,
  opencodeZenDraft,
  resolveOpencodeZenApiKey,
} from "../opencodeZenPreset";
import { OPENCODE_ZEN_ENABLED } from "../../../../config/opencodeZen";
import { customProviderUserAgent } from "../../../../config/providerUserAgent";
import { AddModelDialog } from "./AddModelDialog";
import { SettingsSubpageLayout, settingsText } from "../SettingsSubpageLayout";

/** Debounce before an edit auto-triggers the verify+persist connection. */
const AUTO_CONNECT_DEBOUNCE_MS = 700;

/** How long the "<name> added." confirmation stays up. */
const ADDED_NOTICE_MS = 4000;
/** Same ids in the same positions. */
function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** How many unechoed order writes are remembered (`settleEchoedOrder`). */
const MAX_UNECHOED_ORDERS = 16;

/**
 * Settles `written` (orders this page wrote that nothing has echoed yet,
 * oldest first) against an echoed `order`. The host echoes writes in order,
 * so the echo is the OLDEST equal write: it and every write before it are
 * dropped. Returns whether the echo may be shown: only once no write of this
 * page is unechoed — any order seen before that is older than the list's,
 * and showing it would make the next drop look current and write nothing.
 */
export function settleEchoedOrder(
  written: string[][],
  order: readonly string[],
): boolean {
  const index = written.findIndex((w) => sameOrder(w, order));
  if (index >= 0) written.splice(0, index + 1);
  return written.length === 0;
}

/**
 * Arrow-key reordering moves the row at once but writes the order only once
 * the keys have been still this long (or the grip loses focus): holding or
 * tapping an arrow is one gesture, not one `providers.setOrder` — and one
 * `providers.changed` fan-out to every open surface — per keypress.
 */
const KEYBOARD_REORDER_COMMIT_MS = 400;

/**
 * "Add provider" dropdown value for the "+ Add custom provider…" row. It is an
 * ACTION, not a provider: picking it opens the editor in create mode and never
 * becomes a persisted selection.
 */
const ADD_CUSTOM_PROVIDER_VALUE = "__add_custom_provider__";

/**
 * Dropdown value for "+ Add OpenCode Zen…" — the same create flow as
 * `ADD_CUSTOM_PROVIDER_VALUE`, started from the Zen preset instead of an
 * empty draft (`../opencodeZenPreset.ts`).
 */
const ADD_OPENCODE_ZEN_VALUE = "__add_opencode_zen__";

/** Which draft a create flow started from. */
type CreatePreset = "blank" | "opencode-zen";

function createPresetDraft(preset: CreatePreset): CustomProviderDraft {
  return preset === "opencode-zen"
    ? opencodeZenDraft()
    : emptyCustomProviderDraft();
}

/**
 * The key half of a custom-provider verify probe. The probe is addressed to
 * the dialect's shared backend slot, whose stored key is not this provider's,
 * and the WebUI never holds a saved record's key (only `hasApiKey`). So a
 * SAVED record names itself as `keyProviderId` and the host probes with that
 * record's stored key whenever the draft key is empty. A saved key also wins
 * over the keyless Zen `public` fallback — the same rule the save path uses.
 */
function customProbeKey(
  draft: Pick<CustomProviderDraft, "apiKey" | "baseUrl">,
  record: Pick<CustomProviderRecord, "id" | "hasApiKey"> | undefined,
): { apiKey: string; keyProviderId?: string } {
  const typed = draft.apiKey ?? "";
  if (!record) {
    return { apiKey: resolveOpencodeZenApiKey(draft.baseUrl, typed) };
  }
  return {
    apiKey:
      record.hasApiKey && !typed
        ? ""
        : resolveOpencodeZenApiKey(draft.baseUrl, typed),
    keyProviderId: record.id,
  };
}

/**
 * Provider connection page. Config goes through the worker `providers.*` capability
 * (settings.json `providers.configs`); OAuth, live verification and model counts go
 * through the C++ broker (`providerAuth`). A custom provider's probes address the
 * backend slot id for its wire dialect (`custom-openai` / `custom-anthropic`).
 * Views: HOME (added providers + "Add provider") and one provider's editor.
 */

/** Which of the page's two views is showing — see the component doc. */
type PageView = "home" | "edit";

/** A provider listed on the home page. */
type AddedProviderRow = {
  id: string;
  label: string;
  iconSvg: string | undefined;
  custom: boolean;
  /** Built-ins only — custom providers carry no live verification state. */
  connected: boolean;
  /** The line under the name: subscription, API key, local or custom. */
  kind: ProviderConnectionKind;
};

/** The catalog key for each row's connection-kind line. */
const CONNECTION_KIND_KEY = {
  subscription: "settings.models.kindSubscription",
  apiKey: "settings.models.kindApiKey",
  plugin: "settings.models.mod.kindPlugin",
  local: "settings.models.kindLocal",
  custom: "settings.models.kindCustom",
} as const satisfies Record<ProviderConnectionKind, string>;

/** The provider a Remove / Delete confirmation is for. */
type DeleteTarget = { id: string; name: string; custom: boolean };

type ProviderStatus = "idle" | "verifying" | "ready" | "draft" | "error";

type TestState =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "ok"; modelCount?: number; verifiedAtMs?: number }
  | { status: "failed"; errorCode?: string };

/**
 * The API-key field's label row. A stored key is said ONCE, as "Saved ✓" at
 * the end of this row — not again in the placeholder and a hint below. And it
 * says "saved", never "verified": the host only knows the last probe with
 * this key succeeded, and "verified" reads as the vendor vouching for it.
 */
function ApiKeyLabel({ saved, testId }: { saved: boolean; testId: string }) {
  const t = useT();
  return (
    <span className="flex items-center justify-between gap-2">
      <span className="font-medium">{t("settings.models.apiKey")}</span>
      {saved ? (
        <span
          className="flex items-center gap-1 text-success text-xs"
          data-testid={testId}
        >
          {t("settings.models.apiKeySaved")}
          <CheckIcon className="size-3.5" />
        </span>
      ) : null}
    </span>
  );
}

/** One row in the "Configured models" list. */
function ModelRow({
  model,
  onEdit,
  onRemove,
}: {
  model: CustomModelDef;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const complete = isModelComplete(model);
  const badges = modelCapabilityBadges(model, {
    tools: t("settings.models.capToolCalling"),
    reasoning: t("settings.models.capReasoning"),
    vision: t("settings.models.capVision"),
    imageGen: t("settings.models.capImageGen"),
    structured: t("settings.models.capStructuredOutput"),
  });
  const summary = complete
    ? [
        t("settings.models.contextLabel", {
          value: formatTokenCount(model.contextWindow),
        }),
        t("settings.models.maxOutputLabel", {
          value: formatTokenCount(model.maxOutputTokens),
        }),
        ...badges,
      ].join(" · ")
    : t("settings.models.modelDetailsRequired");

  return (
    <div
      className="flex items-start gap-2 border-b px-3 py-2 last:border-b-0 hover:bg-accent/30"
      data-testid={`custom-model-row-${model.modelId}`}
    >
      <button
        type="button"
        className="min-w-0 flex-1 cursor-pointer text-left"
        onClick={onEdit}
      >
        <div className="truncate font-medium text-sm">{modelLabel(model)}</div>
        <div className="truncate font-mono text-muted-foreground text-xs">
          {model.modelId}
        </div>
        <div
          className={
            complete
              ? "mt-0.5 truncate text-muted-foreground text-xs"
              : "mt-0.5 truncate text-warning text-xs"
          }
        >
          {summary}
        </div>
      </button>
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={modelLabel(model)}
            data-testid={`custom-model-menu-${model.modelId}`}
          >
            <MoreHorizontalIcon className="size-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-36">
          <button
            type="button"
            className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
            onClick={() => {
              setMenuOpen(false);
              onEdit();
            }}
          >
            {t("settings.models.modelEdit")}
          </button>
          <button
            type="button"
            className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-destructive text-sm hover:bg-accent"
            data-testid={`custom-model-remove-${model.modelId}`}
            onClick={() => {
              setMenuOpen(false);
              onRemove();
            }}
          >
            {t("settings.models.modelRemove")}
          </button>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** One row in the "Pending models" list — a model id with a "+" button. */
function PendingModelRow({
  model,
  onAdd,
}: {
  model: CustomModelDef;
  onAdd: () => void;
}) {
  const t = useT();
  return (
    <div
      className="flex items-center gap-2 border-b px-3 py-1.5 last:border-b-0 hover:bg-accent/30"
      data-testid={`pending-model-row-${model.modelId}`}
    >
      <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground text-xs">
        {model.modelId}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="size-6 shrink-0"
        aria-label={t("settings.models.addModelTitle")}
        data-testid={`pending-model-add-${model.modelId}`}
        onClick={onAdd}
      >
        <PlusIcon className="size-3.5" />
      </Button>
    </div>
  );
}

export function ModelsSection({
  catalog,
  transport,
  onProviderConnected,
  footer,
  openProviderRequest,
}: {
  catalog: BrowserLlmCatalog | null | undefined;
  transport: BrowserBridgeTransport;
  /**
   * Open this provider's editor instead of the home list — the quick
   * picker's "Edit…" on a provider. `seq` changes on every request, so asking
   * for the same provider twice opens it twice.
   */
  openProviderRequest?: { providerId: string; seq: number } | null;
  /**
   * Fired when a connection completes without a `providers.changed` broadcast (OAuth
   * sign-in, which lives in the C++ broker), so the shell refreshes the catalog.
   */
  onProviderConnected?: () => void;
  /**
   * Rendered under the provider list on the home view only, and only once at
   * least one provider is added — the Models page puts Session models here,
   * which has nothing to choose from without a provider. Hidden in the
   * editor, which is a page of its own about one provider.
   */
  footer?: React.ReactNode;
}) {
  const t = useT();
  const locale = useLocale();
  const bridge = useSettingsBridge();
  const [configs, setConfigs] = React.useState<
    Record<string, NexusProviderConfig>
  >({});
  const [activeProviderId, setActiveProviderId] = React.useState<
    string | undefined
  >(undefined);
  const [view, setView] = React.useState<PageView>("home");
  /** The user's provider order (settings.json `providers.order`). */
  const [order, setOrder] = React.useState<string[]>([]);
  /**
   * The home list's order WHILE a row is dragged — rows move live under the
   * pointer, and nothing is written until the drop. `null` when idle.
   */
  const [dragPreview, setDragPreview] = React.useState<string[] | null>(null);
  const [draggingId, setDraggingId] = React.useState<string | null>(null);
  /**
   * The drag in flight, for the HANDLERS. State drives the rendering, but a
   * pointermove can arrive before React has re-rendered from the pointerdown
   * (events dispatched back to back — the e2e does exactly that), and a
   * handler reading state would still see "not dragging" and drop the move.
   */
  const dragRef = React.useRef<{
    id: string;
    /** The order at the press: a release on it writes nothing. */
    start: string[];
    preview: string[];
    /** The row the last move swapped with, until the pointer is over the dragged row again. */
    passed: string | null;
    /** Removes the drag's window listeners. */
    detach: () => void;
  } | null>(null);
  React.useEffect(() => () => dragRef.current?.detach(), []);
  /**
   * An arrow-key reorder not yet written (see `KEYBOARD_REORDER_COMMIT_MS`):
   * the order at the gesture's first key, the order to write, and the timer
   * that writes it.
   */
  const keyboardOrderRef = React.useRef<{
    start: string[];
    order: string[];
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  /** Orders written here whose echo has not arrived (`settleEchoedOrder`). */
  const unechoedOrdersRef = React.useRef<string[][]>([]);
  /** The latest `writeOrder` / `flushKeyboardOrder`, for the reorder timer
   *  and the unmount flush, which outlive the render that armed them. */
  const writeOrderRef = React.useRef<(order: string[]) => void>(() => {});
  const flushKeyboardOrderRef = React.useRef<() => void>(() => {});
  // Leaving the page mid-gesture still writes the order the list shows.
  React.useEffect(() => () => flushKeyboardOrderRef.current(), []);
  /**
   * Orders `providers.list` reads against `providers.changed` — a read that
   * saw an event land while it was in flight is dropped
   * (`createProvidersReadGate`).
   */
  const providersReadGate = React.useMemo(() => createProvidersReadGate(), []);
  /** The provider the editor is open on; `""` on the home view. */
  const [selectedId, setSelectedId] = React.useState<string>("");
  /** True once `providers.list` has answered (successfully or not). */
  const [configsLoaded, setConfigsLoaded] = React.useState(false);
  const [form, setForm] = React.useState<NexusProviderConfig>({});
  const [saving, setSaving] = React.useState(false);
  // Verify error code (set by `providerAuth.verify`); drives the "error"
  // status state + the reset-confirm dialog.
  const [verifyError, setVerifyError] = React.useState<string | null>(null);
  const [resetOpen, setResetOpen] = React.useState(false);
  // Provider registry (authMode/type/OAuth state) from the C++ guest route —
  // the bits settings.json doesn't carry. Empty when the route is unavailable,
  // in which case gating degrades to "show both fields" (graceful).
  const [registry, setRegistry] = React.useState<
    Record<string, ProviderAuthProviderInfo>
  >({});
  const [registryLoaded, setRegistryLoaded] = React.useState(false);
  // OAuth device-code scratch state for the in-progress sign-in.
  const [oauth, setOAuth] = React.useState<{
    busy: boolean;
    userCode?: string;
    verificationUri?: string;
  }>({ busy: false });

  // ── Custom-provider editor state ──────────────────────────────────────────
  const [creating, setCreating] = React.useState(false);
  const [createPreset, setCreatePreset] = React.useState<CreatePreset>("blank");
  const [draft, setDraft] = React.useState<CustomProviderDraft>(
    emptyCustomProviderDraft,
  );
  const [testState, setTestState] = React.useState<TestState>({
    status: "idle",
  });
  const [addModelOpen, setAddModelOpen] = React.useState(false);
  const [editingModel, setEditingModel] = React.useState<CustomModelDef | null>(
    null,
  );
  /** Model being promoted from the pending list via the "+" button. */
  const [pendingModel, setPendingModel] = React.useState<CustomModelDef | null>(
    null,
  );
  /**
   * Ephemeral list of model ids discovered from the endpoint. NOT persisted —
   * only models the user explicitly configures via the "+" → Add Model dialog
   * end up in `draft.models` (and thus settings.json).
   */
  const [discoveredIds, setDiscoveredIds] = React.useState<string[]>([]);
  const [deleteTarget, setDeleteTarget] = React.useState<DeleteTarget | null>(
    null,
  );
  // A dirty custom draft is blocking the way back to home.
  const [leaveConfirmOpen, setLeaveConfirmOpen] = React.useState(false);
  const [addedNotice, setAddedNotice] = React.useState<string | null>(null);
  const [nameError, setNameError] = React.useState<string | null>(null);

  // Re-entrancy guard for the auto-connect debounce (see `save`), and a ref to
  // the latest `save` closure so the debounce effect — declared before the
  // early `!bridge` return — can call it without listing it as a dependency.
  const savingRef = React.useRef(false);
  const saveRef = React.useRef<() => void | Promise<void>>(() => {});

  // The trust value this page last WROTE for the selected provider, and its id.
  // Snapshots arrive unordered, so this pins the trust field of every snapshot for
  // that provider and is the baseline the URL derivation compares against. Written
  // only by `saveTrust`; cleared on a provider switch or reset; never released on
  // confirmation (a stale snapshot can still follow).
  const enforcedTrust = React.useRef<{
    providerId: string;
    trust: ProviderTrust | undefined;
  } | null>(null);
  const pinEnforcedTrust = React.useCallback(
    (
      map: Record<string, NexusProviderConfig>,
    ): Record<string, NexusProviderConfig> => {
      const pinned = enforcedTrust.current;
      if (!pinned) return map;
      const config = map[pinned.providerId];
      if (!config || config.trust === pinned.trust) return map;
      return {
        ...map,
        [pinned.providerId]: { ...config, trust: pinned.trust },
      };
    },
    [],
  );

  const providers = React.useMemo<BrowserLlmProvider[]>(
    () => catalog?.providers ?? [],
    [catalog],
  );

  const customRecords = React.useMemo(
    () => listCustomProviderRecords(configs),
    [configs],
  );
  const customIds = React.useMemo(
    () => new Set(customRecords.map((r) => r.id)),
    [customRecords],
  );
  const selectedRecord = React.useMemo(
    () => customRecords.find((r) => r.id === selectedId),
    [customRecords, selectedId],
  );
  const isCustomSelection = creating || !!selectedRecord;

  const reload = React.useCallback(async () => {
    if (!bridge) return;
    try {
      const result = await providersReadGate.read(bridge);
      // `null`: a `providers.changed` landed while the read was in flight and
      // already applied a state at least as new — this answer may be older.
      if (!result) return;
      setConfigs(pinEnforcedTrust(result.configs));
      setActiveProviderId(result.activeProviderId);
      setOrder(result.order ?? []);
    } finally {
      // Flipped even on failure: the initial-selection effect waits on this,
      // and a failed list must degrade to "pick the first provider", not to a
      // page stuck with nothing selected.
      setConfigsLoaded(true);
    }
  }, [bridge, pinEnforcedTrust, providersReadGate]);

  const loadRegistry = React.useCallback(async () => {
    try {
      const res = await providerAuthList(transport);
      const map: Record<string, ProviderAuthProviderInfo> = {};
      for (const p of res.providers ?? []) map[p.id] = p;
      setRegistry(map);
    } catch {
      /* route not in this binary — leave empty (no gating) */
    } finally {
      setRegistryLoaded(true);
    }
  }, [transport]);

  React.useEffect(() => {
    void loadRegistry();
  }, [loadRegistry]);

  React.useEffect(() => {
    void reload();
    if (!bridge) return;
    return bridge.subscribeEvents((envelope) => {
      if (isProvidersChangedEvent(envelope)) {
        providersReadGate.noteChanged();
        const payload = envelope.payload as {
          configs?: Record<string, NexusProviderConfig>;
          activeProviderId?: string;
          order?: string[];
        };
        if (payload.configs) setConfigs(pinEnforcedTrust(payload.configs));
        setActiveProviderId(payload.activeProviderId);
        // An arrow-key reorder still waiting to be written stays on screen,
        // and so does a newer order already written: the event describes
        // the order before either.
        if (Array.isArray(payload.order)) {
          const current = settleEchoedOrder(unechoedOrdersRef.current, payload.order);
          if (current && !keyboardOrderRef.current) setOrder(payload.order);
        }
      }
    });
  }, [bridge, reload, pinEnforcedTrust, providersReadGate]);

  /**
   * Built-in providers shown in the first dropdown group. The two `custom-*`
   * backend ids never appear here: with the custom-provider feature they are
   * EXECUTION SLOTS (see `config/customProviderRegistry.ts`), not user-facing
   * providers — "+ Add custom provider…" replaced the old "Custom endpoint"
   * row.
   */
  const builtInProviders = React.useMemo(
    () =>
      providers.filter((p) => !isCustomBackendId(p.id) && !customIds.has(p.id)),
    [providers, customIds],
  );

  // Home view: the providers the user has added (built-ins first, in catalog
  // order, then custom providers), and the built-ins the "Add provider"
  // dropdown still offers. No provider is selected until the user opens one —
  // selecting on load would run the custom editor's discovery probe, and the
  // built-in editor's seeding, for a provider nobody is looking at.
  // A provider a plugin adds is ADDED by its own rule (a key, a sign-in, the
  // keyless mode, or a kept entry whose plugin is gone); a built-in by the
  // broker's evidence too.
  const isProviderAdded = React.useCallback(
    (p: BrowserLlmProvider) =>
      p.mod
        ? p.mod.state === "plugin-missing" || isModProviderAdded(configs[p.id])
        : isBuiltInProviderAdded(configs[p.id], registry[p.id]),
    [configs, registry],
  );
  const addedRows = React.useMemo<AddedProviderRow[]>(
    () => [
      ...builtInProviders
        .filter((p) => isProviderAdded(p))
        .map((p) => ({
          id: p.id,
          label: p.mod ? modProviderName(p, locale) : p.label,
          iconSvg: p.iconSvg,
          custom: false,
          connected: p.mod
            ? isModProviderConnected(configs[p.id])
            : isBuiltInProviderConnected(configs[p.id], registry[p.id]),
          kind: p.mod ? ("plugin" as const) : providerConnectionKind(registry[p.id], false),
        })),
      ...customRecords.map((record) => ({
        id: record.id,
        label: record.displayName,
        iconSvg: resolveCustomProviderIconSvg(record.providerIcon, catalog),
        custom: true,
        connected: false,
        kind: providerConnectionKind(undefined, true),
      })),
    ],
    [builtInProviders, customRecords, configs, registry, catalog, locale, isProviderAdded],
  );
  const orderedRows = React.useMemo(
    () => orderByProviderIds(addedRows, dragPreview ?? order),
    [addedRows, dragPreview, order],
  );

  // Each row's model count: the quick picker's models for the provider,
  // checked against the provider's listing as fetched EACH TIME the home page
  // shows (the settings page opening, or the way back from an editor). A
  // settings change re-counts at once from the updated catalog. Red needs a
  // fresh, non-empty listing that holds none of the models
  // (settings/providerModelAvailability.ts).
  const [freshModelIds, setFreshModelIds] = React.useState<
    Record<string, FreshModelIds>
  >({});
  const addedIdsKey = addedRows.map((row) => row.id).join("\n");
  React.useEffect(() => {
    if (view !== "home" || !bridge || !configsLoaded || !addedIdsKey) return;
    let cancelled = false;
    for (const id of addedIdsKey.split("\n")) {
      void providersFreshModelIds(bridge, id)
        .catch(
          (error): FreshModelIds => ({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        )
        .then((fresh) => {
          if (!cancelled) setFreshModelIds((prev) => ({ ...prev, [id]: fresh }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [view, bridge, configsLoaded, addedIdsKey]);
  const addableBuiltIns = React.useMemo(
    () => builtInProviders.filter((p) => !isProviderAdded(p)),
    [builtInProviders, isProviderAdded],
  );
  // Gateways (OpenRouter, Vercel AI Gateway — one key, many vendors' models)
  // get their own section of the add menu, apart from the single-vendor ones.
  const addableVendors = React.useMemo(
    () => addableBuiltIns.filter((p) => !p.mod && !isRuntimeOnlyProvider(p.id)),
    [addableBuiltIns],
  );
  // Providers plugins add (drawn from the catalog row alone).
  const addablePlugins = React.useMemo(
    () => addableBuiltIns.filter((p) => p.mod?.state === "ready"),
    [addableBuiltIns],
  );
  const addableGateways = React.useMemo(
    () => addableBuiltIns.filter((p) => !p.mod && isRuntimeOnlyProvider(p.id)),
    [addableBuiltIns],
  );

  // Seed the editor from the selected provider's stored config — except while the
  // user has an UNSAVED base URL in the field (a write's broadcast would snap it back).
  const formRef = React.useRef(form);
  formRef.current = form;
  const seededProviderId = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!selectedId) return;
    const switching = seededProviderId.current !== selectedId;
    seededProviderId.current = selectedId;
    // A different provider's stored value is the only truth we hold for it.
    if (switching && enforcedTrust.current?.providerId !== selectedId) {
      enforcedTrust.current = null;
    }
    // Decided inside the updater, against the LATEST queued form — not
    // `formRef`, which only moves on render. A `providers.changed` render can
    // commit, a URL keystroke then queue its new form, and only afterwards
    // React flush this effect for the earlier render: `formRef` still holds
    // the old URL there, the edit looked unmade, and the stored URL was queued
    // on top of the one just typed.
    const stored = configs[selectedId];
    setForm((prev) => {
      const urlEdited = (prev.baseUrl ?? "") !== (stored?.baseUrl ?? "");
      return !switching && urlEdited ? prev : (stored ?? {});
    });
  }, [selectedId, configs]);

  // Seed the custom draft whenever the selected custom provider changes. Keyed
  // on the id (not the record object) so a `providers.changed` broadcast that
  // re-creates an equivalent record does not clobber in-progress edits.
  const seededRecordId = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (creating) return;
    if (!selectedRecord) {
      seededRecordId.current = null;
      return;
    }
    if (seededRecordId.current === selectedRecord.id) return;
    seededRecordId.current = selectedRecord.id;
    setDraft(draftFromRecord(selectedRecord));
    setTestState({ status: "idle" });
    setNameError(null);
  }, [creating, selectedRecord]);

  // Reset transient per-provider UI state on provider switch — without this a
  // verify error or an in-flight OAuth sign-in from one provider bleeds into
  // the next (e.g. the new provider opens already showing the prior error).
  React.useEffect(() => {
    setVerifyError(null);
    setOAuth({ busy: false });
  }, [selectedId]);

  // Auto-dismiss the "<name> added." confirmation.
  React.useEffect(() => {
    if (!addedNotice) return;
    const timer = window.setTimeout(
      () => setAddedNotice(null),
      ADDED_NOTICE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [addedNotice]);

  // Auto-connect: once the form settles on a state worth verifying, debounce and run
  // the verify+persist `save` flow. Custom providers save explicitly instead.
  React.useEffect(() => {
    if (!bridge) return;
    if (isCustomSelection) return;
    const { isOAuth, requiresApiKey } = deriveProviderGating(
      registry[selectedId],
      selectedId,
    );
    if (
      !shouldAutoConnect({
        form,
        saved: configs[selectedId],
        isOAuth,
        requiresApiKey,
        providerId: selectedId,
      })
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      void saveRef.current();
    }, AUTO_CONNECT_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [bridge, selectedId, form, configs, registry, isCustomSelection]);

  // Auto-discover pending models when the custom-provider editor is shown with
  // a valid base URL. Ephemeral — populates `discoveredIds` only; nothing is
  // persisted until the user promotes a model via the "+" → Add Model dialog.
  // Declared before the early `!bridge` return; uses a ref to reach the
  // `fetchModelIds` helper defined later in the body.
  const fetchModelIdsRef = React.useRef<
    (verifyRes: { models?: Array<{ id: string }>; modelCount?: number }) =>
      Promise<string[]>
  >(async () => []);
  React.useEffect(() => {
    // Reset the pending list whenever the provider / base URL changes.
    setDiscoveredIds([]);
    if (!isCustomSelection) return;
    if (!isValidBaseUrl(draft.baseUrl)) return;
    let cancelled = false;
    void (async () => {
      try {
        const backendId = backendIdForCompatibility(draft.apiCompatibility);
        const key = customProbeKey(draft, selectedRecord);
        const res = await providerAuthVerify(
          transport,
          backendId,
          {
            api_key: key.apiKey,
            base_url: normaliseBaseUrl(draft.baseUrl),
            // Always sent: the shared backend slot may still hold another
            // provider's User-Agent. '' = the host default.
            user_agent: customProviderUserAgent(draft.baseUrl) ?? "",
          },
          key.keyProviderId,
        );
        if (cancelled) return;
        if (!res.success) return;
        const ids = await fetchModelIdsRef.current(res);
        if (!cancelled) setDiscoveredIds(ids);
      } catch {
        /* endpoint unreachable — leave the pending list empty */
      }
    })();
    return () => {
      cancelled = true;
    };
    // Re-run only when the provider or its connection params change, NOT on
    // every keystroke (draft object identity changes each render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCustomSelection, selectedId, draft.baseUrl, draft.apiCompatibility, transport]);

  // The quick picker's "Edit…" lands on that provider's editor (what
  // `openProvider` does; above the early return, so hook order holds).
  const handledOpenRequest = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!openProviderRequest || handledOpenRequest.current === openProviderRequest.seq) return;
    handledOpenRequest.current = openProviderRequest.seq;
    setCreating(false);
    seededRecordId.current = null;
    setSelectedId(openProviderRequest.providerId);
    setView("edit");
  }, [openProviderRequest]);

  const [addMenuOpen, setAddMenuOpen] = React.useState(false);
  const [highlightAddMenu, setHighlightAddMenu] = React.useState(false);
  const guidedEmptyProviders = React.useRef(false);
  React.useEffect(() => {
    if (!configsLoaded || !registryLoaded || !catalog || view !== "home" || openProviderRequest) return;
    if (guidedEmptyProviders.current || addedRows.length > 0 || catalog.providers.some((p) => p.enabled)) return;
    guidedEmptyProviders.current = true;
    setHighlightAddMenu(true);
    setAddMenuOpen(true);
  }, [configsLoaded, registryLoaded, catalog, view, openProviderRequest, addedRows.length]);

  // A half-filled provider form — a built-in's key / URL, or a custom
  // provider's draft — lives only in this page: hold the background
  // updater's reload while the open editor is dirty (glic/unsavedEditsGate.ts).
  // Above the early return, so hook order holds.
  useUnsavedEditsGate(
    view === "edit" &&
      (isCustomSelection
        ? isCustomDraftDirty(
            draft,
            creating ? undefined : selectedRecord,
            creating ? createPresetDraft(createPreset) : undefined,
          )
        : isProviderFormDirty(form, configs[selectedId])),
  );

  if (!bridge) {
    return (
      <SettingsSubpageLayout title={t("settings.models.title")}>
        <p className="text-muted-foreground text-sm">
          {t("settings.bridgeUnavailable")}
        </p>
      </SettingsSubpageLayout>
    );
  }

  const selectedProvider = providers.find((p) => p.id === selectedId);
  const saved = configs[selectedId];
  const dirty = isProviderFormDirty(form, saved);

  // ── Custom-provider derived state ─────────────────────────────────────────
  const builtInLabels = new Map(builtInProviders.map((p) => [p.id, p.label]));
  const draftNameTaken = isProviderNameTaken(
    draft.displayName,
    configs,
    builtInLabels,
    creating ? undefined : selectedRecord?.id,
  );
  const customDirty =
    isCustomSelection &&
    isCustomDraftDirty(
      draft,
      creating ? undefined : selectedRecord,
      creating ? createPresetDraft(createPreset) : undefined,
    );
  const canSubmitCustom = canSubmitCustomProvider({
    displayName: draft.displayName,
    nameTaken: draftNameTaken,
    baseUrl: draft.baseUrl,
    models: draft.models,
    defaultModelId: draft.defaultModel,
  });
  const completeModels = draft.models.filter(isModelComplete);
  /**
   * Ephemeral "Pending models": discovered ids not yet COMPLETE-configured. Never
   * persisted — only a model promoted via the Add Model dialog lands in settings.json.
   */
  const pendingModels = React.useMemo(() => {
    const configured = new Set(completeModels.map((m) => m.modelId));
    return discoveredIds
      .filter((id) => !configured.has(id))
      .map((id) => ({ modelId: id, incomplete: true } as CustomModelDef));
  }, [discoveredIds, completeModels]);
  const customBackendId = backendIdForCompatibility(draft.apiCompatibility);

  // Registry-driven field gating + OAuth state. Defaults (no registry) show
  // both fields, matching the pre-extension behavior. Shared with the
  // auto-connect effect above via `deriveProviderGating`.
  const info = registry[selectedId];
  const { isOAuth, supportsBaseUrl, supportsApiKey } = deriveProviderGating(
    info,
    selectedId,
  );
  const oauthConnected = !!info?.connected;
  // A key is stored for this provider — in settings.json or only in the
  // broker pref (launch prefs / the legacy path).
  const hasStoredKey = !!(saved?.hasApiKey || info?.hasStoredApiKey);
  const secretFields = providerSecretFields(selectedId);
  // Provider note — mirrors the original `getProviderNote_` (the Ollama hint).
  const providerNote =
    info?.note ??
    (info?.type === "local" ? t("settings.models.localNote") : undefined);

  const status: ProviderStatus = verifyError
    ? "error"
    : saving || oauth.busy
      ? "verifying"
      : isOAuth
        ? oauthConnected
          ? "ready"
          : "idle"
        : dirty && (form.apiKey || saved?.hasApiKey)
          ? "draft"
          : // The broker (registry `info`) is the authority: a provider's config
            // can live in the broker pref without a settings.json mirror.
            saved?.lastVerification || info?.isVerified
            ? "ready"
            : saved?.hasApiKey || info?.hasStoredApiKey
              ? "draft"
              : "idle";

  const modelCount =
    saved?.modelEntries?.length ??
    saved?.enabledModels?.length ??
    info?.enabledModels?.length ??
    selectedProvider?.models.length ??
    0;

  // Status-card presentation — strings match the original grd defaults exactly.
  const STATUS_PRESENTATION: Record<
    ProviderStatus,
    {
      chip: string;
      chipVariant: "info" | "success" | "warning" | "muted" | "destructive";
      title: string;
      detail: string;
    }
  > = {
    verifying: {
      chip: t("settings.models.chipConnecting"),
      chipVariant: "info",
      title: t("settings.models.titleConnecting"),
      detail: t("settings.models.detailConnecting"),
    },
    ready: {
      chip: t("settings.models.chipConnected"),
      chipVariant: "success",
      title: t("settings.models.titleConnected"),
      detail:
        modelCount > 0
          ? t("settings.models.modelsFound", {
              count: modelCount,
              unit: t(
                modelCount === 1
                  ? "settings.models.unitModel"
                  : "settings.models.unitModels",
              ),
            })
          : t("settings.models.detailReady"),
    },
    draft: {
      chip: t("settings.models.chipPending"),
      chipVariant: "warning",
      title: t("settings.models.titleVerification"),
      detail: t("settings.models.detailVerify"),
    },
    idle: {
      chip: t("settings.models.chipNotConfigured"),
      chipVariant: "muted",
      title: t("settings.models.titleNoProvider"),
      detail: selectedId
        ? t("settings.models.detailAdditionalSetup")
        : t("settings.models.detailSelectProvider"),
    },
    error: {
      chip: t("settings.models.chipFailed"),
      chipVariant: "destructive",
      title: t("settings.models.titleFailed"),
      detail: mapErrorCode(t, verifyError),
    },
  };
  const present = STATUS_PRESENTATION[status];

  const save = async () => {
    if (!selectedId) return;
    // Re-entrancy guard: the auto-connect debounce can fire again while a
    // previous probe is still in flight (the user kept typing). A second
    // overlapping verify+persist would race the `saved` reload and could
    // resurrect a stale state, so skip while one is running.
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setVerifyError(null);
    try {
      // A provider verified in the runtime — a runtime-only gateway, or a
      // built-in on its ModelProvider (openai, anthropic, kimi) — has its key
      // probed there, and the probe sends the STORED key, host-substituted:
      // the runtime never holds the plaintext. So the key is stored first
      // (save, then verify). On success the
      // runtime stamps the verification (and a gateway picks its first
      // models); a failed probe leaves the key stored but unverified — the
      // state a host without the verify route leaves a native provider in.
      if (verifiesInRuntime(selectedId)) {
        await providersUpsert(
          bridge,
          selectedId,
          mergeProviderConfigForSave({ form, saved, providerId: selectedId, verifiedAtMs: undefined }),
        );
        const res = await providersVerify(bridge, selectedId);
        if (!res.ok) {
          setVerifyError(res.errorCode);
          await reload();
          return;
        }
        await providersSetActive(bridge, selectedId).catch(() => {});
        await reload();
        return;
      }
      // Live verify probe (providerAuth.verify) — a transient connection test
      // that does NOT write prefs. Build-gated: if the route is unavailable,
      // persist unverified (the broker uses the key on the next request once
      // published).
      let verifiedAtMs: number | undefined;
      try {
        const res = await providerAuthVerify(transport, selectedId, {
          api_key: form.apiKey ?? "",
          base_url: form.baseUrl ?? "",
        });
        if (!res.success) {
          setVerifyError(res.errorCode ?? "system_unexpected");
          return;
        }
        verifiedAtMs = res.verifiedAtMs;
      } catch {
        /* verify route not in this binary yet — persist unverified */
      }
      // Persist with correct verification state — fresh stamp on a successful
      // verify, drop a stale one when the key changed but couldn't be verified
      // (see mergeProviderConfigForSave). Guards the "Connected" stale-state.
      const next = mergeProviderConfigForSave({
        form,
        saved,
        providerId: selectedId,
        verifiedAtMs,
      });
      await providersUpsert(bridge, selectedId, next);
      // Make the just-configured provider the active/default one so the quick
      // model picker (and new sessions) default to it with its highest model.
      // Best-effort: a setActive failure must not undo the persisted config.
      await providersSetActive(bridge, selectedId).catch(() => {
        /* provider not yet visible to the worker — adapter auto-promote on
           the upsert above is the fallback */
      });
      await reload();
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  // Keep the debounce effect (declared before the early return) pointed at the
  // latest `save` closure.
  saveRef.current = save;

  /**
   * Persist the trust toggle IMMEDIATELY, on its own: the auto-connect gate needs a
   * typed key, which the WebUI never holds for a connected provider. No probe runs.
   * An empty `apiKey` is stripped (`""` would clear the stored key).
   */
  const saveTrust = async (
    trust: ProviderTrust | undefined,
    base?: NexusProviderConfig,
  ) => {
    if (!selectedId) return;
    // `base` is the caller's own view of the form, and the URL path MUST pass
    // it: `onBaseUrlChange` calls this in the same tick as its `setForm`, so
    // neither the captured `form` nor `formRef` has the just-typed URL yet,
    // and writing either one back would undo the edit that triggered the save.
    const current = base ?? formRef.current;
    setForm({ ...current, trust });
    // Security: persist the trust against the STORED endpoint, never a half-typed URL
    // from the form. Recorded BEFORE the await so a second edit compares against it.
    enforcedTrust.current = { providerId: selectedId, trust };
    const payload: NexusProviderConfig = { ...current, trust };
    if (saved?.baseUrl === undefined) delete payload.baseUrl;
    else payload.baseUrl = saved.baseUrl;
    // Nor the key being typed, nor its verification. A key in the form has not
    // been probed yet; carrying it here stored an unverified key under the
    // OLD `lastVerification`, so the provider read "Connected" for a key
    // nobody validated — the stale state `mergeProviderConfigForSave` guards
    // on the credential path. An absent `apiKey` tells the adapter to keep the
    // stored one (`""` would clear it); the typed key still saves through the
    // auto-connect debounce, behind a probe.
    delete payload.apiKey;
    if (saved?.lastVerification === undefined) delete payload.lastVerification;
    else payload.lastVerification = saved.lastVerification;
    await providersUpsert(bridge, selectedId, payload);
    await reload();
  };

  /**
   * Store (or, with `""`, remove) one of the provider's extra credentials
   * (`ProviderDefinition.secrets`). Written against the STORED config, like
   * `saveTrust`: a half-typed base URL or an unprobed key in the form must
   * not ride along. Then the usage is re-read at once — the secret's whole
   * point (OpenRouter's account balance) shows there.
   */
  const saveSecret = async (name: string, value: string) => {
    if (!selectedId) return;
    const { hasApiKey: _flag, storedSecrets: _names, ...stored } = saved ?? {};
    await providersUpsert(bridge, selectedId, { ...stored, secrets: { [name]: value } });
    await reload();
    getProviderUsageStore().refresh(selectedId, true);
  };

  /**
   * A base URL edit re-derives the checkbox and PERSISTS the flip (only when it
   * flips), writing the marker only — never the half-typed URL (`saveTrust`).
   */
  const onBaseUrlChange = (baseUrl: string) => {
    if (!selectedId) return;
    const next = withDerivedTrust(form, baseUrl);
    setForm(next);
    // Persist only for a provider that HAS a stored config: that is the case
    // where the two can diverge (the box moves, disk keeps the old answer, and
    // disk is what a teammate spawn reads). During first-time setup there is
    // nothing on disk to diverge from, and the eventual connect carries the
    // derived value with the rest of the form — writing a bare trust marker
    // there would create a keyless config mid-typing.
    if (!saved) return;
    // The baseline is what we last ENFORCED, falling back to the stored
    // config — never `form`, which an out-of-order snapshot can have put back
    // to a superseded value (see `enforcedTrust`). Comparing against a stale
    // baseline is how the flip was silently skipped: the box re-derived and
    // ticked while settings.json kept the old answer.
    const enforced = enforcedTrust.current;
    const before =
      enforced?.providerId === selectedId && enforced.trust
        ? enforced.trust
        : resolveProviderTrust({ configs: { [selectedId]: saved } }, selectedId);
    if (next.trust === before) return;
    // Security: the marker is written against the STORED base URL, so a 'trusted'
    // derived from a TYPED vendor URL over a stored relay waits for the URL's own
    // save (else a teammate on the relay runs unrestricted); the pin is dropped.
    if (
      next.trust === "trusted" &&
      defaultProviderTrust(
        { configs: { [selectedId]: { ...saved, trust: undefined } } },
        selectedId,
      ) !== "trusted"
    ) {
      if (enforced?.providerId === selectedId) enforcedTrust.current = null;
      return;
    }
    void saveTrust(next.trust, next);
  };

  /**
   * The form with a new base URL and the official-connection box re-derived from
   * THAT URL's domain; the user's override stands until the URL changes again.
   */
  const withDerivedTrust = (
    current: NexusProviderConfig,
    baseUrl: string,
  ): NexusProviderConfig => {
    if (!selectedId) return { ...current, baseUrl };
    const derived = defaultProviderTrust(
      { configs: { [selectedId]: { ...current, baseUrl, trust: undefined } } },
      selectedId,
    );
    return { ...current, baseUrl, trust: derived };
  };

  /**
   * "Official connection", showing the RESOLVED trust value. Unticked = a relay or
   * gateway is in between, and anything a teammate spawned here reads is uploaded to
   * that operator.
   */
  const officialConnectionCheckbox = selectedId ? (
    <label className="flex shrink-0 items-center gap-2 text-sm whitespace-nowrap">
      <input
        type="checkbox"
        className="size-4 accent-primary"
        data-testid="models-trust-official"
        checked={
          resolveProviderTrust({ configs: { [selectedId]: form } }, selectedId) ===
          "trusted"
        }
        onChange={(e) =>
          void saveTrust(e.target.checked ? "trusted" : "untrusted")
        }
      />
      <span>{t("settings.models.trustOfficial")}</span>
    </label>
  ) : null;

  const doReset = async () => {
    if (!selectedId) return;
    setResetOpen(false);
    // Clear the C++ keychain/verified state too (best-effort; build-gated).
    await providerAuthReset(transport, selectedId).catch(() => {
      /* route not in this binary yet — settings.json reset below still runs */
    });
    await providersRemove(bridge, selectedId);
    // The stored config is gone, so there is nothing left to enforce. Keeping
    // the pin would re-apply the PRE-RESET trust to the reconnected config —
    // which carries no marker and resolves to the derived default — so the box
    // would show the choice the reset was supposed to drop, the next save
    // would carry it back to disk, and the URL derivation would compare
    // against it and skip its write.
    enforcedTrust.current = null;
    setForm({});
    setVerifyError(null);
    await reload();
    await loadRegistry();
  };

  // OAuth sign-in: begin the device-code flow, surface the user-code +
  // verification URI, then poll until connected (or give up after ~2 min).
  const signIn = async () => {
    if (!selectedId) return;
    setVerifyError(null);
    setOAuth({ busy: true });
    try {
      const res = await providerAuthBeginOAuth(transport, selectedId);
      if (!res.success) {
        setOAuth({ busy: false });
        setVerifyError(res.error ?? "system_unexpected");
        return;
      }
      setOAuth({
        busy: true,
        userCode: res.userCode,
        verificationUri: res.verificationUri,
      });
      const deadline = Date.now() + 120_000;
      const poll = async (): Promise<void> => {
        if (Date.now() > deadline) {
          setOAuth({ busy: false });
          return;
        }
        try {
          const st = await providerAuthOAuthStatus(transport, selectedId);
          if (st.connected) {
            setOAuth({ busy: false });
            setAddedNotice(
              t("signIn.toast", {
                name: selectedProvider?.mod
                  ? modProviderName(selectedProvider, locale)
                  : (selectedProvider?.label ?? selectedId),
              }),
            );
            await loadRegistry();
            await reload();
            // OAuth connection state lives in the C++ broker, not settings.json,
            // so nothing broadcast `providers.changed` — tell the shell to
            // refresh its model catalog directly, otherwise the quick model
            // picker keeps serving its stale catalog (missing this provider)
            // until an unrelated focus/visibility event fires.
            onProviderConnected?.();
            return;
          }
        } catch {
          /* transient — keep polling until the deadline */
        }
        window.setTimeout(() => void poll(), 2000);
      };
      window.setTimeout(() => void poll(), 2000);
    } catch {
      setOAuth({ busy: false });
    }
  };

  // ── Custom-provider actions ───────────────────────────────────────────────

  /**
   * Run the transient verify probe against the DRAFT connection, addressed to
   * the backend slot for the chosen dialect. Shared by "Test connection" and
   * "Discover models" — the probe already returns the endpoint's model list.
   */
  const probeCustomEndpoint = async () => {
    const key = customProbeKey(draft, selectedRecord);
    return providerAuthVerify(
      transport,
      customBackendId,
      {
        api_key: key.apiKey,
        base_url: normaliseBaseUrl(draft.baseUrl),
        user_agent: customProviderUserAgent(draft.baseUrl) ?? "",
      },
      key.keyProviderId,
    );
  };

  /**
   * Fetch model ids from the endpoint. Tries `res.models` from the verify
   * result first; if the bridge stripped the array, falls back to
   * `providerAuth.refresh` with the actual provider id, then the backend
   * slot id. Returns whatever ids we could get.
   */
  const fetchModelIds = async (
    verifyRes: { models?: Array<{ id: string }>; modelCount?: number },
  ): Promise<string[]> => {
    let ids = (verifyRes.models ?? []).map((m) => m.id).filter(Boolean);
    if (ids.length > 0) return ids;
    if ((verifyRes.modelCount ?? 0) === 0) return ids;
    // The bridge may strip the complex `models` array while passing the
    // simple `modelCount`. Try refresh with the actual provider id first
    // (the broker registers existing custom providers under their own id),
    // then the backend slot id as a last resort.
    const candidates = [
      selectedRecord?.id,
      customBackendId,
    ].filter((v): v is string => !!v);
    for (const refreshId of candidates) {
      try {
        const refreshed = await providerAuthRefresh(transport, refreshId);
        ids = (refreshed.models ?? []).map((m) => m.id).filter(Boolean);
        if (ids.length > 0) return ids;
      } catch {
        /* try next candidate */
      }
    }
    return ids;
  };
  fetchModelIdsRef.current = fetchModelIds;

  const testCustomConnection = async () => {
    if (!isValidBaseUrl(draft.baseUrl)) {
      setTestState({ status: "failed", errorCode: "config_invalid_base_url" });
      return;
    }
    setTestState({ status: "testing" });
    try {
      const res = await probeCustomEndpoint();
      if (res.success) {
        setTestState({
          status: "ok",
          modelCount: res.modelCount ?? res.models?.length,
          verifiedAtMs: res.verifiedAtMs,
        });
        const ids = await fetchModelIds(res);
        setDiscoveredIds(ids);
      } else {
        setTestState({ status: "failed", errorCode: res.errorCode });
      }
    } catch {
      setTestState({ status: "failed", errorCode: "network_unreachable" });
    }
  };

  const beginCreate = (preset: CreatePreset) => {
    setCreating(true);
    setCreatePreset(preset);
    seededRecordId.current = null;
    setSelectedId("");
    setDraft(createPresetDraft(preset));
    setTestState({ status: "idle" });
    setNameError(null);
    setView("edit");
  };

  /** Open one provider's editor — a home-page Settings click, or an add. */
  const openProvider = (id: string) => {
    setCreating(false);
    seededRecordId.current = null;
    setSelectedId(id);
    setView("edit");
  };

  /**
   * Back to the home list, dropping whatever the editor held. Clearing the
   * seed refs makes the next open of ANY provider — the same one included —
   * reseed from its stored config instead of resuming a stale form.
   */
  const goHome = () => {
    setLeaveConfirmOpen(false);
    setCreating(false);
    setCreatePreset("blank");
    seededRecordId.current = null;
    seededProviderId.current = null;
    setSelectedId("");
    setForm({});
    setDraft(emptyCustomProviderDraft());
    setTestState({ status: "idle" });
    setNameError(null);
    setView("home");
  };

  /** Editor → home, guarded by the unsaved-changes prompt. */
  const requestBack = () => {
    // An untouched create form has nothing to discard, so only a DIRTY draft
    // (in either mode) raises the prompt.
    if (isCustomSelection && customDirty) {
      setLeaveConfirmOpen(true);
      return;
    }
    goHome();
  };

  /** A pick from the home page's "Add provider" dropdown. */
  const addFromMenu = (value: string) => {
    if (value === ADD_CUSTOM_PROVIDER_VALUE) {
      beginCreate("blank");
      return;
    }
    if (value === ADD_OPENCODE_ZEN_VALUE) {
      beginCreate("opencode-zen");
      return;
    }
    openProvider(value);
  };

  const cancelCreate = goHome;

  const submitCustomProvider = async () => {
    if (!canSubmitCustom || savingRef.current) return;
    // Edit mode without a record would have nowhere to write — belt and
    // braces against a selection that changed under an in-flight click.
    if (!creating && !selectedRecord) return;
    if (draftNameTaken) {
      setNameError(
        t("settings.models.providerNameExists", { name: draft.displayName.trim() }),
      );
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      const providerId = creating
        ? generateCustomProviderId(draft.displayName, Object.keys(configs))
        : selectedRecord!.id;
      const verifiedAtMs =
        testState.status === "ok" ? testState.verifiedAtMs : undefined;
      // A keyless Zen provider stores the anonymous `public` key, as
      // OpenCode sends it — unless a key of its own is already stored.
      const keepsStoredKey = !creating && !!selectedRecord?.hasApiKey;
      const config = configFromDraft(
        keepsStoredKey
          ? draft
          : {
              ...draft,
              apiKey: resolveOpencodeZenApiKey(draft.baseUrl, draft.apiKey),
            },
        providerId,
        verifiedAtMs,
      );
      await providersUpsert(bridge, providerId, config);
      // A newly created provider becomes the active one so new sessions pick
      // it up — same promotion the built-in save path performs.
      if (creating) {
        await providersSetActive(bridge, providerId).catch(() => {
          /* worker hasn't observed the upsert yet — auto-promote covers it */
        });
      }
      await reload();
      setCreating(false);
      seededRecordId.current = providerId;
      setSelectedId(providerId);
      if (creating) {
        setAddedNotice(
          t("settings.models.providerAdded", { name: draft.displayName.trim() }),
        );
      }
      // The catalog the shell holds is built from the host + this settings
      // map; a fresh custom provider only reaches the quick picker once it
      // re-reads it.
      onProviderConnected?.();
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const discardCustomChanges = () => {
    if (creating) {
      cancelCreate();
      return;
    }
    if (selectedRecord) setDraft(draftFromRecord(selectedRecord));
    setTestState({ status: "idle" });
    setNameError(null);
  };

  /**
   * The confirmed Delete (custom) / Remove (built-in). Either way the provider
   * leaves the home list and the page lands there — a deleted provider has no
   * editor left to stay on.
   */
  const confirmDelete = async () => {
    const target = deleteTarget;
    if (!target) return;
    setDeleteTarget(null);
    // Best-effort broker-side cleanup: the keychain / verified state of a
    // built-in. A custom id is unknown to the host, so the route is a no-op
    // there — but it costs nothing and covers a build that DOES know the id
    // natively.
    await providerAuthReset(transport, target.id).catch(() => {
      /* route not in this binary — settings.json removal below still runs */
    });
    await providersRemove(bridge, target.id);
    // The stored config is gone, so there is nothing left to enforce — see
    // `doReset`.
    if (enforcedTrust.current?.providerId === target.id) {
      enforcedTrust.current = null;
    }
    goHome();
    await reload();
    // A built-in's "added" evidence includes the broker's key / verified
    // flags, so the registry must be re-read too or the row would stay.
    if (!target.custom) await loadRegistry();
    onProviderConnected?.();
  };

  const upsertDraftModel = (model: CustomModelDef) => {
    setDraft((prev) => {
      // Promoting a pending model replaces its incomplete entry in place;
      // editing an existing configured model replaces that entry; otherwise
      // it's a brand-new add.
      const replaceId =
        (editingModel ?? pendingModel)?.modelId ?? null;
      const existingIndex = replaceId
        ? prev.models.findIndex((m) => m.modelId === replaceId)
        : -1;
      const models =
        existingIndex >= 0
          ? prev.models.map((m, i) => (i === existingIndex ? model : m))
          : [...prev.models, model];
      // Selecting the first complete model as the default saves the user a
      // step; every later add leaves their choice alone.
      const defaultModel =
        prev.defaultModel && models.some((m) => m.modelId === prev.defaultModel)
          ? prev.defaultModel
          : (models.find(isModelComplete)?.modelId ?? "");
      return { ...prev, models, defaultModel };
    });
    setEditingModel(null);
    setPendingModel(null);
  };

  const removeDraftModel = (modelId: string) => {
    setDraft((prev) => {
      const models = prev.models.filter((m) => m.modelId !== modelId);
      const defaultModel =
        prev.defaultModel === modelId
          ? (models.find(isModelComplete)?.modelId ?? "")
          : prev.defaultModel;
      return { ...prev, models, defaultModel };
    });
  };

  // ── Render ────────────────────────────────────────────────────────────────

  /**
   * Persist a new home-list order. `ids` is what the list shows; ids the
   * stored order names but the list does not (a provider removed for now, a
   * broker entry not loaded yet) are kept after them, so re-adding one puts
   * it back where the user had it. Optimistic: the list moves at once, and a
   * failed write re-reads the stored order rather than leaving a lie up.
   */
  /** `ids` (what the list shows) followed by the stored ids it does not show. */
  const fullOrderFor = (ids: string[]): string[] => [
    ...ids,
    ...order.filter((id) => !ids.includes(id)),
  ];
  const nextOrderFor = (ids: string[]): string[] | null => {
    const next = fullOrderFor(ids);
    return sameOrder(next, order) ? null : next;
  };
  const writeOrder = (next: string[]) => {
    const written = unechoedOrdersRef.current;
    written.push(next);
    if (written.length > MAX_UNECHOED_ORDERS) written.shift();
    void providersSetOrder(bridge, next).catch(() => {
      // Nothing will echo a failed write; the re-read shows the stored order.
      unechoedOrdersRef.current = [];
      void reload();
    });
  };
  const commitOrder = (ids: string[]) => {
    const next = nextOrderFor(ids);
    if (!next) return;
    setOrder(next);
    writeOrder(next);
  };
  /**
   * An arrow-key move: shown at once like `commitOrder`, written once per
   * gesture — when the keys have been still for `KEYBOARD_REORDER_COMMIT_MS`,
   * or the grip loses focus. A gesture that ends where it began writes
   * nothing — with no stored order yet, writing would freeze today's order.
   * `shown` is the list before this key's move.
   */
  const flushKeyboardOrder = () => {
    const pending = keyboardOrderRef.current;
    if (!pending) return;
    clearTimeout(pending.timer);
    keyboardOrderRef.current = null;
    if (!sameOrder(pending.order, pending.start)) writeOrderRef.current(pending.order);
  };
  const stageKeyboardOrder = (shown: string[], ids: string[]) => {
    const next = nextOrderFor(ids);
    if (!next) return;
    setOrder(next);
    const pending = keyboardOrderRef.current;
    if (pending) clearTimeout(pending.timer);
    keyboardOrderRef.current = {
      start: pending?.start ?? fullOrderFor(shown),
      order: next,
      timer: setTimeout(() => flushKeyboardOrderRef.current(), KEYBOARD_REORDER_COMMIT_MS),
    };
  };
  /**
   * "Set as default" from a row's menu — the same `setActive` a save in the
   * editor performs, without making the user open the editor to reach it.
   * Optimistic like `commitOrder`; the re-read settles either outcome.
   */
  const makeDefault = (id: string) => {
    setActiveProviderId(id);
    void providersSetActive(bridge, id)
      .catch(() => {
        /* the re-read below puts the stored default back */
      })
      .then(() => reload());
  };

  /** For the drag's window listeners, which outlive the render that added them. */
  const commitOrderRef = React.useRef(commitOrder);
  commitOrderRef.current = commitOrder;
  writeOrderRef.current = writeOrder;
  flushKeyboardOrderRef.current = flushKeyboardOrder;

  /** `ids` with `moving` placed where `target` is. */
  const moveId = (ids: string[], moving: string, target: string): string[] => {
    const from = ids.indexOf(moving);
    const to = ids.indexOf(target);
    if (from < 0 || to < 0 || from === to) return ids;
    const next = [...ids];
    next.splice(from, 1);
    next.splice(to, 0, moving);
    return next;
  };

  const endDrag = () => {
    dragRef.current?.detach();
    dragRef.current = null;
    setDraggingId(null);
    setDragPreview(null);
  };

  /**
   * The home-list row under a viewport point, by its `data-provider-row` id —
   * how a pointer drag finds its target (the events themselves land on the
   * grip while it holds capture, and anywhere once it has lost it).
   */
  const providerRowAt = (x: number, y: number): string | null => {
    const el = document.elementFromPoint(x, y);
    return (
      el?.closest<HTMLElement>("[data-provider-row]")?.dataset.providerRow ??
      null
    );
  };

  /**
   * "Add provider" — an add
   * menu: only the built-ins not yet added, then the two create actions,
   * which are always offered. Controlled at `""` so it never holds a
   * selection; a pick opens that provider's editor.
   */
  const renderAddMenu = () => (
    <SelectRoot
      value=""
      onValueChange={addFromMenu}
      open={addMenuOpen}
      onOpenChange={(open) => {
        setAddMenuOpen(open);
        if (!open) setHighlightAddMenu(false);
      }}
    >
      <SelectTrigger
        size="sm"
        className="shrink-0"
        data-testid="models-add-provider"
      >
        <span className="flex items-center gap-1.5">
          <PlusIcon className="size-4" />
          {t("settings.models.addProviderMenu")}
        </span>
      </SelectTrigger>
      <SelectContent
        align="end"
        data-testid="models-add-provider-menu"
        className={highlightAddMenu ? "nexus-provider-guidance" : undefined}
      >
        {(
          [
            { key: "vendors", label: "settings.models.builtInProviders", list: addableVendors },
            { key: "gateways", label: "settings.models.gatewayProviders", list: addableGateways },
            { key: "plugins", label: "settings.models.mod.pluginProviders", list: addablePlugins },
          ] as const
        ).map(({ key, label, list }) =>
          list.length > 0 ? (
            <React.Fragment key={key}>
              <SelectGroup data-testid={`models-add-group-${key}`}>
                <SelectLabel className="px-2 py-1.5 text-muted-foreground text-xs">
                  {t(label)}
                </SelectLabel>
                {list.map((p) => (
                  <SelectItem
                    key={p.id}
                    value={p.id}
                    data-testid={`models-provider-select-option-${p.id}`}
                  >
                    <span className="flex items-center gap-2">
                      <ProviderIcon svg={p.iconSvg} />
                      {p.mod ? modProviderName(p, locale) : p.label}
                    </span>
                  </SelectItem>
                ))}
              </SelectGroup>
              <SelectSeparator className="my-1 h-px bg-border" />
            </React.Fragment>
          ) : null,
        )}
        <SelectItem
          value={ADD_CUSTOM_PROVIDER_VALUE}
          data-testid="models-add-custom-provider"
        >
          {t("settings.models.addCustomProvider")}
        </SelectItem>
        {OPENCODE_ZEN_ENABLED ? (
          <SelectItem
            value={ADD_OPENCODE_ZEN_VALUE}
            data-testid="models-add-opencode-zen"
          >
            {t("settings.models.addOpencodeZen")}
          </SelectItem>
        ) : null}
      </SelectContent>
    </SelectRoot>
  );

  /**
   * One home-list row, reordered by POINTER drag from its grip (or arrow keys); the
   * order is written once on a release that changed it. Move / release / cancel are
   * heard on the WINDOW, since re-inserting the row releases pointer capture.
   */
  /** "N models available"; red only when a fresh listing confirmed zero. */
  const renderModelCount = (row: AddedProviderRow) => {
    const { count, confirmed } = modelAvailability(
      pickerModelIds(catalog, row.id),
      freshModelIds[row.id],
      // Picked from the provider's own listing: the ids must match verbatim.
      row.custom || isRuntimeOnlyProvider(row.id),
    );
    const none = confirmed && count === 0;
    return (
      <>
        <span aria-hidden className="text-muted-foreground">·</span>
        <span
          className={cn(
            "shrink-0 tabular-nums",
            none ? "font-medium text-destructive" : "text-muted-foreground",
          )}
          data-testid={`models-provider-models-${row.id}`}
          data-confirmed={confirmed ? "true" : "false"}
          data-count={count}
          title={none ? t("settings.models.noModelsConfirmed") : undefined}
        >
          {t("settings.models.modelsFound", {
            count,
            unit: t(
              count === 1
                ? "settings.models.unitModel"
                : "settings.models.unitModels",
            ),
          })}
        </span>
      </>
    );
  };

  const renderProviderRow = (row: AddedProviderRow) => (
    <div
      key={row.id}
      className={cn(
        "flex items-center gap-3 border-b bg-background px-3 py-2.5 last:border-b-0",
        draggingId === row.id && "relative z-10 bg-accent/40 shadow-sm",
      )}
      data-testid={`models-provider-row-${row.id}`}
      data-provider-row={row.id}
      data-provider-dragging={draggingId === row.id ? "" : undefined}
    >
      <span
        role="button"
        tabIndex={0}
        className={cn(
          "-ml-1 flex touch-none select-none items-center text-muted-foreground/70 hover:text-muted-foreground",
          draggingId === row.id ? "cursor-grabbing" : "cursor-grab",
        )}
        data-testid={`models-provider-grip-${row.id}`}
        aria-label={t("settings.models.reorderProviderAria", {
          name: row.label,
        })}
        title={t("settings.models.reorderProviderHint")}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            /* no capture (test DOM) — moves still arrive on the grip */
          }
          dragRef.current?.detach();
          const pointerId = e.pointerId;
          const onMove = (ev: PointerEvent) => {
            const drag = dragRef.current;
            if (!drag || ev.pointerId !== pointerId) return;
            const target = providerRowAt(ev.clientX, ev.clientY);
            if (!target || target === drag.id) {
              drag.passed = null;
              return;
            }
            // Moves can outrun the re-layout and hit the row just passed at
            // its old place again; moving over it twice would undo the move.
            if (target === drag.passed) return;
            drag.passed = target;
            const next = moveId(drag.preview, drag.id, target);
            if (next === drag.preview) return;
            drag.preview = next;
            setDragPreview(next);
          };
          const onUp = (ev: PointerEvent) => {
            const drag = dragRef.current;
            if (!drag || ev.pointerId !== pointerId) return;
            // A press and release that moved nothing writes nothing — with no
            // stored order yet, writing would freeze today's order.
            if (drag.preview.some((id, i) => id !== drag.start[i])) {
              commitOrderRef.current(drag.preview);
            }
            endDrag();
          };
          // The OS took the pointer (a gesture, a lost window): drop the
          // preview and write nothing.
          const onCancel = (ev: PointerEvent) => {
            if (ev.pointerId === pointerId) endDrag();
          };
          window.addEventListener("pointermove", onMove);
          window.addEventListener("pointerup", onUp);
          window.addEventListener("pointercancel", onCancel);
          const preview = orderedRows.map((r) => r.id);
          dragRef.current = {
            id: row.id,
            start: preview,
            preview,
            passed: null,
            detach: () => {
              window.removeEventListener("pointermove", onMove);
              window.removeEventListener("pointerup", onUp);
              window.removeEventListener("pointercancel", onCancel);
            },
          };
          setDraggingId(row.id);
          setDragPreview(preview);
        }}
        onKeyDown={(e) => {
          if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
          e.preventDefault();
          const ids = orderedRows.map((r) => r.id);
          const index = ids.indexOf(row.id);
          const target = ids[e.key === "ArrowUp" ? index - 1 : index + 1];
          if (target) stageKeyboardOrder(ids, moveId(ids, row.id, target));
        }}
        onBlur={flushKeyboardOrder}
      >
        <GripVerticalIcon className="size-4" />
      </span>
      <ProviderIcon svg={row.iconSvg} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-sm">{row.label}</span>
          {row.id === activeProviderId ? (
            <Badge
              variant="info"
              size="sm"
              data-testid={`models-provider-default-${row.id}`}
            >
              {t("settings.models.defaultBadge")}
            </Badge>
          ) : null}
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-xs">
          <span
            className="truncate text-muted-foreground"
            data-testid={`models-provider-kind-${row.id}`}
          >
            {t(CONNECTION_KIND_KEY[row.kind])}
          </span>
          {renderModelCount(row)}
        </div>
      </div>
      {/* Connected is the normal state, so it is said quietly (a dot and
          muted text); only a provider that is NOT connected is flagged. */}
      {row.custom ? null : row.connected ? (
        <span
          className="flex shrink-0 items-center gap-1.5 text-muted-foreground text-xs"
          data-testid={`models-provider-status-${row.id}`}
          data-status="connected"
        >
          <span aria-hidden className="size-1.5 rounded-full bg-success" />
          {t("settings.models.connected")}
        </span>
      ) : (
        <span
          className="flex shrink-0 items-center gap-1 text-warning text-xs"
          data-testid={`models-provider-status-${row.id}`}
          data-status="not-connected"
        >
          <TriangleAlertIcon aria-hidden className="size-3.5" />
          {t("settings.models.notConnected")}
        </span>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="size-7 text-muted-foreground hover:text-foreground"
        data-testid={`models-provider-settings-${row.id}`}
        aria-label={t("settings.models.providerSettingsAria", {
          name: row.label,
        })}
        title={t("settings.models.providerSettingsAria", {
          name: row.label,
        })}
        onClick={() => openProvider(row.id)}
      >
        <SettingsIcon className="size-4" />
      </Button>
      {renderRowMenu(row)}
    </div>
  );

  /**
   * A row's "⋯" menu: the low-frequency actions, kept out of the row so a
   * list of six providers is not six red trash cans. Remove is last and the
   * only red item. "Set as default" turns into a disabled "Default provider"
   * on the default row, and stays disabled for a built-in that is not
   * connected — a default that cannot answer would break every new session.
   */
  const renderRowMenu = (row: AddedProviderRow) => {
    const isDefault = row.id === activeProviderId;
    const canBeDefault = row.custom || row.connected;
    const itemClass =
      "flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-start text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-muted";
    return (
      <DropdownMenuPrimitive.Root>
        <DropdownMenuPrimitive.Trigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground hover:text-foreground"
            data-testid={`models-provider-menu-${row.id}`}
            aria-label={t("settings.models.providerActionsAria", {
              name: row.label,
            })}
            title={t("settings.models.providerActionsAria", {
              name: row.label,
            })}
          >
            <MoreHorizontalIcon className="size-4" />
          </Button>
        </DropdownMenuPrimitive.Trigger>
        <DropdownMenuPrimitive.Portal>
          <DropdownMenuPrimitive.Content
            align="end"
            sideOffset={4}
            className="z-50 min-w-[10rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
          >
            <DropdownMenuPrimitive.Item
              className={itemClass}
              disabled={isDefault || !canBeDefault}
              data-testid={`models-provider-set-default-${row.id}`}
              onSelect={() => makeDefault(row.id)}
            >
              <StarIcon className="size-4" />
              {isDefault
                ? t("settings.models.isDefaultProvider")
                : t("settings.models.setAsDefault")}
            </DropdownMenuPrimitive.Item>
            <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />
            <DropdownMenuPrimitive.Item
              className={cn(
                itemClass,
                "text-destructive data-[highlighted]:bg-destructive/10",
              )}
              data-testid={`models-provider-delete-${row.id}`}
              aria-label={t("settings.models.removeProviderAria", {
                name: row.label,
              })}
              onSelect={() =>
                setDeleteTarget({
                  id: row.id,
                  name: row.label,
                  custom: row.custom,
                })
              }
            >
              <Trash2Icon className="size-4" />
              {t("settings.models.removeProvider")}
            </DropdownMenuPrimitive.Item>
          </DropdownMenuPrimitive.Content>
        </DropdownMenuPrimitive.Portal>
      </DropdownMenuPrimitive.Root>
    );
  };

  const renderHome = () => (
    <div className="flex flex-col gap-3" data-testid="models-provider-home">
      <div className="flex items-center justify-between gap-4">
        <span className="min-w-0 text-muted-foreground text-xs">
          {t("settings.models.aiProviderHint")}
        </span>
        {renderAddMenu()}
      </div>
      <div className="rounded-md border" data-testid="models-provider-list">
        {!configsLoaded || catalog === undefined ? (
          <p className="p-3 text-center text-muted-foreground text-sm">
            {t("settings.models.loadingCatalog")}
          </p>
        ) : addedRows.length === 0 ? (
          <p
            className="p-3 text-center text-muted-foreground text-sm"
            data-testid="models-provider-list-empty"
          >
            {t("settings.models.noProvidersAdded")}
          </p>
        ) : (
          orderedRows.map(renderProviderRow)
        )}
      </div>
    </div>
  );

  /**
   * The editor's header: the way back to home, and WHICH provider this is.
   * Deliberately static — switching providers happens on the home page, so
   * an editor can never be silently repointed at another provider mid-edit.
   * The provider name IS the page heading: the editor drops the section
   * title ("Provider connection") and the custom editor's own "Edit custom
   * provider" line, which only restated where the user already is.
   */
  const editingName = creating
    ? t("settings.models.addCustomProviderTitle")
    : selectedRecord
      ? selectedRecord.displayName
      : selectedProvider?.mod
        ? modProviderName(selectedProvider, locale)
        : (selectedProvider?.label ?? selectedId);
  const editingIconSvg = creating
    ? resolveCustomProviderIconSvg(draft.providerIcon, catalog)
    : selectedRecord
      ? resolveCustomProviderIconSvg(selectedRecord.providerIcon, catalog)
      : selectedProvider?.iconSvg;

  const renderEditorHeader = () => (
    <header className="mb-4 flex flex-col gap-1 border-border/60 border-b pb-5">
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2 self-start text-muted-foreground"
        data-testid="models-back-to-providers"
        onClick={requestBack}
      >
        <ArrowLeftIcon className="size-4" />
        {t("settings.models.backToProviders")}
      </Button>
      <h1
        className={cn("flex items-center gap-2.5", settingsText.pageTitle)}
        data-testid="models-editing-provider"
      >
        <ProviderIcon svg={editingIconSvg} />
        <span className="truncate">{editingName}</span>
      </h1>
    </header>
  );

  const renderCustomEditor = () => (
    <div className="flex flex-col gap-5" data-testid="custom-provider-editor">

      {/* ── Provider details ── */}
      <section className="flex flex-col gap-3">
        <h2 className={settingsText.sectionTitle}>
          {t("settings.models.providerDetails")}
        </h2>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">
            {t("settings.models.providerIcon")}
          </span>
          <Select
            value={draft.providerIcon}
            onValueChange={(v) =>
              setDraft((prev) => {
                const next: CustomProviderDraft = { ...prev, providerIcon: v };
                // Default the provider name to "<IconLabel>-custom" (e.g.
                // "Qwen-custom") when the user hasn't typed a name yet, OR
                // when the name still matches the previous icon's default —
                // so switching icons keeps the name in sync until the user
                // overrides it.
                const label =
                  PROVIDER_ICON_LABELS[v as ProviderIconKey] ?? "Provider";
                const previousLabel =
                  PROVIDER_ICON_LABELS[
                    prev.providerIcon as ProviderIconKey
                  ] ?? "Provider";
                const previousDefault = `${previousLabel}-custom`;
                const nextDefault = `${label}-custom`;
                if (
                  !prev.displayName.trim() ||
                  prev.displayName.trim() === previousDefault
                ) {
                  next.displayName = nextDefault;
                }
                return next;
              })
            }
            options={PROVIDER_ICON_KEYS.map((key) => ({
              value: key,
              label: (
                <span className="flex items-center gap-2">
                  <ProviderIcon
                    svg={resolveCustomProviderIconSvg(key, catalog)}
                  />
                  {PROVIDER_ICON_LABELS[key]}
                </span>
              ),
            }))}
            className="mt-1 w-full"
            testId="custom-provider-icon"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">
            {t("settings.models.providerName")}
          </span>
          <Input
            data-testid="custom-provider-name"
            value={draft.displayName}
            onChange={(e) => {
              setNameError(null);
              setDraft((prev) => ({ ...prev, displayName: e.target.value }));
            }}
            placeholder={t("settings.models.providerNamePlaceholder")}
            aria-invalid={draftNameTaken || !!nameError}
          />
          {draftNameTaken || nameError ? (
            <span
              data-testid="custom-provider-name-error"
              className="text-destructive text-xs"
            >
              {nameError ??
                t("settings.models.providerNameExists", {
                  name: draft.displayName.trim(),
                })}
            </span>
          ) : null}
        </label>
      </section>

      {/* ── Connection ── */}
      <section className="flex flex-col gap-3">
        <h2 className={settingsText.sectionTitle}>
          {t("settings.models.connection")}
        </h2>

        <div className="flex flex-col gap-2 text-sm">
          <span className="font-medium">
            {t("settings.models.apiCompatibility")}
          </span>
          <RadioGroup
            value={draft.apiCompatibility}
            onValueChange={(v) => {
              setDraft((prev) => ({
                ...prev,
                apiCompatibility: v as CustomApiCompatibility,
              }));
              // The dialects probe DIFFERENT URLs, so a prior result no
              // longer describes this connection.
              setTestState({ status: "idle" });
            }}
            // `flex` is REQUIRED, not redundant: RadioGroup's base class is
            // `grid`, and tailwind-merge only drops a class from the SAME
            // group — `flex-row` (flex-direction) does not displace `grid`
            // (display), so a bare `flex-row` left the options stacked.
            className="mt-1 flex flex-row flex-wrap gap-x-6 gap-y-2"
          >
            <RadioOption
              value="openai"
              label={t("settings.models.apiCompatOpenai")}
              testId="custom-compat-openai"
            />
            <RadioOption
              value="anthropic"
              label={t("settings.models.apiCompatAnthropic")}
              testId="custom-compat-anthropic"
            />
          </RadioGroup>
        </div>

        {/* Trust — one toggle describing the connection PATH, not the
            vendor: on = the provider's own endpoint, off = a relay, proxy or
            gateway in between. The teammate spawn reads the same value to
            decide whether a child runs unrestricted or locked down, but that
            policy is deliberately not spelled out here. */}
        <div className="flex flex-col gap-2 text-sm">
          <span className="font-medium">{t("settings.models.trust")}</span>
          <div className="flex items-center justify-between gap-4">
            <span>{t("settings.models.trustOfficial")}</span>
            <Switch
              data-testid="custom-provider-trust-official"
              checked={draft.trust === "trusted"}
              onCheckedChange={(next) =>
                setDraft((prev) => ({
                  ...prev,
                  trust: (next ? "trusted" : "untrusted") as ProviderTrust,
                }))
              }
              aria-label={t("settings.models.trustOfficial")}
            />
          </div>
          <span className="text-muted-foreground text-xs">
            {t("settings.models.trustHint")}
          </span>
        </div>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t("settings.models.baseUrl")}</span>
          <Input
            data-testid="custom-provider-base-url"
            value={draft.baseUrl}
            onChange={(e) => {
              setDraft((prev) => ({ ...prev, baseUrl: e.target.value }));
              setTestState({ status: "idle" });
            }}
            placeholder={
              draft.apiCompatibility === "anthropic"
                ? t("settings.models.baseUrlPlaceholderAnthropic")
                : t("settings.models.baseUrlPlaceholderOpenai")
            }
            aria-invalid={!!draft.baseUrl && !isValidBaseUrl(draft.baseUrl)}
          />
          <span className="text-muted-foreground text-xs">
            {draft.apiCompatibility === "anthropic"
              ? t("settings.models.customPathHintAnthropic")
              : t("settings.models.customPathHintOpenai")}
          </span>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <ApiKeyLabel
            saved={!!selectedRecord?.hasApiKey}
            testId="custom-provider-api-key-saved"
          />
          <Input
            data-testid="custom-provider-api-key"
            type="password"
            value={draft.apiKey}
            onChange={(e) => {
              setDraft((prev) => ({ ...prev, apiKey: e.target.value }));
              setTestState({ status: "idle" });
            }}
            placeholder={
              selectedRecord?.hasApiKey && !draft.apiKey
                ? t("settings.models.apiKeySealedPlaceholder")
                : t("settings.models.apiKeyPlaceholder")
            }
            autoComplete="off"
          />
          <span className="text-muted-foreground text-xs">
            {selectedRecord?.hasApiKey
              ? t("settings.models.apiKeyStoredHint")
              : t("settings.models.apiKeyHint")}
          </span>
          {isOpencodeZenBaseUrl(draft.baseUrl) ? (
            <span
              data-testid="custom-provider-opencode-zen-hint"
              className="text-muted-foreground text-xs"
            >
              {t("settings.models.opencodeZenHint")}
            </span>
          ) : null}
        </label>

        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            data-testid="custom-provider-test"
            disabled={testState.status === "testing"}
            onClick={() => void testCustomConnection()}
          >
            {t("settings.models.testAndDiscover")}
          </Button>
          <span
            className="text-xs"
            data-testid="custom-provider-test-status"
          >
            {testState.status === "idle" ? (
              <span className="text-muted-foreground">
                {t("settings.models.testNotTested")}
              </span>
            ) : testState.status === "testing" ? (
              <span className="text-muted-foreground">
                {t("settings.models.chipConnecting")}
              </span>
            ) : testState.status === "ok" ? (
              <span className="text-success">
                {t("settings.models.testSuccessful")}
                {typeof testState.modelCount === "number"
                  ? ` ${t("settings.models.testModelsFound", {
                      count: testState.modelCount,
                    })}`
                  : ""}
              </span>
            ) : (
              <span className="text-destructive">
                {t("settings.models.testFailed")}
                {` ${mapErrorCode(t, testState.errorCode)}`}
              </span>
            )}
          </span>
        </div>
      </section>

      {/* ── Models ── */}
      <section className="flex flex-col gap-3">
        <h2 className={settingsText.sectionTitle}>
          {t("settings.models.modelsSection")}
        </h2>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">
            {t("settings.models.defaultModel")}
          </span>
          <Select
            value={draft.defaultModel}
            onValueChange={(v) =>
              setDraft((prev) => ({ ...prev, defaultModel: v }))
            }
            // Only COMPLETE models can be the default — an id
            // without limits has no token budget to run against.
            options={completeModels.map((m) => ({
              value: m.modelId,
              label: modelLabel(m),
            }))}
            placeholder={t("settings.models.selectModel")}
            disabled={completeModels.length === 0}
            className="mt-1 w-full"
            testId="custom-provider-default-model"
          />
        </label>

        <div className="flex items-center justify-between">
          <span className="font-medium text-sm">
            {t("settings.models.configuredModels")}
          </span>
          <span
            className="text-muted-foreground text-xs"
            data-testid="custom-provider-model-count"
          >
            {completeModels.length}
          </span>
        </div>

        <div className="rounded-md border">
          {completeModels.length === 0 ? (
            <p className="p-3 text-center text-muted-foreground text-sm">
              {t("settings.models.noModelsYet")}
            </p>
          ) : (
            completeModels.map((model) => (
              <ModelRow
                key={model.modelId}
                model={model}
                onEdit={() => {
                  setEditingModel(model);
                  setPendingModel(null);
                  setAddModelOpen(true);
                }}
                onRemove={() => removeDraftModel(model.modelId)}
              />
            ))
          )}
        </div>

        {pendingModels.length > 0 ? (
          <>
            <div className="flex items-center justify-between">
              <span className="font-medium text-sm">
                {t("settings.models.pendingModels")}
              </span>
              <span
                className="text-muted-foreground text-xs"
                data-testid="custom-provider-pending-count"
              >
                {pendingModels.length}
              </span>
            </div>
            <div
              className="max-h-[300px] overflow-y-auto rounded-md border"
              data-testid="custom-provider-pending-list"
            >
              {pendingModels.map((model) => (
                <PendingModelRow
                  key={model.modelId}
                  model={model}
                  onAdd={() => {
                    setEditingModel(null);
                    setPendingModel(model);
                    setAddModelOpen(true);
                  }}
                />
              ))}
            </div>
          </>
        ) : null}

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            data-testid="custom-provider-add-model"
            onClick={() => {
              setEditingModel(null);
              setAddModelOpen(true);
            }}
          >
            {t("settings.models.addModel")}
          </Button>
        </div>
      </section>

      {/* ── Page actions ── */}
      <div className="flex items-center justify-between gap-2 border-t pt-4">
        <div>
          {!creating && selectedRecord ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive"
              data-testid="custom-provider-delete"
              onClick={() =>
                setDeleteTarget({
                  id: selectedRecord.id,
                  name: selectedRecord.displayName,
                  custom: true,
                })
              }
            >
              {t("settings.models.deleteProvider")}
            </Button>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {creating ? (
            <Button
              variant="ghost"
              size="sm"
              data-testid="custom-provider-cancel"
              onClick={cancelCreate}
            >
              {t("settings.models.cancel")}
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              data-testid="custom-provider-discard"
              disabled={!customDirty}
              onClick={discardCustomChanges}
            >
              {t("settings.models.discardChanges")}
            </Button>
          )}
          <Button
            size="sm"
            data-testid="custom-provider-submit"
            disabled={!canSubmitCustom || saving || (!creating && !customDirty)}
            onClick={() => void submitCustomProvider()}
          >
            {creating
              ? t("settings.models.addProvider")
              : t("settings.models.saveChanges")}
          </Button>
        </div>
      </div>
    </div>
  );

  // A provider a plugin adds has its own editor: it is drawn from the catalog
  // row (credential methods, prompts, declared secrets and settings) and does
  // not take the built-ins' auto-connect.
  const renderModEditor = (provider: BrowserLlmProvider) => (
    <ModProviderEditor
      provider={provider}
      saved={saved}
      bridge={bridge}
      onChanged={reload}
    />
  );

  const renderBuiltInEditor = () => selectedProvider?.mod ? renderModEditor(selectedProvider) : (
    <div className="flex flex-col gap-3 rounded-xl border border-border/70 bg-card p-4">
      {isOAuth ? (
        /* OAuth providers connect by sign-in (no API key). */
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-sm">
            <Badge variant={oauthConnected ? "success" : "muted"} size="sm">
              {oauthConnected
                ? t("settings.models.connected")
                : t("settings.models.notConnected")}
            </Badge>
            {oauthConnected ? (
              <span className="text-muted-foreground text-xs">
                {info?.connectedEmail ?? t("settings.models.signedIn")}
              </span>
            ) : null}
          </div>
          {!oauthConnected ? (
            <Button
              size="sm"
              className="self-start"
              disabled={oauth.busy}
              onClick={() => void signIn()}
            >
              {oauth.busy
                ? t("settings.models.waitingSignIn")
                : t("settings.models.signInWith", {
                    provider:
                      selectedProvider?.label ??
                      t("settings.models.providerFallback"),
                  })}
            </Button>
          ) : null}
          {oauth.userCode ? (
            <div className="rounded-md border bg-muted/30 p-3 text-xs">
              <div className="text-muted-foreground">
                {t("settings.models.enterCode")}
              </div>
              <code className="mt-1 block font-mono text-sm">
                {oauth.userCode}
              </code>
              {oauth.verificationUri ? (
                <div className="mt-1 break-all text-muted-foreground">
                  {oauth.verificationUri}
                </div>
              ) : null}
            </div>
          ) : null}
          <span className="text-muted-foreground text-xs">
            {t("settings.models.useSubscription")}
          </span>
        </div>
      ) : (
        <>
          {supportsBaseUrl ? (
            /* A div, not a label: the official-connection checkbox shares this
               row and a nested label would steal its clicks for the URL input.
               The input keeps its name via `aria-label`. The two belong
               together — the checkbox is a claim about THIS URL's endpoint,
               and it is re-derived whenever the URL changes. */
            <div className="flex flex-col gap-1 text-sm">
              <span className="font-medium">{t("settings.models.baseUrl")}</span>
              <div className="flex items-center gap-3">
                <Input
                  className="flex-1"
                  data-testid="models-base-url"
                  aria-label={t("settings.models.baseUrl")}
                  value={form.baseUrl ?? ""}
                  onChange={(e) => onBaseUrlChange(e.target.value)}
                  placeholder={providerBaseUrlPlaceholder(
                    info?.baseUrl,
                    runtimeProviderDefaultBaseUrl(selectedId),
                  )}
                />
                {officialConnectionCheckbox}
              </div>
            </div>
          ) : null}

          {supportsApiKey ? (
            <div className="flex flex-col gap-1 text-sm">
              <ApiKeyLabel saved={hasStoredKey} testId="models-api-key-saved" />
              <Input
                data-testid="models-api-key"
                type="password"
                aria-label={t("settings.models.apiKey")}
                value={form.apiKey ?? ""}
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                placeholder={
                  hasStoredKey && !form.apiKey
                    ? t("settings.models.apiKeySealedPlaceholder")
                    : t("settings.models.apiKeyPlaceholder")
                }
                autoComplete="off"
              />
              <span className="text-muted-foreground text-xs">
                {hasStoredKey
                  ? t("settings.models.apiKeyStoredHint")
                  : t("settings.models.enterKeyHint")}
              </span>
            </div>
          ) : null}

          {/* Extra credentials (OpenRouter's management key, for the account
              balance) — once the API key is stored: they extend a working
              connection, they do not make one. */}
          {supportsApiKey && hasStoredKey && secretFields.length > 0 ? (
            <ProviderSecretFields
              fields={secretFields}
              storedNames={saved?.storedSecrets ?? []}
              onSave={saveSecret}
            />
          ) : null}
        </>
      )}


      {supportsBaseUrl ? null : (
        <div className="flex text-sm">{officialConnectionCheckbox}</div>
      )}

      {providerNote ? (
        <p className="text-muted-foreground text-xs">{providerNote}</p>
      ) : null}

      {/* The provider's model entries — a family's Latest or a pinned
          version; only these reach the picker. A runtime-only provider (a
          gateway listing hundreds of models) shows them from the start, the
          user picking what to use; a built-in one once it is connected. */}
      {bridge &&
      usesModelEntries(selectedId) &&
      (isRuntimeOnlyProvider(selectedId) || status === "ready") ? (
        <ProviderModelEntries
          bridge={bridge}
          providerId={selectedId}
          providerLabel={selectedProvider?.label ?? selectedId}
          saved={saved}
          provider={selectedProvider}
          onChanged={reload}
          connected={status === "ready" || !!saved?.hasApiKey}
        />
      ) : null}

      {/* Status card. In the connected state the chip and the title say the
          same word ("Connected" twice, one under the other), so the title is
          dropped and the detail — "N models available" — moves up onto the
          chip's line. Keyed on the STATE, not on the two strings being equal:
          they are equal in all seven catalogs today, but that is a property of
          the translations, and a translator wording them differently would
          silently bring the duplicate back. */}
      <div className="flex flex-col gap-1 rounded-md border bg-muted/30 p-3">
        <div className="flex items-center gap-2">
          <Badge variant={present.chipVariant} size="sm">
            {present.chip}
          </Badge>
          {status === "ready" ? (
            <span className="text-muted-foreground text-xs">{present.detail}</span>
          ) : (
            <span className="font-medium text-sm">{present.title}</span>
          )}
        </div>
        {status === "ready" ? null : (
          <span className="text-muted-foreground text-xs">{present.detail}</span>
        )}
        {status === "ready" && isRuntimeOnlyProvider(selectedId) ? (
          <RuntimeProviderUsageLine providerId={selectedId} />
        ) : null}
      </div>

      {/* No explicit Save button: edits auto-connect (verify + persist)
          once the form settles (see the debounce effect). Only the reset
          affordance remains, surfaced once the connection is live. */}
      {status === "ready" ? (
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setResetOpen(true)}>
            {t("settings.models.resetConnection")}
          </Button>
        </div>
      ) : null}
    </div>
  );

  return (
    <SettingsSubpageLayout
      title={view === "home" ? t("settings.models.title") : undefined}
    >
      <div className="flex flex-col gap-4">
        {view === "home" ? renderHome() : renderEditorHeader()}

        {addedNotice ? (
          <p
            className="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-success text-sm"
            data-testid="custom-provider-added-notice"
          >
            {addedNotice}
          </p>
        ) : null}

        {view === "home"
          ? null
          : isCustomSelection
            ? renderCustomEditor()
            : selectedId
              ? renderBuiltInEditor()
              : null}

        {/* Reset confirmation dialog — mirrors the original modal. */}
        <Dialog open={resetOpen} onOpenChange={setResetOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {t("settings.models.resetTitle", {
                  provider:
                    selectedProvider?.label ??
                    t("settings.models.providerFallback"),
                })}
              </DialogTitle>
              <DialogDescription>
                {t("settings.models.resetDescription", {
                  provider:
                    selectedProvider?.label ??
                    t("settings.models.thisProviderFallback"),
                })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => setResetOpen(false)}>
                {t("settings.models.cancel")}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => void doReset()}
              >
                {t("settings.models.resetConnection")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete a custom provider, or remove a built-in from the
            home list. The custom wording is deliberately NOT "Reset
            connection": for a user-created provider it must be obvious that the
            whole thing goes away, not just the key. A built-in is only
            disconnected — it stays on offer under "Add provider". */}
        <Dialog
          open={deleteTarget !== null}
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {deleteTarget?.custom === false
                  ? t("settings.models.removeProviderTitle", {
                      name: deleteTarget.name,
                    })
                  : t("settings.models.deleteProviderTitle", {
                      name: deleteTarget?.name ?? "",
                    })}
              </DialogTitle>
              <DialogDescription>
                {deleteTarget?.custom === false
                  ? t("settings.models.removeProviderDescription", {
                      name: deleteTarget.name,
                    })
                  : t("settings.models.deleteProviderDescription")}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDeleteTarget(null)}
              >
                {t("settings.models.cancel")}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                data-testid={
                  deleteTarget?.custom === false
                    ? "models-provider-remove-confirm"
                    : "custom-provider-delete-confirm"
                }
                onClick={() => void confirmDelete()}
              >
                {deleteTarget?.custom === false
                  ? t("settings.models.removeProviderConfirm")
                  : t("settings.models.deleteProviderConfirm")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Unsaved-changes guard on the way back to home. */}
        <Dialog open={leaveConfirmOpen} onOpenChange={setLeaveConfirmOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {t("settings.models.discardUnsavedTitle")}
              </DialogTitle>
              <DialogDescription>
                {t("settings.models.discardUnsavedDescription", {
                  name: creating
                    ? t("settings.models.newCustomProvider")
                    : (selectedRecord?.displayName ?? ""),
                })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="ghost"
                size="sm"
                data-testid="custom-provider-keep-editing"
                onClick={() => setLeaveConfirmOpen(false)}
              >
                {t("settings.models.keepEditing")}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                data-testid="custom-provider-discard-confirm"
                onClick={goHome}
              >
                {t("settings.models.discardChanges")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <AddModelDialog
          open={addModelOpen}
          onOpenChange={(open) => {
            setAddModelOpen(open);
            if (!open) {
              setEditingModel(null);
              setPendingModel(null);
            }
          }}
          editingModel={editingModel}
          pendingModel={pendingModel}
          // Exclude the pending model's own id so promoting it doesn't trip the
          // duplicate-id check (it's already in draft.models as incomplete).
          existingModelIds={draft.models
            .filter((m) => m.modelId !== pendingModel?.modelId)
            .map((m) => m.modelId)}
          apiCompatibility={draft.apiCompatibility}
          onSubmit={upsertDraftModel}
        />
      </div>
      {view === "home" && configsLoaded && addedRows.length > 0
        ? footer
        : null}
    </SettingsSubpageLayout>
  );
}
