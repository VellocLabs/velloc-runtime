import * as React from "react";
import { CheckIcon, Loader2Icon } from "lucide-react";
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
import type { useT } from "../../i18n";
import type { NexusSettingsBridge } from "../../nexusSettingsBridge";
import { providersSetModBaseUrl } from "../clients";
import { baseUrlProblemKey } from "../modProviderForm";
import { OptionRow, OptionRowList } from "./ModOptionRows";

/**
 * The settings field a provider mod binds to its base URL: the address in
 * force (the person's, else the manifest's default), a save, and a way back
 * to the default. The runtime decides what is accepted; a host outside the
 * provider's declared domains is saved only after the person confirms it
 * here, and cancelling keeps the address as it was.
 */
export function ModBaseUrlField({
  providerId,
  providerName,
  fieldName,
  label,
  hint,
  defaultBaseUrl,
  storedBaseUrl,
  bridge,
  onSaved,
  t,
}: {
  providerId: string;
  providerName: string;
  fieldName: string;
  label: string;
  hint?: string;
  defaultBaseUrl: string;
  /** The person's address, when one is stored. */
  storedBaseUrl: string | undefined;
  bridge: NexusSettingsBridge;
  onSaved: () => Promise<void>;
  t: ReturnType<typeof useT>;
}) {
  const inForce = storedBaseUrl?.trim() || defaultBaseUrl;
  const [draft, setDraft] = React.useState(inForce);
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(false);
  const [confirmHost, setConfirmHost] = React.useState<string | null>(null);
  // Another client, or this one's save, changed the stored address.
  React.useEffect(() => {
    setDraft(inForce);
  }, [inForce]);

  const id = `mod-base-url-${fieldName}`;
  const changed = draft.trim() !== inForce;
  const overridden = inForce !== defaultBaseUrl;

  const send = async (baseUrl: string | null, confirmedHost?: string) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    setDone(false);
    try {
      const result = await providersSetModBaseUrl(bridge, {
        id: providerId,
        baseUrl,
        ...(confirmedHost !== undefined ? { confirmedHost } : {}),
      });
      if (result.ok) {
        setConfirmHost(null);
        setDraft(result.baseUrl);
        setDone(true);
        await onSaved();
      } else if (result.reason === "needs-confirmation") {
        setConfirmHost(result.host);
      } else {
        setConfirmHost(null);
        setProblem(t(baseUrlProblemKey(result.problem)));
      }
    } catch (error) {
      setProblem(
        t("settings.models.mod.baseUrl.saveFailed", { error: error instanceof Error ? error.message : String(error) }),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <OptionRowList data-testid="mod-base-url">
        <OptionRow
          id={id}
          label={label}
          testId="mod-base-url-row"
          mark={
            done && !changed ? (
              <span className="flex items-center gap-1 font-normal text-success text-xs" data-testid="mod-base-url-saved">
                {t("settings.models.apiKeySaved")}
                <CheckIcon className="size-3.5" />
              </span>
            ) : null
          }
          hint={
            <>
              {hint ? <span className="block">{hint}</span> : null}
              {overridden ? (
                <span className="block" data-testid="mod-base-url-default-hint">
                  {t("settings.models.mod.baseUrl.defaultHint", { url: defaultBaseUrl })}
                </span>
              ) : null}
            </>
          }
          note={
            problem ? (
              <span className="text-destructive text-xs" data-testid="mod-base-url-problem">
                {problem}
              </span>
            ) : null
          }
        >
          <Input
            id={id}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            className="h-8 w-72 max-w-full text-xs"
            data-testid="mod-base-url-input"
            value={draft}
            disabled={busy}
            onChange={(event) => {
              setDraft(event.target.value);
              setProblem(null);
              setDone(false);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              if (changed) void send(draft.trim());
            }}
          />
          <Button
            size="sm"
            disabled={busy || !changed || draft.trim() === ""}
            data-testid="mod-base-url-save"
            onClick={() => void send(draft.trim())}
          >
            {busy ? <Loader2Icon className="size-3.5 animate-spin" aria-hidden /> : null}
            {t("settings.models.mod.baseUrl.save")}
          </Button>
          {overridden ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              data-testid="mod-base-url-use-default"
              onClick={() => void send(null)}
            >
              {t("settings.models.mod.baseUrl.useDefault")}
            </Button>
          ) : null}
        </OptionRow>
      </OptionRowList>
      <Dialog
        open={confirmHost !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmHost(null);
        }}
      >
        <DialogContent data-testid="mod-base-url-confirm-dialog">
          <DialogHeader>
            <DialogTitle>{t("settings.models.mod.baseUrl.confirmTitle", { host: confirmHost ?? "" })}</DialogTitle>
            <DialogDescription>
              {t("settings.models.mod.baseUrl.confirmDescription", { host: confirmHost ?? "", provider: providerName })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" data-testid="mod-base-url-confirm-cancel" onClick={() => setConfirmHost(null)}>
              {t("settings.models.cancel")}
            </Button>
            <Button
              size="sm"
              disabled={busy}
              data-testid="mod-base-url-confirm"
              onClick={() => {
                if (confirmHost !== null) void send(draft.trim(), confirmHost);
              }}
            >
              {t("settings.models.mod.baseUrl.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
