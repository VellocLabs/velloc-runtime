import * as React from "react";
import { CheckIcon, PlusIcon, RouteIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { useT } from "../../i18n";
import { sendsThroughView, type RouterPeerRow } from "../modRouterView";

/**
 * Where a router's own settings app is opened from (F-27, F-40). Empty until
 * the provider's settings app is wired; it receives the router's id.
 */
export function RouterSettingsAppEntry(_props: { providerId: string }): React.JSX.Element | null {
  return null;
}

/**
 * A router's part of the provider editor (F-27): the switch that adds it and
 * the "sends through" card. A router has no key, no sign-in and no base URL,
 * so none of those rows is drawn. Names come from the page's labels only.
 */
export function ModRouterPanel({
  providerId,
  name,
  routesTo,
  peers,
  added,
  onAdd,
  onConnectProvider,
  t,
}: {
  providerId: string;
  name: string;
  routesTo: "*" | string[] | undefined;
  /** Every provider the page knows, the router itself among them. */
  peers: readonly RouterPeerRow[];
  /** The router's entry is stored (it is listed on the home page). */
  added: boolean;
  onAdd: () => Promise<void>;
  /** The page's own way to set up another provider; absent = not offered. */
  onConnectProvider?: () => void;
  t: ReturnType<typeof useT>;
}) {
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState<string | null>(null);
  const view = sendsThroughView(routesTo, providerId, peers);

  const add = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(null);
    try {
      await onAdd();
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3" data-testid="mod-router-panel">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground text-xs">{t("settings.models.mod.router.hint")}</span>
        <RouterSettingsAppEntry providerId={providerId} />
      </div>
      {added ? (
        <span className="flex items-center gap-1 text-success text-xs" data-testid="mod-router-on">
          <CheckIcon className="size-3.5" />
          {t("settings.models.mod.router.on")}
        </span>
      ) : (
        <Button
          type="button"
          size="sm"
          className="self-start"
          disabled={busy}
          data-testid="mod-router-use"
          onClick={() => void add()}
        >
          {t("settings.models.mod.router.use", { name })}
        </Button>
      )}
      {failed ? (
        <span className="text-destructive text-xs" data-testid="mod-router-use-failed">
          {t("settings.models.mod.saveFailed", { error: failed })}
        </span>
      ) : null}

      <div
        className="flex flex-col gap-2 rounded-md border bg-muted/30 p-3"
        data-testid="mod-router-sends-through"
        data-scope={view.scope}
        data-needs-providers={view.needsProviders ? "true" : "false"}
      >
        <div className="flex items-center gap-2">
          <RouteIcon className="size-4 text-muted-foreground" aria-hidden />
          <span className="font-medium text-sm">{t("settings.models.mod.router.title")}</span>
        </div>
        <span className="text-muted-foreground text-xs" data-testid="mod-router-scope">
          {view.scope === "any" ? t("settings.models.mod.router.any") : t("settings.models.mod.router.list")}
        </span>
        {view.targets.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5" data-testid="mod-router-targets">
            {view.targets.map((target) => (
              <li key={target.id} data-testid={`mod-router-target-${target.id}`} data-set-up={target.setUp ? "true" : "false"}>
                <Badge variant={target.setUp ? "muted" : "outline"} size="sm">
                  {target.setUp
                    ? target.label
                    : t("settings.models.mod.router.targetNotSetUp", { name: target.label })}
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}
        {view.unknown > 0 ? (
          <span className="text-muted-foreground text-xs" data-testid="mod-router-unknown">
            {view.unknown === 1
              ? t("settings.models.mod.router.unknownOne", { count: view.unknown })
              : t("settings.models.mod.router.unknown", { count: view.unknown })}
          </span>
        ) : null}
        {view.needsProviders ? (
          <div className="flex flex-col gap-2" data-testid="mod-router-needs-providers">
            <span className="text-xs">
              {t("settings.models.mod.router.needsProviders", { name, count: view.reachable })}
            </span>
            {onConnectProvider ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="self-start"
                data-testid="mod-router-connect-provider"
                onClick={onConnectProvider}
              >
                <PlusIcon className="size-3.5" aria-hidden />
                {t("settings.models.mod.router.connectProvider")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
