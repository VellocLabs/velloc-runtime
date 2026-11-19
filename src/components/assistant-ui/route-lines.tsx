import { useAssistantState } from "@assistant-ui/react";
import { type FC } from "react";
import type { RoutedVia } from "@/models/drivers/providerRouter";
import { useT } from "@/browser/webview/i18n";
import {
  ROUTED_VIA_KEY,
  routeMemberName,
  routeNoticeKey,
  useRouteNames,
} from "@/browser/webview/routeDisplay";

function useRoutedVia(): RoutedVia | undefined {
  return useAssistantState(
    (s) =>
      (s.message.metadata.custom as Record<string, unknown> | undefined)?.[
        ROUTED_VIA_KEY
      ] as RoutedVia | undefined,
  );
}

/**
 * The quiet line ahead of a routed reply whose member changed (F-27). Drawn
 * from the reply's record alone: it is no message, so it is never sent to a
 * model, copied with the reply, or edited.
 */
export const RouteSwitchNotice: FC = () => {
  const t = useT();
  const names = useRouteNames();
  const via = useRoutedVia();
  const from = via?.switchedFrom;
  if (!via || !from) return null;
  return (
    <div
      role="note"
      data-role="route-switch-notice"
      data-reason={from.reason ?? "other"}
      className="aui-route-switch-notice select-none px-2 pb-1.5 text-muted-foreground text-xs"
    >
      {t(routeNoticeKey(from.reason), {
        from: routeMemberName(t, names, from),
        to: routeMemberName(t, names, via),
      })}
    </div>
  );
};

/** The member that served a routed reply, beside the reply's clock. */
export const RouteMemberLabel: FC = () => {
  const t = useT();
  const names = useRouteNames();
  const via = useRoutedVia();
  if (!via) return null;
  return (
    <span
      data-role="route-member"
      className="self-center whitespace-nowrap px-1 text-muted-foreground/60 text-xs"
    >
      {t("routeReply.servedBy", { member: routeMemberName(t, names, via) })}
    </span>
  );
};
