import * as React from "react";
import { PencilIcon, Trash2Icon } from "lucide-react";

import { McpServerDetailDialog } from "@/components/assistant-ui/mcp-server-detail-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useUnsavedEditsGate } from "@/glic/unsavedEditsGate";

import type { NexusMcpServerConfig } from "../../../../settings/settingsTypes";
import type { PluginMcpServerListing } from "../../../bridge/protocol";
import type { McpToolSummary } from "../../../../mcp/toolSummary";
import { useT } from "../../i18n";
import { useSettingsBridge } from "../../nexusSettingsBridge";
import {
  mcpSettingsList,
  mcpSettingsRemove,
  mcpSettingsTestConnect,
  mcpSettingsUpsert,
} from "../clients";
import {
  SettingsGroupLabel,
  SettingsNotice,
  SettingsSubpageLayout,
  settingsText,
} from "../SettingsSubpageLayout";
import { canReadClipboard, readClipboard } from "../../../../utils/clipboard";

/**
 * MCP servers — CRUD over the
 * worker `mcpSettings` capability (settings.json); "Save & connect" first runs
 * the worker MCP client's connection test (`mcpSettings.testConnect`). An http
 * server's credential headers are stored by the host and come back from the
 * worker as `{{secret:mcp:…}}` placeholders, which an edit keeps as they are.
 */

type Transport = "stdio" | "http";

type FormState = {
  id: string;
  transport: Transport;
  command: string;
  args: string;
  url: string;
  env: string;
  headers: string;
};

const EMPTY_FORM: FormState = {
  id: "",
  transport: "stdio",
  command: "",
  args: "",
  url: "",
  env: "",
  headers: "",
};

/** Parse `KEY=VALUE` lines into a record (blank lines ignored). */
/** Compact error text for surfacing a failed bridge call inline. */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function parseKv(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Parse header lines accepting BOTH `Name: Value` and `Name=Value` (matching
 * the original) — splits on whichever delimiter appears first.
 */
function headerLinesToMap(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    const eq = trimmed.indexOf("=");
    let idx = -1;
    if (colon > 0 && eq > 0) idx = Math.min(colon, eq);
    else idx = colon > 0 ? colon : eq;
    if (idx <= 0) continue;
    out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function formatKv(record?: Record<string, string>, sep = "="): string {
  if (!record) return "";
  return Object.entries(record)
    .map(([k, v]) => `${k}${sep}${v}`)
    .join("\n");
}

function formToConfig(form: FormState): NexusMcpServerConfig {
  if (form.transport === "http") {
    return {
      transport: "http",
      url: form.url.trim(),
      ...(headerLinesToMap(form.headers)
        ? { headers: headerLinesToMap(form.headers) }
        : {}),
    };
  }
  const args = form.args.trim() ? form.args.trim().split(/\s+/) : undefined;
  return {
    transport: "stdio",
    command: form.command.trim(),
    ...(args ? { args } : {}),
    ...(parseKv(form.env) ? { env: parseKv(form.env) } : {}),
  };
}

function configToForm(id: string, config: NexusMcpServerConfig): FormState {
  // Infer transport from url presence when the imported config omits it.
  const transport: Transport =
    config.transport ?? (config.url ? "http" : "stdio");
  return {
    id,
    transport,
    command: config.command ?? "",
    args: (config.args ?? []).join(" "),
    url: config.url ?? "",
    env: formatKv(config.env),
    headers: formatKv(config.headers, ": "),
  };
}

export function McpSection() {
  const t = useT();
  const bridge = useSettingsBridge();
  const [servers, setServers] = React.useState<
    Record<string, NexusMcpServerConfig>
  >({});
  // Tool counts learned from the pre-save connection test (mcp.testConnect),
  // keyed by server id; shown as "N tools" when known.
  const [toolCounts, setToolCounts] = React.useState<Record<string, number>>(
    {},
  );
  // Servers the enabled plugins declare: listed, never edited here.
  const [pluginServers, setPluginServers] = React.useState<
    PluginMcpServerListing[]
  >([]);
  // The server whose detail view is open, with its tools from a live probe.
  const [detail, setDetail] = React.useState<{
    id: string;
    loading: boolean;
    tools?: McpToolSummary[];
    version?: string;
    instructions?: string;
    error?: string;
  } | null>(null);
  const detailRequest = React.useRef(0);
  const [form, setForm] = React.useState<FormState | null>(null);
  const [editingExisting, setEditingExisting] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  // An open add/edit form is unsaved page-local state — hold the background
  // updater's reload while it is open (glic/unsavedEditsGate.ts).
  useUnsavedEditsGate(form !== null);

  const reload = React.useCallback(async () => {
    if (!bridge) return;
    try {
      const result = await mcpSettingsList(bridge);
      setServers(result.servers);
      setPluginServers(result.pluginServers ?? []);
      setLoadError(null);
    } catch (e) {
      setLoadError(
        t("settings.mcp.loadFailed", {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  }, [bridge, t]);

  React.useEffect(() => {
    void reload();
    if (!bridge) return;
    // Live-refresh when another tab edits MCP config.
    return bridge.subscribeEvents((envelope) => {
      const route = envelope.route as { capability?: string; action?: string };
      if (route?.capability === "mcpSettings" && route?.action === "changed") {
        const payload = envelope.payload as {
          servers?: Record<string, NexusMcpServerConfig>;
        };
        if (payload.servers) setServers(payload.servers);
      }
    });
  }, [bridge, reload]);

  // Off a secure context there is no clipboard READ at all (and no legacy
  // fallback for paste), so the Paste entry is not rendered rather than
  // rendered-and-always-failing. Constant for the page's lifetime.
  const clipboardReadable = React.useMemo(() => canReadClipboard(), []);

  const startAdd = () => {
    setForm({ ...EMPTY_FORM });
    setEditingExisting(false);
    setFormError(null);
  };
  const startEdit = (id: string) => {
    setForm(configToForm(id, servers[id]!));
    setEditingExisting(true);
    setFormError(null);
  };
  const cancel = () => {
    setForm(null);
    setFormError(null);
  };

  const importFromClipboard = async () => {
    setFormError(null);
    // `readClipboard` returns null where the clipboard is unreadable (no
    // secure context) — the button is hidden in that case, so this is the
    // denied-permission path.
    const text = await readClipboard();
    if (text === null) {
      setFormError(t("settings.mcp.clipboardEmpty"));
      return;
    }
    if (!text.trim()) {
      setFormError(t("settings.mcp.clipboardEmpty"));
      return;
    }
    try {
      const parsed = JSON.parse(text) as {
        mcpServers?: Record<string, NexusMcpServerConfig>;
      } & Record<string, NexusMcpServerConfig>;
      const map = parsed.mcpServers ?? parsed;
      const entries = Object.entries(map ?? {});
      if (entries.length === 0) throw new Error("no servers");
      const [id, cfg] = entries[0]!;
      setForm(configToForm(id, cfg));
      setEditingExisting(false);
    } catch {
      setFormError(t("settings.mcp.clipboardInvalid"));
    }
  };

  const save = async () => {
    if (!bridge || !form) return;
    let id = form.id.trim();
    setFormError(null);
    // Field validation (matches the original's pre-save guards).
    if (form.transport === "http" && !form.url.trim()) {
      setFormError(t("settings.mcp.urlRequired"));
      return;
    }
    if (form.transport === "stdio" && !form.command.trim()) {
      setFormError(t("settings.mcp.commandRequired"));
      return;
    }
    if (!editingExisting && id && servers[id]) {
      setFormError(t("settings.mcp.alreadyExists", { id }));
      return;
    }

    setSaving(true);
    try {
      const config = formToConfig(form);
      // Pre-save connection test (mcpSettings.testConnect): probe the server,
      // then auto-name from its reported identity when the name was left blank
      // and capture its version + tool count. A host that cannot run MCP
      // servers errors, and the catch falls back to a name-required save.
      let toolCount: number | undefined;
      try {
        const test = await mcpSettingsTestConnect(bridge, config);
        if (!test.ok) {
          setFormError(
            test.error
              ? t("settings.mcp.connectFailed", { error: test.error })
              : t("settings.mcp.connectFailedGeneric"),
          );
          return;
        }
        toolCount = test.toolCount;
        if (!id && test.serverName) id = test.serverName.trim();
        // Persist the display metadata alongside the launch config —
        // `NexusMcpServerConfig.version/toolCount` exist for exactly this
        // (the list's "N tools" tag must survive a reload). The pool's
        // config-drift differ ignores them.
        if (test.serverVersion) config.version = test.serverVersion;
        if (test.toolCount !== undefined) config.toolCount = test.toolCount;
      } catch {
        /* no connection test on this host — proceed to a name-required save */
      }
      if (!id) {
        setFormError(t("settings.mcp.noName"));
        return;
      }
      if (!editingExisting && servers[id]) {
        setFormError(t("settings.mcp.alreadyExists", { id }));
        return;
      }
      await mcpSettingsUpsert(bridge, id, config);
      if (toolCount !== undefined) {
        const savedId = id;
        setToolCounts((t) => ({ ...t, [savedId]: toolCount }));
      }
      setForm(null);
      await reload();
    } catch (e) {
      // Surface a failed upsert/reload in the form.
      setFormError(t("settings.mcp.saveFailed", { error: errMsg(e) }));
    } finally {
      setSaving(false);
    }
  };

  // Opens the detail view and lists the server's tools through a probe
  // connection; a later open supersedes an earlier one still in flight.
  const openDetail = async (id: string) => {
    const config = servers[id];
    if (!bridge || !config) return;
    const request = ++detailRequest.current;
    setDetail({ id, loading: true });
    let next: NonNullable<typeof detail>;
    try {
      const test = await mcpSettingsTestConnect(bridge, config);
      next = test.ok
        ? {
            id,
            loading: false,
            tools: test.tools ?? [],
            ...(test.serverVersion ? { version: test.serverVersion } : {}),
            ...(test.instructions ? { instructions: test.instructions } : {}),
          }
        : {
            id,
            loading: false,
            error: test.error
              ? t("settings.mcp.connectFailed", { error: test.error })
              : t("settings.mcp.connectFailedGeneric"),
          };
      if (test.ok && test.toolCount !== undefined) {
        const toolCount = test.toolCount;
        setToolCounts((counts) => ({ ...counts, [id]: toolCount }));
      }
    } catch (e) {
      next = { id, loading: false, error: t("settings.mcp.connectFailed", { error: errMsg(e) }) };
    }
    if (request === detailRequest.current) setDetail(next);
  };

  const closeDetail = () => {
    detailRequest.current += 1;
    setDetail(null);
  };

  const remove = async (id: string) => {
    if (!bridge) return;
    try {
      await mcpSettingsRemove(bridge, id);
      await reload();
    } catch (e) {
      // Was silent — a failed remove just closed/no-op'd with nothing shown.
      setLoadError(t("settings.mcp.removeFailed", { id, error: errMsg(e) }));
    }
  };

  if (!bridge) {
    return (
      <SettingsSubpageLayout title={t("settings.mcp.title")}>
        <p className="text-muted-foreground text-sm">
          {t("settings.bridgeUnavailable")}
        </p>
      </SettingsSubpageLayout>
    );
  }

  const entries = Object.entries(servers);

  return (
    <SettingsSubpageLayout
      title={t("settings.mcp.title")}
      actions={
        !form ? (
          <Button
            variant="outline"
            size="sm"
            data-testid="mcp-add-server"
            onClick={startAdd}
          >
            {t("settings.mcp.addServer")}
          </Button>
        ) : null
      }
    >
      <SettingsNotice testId="mcp-info-banner">
        {t("settings.mcp.infoBanner")}
      </SettingsNotice>

      <div className="flex flex-col gap-3">
        {loadError ? (
          <p className="rounded border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-sm">
            {loadError}
          </p>
        ) : null}
        {entries.length === 0 && pluginServers.length === 0 && !form ? (
          <p className="text-muted-foreground text-sm">
            {t("settings.mcp.none")}
          </p>
        ) : (
          entries.map(([id, config]) => {
            // Session-fresh count from the last connect test wins; fall back
            // to the persisted one so the tag survives reload/restart.
            const count = toolCounts[id] ?? config.toolCount;
            return (
              <div
                key={id}
                data-testid={`mcp-server-row-${id}`}
                className="flex items-center justify-between gap-3 rounded-xl border border-border/70 bg-card p-4"
              >
                <button
                  type="button"
                  data-testid={`mcp-server-details-${id}`}
                  title={t("settings.mcp.details")}
                  aria-label={t("settings.mcp.detailsAria", { id })}
                  onClick={() => void openDetail(id)}
                  className="-m-2 min-w-0 flex-1 rounded-lg p-2 text-start outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="flex min-w-0 items-center gap-2 font-medium text-sm">
                    <span className="truncate">{id}</span>
                    <Badge variant="muted" size="sm" className="shrink-0">
                      {(config.transport ?? "stdio").toUpperCase()}
                    </Badge>
                  </div>
                  {count !== undefined ? (
                    <div className="mt-1 text-muted-foreground text-xs">
                      {count}{" "}
                      {t(
                        count === 1
                          ? "settings.mcp.toolSingular"
                          : "settings.mcp.toolPlural",
                      )}
                    </div>
                  ) : null}
                </button>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    title={t("settings.mcp.edit")}
                    aria-label={t("settings.mcp.editAria", { id })}
                    onClick={() => startEdit(id)}
                  >
                    <PencilIcon className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    title={t("settings.mcp.remove")}
                    aria-label={t("settings.mcp.removeAria", { id })}
                    onClick={() => void remove(id)}
                  >
                    <Trash2Icon className="size-4" />
                  </Button>
                </div>
              </div>
            );
          })
        )}

        {form ? (
          <div className="flex flex-col gap-3 rounded-xl border border-border/70 bg-muted/30 p-4">
            {!editingExisting && clipboardReadable ? (
              <div className="border-b pb-3">
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="mcp-import"
                  onClick={() => void importFromClipboard()}
                >
                  {t("settings.mcp.import")}
                </Button>
              </div>
            ) : null}
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">{t("settings.mcp.serverName")}</span>
              <Input
                data-testid="mcp-server-id"
                value={form.id}
                disabled={editingExisting}
                onChange={(e) => setForm({ ...form, id: e.target.value })}
                placeholder={
                  editingExisting
                    ? undefined
                    : t("settings.mcp.serverNamePlaceholder")
                }
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">{t("settings.mcp.transport")}</span>
              <Select
                testId="mcp-transport"
                value={form.transport}
                onValueChange={(v) =>
                  setForm({ ...form, transport: v as Transport })
                }
                options={[
                  {
                    value: "stdio",
                    label: (
                      <span className="flex flex-col">
                        <span>stdio</span>
                        <span className="text-muted-foreground text-xs">
                          {t("settings.mcp.stdioDesc")}
                        </span>
                      </span>
                    ),
                  },
                  {
                    value: "http",
                    label: (
                      <span className="flex flex-col">
                        <span>http</span>
                        <span className="text-muted-foreground text-xs">
                          {t("settings.mcp.httpDesc")}
                        </span>
                      </span>
                    ),
                  },
                ]}
                className="w-full"
              />
            </label>
            {form.transport === "stdio" ? (
              <>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium">
                    {t("settings.mcp.command")}
                  </span>
                  <Input
                    data-testid="mcp-command"
                    value={form.command}
                    onChange={(e) =>
                      setForm({ ...form, command: e.target.value })
                    }
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium">{t("settings.mcp.args")}</span>
                  <Input
                    data-testid="mcp-args"
                    value={form.args}
                    onChange={(e) => setForm({ ...form, args: e.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium">{t("settings.mcp.env")}</span>
                  <textarea
                    data-testid="mcp-env"
                    value={form.env}
                    onChange={(e) => setForm({ ...form, env: e.target.value })}
                    rows={3}
                    className="rounded-md border bg-transparent px-3 py-2 font-mono text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  />
                </label>
              </>
            ) : (
              <>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium">{t("settings.mcp.url")}</span>
                  <Input
                    data-testid="mcp-url"
                    value={form.url}
                    onChange={(e) => setForm({ ...form, url: e.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium">
                    {t("settings.mcp.headers")}
                  </span>
                  <textarea
                    data-testid="mcp-headers"
                    value={form.headers}
                    onChange={(e) =>
                      setForm({ ...form, headers: e.target.value })
                    }
                    rows={3}
                    placeholder={t("settings.mcp.headersPlaceholder")}
                    className="rounded-md border bg-transparent px-3 py-2 font-mono text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  />
                </label>
              </>
            )}
            {formError ? (
              <p data-testid="mcp-form-error" className="text-destructive text-xs">
                {formError}
              </p>
            ) : null}
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                data-testid="mcp-cancel"
                onClick={cancel}
              >
                {t("settings.mcp.cancel")}
              </Button>
              <Button
                size="sm"
                data-testid="mcp-save"
                disabled={saving}
                onClick={() => void save()}
              >
                {saving
                  ? t("settings.mcp.testing")
                  : t("settings.mcp.save")}
              </Button>
            </div>
          </div>
        ) : null}

        {pluginServers.length > 0 ? (
          <section
            data-testid="mcp-plugin-servers"
            className="flex flex-col gap-2 pt-2"
          >
            <SettingsGroupLabel>{t("settings.mcp.pluginServers")}</SettingsGroupLabel>
            <p className={settingsText.description}>
              {t("settings.mcp.pluginServersHint")}
            </p>
            {pluginServers.map((server) => (
              <div
                key={`${server.plugin}\u0000${server.name}`}
                data-testid={`mcp-plugin-server-row-${server.name}`}
                className="flex items-center justify-between gap-3 rounded-xl border border-border/70 bg-card p-4"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 font-medium text-sm">
                    <span className="truncate">{server.name}</span>
                    {server.transport ? (
                      <Badge variant="muted" size="sm">
                        {server.transport.toUpperCase()}
                      </Badge>
                    ) : null}
                  </div>
                  <div className="mt-1 text-muted-foreground text-xs">
                    {t("settings.mcp.fromPlugin", { plugin: server.plugin })}
                  </div>
                </div>
              </div>
            ))}
          </section>
        ) : null}

        {/* Footer helper text — matches the original's prose under the list. */}
        <p className="text-[13px] text-muted-foreground">
          {t("settings.mcp.footer")}
        </p>
      </div>
      <McpServerDetailDialog
        open={detail !== null}
        onOpenChange={(open) => {
          if (!open) closeDetail();
        }}
        server={
          detail && servers[detail.id]
            ? {
                name: detail.id,
                origin: { kind: "settings" },
                transport: servers[detail.id].transport ?? "stdio",
                version: detail.version ?? servers[detail.id].version,
                toolCount: toolCounts[detail.id] ?? servers[detail.id].toolCount,
                ...(detail.tools ? { status: "connected" as const, tools: detail.tools } : {}),
                ...(detail.instructions ? { instructions: detail.instructions } : {}),
              }
            : null
        }
        toolsLoading={detail?.loading}
        toolsError={detail?.error}
        onRetry={detail ? () => void openDetail(detail.id) : undefined}
      />
    </SettingsSubpageLayout>
  );
}
