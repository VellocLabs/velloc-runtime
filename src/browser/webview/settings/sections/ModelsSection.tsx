import * as React from "react";
import { ArrowLeftIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ProviderIcon } from "../../ProviderIcon";
import { useUnsavedEditsGate } from "@/glic/unsavedEditsGate";

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
import type { FreshModelIds } from "../providerModelAvailability";
import {
  isRuntimeOnlyProvider,
  providerSecretFields,
  verifiesInRuntime,
} from "../../../../models/drivers/driverRegistry";
import { getProviderUsageStore } from "../../providerUsageStore";
import { ModProviderEditor, modProviderName } from "./ModProviderEditor";
import { isModProviderAdded, isModProviderConnected } from "../modProviderForm";
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
  providerConnectionKind,
  shouldAutoConnect,
} from "../providerFormHelpers";
import {
  backendIdForCompatibility,
  canSubmitCustomProvider,
  configFromDraft,
  draftFromRecord,
  emptyCustomProviderDraft,
  generateCustomProviderId,
  isCustomBackendId,
  isCustomDraftDirty,
  isModelComplete,
  isValidBaseUrl,
  listCustomProviderRecords,
  normaliseBaseUrl,
  isProviderNameTaken,
  resolveCustomProviderIconSvg,
  type CustomProviderDraft,
  type CustomProviderRecord,
} from "../customProviderHelpers";
import {
  opencodeZenDraft,
  resolveOpencodeZenApiKey,
} from "../opencodeZenPreset";
import { customProviderUserAgent } from "../../../../config/providerUserAgent";
import { AddModelDialog } from "./AddModelDialog";
import { SettingsSubpageLayout, settingsText } from "../SettingsSubpageLayout";
import {
  sameOrder,
  MAX_UNECHOED_ORDERS,
  settleEchoedOrder,
  KEYBOARD_REORDER_COMMIT_MS,
} from "./models/providerOrder";
import {
  ADD_CUSTOM_PROVIDER_VALUE,
  ADD_OPENCODE_ZEN_VALUE,
  renderAddProviderMenu,
} from "./models/AddProviderMenu";
import type {
  PageView,
  AddedProviderRow,
  DeleteTarget,
  ProviderStatus,
  TestState,
} from "./models/modelsPageTypes";
import {
  renderProviderModelCount,
  renderProviderListRow,
  renderProviderRowMenu,
} from "./models/ProviderListRow";
import type { ApiKeyRowState } from "./models/ApiKeyLabel";
import { renderCustomProviderEditor } from "./models/CustomProviderEditor";
import { renderBuiltInProviderEditor } from "./models/BuiltInProviderEditor";
import { providerStatusPresentation } from "./models/providerStatusPresentation";
import {
  renderDeleteProviderDialog,
  renderDiscardChangesDialog,
  renderResetConnectionDialog,
} from "./models/ProviderConfirmDialogs";

/** Debounce before an edit auto-triggers the verify+persist connection. */
const AUTO_CONNECT_DEBOUNCE_MS = 700;

/** How long the "<name> added." confirmation stays up. */
const ADDED_NOTICE_MS = 4000;

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
  // The provider whose typed key the last save stored: the field empties
  // after a save, so this is the only sign a replacement key landed.
  const [keyStoredFor, setKeyStoredFor] = React.useState<string | null>(null);
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
    setKeyStoredFor(null);
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
  // A rejected typed key falls back to the stored state; the status card says why.
  const keyRowState: ApiKeyRowState | null =
    (form.apiKey ?? "").trim() !== "" && !verifyError
      ? "saving"
      : hasStoredKey && keyStoredFor === selectedId && !form.apiKey
        ? "updated"
        : hasStoredKey
          ? "saved"
          : null;
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

  const STATUS_PRESENTATION = providerStatusPresentation({
    t,
    modelCount,
    selectedId,
    verifyError,
  });
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
    setKeyStoredFor(null);
    const keyTyped = (form.apiKey ?? "").trim() !== "";
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
        if (keyTyped) setKeyStoredFor(selectedId);
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
      if (keyTyped) setKeyStoredFor(selectedId);
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

  const renderAddMenu = () =>
    renderAddProviderMenu(
      {
        addFromMenu, addMenuOpen, setAddMenuOpen, setHighlightAddMenu, t,
        highlightAddMenu, addableVendors, addableGateways, addablePlugins,
        locale
      },
    );

  const renderModelCount = (row: AddedProviderRow) =>
    renderProviderModelCount(
      {
        catalog, freshModelIds, t
      }, row,
    );

  const renderProviderRow = (row: AddedProviderRow) =>
    renderProviderListRow(
      {
        draggingId, t, dragRef, providerRowAt, moveId, setDragPreview,
        commitOrderRef, endDrag, orderedRows, setDraggingId,
        stageKeyboardOrder, flushKeyboardOrder, activeProviderId,
        renderModelCount, openProvider, renderRowMenu
      }, row,
    );

  const renderRowMenu = (row: AddedProviderRow) =>
    renderProviderRowMenu(
      {
        activeProviderId, t, makeDefault, setDeleteTarget
      }, row,
    );

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

  const renderCustomEditor = () =>
    renderCustomProviderEditor(
      {
        t, draft, setDraft, catalog, setNameError, draftNameTaken, nameError,
        setTestState, selectedRecord, testState, testCustomConnection,
        completeModels, setEditingModel, setPendingModel, setAddModelOpen,
        removeDraftModel, pendingModels, creating, setDeleteTarget,
        cancelCreate, customDirty, discardCustomChanges, canSubmitCustom,
        saving, submitCustomProvider
      },
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

  const renderBuiltInEditor = () =>
    renderBuiltInProviderEditor(
      {
        selectedProvider, renderModEditor, isOAuth, oauthConnected, t, info,
        oauth, signIn, supportsBaseUrl, form, onBaseUrlChange, selectedId,
        officialConnectionCheckbox, supportsApiKey, keyRowState,
        setKeyStoredFor, setForm, hasStoredKey, secretFields, saved,
        saveSecret, providerNote, bridge, status, reload, present,
        setResetOpen
      },
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

        {renderResetConnectionDialog({
          t,
          resetOpen,
          setResetOpen,
          selectedProvider,
          doReset,
        })}

        {renderDeleteProviderDialog({
          t,
          deleteTarget,
          setDeleteTarget,
          confirmDelete,
        })}

        {renderDiscardChangesDialog({
          t,
          leaveConfirmOpen,
          setLeaveConfirmOpen,
          creating,
          selectedRecord,
          goHome,
        })}

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
