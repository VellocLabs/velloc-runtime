import { CheckIcon, ChevronRightIcon, PlusIcon } from "lucide-react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { useEffect, useMemo, useRef, useState, type FC } from "react";

import { useT } from "@/browser/webview/i18n";
import type { ThemeBackdropScope, ThemeModEntry } from "@/mods/themeMods";
import { isThemeBackdropScope } from "@/mods/themeMods";
import { cn } from "@/lib/utils";
import { useModUi } from "./mod-ui-context";
import { useThemeModsContext } from "./theme-mods-context";

/**
 * The conversation's theme menu (F-25): a right-click on its empty space lists
 * the mods that have set a theme — a check on each enabled one, a mark on the
 * one whose theme shows — and chooses how far the backdrop reaches. A press on
 * a mod enables or disables the plugin itself.
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

/** The rows in menu order: the mod whose theme shows, the other enabled ones, the disabled ones; by name within each. */
export function orderThemeMods(
  mods: readonly ThemeModEntry[],
  enabled: (plugin: string) => boolean,
  showing: string | undefined,
): ThemeModRow[] {
  const rank = (row: ThemeModRow) => (row.showing ? 0 : row.enabled ? 1 : 2);
  return mods
    .map((mod) => ({ ...mod, enabled: enabled(mod.plugin), showing: mod.plugin === showing }))
    .sort((a, b) => rank(a) - rank(b) || a.plugin.localeCompare(b.plugin));
}

const ITEM_CLASS =
  "flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-start outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[state=open]:bg-accent";
const CONTENT_CLASS =
  "z-50 min-w-56 rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-md";
const SEPARATOR_CLASS = "-mx-1 my-1 h-px bg-border";

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

/** A window in small: the bar, the side and the conversation, each tinted where the backdrop reaches. */
const ScopeThumb: FC<{ scope: ThemeBackdropScope }> = ({ scope }) => {
  const reach = scope === "window" ? "bg-primary/40" : "bg-muted";
  return (
    <span
      aria-hidden="true"
      className="grid h-7 w-10 shrink-0 grid-cols-[9px_1fr] grid-rows-[6px_1fr] overflow-hidden rounded-sm border"
    >
      <span className={cn("col-span-2", reach)} />
      <span className={reach} />
      <span className="bg-primary/40" />
    </span>
  );
};

type OpenMenu = { x: number; y: number; returnFocus: HTMLElement | null };

export const ThemeModsMenu: FC<{ sessionId?: string; isForeground?: boolean }> = ({ sessionId, isForeground }) => {
  const t = useT();
  const themes = useThemeModsContext();
  const { theme, plugins } = useModUi();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  // A press shows at once; the runtime's list of loaded mods then takes over.
  const [pressed, setPressed] = useState<Readonly<Record<string, boolean>>>({});
  const [failure, setFailure] = useState<string | null>(null);

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
  useEffect(() => {
    setPressed({});
  }, [plugins]);

  const rows = useMemo(
    () =>
      orderThemeMods(
        themes?.mods ?? [],
        (plugin) => pressed[plugin] ?? plugins?.[plugin] !== undefined,
        theme?.plugin,
      ),
    [themes?.mods, pressed, plugins, theme?.plugin],
  );

  if (!themes) return null;
  const { setEnabled, setBackdropScope, openThemeStore } = themes;
  const on = rows.filter((row) => row.enabled).length;

  const toggle = (row: ThemeModRow, next: boolean) => {
    if (!setEnabled) return;
    setFailure(null);
    setPressed((previous) => ({ ...previous, [row.plugin]: next }));
    void setEnabled(row, next).catch((error: unknown) => {
      setPressed((previous) => {
        const { [row.plugin]: _dropped, ...rest } = previous;
        return rest;
      });
      const reason = error instanceof Error ? error.message : String(error);
      setFailure(t(next ? "settings.plugins.enableFailed" : "settings.plugins.disableFailed", { error: reason }));
    });
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
            <DropdownMenuPrimitive.Sub>
              <DropdownMenuPrimitive.SubTrigger data-testid="theme-mods-menu-mods" className={ITEM_CLASS}>
                <ThemeModsGlyph />
                <span className="flex-1">{t("themeMenu.mods")}</span>
                <span className="text-xs text-muted-foreground">{t("themeMenu.modsOn", { n: on })}</span>
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
                      disabled={!setEnabled}
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
                  {openThemeStore && (
                    <>
                      <DropdownMenuPrimitive.Separator className={SEPARATOR_CLASS} />
                      <DropdownMenuPrimitive.Item
                        data-testid="theme-mods-menu-more"
                        onSelect={() => openThemeStore()}
                        className={ITEM_CLASS}
                      >
                        <PlusIcon aria-hidden className="size-4 text-muted-foreground" />
                        <span className="flex-1">{t("themeMenu.getMore")}</span>
                      </DropdownMenuPrimitive.Item>
                    </>
                  )}
                </DropdownMenuPrimitive.SubContent>
              </DropdownMenuPrimitive.Portal>
            </DropdownMenuPrimitive.Sub>
            <DropdownMenuPrimitive.Separator className={SEPARATOR_CLASS} />
            <DropdownMenuPrimitive.Label className="px-2 pt-1.5 pb-0.5 text-xs text-muted-foreground">
              {t("themeMenu.backdrop")}
            </DropdownMenuPrimitive.Label>
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
          </DropdownMenuPrimitive.Content>
        )}
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
};
