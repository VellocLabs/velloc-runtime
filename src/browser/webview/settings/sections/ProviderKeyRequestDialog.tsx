import * as React from "react";
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
import { resolveLocalizedText } from "../../../../config/localizedText";
import type { ProviderKeyRequest } from "../../../../mods/provider/keyRequest/keyRequestProtocol";
import { useLocale, useT } from "../../i18n";
import { getProviderKeyRequestStore, useProviderKeyRequest } from "../../providerKeyRequestStore";

/**
 * The platform's dialog for a key a router's settings app asked for, DRAWN
 * from the runtime's `providers/keyRequests` state alone; the answer goes
 * back as `providerKeyRequest.answer`. Security: the key lives in the field
 * until it is sent and is cleared with the request; no plugin code runs here.
 */
export function ProviderKeyRequestDialog({ request }: { request: ProviderKeyRequest | undefined }) {
  const t = useT();
  const locale = useLocale();
  const store = getProviderKeyRequestStore();
  const [key, setKey] = React.useState("");
  const id = React.useId();
  const requestId = request?.requestId;
  // A key typed for one request is never carried to the next.
  React.useEffect(() => setKey(""), [requestId]);
  if (!request) return null;
  const name = resolveLocalizedText(request.label, locale);
  const router = request.routerLabel ? resolveLocalizedText(request.routerLabel, locale) : request.routerId;
  const ended = request.ended;
  const close = () => void store.cancel(request.requestId).catch(() => undefined);
  const send = () => {
    const text = key.trim();
    if (text === "" || request.busy) return;
    void store.answer(request.requestId, text).catch(() => undefined);
    setKey("");
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent data-testid="provider-key-request-dialog">
        <DialogHeader>
          <DialogTitle>{t("settings.models.mod.keyRequest.title", { name })}</DialogTitle>
          <DialogDescription>{t("settings.models.mod.keyRequest.description")}</DialogDescription>
        </DialogHeader>
        <p className="text-muted-foreground text-xs" data-testid="provider-key-request-asked-by">
          {request.plugin === undefined
            ? t("settings.models.mod.keyRequest.askedByBuiltIn", { router })
            : t("settings.models.mod.keyRequest.askedBy", { router, plugin: request.plugin })}
        </p>
        {ended ? (
          <>
            <p className="text-sm" role="alert" data-testid="provider-key-request-ended">
              {ended.kind === "duplicate"
                ? t("settings.models.mod.keyRequest.duplicate", { name: ended.name })
                : t("settings.models.mod.keyRequest.failed")}
            </p>
            <DialogFooter>
              <Button size="sm" onClick={close} data-testid="provider-key-request-close">
                {t("settings.models.mod.keyRequest.close")}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form
            noValidate
            className="flex flex-col gap-3"
            data-testid="provider-key-request-form"
            onSubmit={(event) => {
              event.preventDefault();
              send();
            }}
          >
            <label htmlFor={id} className="font-medium text-sm">
              {request.prompt ? resolveLocalizedText(request.prompt, locale) : t("settings.models.apiKey")}
            </label>
            <Input
              id={id}
              data-testid="provider-key-request-input"
              type="password"
              autoComplete="off"
              autoFocus
              disabled={request.busy === true}
              value={key}
              onChange={(event) => setKey(event.currentTarget.value)}
            />
            <DialogFooter>
              <Button type="button" variant="outline" size="sm" onClick={close} disabled={request.busy === true} data-testid="provider-key-request-cancel">
                {t("settings.models.mod.keyRequest.cancel")}
              </Button>
              <Button type="submit" size="sm" disabled={request.busy === true || key.trim() === ""} data-testid="provider-key-request-submit">
                {request.busy ? t("settings.models.mod.keyRequest.adding") : t("settings.models.mod.keyRequest.add")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The dialog over whatever the window shows: mounted once, by the shell. */
export function ProviderKeyRequestHost() {
  return <ProviderKeyRequestDialog request={useProviderKeyRequest()} />;
}
