/**
 * Asks for the settings a plugin declares `required: true` that are still
 * unset, right after it is turned on or installed (F-25). Save stores what was
 * filled in (`plugins/setSettings`); Skip leaves the plugin on with those
 * fields unset, which Settings then marks as missing. A sensitive field is a
 * password input and is stored as the settings page stores it.
 */
import * as React from "react";
import { Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ModsOptionValue, ModsUserConfig } from "../../../runtimeProtocol";
import { useT } from "../../i18n";
import { draftOf, valuesOf, type OptionsDraft } from "../modOptionsDraft";
import { OptionFieldControl, OptionRow, OptionRowList } from "./ModOptionRows";

/** The plugin being set up and its missing fields. */
export type PluginSetupTarget = {
  /** What the dialog calls it. */
  name: string;
  /** Its id, as `pluginConfigs` is keyed. */
  plugin: string;
  /** A directory plugin's folder. */
  path?: string;
  fields: ModsUserConfig["fields"];
};

export function PluginSetupDialog({
  target,
  onSave,
  onSkip,
}: {
  target: PluginSetupTarget | null;
  /** Stores the values; a throw is shown in the dialog. */
  onSave: (target: PluginSetupTarget, values: Record<string, ModsOptionValue>) => Promise<void>;
  onSkip: () => void;
}) {
  const t = useT();
  const config = React.useMemo<ModsUserConfig | null>(
    () => (target ? { fields: target.fields, values: {} } : null),
    [target],
  );
  const [draft, setDraft] = React.useState<OptionsDraft>({});
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    setDraft(config ? draftOf(config) : {});
    setBusy(false);
    setError(null);
  }, [config]);
  const filled = config ? Object.keys(valuesOf(config, draft).values).length > 0 : false;

  const save = async () => {
    if (!target || !config || busy) return;
    const { values, invalid } = valuesOf(config, draft);
    if (invalid.length > 0) {
      setError(t("settings.plugins.mods.options.invalid", { fields: invalid.join(", ") }));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave(target, values);
    } catch (e) {
      setError(t("settings.plugins.mods.options.saveFailed", { error: e instanceof Error ? e.message : String(e) }));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onSkip();
      }}
    >
      <DialogContent data-testid="plugin-setup-dialog" className="sm:max-w-xl">
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("settings.plugins.setup.title", { name: target?.name ?? "" })}</DialogTitle>
            <DialogDescription>{t("settings.plugins.setup.description", { name: target?.name ?? "" })}</DialogDescription>
          </DialogHeader>
          {target ? (
            <OptionRowList>
              {Object.entries(target.fields).map(([name, field]) => {
                const id = `plugin-setup-${name}`;
                return (
                  <OptionRow
                    key={name}
                    id={id}
                    label={field.title || name}
                    required
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
                      kept={false}
                      disabled={busy}
                      onChange={(next) => setDraft((prev) => ({ ...prev, [name]: next }))}
                    />
                  </OptionRow>
                );
              })}
            </OptionRowList>
          ) : null}
          <span className="text-destructive text-xs empty:hidden" data-testid="plugin-setup-error">
            {error ?? ""}
          </span>
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" data-testid="plugin-setup-skip" disabled={busy} onClick={onSkip}>
              {t("settings.plugins.setup.skip")}
            </Button>
            <Button type="submit" size="sm" data-testid="plugin-setup-save" disabled={busy || !filled}>
              {busy ? <Loader2Icon className="size-3.5 animate-spin" aria-hidden /> : null}
              {t("settings.plugins.mods.options.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
