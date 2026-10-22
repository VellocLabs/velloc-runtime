/**
 * A plugin's `userConfig` values, edited in Settings → Plugins (F-25), from the
 * mod's `mods/state` row. A sensitive field's stored value is never shown. Save
 * writes `mods.setOptions` (settings.json `pluginConfigs.<id>.options`) and reloads
 * every session's plugins; it stays inert until a field changes.
 */
import * as React from "react";
import { createPortal } from "react-dom";
import { CheckCircle2Icon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ModsOptionValue, ModsUserConfig } from "../../../runtimeProtocol";
import { useT } from "../../i18n";
import { draftChanged, draftOf, holdsStoredSecret, valuesOf, type OptionsDraft } from "../modOptionsDraft";
import { OptionFieldControl, OptionRow, OptionRowList } from "./ModOptionRows";

/** How long the "saved" tip stays up. */
const SAVED_TIP_MS = 2600;
/** The tip's fade-out, the end of its {@link SAVED_TIP_MS}. */
const SAVED_TIP_FADE_MS = 300;

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
  const [draft, setDraft] = React.useState<OptionsDraft>(() => draftOf(config));
  // The draft as last saved (or as loaded): what `dirty` compares against.
  const baseline = React.useRef<OptionsDraft>(draftOf(config));
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
  const dirty = draftChanged(draft, baseline.current);
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
      <OptionRowList>
        {names.map((name) => {
          const field = config.fields[name]!;
          const id = `mod-option-${plugin}-${name}`;
          return (
            <OptionRow
              key={name}
              id={id}
              label={field.title || name}
              required={field.required}
              mark={
                field.sensitive ? (
                  <span className="font-normal text-muted-foreground">{t("settings.plugins.mods.options.sensitive")}</span>
                ) : null
              }
              hint={field.description || undefined}
            >
              <OptionFieldControl
                id={id}
                field={field}
                value={draft[name]}
                kept={holdsStoredSecret(config, name)}
                disabled={!onSave}
                onChange={(next) => set(name, next)}
              />
            </OptionRow>
          );
        })}
      </OptionRowList>
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
