/**
 * Settings for a provider's MODEL ENTRIES — a family's "Latest" or a pinned version;
 * only entries reach the model picker. Every figure comes from the runtime and every
 * write is `providers.setModelEntries`: the page never talks to the provider.
 */
import * as React from "react";
import { ChevronDownIcon, ChevronRightIcon, ExternalLinkIcon, PencilIcon, PinIcon, XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { BrowserLlmProvider } from "../../../bridge/protocol/nexus_llm";
import {
  editableEntries,
  entryId,
  LATEST,
  type ModelEntry,
} from "../../../../config/nexusModelConfig/modelEntries";
import type {
  ProviderFamilyDetail,
  ProviderFamilyVersion,
  ProviderModelFamilies,
} from "../../../../models/drivers/modelFamilies";
import type { NexusProviderConfig } from "../../../../settings/settingsTypes";
import { resolveLocalizedText } from "../../../../config/localizedText";
import type { ProviderModelsUi } from "../../../../mods/provider/providerManifest";
import {
  USER_MODEL_GROUP,
  type UserModelDef,
} from "../../../../config/nexusModelConfig/userModels";
import { UserModelDialog } from "./UserModelDialog";
import { useLocale, useT } from "../../i18n";
import type { NexusSettingsBridge } from "../../nexusSettingsBridge";
import { amountLabelKey, balanceNoteKey, useFormatAmount, windowLabelKey } from "../../planUsageLabels";
import { useProviderUsage } from "../../providerUsageStore";
import {
  listedProviderIdsOf,
  providersDismissRemoved,
  providersModelFamilies,
  providersSetModelEntries,
  providersSetUserModels,
} from "../clients";
import { FreeModelIcon } from "../../FreeModelIcon";
import { contextFigure, priceFigure } from "../../modelFigures";
import { displayModelLabel } from "../../../../config/nexusModelConfig/modelDisplay";

/** The vendor half of a gateway family key (`anthropic/claude-opus-*` →
 *  `anthropic`); empty for a built-in provider's. */
export function modelVendor(id: string): string {
  const slash = id.indexOf("/");
  return slash > 0 ? id.slice(0, slash) : "";
}

/** A pseudo tag: a version the provider marks deprecated wears it. */
const DEPRECATED_TAG = "deprecated";

/** The badge names of a version: deprecated first, then the listing's tags. */
function badgeTags(version: ProviderFamilyVersion): string[] {
  return [...(version.deprecated ? [DEPRECATED_TAG] : []), ...(version.tags ?? [])];
}

/** The group a family is listed under: the listing's own (a provider mod's),
 *  else the vendor half of its key. */
export function familyGroup(family: ProviderFamilyDetail): string {
  return family.group ?? modelVendor(family.family);
}

/** Group keys in page order: the manifest's `order` first, then by label. */
function orderedGroups<T>(
  groups: Array<[string, T]>,
  ui: ProviderModelsUi | undefined,
  labelOf: (key: string) => string,
): Array<[string, T]> {
  const orderOf = (key: string) => ui?.groups?.[key]?.order ?? Number.MAX_SAFE_INTEGER;
  return [...groups].sort(
    ([a], [b]) => orderOf(a) - orderOf(b) || labelOf(a).localeCompare(labelOf(b)),
  );
}

/** The page-level text a provider mod declares: intro and links. */
function ModelsUiNote({ ui }: { ui: ProviderModelsUi | undefined }) {
  const locale = useLocale();
  const intro = ui?.intro ? resolveLocalizedText(ui.intro, locale) : "";
  if (!intro && !ui?.links?.length) return null;
  return (
    <div className="flex flex-col gap-1 text-muted-foreground text-xs" data-testid="model-entries-ui-note">
      {intro ? <p>{intro}</p> : null}
      {ui?.links?.length ? (
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {ui.links.map((link) => (
            <a
              key={link.url}
              href={link.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 hover:underline"
            >
              {resolveLocalizedText(link.label, locale)}
              <ExternalLinkIcon className="size-3 shrink-0" />
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Badges for a row: the names its listing gave, labeled by the manifest. */
function TagBadges({ tags, ui }: { tags: readonly string[] | undefined; ui: ProviderModelsUi | undefined }) {
  const locale = useLocale();
  const t = useT();
  if (!tags?.length) return null;
  return (
    <>
      {tags.map((tag) => (
        <Badge key={tag} variant="muted" size="sm" data-testid={`model-tag-${tag}`}>
          {ui?.tags?.[tag]
            ? resolveLocalizedText(ui.tags[tag]!.label, locale)
            : tag === DEPRECATED_TAG
              ? t("settings.models.entries.deprecated")
              : tag}
        </Badge>
      ))}
    </>
  );
}

function versionSummary(
  version: ProviderFamilyVersion | undefined,
  t: ReturnType<typeof useT>,
  locale: string,
): string {
  if (!version) return "";
  return [
    version.description ? resolveLocalizedText(version.description, locale) : "",
    contextFigure(version, t),
    version.reasoning ? t("settings.models.capReasoning") : undefined,
    version.vision ? t("settings.models.capVision") : undefined,
    priceFigure(version, t, locale),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The newest stable version — what the family's Latest resolves to. */
const latestOf = (family: ProviderFamilyDetail): ProviderFamilyVersion | undefined =>
  family.versions.find((v) => !v.preview);

export function ProviderModelEntries({
  bridge,
  providerId,
  providerLabel,
  saved,
  provider,
  onChanged,
  ui,
  connected = true,
}: {
  bridge: NexusSettingsBridge;
  providerId: string;
  providerLabel: string;
  /** A provider mod's declared look of this page (manifest `modelsUi`). */
  ui?: ProviderModelsUi;
  saved: NexusProviderConfig | undefined;
  /** The provider's catalog row — its models are the resolved entries. */
  provider: BrowserLlmProvider | undefined;
  /** Re-read the saved configs after a write. */
  onChanged: () => void | Promise<void>;
  /** A key, a sign-in or the keyless mode is saved. Absent = connected. */
  connected?: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const [families, setFamilies] = React.useState<ProviderModelFamilies | null>(null);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [freePickerOpen, setFreePickerOpen] = React.useState(false);
  const [saveFailed, setSaveFailed] = React.useState(false);
  const [userDialog, setUserDialog] = React.useState<{ open: boolean; editing: UserModelDef | null }>({
    open: false,
    editing: null,
  });
  const userModels: UserModelDef[] = ui?.customModels ? saved?.userModels ?? [] : [];
  // `saved` is the page's copy: opening the section (or the dialog) can make
  // the runtime reconcile and drop delisted entries before that copy
  // refreshes via `providers.changed`. Never show or write back an entry the
  // listing says was removed, so an edit in that window cannot resurrect it
  // (the runtime drops one too — `staleEntryIds`).
  const removedEntryIds = new Set(families?.ok ? families.removed?.entryIds ?? [] : []);
  const entries = editableEntries(saved?.modelEntries, provider?.models ?? []).filter(
    (entry) => !removedEntryIds.has(entryId(entry)),
  );
  const ids = entries.map(entryId);
  const rows = new Map((provider?.models ?? []).map((m) => [m.id, m]));

  const load = React.useCallback(
    async (force: boolean) => {
      try {
        setFamilies(await providersModelFamilies(bridge, providerId, force));
      } catch (error) {
        setFamilies({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          families: [],
        });
      }
    },
    [bridge, providerId],
  );

  React.useEffect(() => {
    setFamilies(null);
    void load(false);
  }, [load]);

  // A key saved while the page is open: list again, past any answer from
  // before the key (a remembered failure, or a listing still running).
  const wasConnected = React.useRef(connected);
  React.useEffect(() => {
    if (connected && !wasConnected.current) void load(true);
    wasConnected.current = connected;
  }, [connected, load]);

  // The runtime lists the provider again when the model catalog changed what
  // its module read, and says so on `providers.changed`; read the rows again
  // (no spinner: the page keeps showing the old ones until the new arrive).
  React.useEffect(
    () =>
      bridge.subscribeEvents((envelope) => {
        if (listedProviderIdsOf(envelope).includes(providerId)) void load(false);
      }),
    [bridge, providerId, load],
  );

  const write = async (next: ModelEntry[], defaultModel?: string) => {
    setSaveFailed(false);
    try {
      await providersSetModelEntries(bridge, providerId, next, defaultModel);
      await onChanged();
    } catch {
      setSaveFailed(true);
    }
  };

  const writeUserModels = async (next: UserModelDef[]) => {
    setSaveFailed(false);
    try {
      await providersSetUserModels(bridge, providerId, next);
      await onChanged();
      void load(false);
    } catch {
      setSaveFailed(true);
    }
  };

  const defaultId =
    [saved?.defaultModel, provider?.defaultModelId].find(
      (id): id is string => !!id && ids.includes(id),
    ) ?? ids[0];
  const removed = families?.ok ? families.removed : undefined;
  // Nothing to add from until a key lists the models: a provider with no
  // credential saved, no rows of its own and nothing listed is shown locked.
  const locked =
    !connected &&
    entries.length === 0 &&
    userModels.length === 0 &&
    !(families?.ok && families.families.length > 0);
  const hasFree = (families?.families ?? []).some((f) => f.versions.some((v) => v.free));

  const entryLabel = (entry: ModelEntry): string => {
    const row = rows.get(entryId(entry));
    if (row) return displayModelLabel(providerId, row.label, row);
    const family = families?.families.find((f) => f.family === entry.family);
    const label = family?.familyLabel ?? entry.family;
    return entry.version === LATEST ? label : `${label} ${entry.version}`;
  };

  return (
    <div className="flex flex-col gap-2 text-sm" data-testid="model-entries">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">
          {t("settings.models.entries.title")}
          {entries.length > 0 ? (
            <span className="ml-2 text-muted-foreground text-xs" data-testid="model-entries-count">
              {entries.length}
            </span>
          ) : null}
        </span>
        <div className="flex items-center gap-2">
          {ui?.customModels ? (
            <Button
              size="sm"
              variant="outline"
              data-testid="model-entries-add-custom"
              disabled={locked}
              onClick={() => setUserDialog({ open: true, editing: null })}
            >
              {t("settings.models.entries.customAdd")}
            </Button>
          ) : null}
          {hasFree ? (
            <Button
              size="sm"
              variant="outline"
              data-testid="model-entries-add-free"
              onClick={() => setFreePickerOpen(true)}
            >
              {t("settings.models.entries.addFree")}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            data-testid="model-entries-add"
            disabled={locked}
            onClick={() => setPickerOpen(true)}
          >
            {t("settings.models.entries.add")}
          </Button>
        </div>
      </div>
      {entries.length > 0 ? (
        <span className="text-muted-foreground text-xs" data-testid="model-entries-hint">
          {t("settings.models.entries.hint", { name: providerLabel })}
        </span>
      ) : null}
      <ModelsUiNote ui={ui} />

      {removed && removed.ids.length > 0 ? (
        <div
          className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs"
          data-testid="model-entries-removed"
        >
          <span className="flex-1">
            {t("settings.models.entries.removedNotice", {
              name: providerLabel,
              count: String(removed.ids.length),
              models: removed.ids.join(", "),
            })}
          </span>
          <Button
            size="sm"
            variant="ghost"
            data-testid="model-entries-removed-dismiss"
            onClick={async () => {
              await providersDismissRemoved(bridge, providerId).catch(() => {});
              void load(false);
            }}
          >
            {t("settings.models.entries.dismiss")}
          </Button>
        </div>
      ) : null}

      {families && !families.ok && !locked ? (
        <div
          className="flex items-center gap-2 text-destructive text-xs"
          data-testid="model-entries-list-error"
        >
          <span className="flex-1">
            {t("settings.models.entries.listFailed", { name: providerLabel })}
          </span>
          <Button size="sm" variant="ghost" onClick={() => void load(true)}>
            {t("settings.models.entries.retry")}
          </Button>
        </div>
      ) : null}

      {saveFailed ? (
        <p className="text-destructive text-xs" data-testid="model-entries-save-error">
          {t("settings.models.entries.saveFailed")}
        </p>
      ) : null}

      {entries.length > 0 && defaultId ? (
        <label className="flex flex-col gap-1">
          <span className="font-medium">{t("settings.models.defaultModel")}</span>
          <Select
            value={defaultId}
            onValueChange={(value) => void write(entries, value)}
            options={entries.map((entry) => ({ value: entryId(entry), label: entryLabel(entry) }))}
            placeholder={t("settings.models.selectModel")}
            className="mt-1 w-full"
            testId="model-entries-default"
          />
        </label>
      ) : null}

      <div className="rounded-md border">
        {entries.length === 0 ? (
          <div className="flex items-center justify-center gap-2 p-3">
            <p
              className="text-center text-muted-foreground text-sm"
              data-testid="model-entries-empty"
            >
              {locked
                ? t("settings.models.entries.needsKey")
                : t("settings.models.entries.empty")}
            </p>
            {locked && families && !families.ok ? (
              <Button
                size="sm"
                variant="ghost"
                data-testid="model-entries-locked-retry"
                onClick={() => void load(true)}
              >
                {t("settings.models.entries.retry")}
              </Button>
            ) : null}
          </div>
        ) : (
          entries.map((entry) => {
            const id = entryId(entry);
            const model = rows.get(id);
            const info = model?.entry;
            const pinned = entry.version !== LATEST;
            const label = entryLabel(entry);
            // What the entry runs on today: its window and its price (or
            // Free), as Add models showed them when it was picked.
            const figures = model
              ? [contextFigure(model, t), priceFigure(model, t, locale)].filter(Boolean).join(" · ")
              : "";
            return (
              <div
                key={id}
                className="flex items-start gap-2 border-b px-3 py-2 last:border-b-0"
                data-testid={`model-entry-row-${id}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate">{label}</span>
                    {model?.free ? <FreeModelIcon /> : null}
                    {pinned ? (
                      <PinIcon
                        className="size-3 shrink-0 text-muted-foreground"
                        aria-label={t("settings.models.entries.pinned")}
                      />
                    ) : null}
                    {info?.preview ? (
                      <Badge
                        variant="muted"
                        size="sm"
                        title={t("settings.models.entries.previewHint")}
                      >
                        {t("settings.models.entries.preview")}
                      </Badge>
                    ) : null}
                    {info?.unverified ? (
                      <Badge
                        variant="muted"
                        size="sm"
                        title={t("settings.models.entries.unverifiedHint")}
                        data-testid={`model-entry-unverified-${id}`}
                      >
                        {t("settings.models.entries.unverified")}
                      </Badge>
                    ) : null}
                  </div>
                  <div className="text-muted-foreground text-xs">
                    {!info
                      ? t("settings.models.entries.unavailable")
                      : pinned
                        ? t("settings.models.entries.pinned")
                        : info.resolvedVersion
                          ? t("settings.models.entries.latestNow", { version: info.resolvedVersion })
                          : t("settings.models.entries.latest")}
                  </div>
                  {info?.resolvedId ? (
                    <div className="truncate font-mono text-muted-foreground text-xs">
                      {info.resolvedId}
                    </div>
                  ) : null}
                  {figures ? (
                    <div
                      className="text-muted-foreground text-xs tabular-nums"
                      data-testid={"model-entry-figures-" + id}
                    >
                      {figures}
                    </div>
                  ) : null}
                </div>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("settings.models.entries.remove", { model: label })}
                  data-testid={`model-entry-remove-${id}`}
                  onClick={() => void write(entries.filter((e) => entryId(e) !== id))}
                >
                  <XIcon className="size-4" />
                </Button>
              </div>
            );
          })
        )}
      </div>

      {userModels.length > 0 ? (
        <div className="flex flex-col gap-1" data-testid="user-models">
          <span className="font-medium">
            {t("settings.models.entries.customSection")}
            <span className="ml-2 text-muted-foreground text-xs">{userModels.length}</span>
          </span>
          <div className="rounded-md border">
            {userModels.map((model) => (
              <div
                key={model.id}
                className="flex items-center gap-2 border-b px-3 py-2 last:border-b-0"
                data-testid={`user-model-row-${model.id}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate">{model.name || model.id}</div>
                  <div className="truncate font-mono text-muted-foreground text-xs">{model.id}</div>
                </div>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("settings.models.entries.customEdit", { model: model.name || model.id })}
                  data-testid={`user-model-edit-${model.id}`}
                  onClick={() => setUserDialog({ open: true, editing: model })}
                >
                  <PencilIcon className="size-4" />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("settings.models.entries.customRemove", { model: model.name || model.id })}
                  data-testid={`user-model-remove-${model.id}`}
                  onClick={() => void writeUserModels(userModels.filter((m) => m.id !== model.id))}
                >
                  <XIcon className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {ui?.customModels ? (
        <UserModelDialog
          open={userDialog.open}
          onOpenChange={(next) => setUserDialog((prev) => ({ ...prev, open: next }))}
          editing={userDialog.editing}
          existingIds={[
            ...(families?.families ?? []).flatMap((f) => f.versions.map((v) => v.id)),
            ...userModels.map((m) => m.id),
          ]}
          formats={ui.customModels.formats}
          providerLabel={providerLabel}
          onSubmit={async (model) => {
            const editingId = userDialog.editing?.id;
            setUserDialog({ open: false, editing: null });
            await writeUserModels([...userModels.filter((m) => m.id !== editingId), model]);
          }}
        />
      ) : null}

      <ModelEntryPickerDialog
        ui={ui}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        providerId={providerId}
        providerLabel={providerLabel}
        families={families}
        entries={entries}
        onRefresh={() => load(true)}
        onAdd={async (added) => {
          setPickerOpen(false);
          await write([...entries, ...added.filter((e) => !ids.includes(entryId(e)))]);
        }}
      />
      <ModelEntryPickerDialog
        ui={ui}
        freeOnly
        open={freePickerOpen}
        onOpenChange={setFreePickerOpen}
        providerId={providerId}
        providerLabel={providerLabel}
        families={families}
        entries={entries}
        onRefresh={() => load(true)}
        onAdd={async (added) => {
          setFreePickerOpen(false);
          await write([...entries, ...added.filter((e) => !ids.includes(entryId(e)))]);
        }}
      />
    </div>
  );
}

function matches(family: ProviderFamilyDetail, query: string): { family: boolean; versions: boolean } {
  if (!query) return { family: true, versions: false };
  const inFamily =
    family.familyLabel.toLowerCase().includes(query) || family.family.toLowerCase().includes(query);
  const inVersions = family.versions.some(
    (v) => v.versionLabel.toLowerCase().includes(query) || v.id.toLowerCase().includes(query),
  );
  return { family: inFamily || inVersions, versions: !inFamily && inVersions };
}

/**
 * The Free models view of a provider's families: only versions the provider
 * prices at zero, each a PINNED entry. A family's Latest is left out on
 * purpose — it follows the newest version, which need not be free, so a
 * Latest entry could start billing without the user changing anything. The one
 * exception is a family of a single unversioned model: its Latest is that
 * model and nothing else.
 */
export function freeOnlyFamilies(families: readonly ProviderFamilyDetail[]): ProviderFamilyDetail[] {
  return pinnableFamilies(families, (v) => !!v.free);
}

/** Families cut to the versions `keep` accepts that can be offered PINNED (see
 *  `freeOnlyFamilies` for the one Latest exception). */
export function pinnableFamilies(
  families: readonly ProviderFamilyDetail[],
  keep: (version: ProviderFamilyVersion) => boolean,
): ProviderFamilyDetail[] {
  const out: ProviderFamilyDetail[] = [];
  for (const family of families) {
    const versions = family.versions.filter(
      (v) => keep(v) && (v.versionLabel || family.versions.length === 1),
    );
    if (versions.length > 0) out.push({ ...family, versions });
  }
  return out;
}

export function ModelEntryPickerDialog({
  freeOnly = false,
  open,
  onOpenChange,
  providerId,
  providerLabel,
  families,
  entries,
  onRefresh,
  onAdd,
  ui,
}: {
  /** A provider mod's declared look (groups, badges, empty text). */
  ui?: ProviderModelsUi;
  /** Offer only the provider's free models (`freeOnlyFamilies`). */
  freeOnly?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whose display rules name the options (`modelDisplay.ts`). */
  providerId: string;
  providerLabel: string;
  families: ProviderModelFamilies | null;
  entries: readonly ModelEntry[];
  onRefresh: () => Promise<void>;
  onAdd: (entries: ModelEntry[]) => void | Promise<void>;
}) {
  const t = useT();
  const locale = useLocale();
  const [search, setSearch] = React.useState("");
  const [selected, setSelected] = React.useState<Map<string, ModelEntry>>(new Map());
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = React.useState(false);
  const [othersOpen, setOthersOpen] = React.useState(false);

  // A fresh listing whenever the dialog opens (the user asked to look).
  React.useEffect(() => {
    if (!open) return;
    setSearch("");
    setFilter(null);
    setSelected(new Map());
    setExpanded(new Set());
    setOthersOpen(false);
    setRefreshing(true);
    void onRefresh().finally(() => setRefreshing(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const added = React.useMemo(() => new Set(entries.map(entryId)), [entries]);
  // A tag filter (manifest `modelsUi.filters`) narrows the list the way Free
  // models does: to exact versions, each pinned.
  const [filter, setFilter] = React.useState<string | null>(null);
  const pinOnly = freeOnly || filter !== null;
  const all = React.useMemo(() => {
    const base = freeOnly ? freeOnlyFamilies(families?.families ?? []) : families?.families ?? [];
    return filter === null ? base : pinnableFamilies(base, (v) => !!v.tags?.includes(filter));
  }, [freeOnly, families, filter]);
  const query = search.trim().toLowerCase();
  // Models outside the curated catalog: offered apart, pinned, unverified.
  const others = React.useMemo(
    () =>
      pinOnly || !families?.ok
        ? []
        : pinnableFamilies(families.others ?? [], () => true).filter(
            (family) => matches(family, query).family,
          ),
    [pinOnly, families, query],
  );
  const groupLabel = (key: string): string => {
    const declared = ui?.groups?.[key]?.label;
    if (declared) return resolveLocalizedText(declared, locale);
    if (key === USER_MODEL_GROUP) return t("settings.models.entries.groupCustom");
    return key;
  };
  const groups = React.useMemo(() => {
    const out = new Map<string, Array<{ family: ProviderFamilyDetail; openByQuery: boolean }>>();
    for (const family of all) {
      const hit = matches(family, query);
      if (!hit.family) continue;
      const vendor = familyGroup(family);
      const list = out.get(vendor) ?? [];
      list.push({ family, openByQuery: hit.versions });
      out.set(vendor, list);
    }
    return orderedGroups([...out.entries()], ui, groupLabel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, query, ui, locale]);
  const showVendors = groups.some(([vendor]) => vendor !== "");

  const toggle = (entry: ModelEntry) =>
    setSelected((prev) => {
      const next = new Map(prev);
      const id = entryId(entry);
      if (next.has(id)) next.delete(id);
      else next.set(id, entry);
      return next;
    });

  const option = (
    entry: ModelEntry,
    title: React.ReactNode,
    detail: string,
    testId: string,
    preview = false,
    free = false,
    tags: readonly string[] | undefined = undefined,
  ) => {
    const id = entryId(entry);
    const isAdded = added.has(id);
    // Under the summary, the exact id the option resolves to now: families
    // whose names read alike (GPT Luna, GPT Luna batch, ~openai/...-latest)
    // differ there.
    return (
      <label
        key={id}
        className="flex cursor-pointer items-start gap-2 px-3 py-1.5 hover:bg-accent/30"
        data-testid={testId}
      >
        <input
          type="checkbox"
          className="mt-1"
          checked={isAdded || selected.has(id)}
          disabled={isAdded}
          onChange={() => toggle(entry)}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate">{title}</span>
            {free ? <FreeModelIcon /> : null}
            <TagBadges tags={tags} ui={ui} />
            {preview ? (
              <Badge variant="muted" size="sm" title={t("settings.models.entries.previewHint")}>
                {t("settings.models.entries.preview")}
              </Badge>
            ) : null}
          </div>
          <div className="text-muted-foreground text-xs">
            {[detail, isAdded ? t("settings.models.entries.added") : ""].filter(Boolean).join(" · ")}
          </div>
          {entry.id ? (
            <div className="truncate font-mono text-muted-foreground text-xs" data-testid={"resolved-id-" + testId}>
              {entry.id}
            </div>
          ) : null}
        </div>
      </label>
    );
  };

  const renderFreeFamily = (family: ProviderFamilyDetail, kind: "free" | "other" = "free") => (
    <div key={family.family} data-testid={`model-${kind}-family-${family.family}`}>
      {family.versions.map((v) =>
        option(
          { family: family.family, version: v.versionLabel || LATEST, id: v.id },
          displayModelLabel(
            providerId,
            v.versionLabel ? `${family.familyLabel} ${v.versionLabel}` : family.familyLabel,
            v,
          ),
          versionSummary(v, t, locale),
          `model-${kind}-option-${family.family}@${v.versionLabel || LATEST}`,
          v.preview,
          !!v.free,
          badgeTags(v),
        ),
      )}
    </div>
  );

  const renderFamily = (family: ProviderFamilyDetail, openByQuery: boolean) => {
    const latest = latestOf(family);
    const versions = family.versions.filter((v) => v.versionLabel);
    const stable = versions.filter((v) => !v.preview);
    const previews = versions.filter((v) => v.preview);
    const isOpen = openByQuery || expanded.has(family.family);
    return (
      <div key={family.family} className="border-b last:border-b-0" data-testid={`model-family-${family.family}`}>
        <div className="flex items-start gap-1">
          <div className="min-w-0 flex-1">
            {latest
              ? option(
                  { family: family.family, version: LATEST, id: latest.id },
                  displayModelLabel(providerId, family.familyLabel, latest),
                  [
                    latest.versionLabel
                      ? t("settings.models.entries.latestNow", { version: latest.versionLabel })
                      : "",
                    versionSummary(latest, t, locale),
                  ]
                    .filter(Boolean)
                    .join(" · "),
                  `model-family-latest-${family.family}`,
                  false,
                  !!latest.free,
                  badgeTags(latest),
                )
              : (
                  <div className="px-3 py-1.5">
                    {/* No Latest row to carry the Free mark: the family wears
                        it when every version it has is free. */}
                    <div className="flex items-center gap-1.5">
                      <span className="truncate">{family.familyLabel}</span>
                      {family.versions.every((v) => v.free) ? <FreeModelIcon /> : null}
                    </div>
                    <div className="text-muted-foreground text-xs">
                      {t("settings.models.entries.previewOnly")}
                    </div>
                  </div>
                )}
          </div>
          {versions.length > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              className="mt-1 mr-1 shrink-0 gap-1 text-muted-foreground text-xs"
              aria-expanded={isOpen}
              aria-label={t("settings.models.entries.showVersions", { model: family.familyLabel })}
              data-testid={`model-family-expand-${family.family}`}
              onClick={() =>
                setExpanded((prev) => {
                  const next = new Set(prev);
                  if (next.has(family.family)) next.delete(family.family);
                  else next.add(family.family);
                  return next;
                })
              }
            >
              {t("settings.models.entries.versions", { count: String(versions.length) })}
              {isOpen ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
            </Button>
          ) : null}
        </div>
        {isOpen ? (
          <div className="pb-1 pl-5">
            {stable.map((v) =>
              option(
                { family: family.family, version: v.versionLabel, id: v.id },
                displayModelLabel(providerId, `${family.familyLabel} ${v.versionLabel}`, v),
                versionSummary(v, t, locale),
                `model-version-option-${family.family}@${v.versionLabel}`,
                false,
                !!v.free,
                badgeTags(v),
              ),
            )}
            {previews.length > 0 ? (
              <>
                <div className="px-3 pt-1.5 pb-0.5 text-muted-foreground text-xs">
                  {t("settings.models.entries.previewSection")}
                </div>
                {previews.map((v) =>
                  option(
                    { family: family.family, version: v.versionLabel, id: v.id },
                    displayModelLabel(providerId, `${family.familyLabel} ${v.versionLabel}`, v),
                    versionSummary(v, t, locale),
                    `model-version-option-${family.family}@${v.versionLabel}`,
                    true,
                    !!v.free,
                    badgeTags(v),
                  ),
                )}
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" data-testid="model-entry-picker">
        <DialogHeader>
          <DialogTitle>
            {t(freeOnly ? "settings.models.entries.freePickerTitle" : "settings.models.entries.pickerTitle", {
              name: providerLabel,
            })}
          </DialogTitle>
          <DialogDescription>
            {t(freeOnly ? "settings.models.entries.freePickerHint" : "settings.models.entries.pickerHint")}
          </DialogDescription>
        </DialogHeader>
        <ModelsUiNote ui={ui} />
        {ui?.filters?.length ? (
          <div className="flex flex-wrap gap-1.5" data-testid="model-entry-picker-filters">
            {[null, ...ui.filters].map((name) => (
              <Button
                key={name ?? "_all"}
                size="sm"
                variant={filter === name ? "default" : "outline"}
                aria-pressed={filter === name}
                data-testid={`model-entry-filter-${name ?? "all"}`}
                onClick={() => setFilter(name)}
              >
                {name === null
                  ? t("settings.models.entries.filterAll")
                  : ui.tags?.[name]
                    ? resolveLocalizedText(ui.tags[name]!.label, locale)
                    : name}
              </Button>
            ))}
          </div>
        ) : null}
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("settings.models.entries.pickerSearch")}
          aria-label={t("settings.models.entries.pickerSearch")}
          data-testid="model-entry-picker-search"
          autoFocus
        />
        {families && !families.ok ? (
          <p className="text-destructive text-xs" data-testid="model-entry-picker-error">
            {all.length > 0
              ? t("settings.models.entries.pickerStale")
              : t("settings.models.entries.listFailed", { name: providerLabel })}
          </p>
        ) : null}
        <div className="max-h-96 overflow-y-auto rounded-md border">
          {all.length === 0 && refreshing ? (
            <p className="p-3 text-center text-muted-foreground text-sm">
              {t("settings.models.entries.pickerLoading")}
            </p>
          ) : groups.length === 0 && others.length === 0 ? (
            <p className="p-3 text-center text-muted-foreground text-sm" data-testid="model-entry-picker-empty">
              {all.length === 0 && ui?.empty
                ? resolveLocalizedText(ui.empty, locale)
                : t("settings.models.entries.pickerNoMatch")}
            </p>
          ) : (
            groups.map(([vendor, list]) => (
              <div key={vendor || "_"}>
                {showVendors ? (
                  <div className="sticky top-0 z-10 bg-muted/80 px-3 py-1 font-medium text-muted-foreground text-xs backdrop-blur">
                    {vendor ? groupLabel(vendor) : t("settings.models.entries.otherVendor")}
                  </div>
                ) : null}
                {list.map(({ family, openByQuery }) =>
                  pinOnly ? renderFreeFamily(family) : renderFamily(family, openByQuery),
                )}
              </div>
            ))
          )}
          {others.length > 0 ? (
            <div data-testid="model-other-section">
              <button
                type="button"
                className="sticky top-0 z-10 flex w-full items-center gap-1 bg-muted/80 px-3 py-1 text-left font-medium text-muted-foreground text-xs backdrop-blur"
                aria-expanded={othersOpen || !!query}
                data-testid="model-other-toggle"
                onClick={() => setOthersOpen((prev) => !prev)}
              >
                {othersOpen || query ? (
                  <ChevronDownIcon className="size-3.5" />
                ) : (
                  <ChevronRightIcon className="size-3.5" />
                )}
                {t("settings.models.entries.otherModels", { count: String(others.length) })}
              </button>
              {othersOpen || query ? (
                <>
                  <p className="px-3 py-1.5 text-muted-foreground text-xs">
                    {t("settings.models.entries.otherModelsHint")}
                  </p>
                  {others.map((family) => renderFreeFamily(family, "other"))}
                </>
              ) : null}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" data-testid="model-entry-picker-cancel" onClick={() => onOpenChange(false)}>
            {t("settings.models.cancel")}
          </Button>
          <Button
            disabled={selected.size === 0}
            data-testid="model-entry-picker-add"
            onClick={() => void onAdd([...selected.values()])}
          >
            {t("settings.models.entries.pickerAdd", { count: String(selected.size) })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The provider's usage / balance, one line for the status card. */
export function RuntimeProviderUsageLine({ providerId }: { providerId: string }) {
  const t = useT();
  const formatAmount = useFormatAmount();
  const entry = useProviderUsage(providerId);
  const usage = entry?.usage;
  if (!usage) return null;
  const parts = [
    ...usage.windows.map((w) =>
      t("tokenUsage.planSummary", {
        pct: w.usedPercent.toFixed(0),
        window: t(windowLabelKey(w, true)),
      }),
    ),
    ...(usage.balanceNote ? [t(balanceNoteKey(usage.balanceNote))] : []),
    ...(usage.amounts ?? []).map((a) =>
      t("tokenUsage.amountSummary", { label: t(amountLabelKey(a)), amount: formatAmount(a) }),
    ),
  ];
  if (parts.length === 0) return null;
  return (
    <span className="text-muted-foreground text-xs tabular-nums" data-testid="runtime-provider-usage">
      {parts.join(" · ")}
    </span>
  );
}
