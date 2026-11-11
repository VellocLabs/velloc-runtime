/**
 * The menu an app's background module answered a press with (F-40), drawn
 * at the icon that was pressed. The labels are the plugin's own text; a pick
 * goes back to the module as a new press.
 */
import * as React from "react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";

import { resolveLocalizedText } from "../../../config/localizedText";
import { useLocale } from "../i18n";
import type { PluginTopbarState } from "./PluginTopbarItems";

export function AppPressMenu({
  state,
  contentClassName,
  itemClassName,
}: {
  state: PluginTopbarState | null;
  contentClassName: string;
  itemClassName: string;
}) {
  const locale = useLocale();
  const menu = state?.menu;
  const returnTo = React.useRef<HTMLElement | null>(null);
  React.useLayoutEffect(() => {
    if (!menu) return;
    const held = document.activeElement;
    returnTo.current = held instanceof HTMLElement && held !== document.body ? held : null;
  }, [menu]);
  if (!state || !menu) return null;
  return (
    <DropdownMenuPrimitive.Root
      open
      modal={false}
      onOpenChange={open => {
        if (!open) state.closeMenu();
      }}
    >
      <DropdownMenuPrimitive.Trigger asChild>
        <span
          className="pointer-events-none fixed size-0"
          style={{ left: menu.at.x, top: menu.at.y }}
        />
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="start"
          sideOffset={6}
          aria-label={menu.title}
          onCloseAutoFocus={event => {
            event.preventDefault();
            if (returnTo.current?.isConnected) returnTo.current.focus();
          }}
          data-testid={`topbar-app-${menu.appId}-menu`}
          className={contentClassName}
        >
          {menu.items.map(item => (
            <DropdownMenuPrimitive.Item
              key={item.id}
              disabled={item.disabled === true}
              onSelect={() => state.pickMenuItem(item.id)}
              data-testid={`topbar-app-${menu.appId}-menu-${item.id}`}
              className={itemClassName}
            >
              <span className="flex-1">{resolveLocalizedText(item.label, locale)}</span>
            </DropdownMenuPrimitive.Item>
          ))}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}
