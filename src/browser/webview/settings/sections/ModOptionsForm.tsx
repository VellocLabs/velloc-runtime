/**
 * A plugin's `userConfig` values, edited in Settings → Plugins (F-25), from the
 * mod's `mods/state` row. A sensitive field's stored value is never shown. Save
 * writes `mods.setOptions` (settings.json `pluginConfigs.<id>.options`) and reloads
 * every session's plugins; it stays inert until a field changes.
 */
import * as React from "react";
import { createPortal } from "react-dom";
import { CheckCircle2Icon, ChevronDownIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { ModsOptionValue, ModsUserConfig } from "../../../runtimeProtocol";
import { useT } from "../../i18n";

type Draft = Record<string, string | boolean>;

/** How long the "saved" tip stays up. */
const SAVED_TIP_MS = 2600;
/** The tip's fade-out, the end of its {@link SAVED_TIP_MS}. */
const SAVED_TIP_FADE_MS = 300;

function draftOf(config: ModsUserConfig): Draft {
  const draft: Draft = {};
  for (const [name, field] of Object.entries(config.fields)) {
    const value = config.values[name] ?? field.default;
    if (field.type === "boolean") draft[name] = value === true;
    else if (field.sensitive) draft[name] = "";
    else if (Array.isArray(value)) draft[name] = (value as readonly string[]).join(", ");
    else draft[name] = value === undefined ? "" : String(value);
  }
  return draft;
}

/** The draft as values to store: a blank text is "unset" (the default
 *  applies); a blank sensitive field keeps what is stored. */
function valuesOf(
  config: ModsUserConfig,
  draft: Draft,
): { values: Record<string, ModsOptionValue>; keep: string[]; invalid: string[] } {
  const values: Record<string, ModsOptionValue> = {};
  const keep: string[] = [];
  const invalid: string[] = [];
  for (const [name, field] of Object.entries(config.fields)) {
    const raw = draft[name];
    if (field.type === "boolean") {
      values[name] = raw === true;
      continue;
    }
    const text = typeof raw === "string" ? raw.trim() : "";
    if (text === "") {
      if (field.sensitive && config.values[name] !== undefined && config.values[name] !== "") {
        // Kept: the stored secret is not shown and not replaced. What this
        // form holds is only its mask, so the runtime keeps it by name.
        keep.push(name);
      }
      continue;
    }
    if (field.type === "number") {
      // A number input: finite, and within the field's bounds.
      const number = Number(text);
      if (
        !Number.isFinite(number) ||
        (field.min !== undefined && number < field.min) ||
        (field.max !== undefined && number > field.max)
      ) {
        invalid.push(field.title || name);
        continue;
      }
      values[name] = number;
    } else if (field.type === "string" && field.multiple) {
      values[name] = text.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
    } else {
      values[name] = text;
    }
  }
  return { values, keep, invalid };
}

/** The tip after a save: bottom-centre, a moment, then it fades out.
 *  Portaled to the body so a transformed settings container cannot pin its
 *  `fixed`. Visual only — the form's own live region, mounted all along,
 *  announces the same words (a region inserted already filled often is not). */
function SavedTip({ plugin, text, leaving }: { plugin: string; text: string; leaving: boolean }) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      data-testid={`mod-options-saved-tip-${plugin}`}
      aria-hidden
      className={cn(
        "pointer-events-none fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border bg-card px-3.5 py-2 text-foreground text-xs shadow-lg transition-opacity duration-300 animate-in fade-in slide-in-from-bottom-2",
        leaving && "opacity-0",
      )}
    >
      <CheckCircle2Icon className="size-4 shrink-0 text-success" aria-hidden />
      <span>{text}</span>
    </div>,
    document.body,
  );
}

export function ModOptionsForm({
  plugin,
  config,
  loadedSessions = 0,
  onSave,
}: {
  plugin: string;
  config: ModsUserConfig;
  /** How many sessions run the mod now: the ones a save reloads it in. */
  loadedSessions?: number;
  /** Absent: the connection cannot write (no `mods.setOptions`); the form is read-only. */
  onSave?: (values: Record<string, ModsOptionValue>, keep: string[]) => Promise<void>;
}) {
  const t = useT();
  const [draft, setDraft] = React.useState<Draft>(() => draftOf(config));
  // The draft as last saved (or as loaded): what `dirty` compares against.
  const baseline = React.useRef<Draft>(draftOf(config));
  const [state, setState] = React.useState<{ kind: "idle" } | { kind: "saving" } | { kind: "failed"; error: string }>({ kind: "idle" });
  // The tip's words, fixed when the save lands; null once it has faded.
  const [tip, setTip] = React.useState<string | null>(null);
  // The last stretch of the tip's moment: it fades rather than blinking out.
  const [tipLeaving, setTipLeaving] = React.useState(false);
  const configKey = JSON.stringify(config);
  // A reload brought new values (another client saved): the draft follows.
  React.useEffect(() => {
    const next = draftOf(config);
    setDraft(next);
    baseline.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configKey]);
  React.useEffect(() => {
    if (tip === null) return;
    setTipLeaving(false);
    const fade = setTimeout(() => setTipLeaving(true), SAVED_TIP_MS - SAVED_TIP_FADE_MS);
    const timer = setTimeout(() => setTip(null), SAVED_TIP_MS);
    return () => {
      clearTimeout(fade);
      clearTimeout(timer);
    };
  }, [tip]);
  const names = Object.keys(config.fields);
  if (names.length === 0) return null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline.current);
  const set = (name: string, next: string | boolean) => setDraft((prev) => ({ ...prev, [name]: next }));
  const save = async () => {
    if (!onSave) return;
    const { values, keep, invalid } = valuesOf(config, draft);
    if (invalid.length > 0) {
      setState({ kind: "failed", error: t("settings.plugins.mods.options.invalid", { fields: invalid.join(", ") }) });
      return;
    }
    setState({ kind: "saving" });
    setTip(null);
    try {
      await onSave(values, keep);
      // What is stored is now the draft: Save goes inert until the next edit.
      baseline.current = { ...draft };
      setState({ kind: "idle" });
      setTip(
        loadedSessions > 0
          ? t("settings.plugins.mods.options.savedReloaded", { name: plugin, n: loadedSessions })
          : t("settings.plugins.mods.options.savedIdle", { name: plugin }),
      );
    } catch (e) {
      setState({ kind: "failed", error: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <form
      // The bounds are checked by `valuesOf`, which names the field in the
      // catalog's words; the browser's own bubble would stop the submit first.
      noValidate
      data-testid={`mod-options-${plugin}`}
      className="mt-3 flex flex-col gap-2.5 border-border/60 border-t pt-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-medium text-foreground text-xs">{t("settings.plugins.mods.options.title")}</span>
        <span className="text-muted-foreground text-xs">{t("settings.plugins.mods.options.hint")}</span>
      </div>
      <div className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/70 bg-muted/20">
        {names.map((name) => {
          const field = config.fields[name]!;
          const id = `mod-option-${plugin}-${name}`;
          const value = draft[name];
          return (
            // A row wraps its control below the words when the card is narrow.
            <div key={name} data-testid={`${id}-row`} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-3 py-2.5">
              <div className="flex min-w-[12rem] flex-1 flex-col gap-0.5">
                <label htmlFor={id} className="flex items-center gap-1.5 font-medium text-foreground text-xs">
                  <span>{field.title || name}</span>
                  {field.required ? <span className="text-destructive">*</span> : null}
                  {field.sensitive ? (
                    <span className="font-normal text-muted-foreground">{t("settings.plugins.mods.options.sensitive")}</span>
                  ) : null}
                </label>
                {field.description ? (
                  <span className="text-[11px] text-muted-foreground leading-snug">{field.description}</span>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center">
                {field.type === "boolean" ? (
                  <Switch
                    id={id}
                    data-testid={id}
                    checked={value === true}
                    disabled={!onSave}
                    onCheckedChange={(next) => set(name, next)}
                  />
                ) : field.type === "string" && field.options ? (
                  // A native picker, drawn as the settings select trigger: as
                  // wide as its longest choice, not the row.
                  <div className="relative">
                    <select
                      id={id}
                      data-testid={id}
                      className="h-8 min-w-[7rem] max-w-[14rem] cursor-pointer appearance-none truncate rounded-md border border-input bg-background pr-7 pl-2.5 text-xs outline-none transition-colors hover:bg-accent/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                      value={typeof value === "string" ? value : ""}
                      disabled={!onSave}
                      onChange={(event) => {
                        // Read now: React clears `currentTarget` once the handler
                        // returns, before the updater runs.
                        const next = event.currentTarget.value;
                        set(name, next);
                      }}
                    >
                      {!field.required ? <option value="">{t("settings.plugins.mods.options.unset")}</option> : null}
                      {field.options.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                    <ChevronDownIcon
                      className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-muted-foreground"
                      aria-hidden
                    />
                  </div>
                ) : (
                  <Input
                    id={id}
                    data-testid={id}
                    type={field.sensitive ? "password" : field.type === "number" ? "number" : "text"}
                    {...(field.type === "number" && field.min !== undefined ? { min: field.min } : {})}
                    {...(field.type === "number" && field.max !== undefined ? { max: field.max } : {})}
                    // A number is a short right-aligned figure; a text gets
                    // room for a path or a list.
                    className={cn("h-8 text-xs", field.type === "number" ? "w-24 text-right tabular-nums" : "w-56")}
                    value={typeof value === "string" ? value : ""}
                    placeholder={
                      field.sensitive && config.values[name] !== undefined && config.values[name] !== ""
                        ? t("settings.plugins.mods.options.keptSecret")
                        : field.default !== undefined
                          ? String(Array.isArray(field.default) ? (field.default as readonly string[]).join(", ") : field.default)
                          : undefined
                    }
                    disabled={!onSave}
                    onChange={(event) => {
                      // Read now: React clears `currentTarget` once the handler
                      // returns, before the updater runs.
                      const next = event.currentTarget.value;
                      set(name, next);
                    }}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
      {onSave ? (
        // Right-aligned, the way a settings form ends; a failure reads just
        // before the button, a success is the tip.
        <div className="flex items-center justify-end gap-2" data-testid={`mod-options-actions-${plugin}`}>
          <span className="text-destructive text-xs" data-testid={`mod-options-status-${plugin}`}>
            {state.kind === "failed" ? t("settings.plugins.mods.options.saveFailed", { error: state.error }) : ""}
          </span>
          <Button
            type="submit"
            size="sm"
            className="min-w-[4.5rem] text-xs"
            data-testid={`mod-options-save-${plugin}`}
            disabled={state.kind === "saving" || !dirty}
          >
            {state.kind === "saving" ? <Loader2Icon className="size-3.5 animate-spin" aria-hidden /> : null}
            {t("settings.plugins.mods.options.save")}
          </Button>
        </div>
      ) : null}
      {/* Mounted all along, filled when a save lands: the tip's words for a
          screen reader. */}
      <span role="status" aria-live="polite" className="sr-only" data-testid={`mod-options-announce-${plugin}`}>
        {tip ?? ""}
      </span>
      {tip !== null ? <SavedTip plugin={plugin} text={tip} leaving={tipLeaving} /> : null}
    </form>
  );
}
