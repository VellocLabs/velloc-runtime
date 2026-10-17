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

export function PluginTopbarItems({
  activeSessionId,
  onPress,
}: {
  activeSessionId?: string;
  /** Run the item `id` for `sessionId`. Omitted: nothing renders. */
  onPress?: (sessionId: string, id: string) => Promise<ModsPressTopbarResult>;
}) {
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
    (sessionId: string, id: string) => {
      if (!onPress) return;
      onPress(sessionId, id).then(
        result => setNotice(result.ok ? null : { id, key: REFUSAL[result.reason] }),
        () => setNotice({ id, key: "topbar.pluginItemUnavailable" }),
      );
    },
    [onPress],
  );
  if (!onPress || !canPress || contributions.topbar.length === 0) return null;
  return (
    <>
      {contributions.topbar.map(item => {
        const title = resolveLocalizedText(item.title, locale);
        const tooltip = t("topbar.pluginItemTooltip", { title, plugin: item.plugin });
        return (
          <React.Fragment key={item.id}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  data-testid={`topbar-plugin-item-${item.id.replace(":", "--")}`}
                  aria-label={tooltip}
                  disabled={!activeSessionId}
                  onClick={() => {
                    if (activeSessionId) press(activeSessionId, item.id);
                  }}
                >
                  <ModIconSlot icon={item.icon} icons={contributions.icons} className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{tooltip}</TooltipContent>
            </Tooltip>
            {notice?.id === item.id ? (
              <span
                role="status"
                data-testid="topbar-plugin-item-notice"
                className="max-w-56 truncate rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground"
              >
                {t(notice.key)}
              </span>
            ) : null}
          </React.Fragment>
        );
      })}
    </>
  );
}
