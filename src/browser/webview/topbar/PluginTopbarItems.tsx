/**
 * The topbar items the person's plugins contribute (F-25), just before the
 * search control. A press asks the runtime to run the item for the active
 * session (`mods.pressTopbar`); what it runs is the runtime's to decide. Not
 * rendered for a connection that may not press.
 */
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { resolveLocalizedText } from "../../../config/localizedText";
import { useLocale, useT } from "../i18n";
import { useCan } from "../useCan";
import { ModIconSlot, useModContributions } from "../mods/modContributionsView";
import type { ModsPressTopbarResult } from "../../runtimeProtocol/modContributions";
import type { MessageKey } from "../i18n/messages/en";

const REFUSAL: Record<Extract<ModsPressTopbarResult, { ok: false }>["reason"], MessageKey> = {
  waiting: "topbar.pluginItemWaiting",
  unknown: "topbar.pluginItemUnavailable",
  "no-session": "topbar.pluginItemNoSession",
};
const NOTICE_MS = 4000;

export type PluginTopbarItem = { id: string; label: string; icon: React.ReactNode };

export type PluginTopbarState = {
  items: readonly PluginTopbarItem[];
  /** Run an item for the active session; a refusal shows a notice beside the bar. */
  press: (id: string) => void;
  notice: { id: string; key: MessageKey } | null;
  sessionReady: boolean;
};

/** The plugin topbar items and their press, or `null` when none render. */
export function usePluginTopbarItems(
  activeSessionId: string | undefined,
  /** Run the item `id` for `sessionId`. Omitted: nothing renders. */
  onPress: ((sessionId: string, id: string) => Promise<ModsPressTopbarResult>) | undefined,
): PluginTopbarState | null {
  const t = useT();
  const locale = useLocale();
  const contributions = useModContributions();
  const canPress = useCan("mods", "pressTopbar");
  const [notice, setNotice] = React.useState<{ id: string; key: MessageKey } | null>(null);
  React.useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);
  const press = React.useCallback(
    (id: string) => {
      if (!onPress || !activeSessionId) return;
      onPress(activeSessionId, id).then(
        result => setNotice(result.ok ? null : { id, key: REFUSAL[result.reason] }),
        () => setNotice({ id, key: "topbar.pluginItemUnavailable" }),
      );
    },
    [onPress, activeSessionId],
  );
  if (!onPress || !canPress || contributions.topbar.length === 0) return null;
  return {
    items: contributions.topbar.map(item => ({
      id: item.id,
      label: t("topbar.pluginItemTooltip", {
        title: resolveLocalizedText(item.title, locale),
        plugin: item.plugin,
      }),
      icon: <ModIconSlot icon={item.icon} icons={contributions.icons} className="size-4" />,
    })),
    press,
    notice,
    sessionReady: !!activeSessionId,
  };
}

/** The unit key an item folds under (`useTopbarFit`). */
export const pluginFoldKey = (id: string) => `plugin:${id}`;

/** The items still in the bar; a notice shows for any item, folded or not. */
export function PluginTopbarItems({
  state,
  folded,
}: {
  state: PluginTopbarState | null;
  folded: ReadonlySet<string>;
}) {
  const t = useT();
  if (!state) return null;
  return (
    <>
      {state.items.map(item => (
        <React.Fragment key={item.id}>
          {folded.has(pluginFoldKey(item.id)) ? null : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  data-testid={`topbar-plugin-item-${item.id.replace(":", "--")}`}
                  data-topbar-fold={pluginFoldKey(item.id)}
                  aria-label={item.label}
                  disabled={!state.sessionReady}
                  onClick={() => state.press(item.id)}
                >
                  {item.icon}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{item.label}</TooltipContent>
            </Tooltip>
          )}
          {state.notice?.id === item.id ? (
            <span
              role="status"
              data-testid="topbar-plugin-item-notice"
              className="max-w-56 truncate rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground"
            >
              {t(state.notice.key)}
            </span>
          ) : null}
        </React.Fragment>
      ))}
    </>
  );
}
