/**
 * The topbar items the person's plugins contribute (F-25), just before the
 * search control. A command item's press asks the runtime to run it for the
 * active session (`mods.pressTopbar`), and is not rendered for a connection
 * that may not press. An app's icon (F-40) opens the app's session, with or
 * without a session on screen, and reads as pressed while the app is on
 * screen; its press is first offered to the app's background module.
 */
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { resolveLocalizedText } from "../../../config/localizedText";
import { useLocale, useT } from "../i18n";
import { useCan } from "../useCan";
import { ModIconSlot, useModContributions } from "../mods/modContributionsView";
import type { ModsPressTopbarResult } from "../../runtimeProtocol/modContributions";
import type { AppPressMenuItem, AppPressTrigger } from "../../runtimeProtocol/modApps";
import { runAppPress, type AppPressPort } from "../apps/appPress";
import type { MessageKey } from "../i18n/messages/en";

const REFUSAL: Record<Extract<ModsPressTopbarResult, { ok: false }>["reason"], MessageKey> = {
  waiting: "topbar.pluginItemWaiting",
  unknown: "topbar.pluginItemUnavailable",
  "no-session": "topbar.pluginItemNoSession",
};
const NOTICE_MS = 4000;
const NO_APPS: readonly never[] = [];
/** The largest count the badge spells out; beyond it the pill reads `99+`. */
export const APP_BADGE_MAX = 99;

/** The pill's text for a badge count; empty for a count that draws no pill. */
export function appBadgeText(count: number | undefined): string {
  if (count === undefined || !Number.isFinite(count) || count <= 0) return "";
  return count > APP_BADGE_MAX ? `${APP_BADGE_MAX}+` : String(Math.floor(count));
}

export type PluginTopbarItem = {
  id: string;
  label: string;
  /** The hover text when it is not `label`. */
  tooltip?: string;
  icon: React.ReactNode;
  /** A command item runs for the active session, so it waits for one. */
  needsSession: boolean;
  /** An app's icon while the app is on screen; absent for every other item. */
  pressed?: boolean;
  /** The pill on an app's icon, as drawn (`appBadgeText`); absent when none. */
  badge?: string;
  /** An app whose background module is at work: a ring turns around its icon. */
  busy?: boolean;
  testId: string;
  /** The test id in the More menu once folded. */
  foldedTestId: string;
  /** An app's icon: its context menu is the app's own. */
  isApp?: boolean;
};

/** Where a menu is drawn: a point of the page, in CSS pixels. */
export type MenuPoint = { x: number; y: number };

/** The point under the left end of `element`. */
export function menuPointOf(element: Element): MenuPoint {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom };
}

/** The menu an app's module answered a press with. */
export type AppPressMenuState = {
  itemId: string;
  appId: string;
  /** The app's title, as the menu's accessible name. */
  title: string;
  items: readonly AppPressMenuItem[];
  at: MenuPoint;
};

/** The item id of app `type`, apart from the plugin's command items. */
export const appItemId = (type: string) => `app:${type}`;

export type PluginTopbarState = {
  items: readonly PluginTopbarItem[];
  /** Run an item for the active session; a refusal shows a notice beside the bar. `at` is where an app's menu would be drawn. */
  press: (id: string, at?: MenuPoint) => void;
  /** The context menu of an app's icon was asked for. */
  pressContext: (id: string, at: MenuPoint) => void;
  menu: AppPressMenuState | null;
  pickMenuItem: (item: string) => void;
  closeMenu: () => void;
  notice: { id: string; key: MessageKey } | null;
  sessionReady: boolean;
};

/** The plugin topbar items and their press, or `null` when none render. */
export function usePluginTopbarItems(
  activeSessionId: string | undefined,
  /** Run the item `id` for `sessionId`. Omitted: no command item renders. */
  onPress: ((sessionId: string, id: string) => Promise<ModsPressTopbarResult>) | undefined,
  /** Open the app of template `type`. Omitted: no app icon renders. */
  onOpenApp?: (type: string) => void,
  /** The template type of the app on screen. */
  shownAppType?: string,
  /** Starts the sign-ins an app's MCP servers wait on, at its press. Omitted: none is started. */
  onAppSignIn?: (urls: readonly string[]) => void,
  /** Offers an app's press to its background module. Omitted: every press opens the app. */
  appPress?: AppPressPort,
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
  const apps = contributions.apps ?? NO_APPS;
  const [menu, setMenu] = React.useState<AppPressMenuState | null>(null);
  const pressSeq = React.useRef(0);
  const pressApp = React.useCallback(
    (id: string, trigger: AppPressTrigger, at: MenuPoint | undefined, item?: string): boolean => {
      const app = onOpenApp ? apps.find(entry => appItemId(entry.type) === id) : undefined;
      if (!app) return false;
      const seq = ++pressSeq.current;
      setNotice(null);
      setMenu(null);
      runAppPress(
        appPress,
        app.appId,
        {
          open: () => onOpenApp!(app.type),
          defaultSignIn: () => {
            if (app.signInUrls?.length) onAppSignIn?.(app.signInUrls);
          },
          showMenu: items =>
            setMenu({ itemId: id, appId: app.appId, title: resolveLocalizedText(app.title, locale), items, at: at ?? { x: 0, y: 0 } }),
          isCurrent: () => seq === pressSeq.current,
        },
        trigger,
        item,
      );
      return true;
    },
    [onOpenApp, onAppSignIn, appPress, apps, locale],
  );
  const pressContext = React.useCallback((id: string, at: MenuPoint) => void pressApp(id, "context", at), [pressApp]);
  const closeMenu = React.useCallback(() => setMenu(null), []);
  const pickMenuItem = React.useCallback(
    (item: string) => {
      if (menu) pressApp(menu.itemId, "menu", menu.at, item);
    },
    [menu, pressApp],
  );
  const press = React.useCallback(
    (id: string, at?: MenuPoint) => {
      if (pressApp(id, "primary", at)) return;
      if (!onPress || !activeSessionId) return;
      onPress(activeSessionId, id).then(
        result => setNotice(result.ok ? null : { id, key: REFUSAL[result.reason] }),
        () => setNotice({ id, key: "topbar.pluginItemUnavailable" }),
      );
    },
    [onPress, pressApp, activeSessionId],
  );
  const commands = onPress && canPress ? contributions.topbar : [];
  const appItems = onOpenApp ? apps : [];
  if (commands.length === 0 && appItems.length === 0) return null;
  return {
    items: [
      ...commands.map(item => ({
        id: item.id,
        label: t("topbar.pluginItemTooltip", {
          title: resolveLocalizedText(item.title, locale),
          plugin: item.plugin,
        }),
        icon: <ModIconSlot icon={item.icon} icons={contributions.icons} className="size-4" />,
        needsSession: true,
        testId: `topbar-plugin-item-${item.id.replace(":", "--")}`,
        foldedTestId: `topbar-folded-plugin-${item.id.replace(":", "--")}`,
      })),
      ...appItems.map(app => {
        const title = resolveLocalizedText(app.title, locale);
        const badge = appBadgeText(app.badge);
        return {
          id: appItemId(app.type),
          label: app.busy
            ? t("topbar.openAppBusy", { title })
            : badge
              ? t("topbar.openAppAttention", { title, count: badge })
              : t("topbar.openApp", { title }),
          tooltip: app.busy ? t("topbar.appBusy", { title }) : badge ? t("topbar.appAttention", { title, count: badge }) : title,
          icon: <ModIconSlot icon={app.icon} icons={contributions.icons} className="size-4" />,
          needsSession: false,
          pressed: app.type === shownAppType,
          isApp: true,
          ...(badge ? { badge } : {}),
          ...(app.busy ? { busy: true } : {}),
          testId: `topbar-app-${app.appId}`,
          foldedTestId: `topbar-folded-app-${app.appId}`,
        };
      }),
    ],
    press,
    pressContext,
    menu,
    pickMenuItem,
    closeMenu,
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
                  className={item.badge || item.busy ? "relative" : undefined}
                  {...(item.busy ? { "aria-busy": true } : {})}
                  data-testid={item.testId}
                  data-topbar-fold={pluginFoldKey(item.id)}
                  aria-label={item.label}
                  {...(item.pressed === undefined ? {} : { "aria-pressed": item.pressed })}
                  disabled={item.needsSession && !state.sessionReady}
                  onClick={event => state.press(item.id, menuPointOf(event.currentTarget))}
                  {...(item.isApp
                    ? {
                        onContextMenu: (event: React.MouseEvent<HTMLButtonElement>) => {
                          event.preventDefault();
                          state.pressContext(item.id, menuPointOf(event.currentTarget));
                        },
                      }
                    : {})}
                >
                  {item.busy ? <span className="opacity-50">{item.icon}</span> : item.icon}
                  {item.busy ? (
                    <span
                      aria-hidden="true"
                      data-testid={`${item.testId}-busy`}
                      className="pointer-events-none absolute inset-0.5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground motion-reduce:animate-none"
                    />
                  ) : null}
                  {item.badge ? (
                    <span
                      aria-hidden="true"
                      data-testid={`${item.testId}-badge`}
                      className="pointer-events-none absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[color-mix(in_oklab,var(--destructive)_16%,var(--background))] px-1 text-[10px] font-semibold leading-none text-destructive ring-1 ring-background"
                    >
                      {item.badge}
                    </span>
                  ) : null}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{item.tooltip ?? item.label}</TooltipContent>
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
