import { CheckIcon, ChevronRightIcon, ClockIcon, Loader2Icon, MonitorIcon, MoonIcon, PaletteIcon, PlusIcon, PowerOffIcon, SunIcon } from "lucide-react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { useEffect, useMemo, useRef, useState, type FC } from "react";

import type { GuestColorScheme } from "@/browser/boot/guestColorScheme";
import { useT } from "@/browser/webview/i18n";
import type { MessageKey } from "@/browser/webview/i18n/messages/en";
import {
  appliedLooks,
  lookBlocked,
  lookInUse,
  themeStandingOf,
  lookKey,
  packTitle,
  THEME_FAILURE_MESSAGE,
  useWaitingLooks,
  type ThemePlugin,
} from "@/browser/webview/mods/themeLooks";
import { useGuestColorScheme } from "@/browser/webview/useGuestColorScheme";
import type { ThemeLook } from "@/pluginHost/registryFormats";
import type { ThemeBackdropScope, ThemeModEntry } from "@/mods/themeMods";
import { isThemeBackdropScope } from "@/mods/themeMods";
import { cn } from "@/lib/utils";
import { useModUi } from "./mod-ui-context";
import { useThemeModsContext } from "./theme-mods-context";

/**
 * The conversation's theme menu (F-25): a right-click on its empty space lists
 * the looks the directory lists for the enabled theme plugins (a press applies
 * one), the mods that have set a theme — a check on each enabled one, a mark on
 * the one whose theme shows — and chooses how far the backdrop reaches. A press
 * on a mod enables or disables the plugin itself.
 */

/** What a right-click keeps its own menu on: text, controls, media, a message, the composer's footer. */
const OWN_MENU_SELECTOR =
  "a,button,input,textarea,select,summary,label,pre,code,img,video,canvas,svg,[contenteditable],[data-message-id],.aui-thread-viewport-footer,[data-slot='thread-top-right']";

/** Whether `target` is empty space of the conversation `root`: nothing above with a menu of its own, no text selected. */
export function isBlankThreadTarget(target: EventTarget | null, root: Element): boolean {
  if (!target || typeof (target as Element).closest !== "function") return false;
  const element = target as Element;
  if (!root.contains(element)) return false;
  const owner = element.closest(OWN_MENU_SELECTOR);
  if (owner && owner !== root && root.contains(owner)) return false;
  const selection = root.ownerDocument.getSelection();
  return !selection || selection.isCollapsed;
}

export type ThemeModRow = ThemeModEntry & { enabled: boolean; showing: boolean };

/** The rows in menu order: by name, so a row keeps its place whatever its state. A disabled mod never shows:
 *  its theme leaves with it, a moment after the press. */
export function orderThemeMods(
  mods: readonly ThemeModEntry[],
  enabled: (plugin: string) => boolean,
  showing: string | undefined,
): ThemeModRow[] {
  return mods
    .map((mod) => {
      const on = enabled(mod.plugin);
      return { ...mod, enabled: on, showing: on && mod.plugin === showing };
    })
    .sort((a, b) => a.plugin.localeCompare(b.plugin));
}

const ITEM_CLASS =
  "flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-start outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[state=open]:bg-accent";
const CONTENT_CLASS =
  "z-50 min-w-56 rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-md";
const SEPARATOR_CLASS = "-mx-1 my-1 h-px bg-border";
const LABEL_CLASS = "px-2 pt-1.5 pb-0.5 text-xs text-muted-foreground";

/** The name of the look `key` names among `plugins`, or undefined. */
function lookNamed(plugins: readonly ThemePlugin[], key: string): string | undefined {
  for (const plugin of plugins) {
    const look = plugin.theme.looks.find((each) => lookKey(plugin.name, each.id) === key);
    if (look) return look.name ?? look.id;
  }
  return undefined;
}

const APPEARANCE: Record<NonNullable<ThemeLook["appearance"]>, MessageKey> = {
  light: "customize.themes.appearance.light",
  dark: "customize.themes.appearance.dark",
  both: "customize.themes.appearance.both",
};

/** Two stacked windows with a scene in the one behind. */
const ThemeModsGlyph: FC = () => (
  <svg
    aria-hidden="true"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="size-4 shrink-0 text-muted-foreground"
  >
    <rect x="3" y="3" width="13" height="13" rx="3" />
    <path d="M8 8h13v10a3 3 0 0 1-3 3h-7a3 3 0 0 1-3-3z" fill="currentColor" fillOpacity="0.18" />
    <circle cx="16.5" cy="13" r="1.6" />
    <path d="M8 19l3.5-3.5 3 3 2-2 4.5 4" />
  </svg>
);

/** The app's own modes, in the Appearance settings' order; each label is that setting's. */
const COLOR_SCHEMES: ReadonlyArray<{ scheme: GuestColorScheme; label: MessageKey; Icon: typeof SunIcon }> = [
  { scheme: "system", label: "settings.appearance.modeSystem", Icon: MonitorIcon },
  { scheme: "light", label: "settings.appearance.modeLight", Icon: SunIcon },
  { scheme: "dark", label: "settings.appearance.modeDark", Icon: MoonIcon },
];

/** A window in small: a picture in its middle alone, or all over it. */
const ScopeThumb: FC<{ scope: ThemeBackdropScope }> = ({ scope }) => (
  <svg
    aria-hidden="true"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.3"
    className="size-4 shrink-0 text-muted-foreground"
  >
    <rect x="1.65" y="1.65" width="12.7" height="12.7" rx="2.5" fill={scope === "window" ? "currentColor" : "none"} fillOpacity="0.45" />
    {scope === "conversation" && <rect x="5" y="5" width="6" height="6" rx="1" fill="currentColor" fillOpacity="0.45" stroke="none" />}
  </svg>
);

type OpenMenu = { x: number; y: number; returnFocus: HTMLElement | null };

export const ThemeModsMenu: FC<{ sessionId?: string; isForeground?: boolean }> = ({ sessionId, isForeground }) => {
  const t = useT();
  const themes = useThemeModsContext();
  const { theme, plugins, isLoaded, modsSettled } = useModUi();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  // A press shows at once; the stored state then takes over.
  const [pressed, setPressed] = useState<Readonly<Record<string, boolean>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [turningOff, setTurningOff] = useState(false);
  // The look being applied, and why the last one was not.
  const [applying, setApplying] = useState<string | null>(null);
  const [lookFailure, setLookFailure] = useState<string | null>(null);
  // The look picked during a turn, waiting for it to end (shared with the theme directory).
  const waiting = useWaitingLooks();
  const [colorScheme, setColorScheme] = useGuestColorScheme();

  const available = themes !== undefined;
  const refreshRef = useRef(themes?.refresh);
  refreshRef.current = themes?.refresh;

  useEffect(() => {
    if (!available) return;
    const root = anchorRef.current?.closest(".aui-thread-root");
    if (!root) return;
    const onContextMenu = (event: Event) => {
      const pointer = event as MouseEvent;
      if (pointer.defaultPrevented || !isBlankThreadTarget(pointer.target, root)) return;
      pointer.preventDefault();
      refreshRef.current?.();
      setFailure(null);
      setLookFailure(null);
      const active = root.ownerDocument.activeElement;
      setMenu({ x: pointer.clientX, y: pointer.clientY, returnFocus: active instanceof HTMLElement ? active : null });
    };
    root.addEventListener("contextmenu", onContextMenu);
    return () => root.removeEventListener("contextmenu", onContextMenu);
  }, [available]);

  // A menu belongs to the session it opened in: leaving that session closes it.
  useEffect(() => {
    if (isForeground === false) setMenu(null);
  }, [isForeground]);
  useEffect(() => {
    setMenu(null);
  }, [sessionId]);
  // What is stored, once read again, replaces what a press showed.
  const stored = themes?.enabled;
  useEffect(() => {
    setPressed({});
  }, [stored]);

  const rows = useMemo(
    () =>
      orderThemeMods(
        themes?.mods ?? [],
        (plugin) => pressed[plugin] ?? stored?.[plugin] ?? plugins?.[plugin] !== undefined,
        theme?.plugin,
      ),
    [themes?.mods, pressed, stored, plugins, theme?.plugin],
  );

  if (!themes) return null;
  const { setEnabled, setBackdropScope, openThemeStore, turnOffAll, applyLook } = themes;
  const on = rows.filter((row) => row.enabled).length;
  // A listing whose mod a press has just turned off leaves with it.
  const lookPlugins = (themes.looks ?? []).filter((listing) => pressed[listing.name] !== false);
  // Looks apply to the session the window shows: this menu's, unless another shows.
  const lookTarget = themes.lookTarget?.sessionId === sessionId ? themes.lookTarget : null;
  const blocked = lookBlocked(lookTarget);
  const waitingKey = lookTarget ? waiting[lookTarget.sessionId] : undefined;
  const waitingLook = waitingKey === undefined ? undefined : lookNamed(lookPlugins, waitingKey);
  const inUse = sessionId
    ? lookInUse(appliedLooks()[sessionId], themeStandingOf({ theme, isLoaded, modsSettled }), themes.looks ?? [])
    : null;

  const SchemeIcon = (COLOR_SCHEMES.find((each) => each.scheme === colorScheme) ?? COLOR_SCHEMES[0]!).Icon;

  const apply = (plugin: ThemePlugin, look: ThemeLook) => {
    if (!applyLook || !lookTarget || blocked || applying) return;
    const key = lookKey(plugin.name, look.id);
    // During a turn the look waits for it to end; the list says so and stays open.
    const waitForTurn = lookTarget.busy;
    if (!waitForTurn) setApplying(key);
    setLookFailure(null);
    // A look that applies late closes only the menu it was picked in, not one opened since.
    const pickedIn = menu;
    void applyLook(lookTarget.sessionId, plugin.name, look.id, { waitForTurn })
      .then(
        (result) => {
          if (result === null) return;
          if (result.ok) setMenu((current) => (current === pickedIn ? null : current));
          else setLookFailure(t(THEME_FAILURE_MESSAGE[result.reason]));
        },
        () => setLookFailure(t(THEME_FAILURE_MESSAGE.request)),
      )
      .finally(() => {
        if (!waitForTurn) setApplying(null);
      });
  };

  const turnOff = () => {
    if (!turnOffAll || turningOff) return;
    setFailure(null);
    setTurningOff(true);
    setPressed((previous) => ({
      ...previous,
      ...Object.fromEntries(rows.filter((row) => row.enabled).map((row) => [row.plugin, false])),
      ...Object.fromEntries(lookPlugins.map((listing) => [listing.name, false])),
    }));
    void turnOffAll()
      .catch((error: unknown) => {
        setPressed({});
        const reason = error instanceof Error ? error.message : String(error);
        setFailure(t("settings.plugins.disableFailed", { error: reason }));
      })
      .finally(() => setTurningOff(false));
  };
  // A mod no plugin list knows (a dev folder's, an uninstalled one) has no stored state a press could change.
  const canToggle = (row: ThemeModRow) => setEnabled !== undefined && (stored === undefined || row.plugin in stored);

  const toggle = (row: ThemeModRow, next: boolean) => {
    if (!setEnabled || !canToggle(row)) return;
    setFailure(null);
    // One at a time: enabling a mod disables every other enabled one, after it.
    const others = next && themes.single ? rows.filter((other) => other.enabled && other.plugin !== row.plugin && canToggle(other)) : [];
    setPressed((previous) => ({
      ...previous,
      ...Object.fromEntries(others.map((other) => [other.plugin, false])),
      [row.plugin]: next,
    }));
    const fail = (enabling: boolean) => (error: unknown) => {
      setPressed({});
      const reason = error instanceof Error ? error.message : String(error);
      setFailure(t(enabling ? "settings.plugins.enableFailed" : "settings.plugins.disableFailed", { error: reason }));
    };
    void setEnabled(row, next).then(async () => {
      for (const other of others) await setEnabled(other, false).catch(fail(false));
    }, fail(next));
  };

  return (
    <DropdownMenuPrimitive.Root
      open={menu !== null}
      onOpenChange={(open) => {
        if (!open) setMenu(null);
      }}
    >
      <DropdownMenuPrimitive.Trigger asChild>
        <span
          ref={anchorRef}
          aria-hidden="true"
          tabIndex={-1}
          className="pointer-events-none fixed size-0"
          style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }}
        />
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        {menu && (
          <DropdownMenuPrimitive.Content
            data-testid="theme-mods-menu"
            aria-label={t("themeMenu.label")}
            align="start"
            side="bottom"
            sideOffset={2}
            collisionPadding={8}
            loop
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              menu.returnFocus?.focus({ preventScroll: true });
            }}
            className={CONTENT_CLASS}
          >
            {applyLook && lookPlugins.length > 0 && (
              <DropdownMenuPrimitive.Sub>
                <DropdownMenuPrimitive.SubTrigger data-testid="theme-mods-menu-looks" className={ITEM_CLASS}>
                  <PaletteIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1">{t("themeMenu.looks")}</span>
                  <ChevronRightIcon aria-hidden className="size-4 text-muted-foreground rtl:rotate-180" />
                </DropdownMenuPrimitive.SubTrigger>
                <DropdownMenuPrimitive.Portal>
                  <DropdownMenuPrimitive.SubContent
                    data-testid="theme-mods-menu-looks-list"
                    sideOffset={6}
                    collisionPadding={8}
                    className={cn(
                      CONTENT_CLASS,
                      "w-80 max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto",
                    )}
                  >
                    {(blocked || lookTarget?.busy || waitingLook) && (
                      <div
                        role="status"
                        data-testid="theme-mods-menu-looks-note"
                        className="px-2 py-1.5 text-xs text-muted-foreground"
                      >
                        {blocked
                          ? t(blocked)
                          : waitingLook
                            ? t("themeMenu.lookWaiting", { name: waitingLook })
                            : t("customize.themes.busy")}
                      </div>
                    )}
                    {lookPlugins.map((plugin, index) => (
                      <DropdownMenuPrimitive.Group key={plugin.name}>
                        {index > 0 && <DropdownMenuPrimitive.Separator className={SEPARATOR_CLASS} />}
                        <DropdownMenuPrimitive.Label className={LABEL_CLASS}>{packTitle(plugin.name)}</DropdownMenuPrimitive.Label>
                        {plugin.theme.looks.map((look) => {
                          const key = lookKey(plugin.name, look.id);
                          return (
                            <DropdownMenuPrimitive.Item
                              key={key}
                              data-testid={`theme-look:${key}`}
                              data-in-use={inUse === key ? "" : undefined}
                              data-waiting={waitingKey === key ? "" : undefined}
                              disabled={blocked !== null || (applying !== null && applying !== key)}
                              onSelect={(event) => {
                                event.preventDefault();
                                apply(plugin, look);
                              }}
                              className={cn(ITEM_CLASS, "items-start")}
                            >
                              <span className="flex size-4 shrink-0 items-center justify-center pt-0.5">
                                {applying === key ? (
                                  <Loader2Icon aria-hidden className="size-4 animate-spin text-muted-foreground" />
                                ) : waitingKey === key ? (
                                  <ClockIcon aria-hidden className="size-4 text-muted-foreground" />
                                ) : inUse === key ? (
                                  <CheckIcon aria-hidden className="size-4 text-primary" />
                                ) : null}
                              </span>
                              <span className="flex min-w-0 flex-1 flex-col">
                                <span className="truncate">{look.name ?? look.id}</span>
                                {look.description && (
                                  <span className="line-clamp-2 text-xs text-muted-foreground">{look.description}</span>
                                )}
                              </span>
                              {look.appearance && (
                                <span className="shrink-0 pt-0.5 text-xs text-muted-foreground">
                                  {t(APPEARANCE[look.appearance])}
                                </span>
                              )}
                            </DropdownMenuPrimitive.Item>
                          );
                        })}
                      </DropdownMenuPrimitive.Group>
                    ))}
                    {lookFailure && (
                      <div role="status" className="px-2 py-1.5 text-xs text-destructive">
                        {lookFailure}
                      </div>
                    )}
                  </DropdownMenuPrimitive.SubContent>
                </DropdownMenuPrimitive.Portal>
              </DropdownMenuPrimitive.Sub>
            )}
            <DropdownMenuPrimitive.Sub>
              <DropdownMenuPrimitive.SubTrigger data-testid="theme-mods-menu-mods" className={ITEM_CLASS}>
                <ThemeModsGlyph />
                <span className="flex-1">{t("themeMenu.mods")}</span>
                <ChevronRightIcon aria-hidden className="size-4 text-muted-foreground rtl:rotate-180" />
              </DropdownMenuPrimitive.SubTrigger>
              <DropdownMenuPrimitive.Portal>
                <DropdownMenuPrimitive.SubContent
                  data-testid="theme-mods-menu-list"
                  sideOffset={6}
                  collisionPadding={8}
                  className={CONTENT_CLASS}
                >
                  {rows.length === 0 && (
                    <DropdownMenuPrimitive.Item disabled className={cn(ITEM_CLASS, "text-muted-foreground")}>
                      {t("themeMenu.empty")}
                    </DropdownMenuPrimitive.Item>
                  )}
                  {rows.map((row) => (
                    <DropdownMenuPrimitive.CheckboxItem
                      key={row.plugin}
                      data-testid={`theme-mod:${row.plugin}`}
                      checked={row.enabled}
                      disabled={!canToggle(row)}
                      onCheckedChange={(value) => toggle(row, value === true)}
                      onSelect={(event) => event.preventDefault()}
                      className={ITEM_CLASS}
                    >
                      <span className="flex size-4 items-center justify-center">
                        <DropdownMenuPrimitive.ItemIndicator>
                          <CheckIcon aria-hidden className="size-4 text-primary" />
                        </DropdownMenuPrimitive.ItemIndicator>
                      </span>
                      <span className={cn("min-w-0 flex-1 truncate", !row.enabled && "text-muted-foreground")}>
                        {row.plugin}
                      </span>
                      {row.showing && (
                        <span
                          data-testid="theme-mod-showing"
                          className="rounded-sm bg-primary/15 px-1.5 py-0.5 text-xs text-primary"
                        >
                          {t("themeMenu.showing")}
                        </span>
                      )}
                    </DropdownMenuPrimitive.CheckboxItem>
                  ))}
                  {failure && (
                    <div role="status" className="max-w-64 px-2 py-1.5 text-xs text-destructive">
                      {failure}
                    </div>
                  )}
                  {turnOffAll && (
                    <>
                      <DropdownMenuPrimitive.Separator className={SEPARATOR_CLASS} />
                      <DropdownMenuPrimitive.Item
                        data-testid="theme-mods-menu-turn-off"
                        disabled={(on === 0 && !themes.pluginsOn) || turningOff}
                        onSelect={(event) => {
                          event.preventDefault();
                          turnOff();
                        }}
                        className={ITEM_CLASS}
                      >
                        <PowerOffIcon aria-hidden className="size-4 text-muted-foreground" />
                        <span className="flex-1">{t("themeMenu.turnOffAll")}</span>
                      </DropdownMenuPrimitive.Item>
                    </>
                  )}
                  {openThemeStore && (
                    <>
                      <DropdownMenuPrimitive.Separator className={SEPARATOR_CLASS} />
                      <DropdownMenuPrimitive.Item
                        data-testid="theme-mods-menu-more"
                        onSelect={() => openThemeStore()}
                        className={ITEM_CLASS}
                      >
                        <PlusIcon aria-hidden className="size-4 text-muted-foreground" />
                        <span className="flex-1">{t("themeMenu.more")}</span>
                      </DropdownMenuPrimitive.Item>
                    </>
                  )}
                </DropdownMenuPrimitive.SubContent>
              </DropdownMenuPrimitive.Portal>
            </DropdownMenuPrimitive.Sub>
            <DropdownMenuPrimitive.Separator className={SEPARATOR_CLASS} />
            <DropdownMenuPrimitive.Sub>
              <DropdownMenuPrimitive.SubTrigger data-testid="theme-mods-menu-default" className={ITEM_CLASS}>
                <SchemeIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <span className="flex-1">{t("themeMenu.defaultTheme")}</span>
                <ChevronRightIcon aria-hidden className="size-4 text-muted-foreground rtl:rotate-180" />
              </DropdownMenuPrimitive.SubTrigger>
              <DropdownMenuPrimitive.Portal>
                <DropdownMenuPrimitive.SubContent
                  data-testid="theme-mods-menu-default-list"
                  sideOffset={6}
                  collisionPadding={8}
                  className={CONTENT_CLASS}
                >
                  <DropdownMenuPrimitive.RadioGroup
                    value={colorScheme}
                    onValueChange={(value) => {
                      const picked = COLOR_SCHEMES.find((each) => each.scheme === value);
                      if (picked) setColorScheme(picked.scheme);
                    }}
                  >
                    {COLOR_SCHEMES.map(({ scheme, label, Icon }) => (
                      <DropdownMenuPrimitive.RadioItem
                        key={scheme}
                        value={scheme}
                        data-testid={`theme-default-scheme:${scheme}`}
                        onSelect={(event) => event.preventDefault()}
                        className={ITEM_CLASS}
                      >
                        <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                        <span className="flex-1">{t(label)}</span>
                        <span className="flex size-4 items-center justify-center">
                          <DropdownMenuPrimitive.ItemIndicator>
                            <CheckIcon aria-hidden className="size-4 text-primary" />
                          </DropdownMenuPrimitive.ItemIndicator>
                        </span>
                      </DropdownMenuPrimitive.RadioItem>
                    ))}
                  </DropdownMenuPrimitive.RadioGroup>
                </DropdownMenuPrimitive.SubContent>
              </DropdownMenuPrimitive.Portal>
            </DropdownMenuPrimitive.Sub>
            <DropdownMenuPrimitive.Sub>
              <DropdownMenuPrimitive.SubTrigger data-testid="theme-mods-menu-backdrop" className={ITEM_CLASS}>
                <ScopeThumb scope={themes.backdropScope} />
                <span className="flex-1">{t("themeMenu.backdrop")}</span>
                <ChevronRightIcon aria-hidden className="size-4 text-muted-foreground rtl:rotate-180" />
              </DropdownMenuPrimitive.SubTrigger>
              <DropdownMenuPrimitive.Portal>
                <DropdownMenuPrimitive.SubContent
                  data-testid="theme-mods-menu-backdrop-list"
                  sideOffset={6}
                  collisionPadding={8}
                  className={CONTENT_CLASS}
                >
                  <DropdownMenuPrimitive.RadioGroup
                    value={themes.backdropScope}
                    onValueChange={(value) => {
                      if (isThemeBackdropScope(value)) void setBackdropScope?.(value).catch(() => undefined);
                    }}
                  >
                    {(["conversation", "window"] as const).map((scope) => (
                      <DropdownMenuPrimitive.RadioItem
                        key={scope}
                        value={scope}
                        data-testid={`theme-backdrop-scope:${scope}`}
                        disabled={!setBackdropScope}
                        onSelect={(event) => event.preventDefault()}
                        className={ITEM_CLASS}
                      >
                        <ScopeThumb scope={scope} />
                        <span className="flex-1">
                          {t(scope === "window" ? "themeMenu.backdropWindow" : "themeMenu.backdropConversation")}
                        </span>
                        <span className="flex size-4 items-center justify-center">
                          <DropdownMenuPrimitive.ItemIndicator>
                            <CheckIcon aria-hidden className="size-4 text-primary" />
                          </DropdownMenuPrimitive.ItemIndicator>
                        </span>
                      </DropdownMenuPrimitive.RadioItem>
                    ))}
                  </DropdownMenuPrimitive.RadioGroup>
                </DropdownMenuPrimitive.SubContent>
              </DropdownMenuPrimitive.Portal>
            </DropdownMenuPrimitive.Sub>
          </DropdownMenuPrimitive.Content>
        )}
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
};
