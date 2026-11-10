import * as React from "react";
import {
  GripVerticalIcon,
  MoreHorizontalIcon,
  SettingsIcon,
  StarIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ProviderIcon } from "../../../ProviderIcon";

import type { BrowserLlmCatalog } from "../../../../bridge/protocol/nexus_llm";
import {
  modelAvailability,
  pickerModelIds,
  type FreshModelIds,
} from "../../providerModelAvailability";
import {
  isRuntimeOnlyProvider,
} from "../../../../../models/drivers/driverRegistry";
import type { ProviderConnectionKind } from "../../providerFormHelpers";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { TranslateFn } from "../../../i18n/translate";
import type { AddedProviderRow, DeleteTarget, ProviderDragState } from "./modelsPageTypes";

/** The catalog key for each row's connection-kind line. */
export const CONNECTION_KIND_KEY = {
  subscription: "settings.models.kindSubscription",
  apiKey: "settings.models.kindApiKey",
  plugin: "settings.models.mod.kindPlugin",
  local: "settings.models.kindLocal",
  custom: "settings.models.kindCustom",
} as const satisfies Record<ProviderConnectionKind, string>;

export type ProviderModelCountContext = {
  catalog: BrowserLlmCatalog | null | undefined;
  freshModelIds: Record<string, FreshModelIds>;
  t: TranslateFn;
};

/** "N models available"; red only when a fresh listing confirmed zero. */
export function renderProviderModelCount(
  {
    catalog, freshModelIds, t
  }: ProviderModelCountContext,
  row: AddedProviderRow,
) {
  const { count, confirmed } = modelAvailability(
    pickerModelIds(catalog, row.id),
    freshModelIds[row.id],
    // Picked from the provider's own listing: the ids must match verbatim.
    row.custom || isRuntimeOnlyProvider(row.id),
  );
  const none = confirmed && count === 0;
  return (
    <>
      <span aria-hidden className="text-muted-foreground">·</span>
      <span
        className={cn(
          "shrink-0 tabular-nums",
          none ? "font-medium text-destructive" : "text-muted-foreground",
        )}
        data-testid={`models-provider-models-${row.id}`}
        data-confirmed={confirmed ? "true" : "false"}
        data-count={count}
        title={none ? t("settings.models.noModelsConfirmed") : undefined}
      >
        {t("settings.models.modelsFound", {
          count,
          unit: t(
            count === 1
              ? "settings.models.unitModel"
              : "settings.models.unitModels",
          ),
        })}
      </span>
    </>
  );
}

export type ProviderListRowContext = {
  draggingId: string | null;
  t: TranslateFn;
  dragRef: RefObject<ProviderDragState | null>;
  providerRowAt: (x: number, y: number) => string | null;
  moveId: (ids: string[], moving: string, target: string) => string[];
  setDragPreview: Dispatch<SetStateAction<string[] | null>>;
  commitOrderRef: RefObject<(ids: string[]) => void>;
  endDrag: () => void;
  orderedRows: AddedProviderRow[];
  setDraggingId: Dispatch<SetStateAction<string | null>>;
  stageKeyboardOrder: (shown: string[], ids: string[]) => void;
  flushKeyboardOrder: () => void;
  activeProviderId: string | undefined;
  renderModelCount: (row: AddedProviderRow) => React.JSX.Element;
  openProvider: (id: string) => void;
  renderRowMenu: (row: AddedProviderRow) => React.JSX.Element;
};

/**
 * One home-list row, reordered by POINTER drag from its grip (or arrow keys); the
 * order is written once on a release that changed it. Move / release / cancel are
 * heard on the WINDOW, since re-inserting the row releases pointer capture.
 */
export function renderProviderListRow(
  {
    draggingId, t, dragRef, providerRowAt, moveId, setDragPreview,
    commitOrderRef, endDrag, orderedRows, setDraggingId, stageKeyboardOrder,
    flushKeyboardOrder, activeProviderId, renderModelCount, openProvider,
    renderRowMenu
  }: ProviderListRowContext,
  row: AddedProviderRow,
) {
  return (
    <div
      key={row.id}
      className={cn(
        "flex items-center gap-3 border-b bg-background px-3 py-2.5 last:border-b-0",
        draggingId === row.id && "relative z-10 bg-accent/40 shadow-sm",
      )}
      data-testid={`models-provider-row-${row.id}`}
      data-provider-row={row.id}
      data-provider-dragging={draggingId === row.id ? "" : undefined}
    >
      <span
        role="button"
        tabIndex={0}
        className={cn(
          "-ml-1 flex touch-none select-none items-center text-muted-foreground/70 hover:text-muted-foreground",
          draggingId === row.id ? "cursor-grabbing" : "cursor-grab",
        )}
        data-testid={`models-provider-grip-${row.id}`}
        aria-label={t("settings.models.reorderProviderAria", {
          name: row.label,
        })}
        title={t("settings.models.reorderProviderHint")}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            /* no capture (test DOM) — moves still arrive on the grip */
          }
          dragRef.current?.detach();
          const pointerId = e.pointerId;
          const onMove = (ev: PointerEvent) => {
            const drag = dragRef.current;
            if (!drag || ev.pointerId !== pointerId) return;
            const target = providerRowAt(ev.clientX, ev.clientY);
            if (!target || target === drag.id) {
              drag.passed = null;
              return;
            }
            // Moves can outrun the re-layout and hit the row just passed at
            // its old place again; moving over it twice would undo the move.
            if (target === drag.passed) return;
            drag.passed = target;
            const next = moveId(drag.preview, drag.id, target);
            if (next === drag.preview) return;
            drag.preview = next;
            setDragPreview(next);
          };
          const onUp = (ev: PointerEvent) => {
            const drag = dragRef.current;
            if (!drag || ev.pointerId !== pointerId) return;
            // A press and release that moved nothing writes nothing — with no
            // stored order yet, writing would freeze today's order.
            if (drag.preview.some((id, i) => id !== drag.start[i])) {
              commitOrderRef.current(drag.preview);
            }
            endDrag();
          };
          // The OS took the pointer (a gesture, a lost window): drop the
          // preview and write nothing.
          const onCancel = (ev: PointerEvent) => {
            if (ev.pointerId === pointerId) endDrag();
          };
          window.addEventListener("pointermove", onMove);
          window.addEventListener("pointerup", onUp);
          window.addEventListener("pointercancel", onCancel);
          const preview = orderedRows.map((r) => r.id);
          dragRef.current = {
            id: row.id,
            start: preview,
            preview,
            passed: null,
            detach: () => {
              window.removeEventListener("pointermove", onMove);
              window.removeEventListener("pointerup", onUp);
              window.removeEventListener("pointercancel", onCancel);
            },
          };
          setDraggingId(row.id);
          setDragPreview(preview);
        }}
        onKeyDown={(e) => {
          if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
          e.preventDefault();
          const ids = orderedRows.map((r) => r.id);
          const index = ids.indexOf(row.id);
          const target = ids[e.key === "ArrowUp" ? index - 1 : index + 1];
          if (target) stageKeyboardOrder(ids, moveId(ids, row.id, target));
        }}
        onBlur={flushKeyboardOrder}
      >
        <GripVerticalIcon className="size-4" />
      </span>
      <ProviderIcon svg={row.iconSvg} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-sm">{row.label}</span>
          {row.id === activeProviderId ? (
            <Badge
              variant="info"
              size="sm"
              data-testid={`models-provider-default-${row.id}`}
            >
              {t("settings.models.defaultBadge")}
            </Badge>
          ) : null}
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-xs">
          <span
            className="truncate text-muted-foreground"
            data-testid={`models-provider-kind-${row.id}`}
          >
            {t(CONNECTION_KIND_KEY[row.kind])}
          </span>
          {renderModelCount(row)}
        </div>
      </div>
      {/* Connected is the normal state, so it is said quietly (a dot and
          muted text); only a provider that is NOT connected is flagged. */}
      {row.custom ? null : row.connected ? (
        <span
          className="flex shrink-0 items-center gap-1.5 text-muted-foreground text-xs"
          data-testid={`models-provider-status-${row.id}`}
          data-status="connected"
        >
          <span aria-hidden className="size-1.5 rounded-full bg-success" />
          {t("settings.models.connected")}
        </span>
      ) : (
        <span
          className="flex shrink-0 items-center gap-1 text-warning text-xs"
          data-testid={`models-provider-status-${row.id}`}
          data-status="not-connected"
        >
          <TriangleAlertIcon aria-hidden className="size-3.5" />
          {t("settings.models.notConnected")}
        </span>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="size-7 text-muted-foreground hover:text-foreground"
        data-testid={`models-provider-settings-${row.id}`}
        aria-label={t("settings.models.providerSettingsAria", {
          name: row.label,
        })}
        title={t("settings.models.providerSettingsAria", {
          name: row.label,
        })}
        onClick={() => openProvider(row.id)}
      >
        <SettingsIcon className="size-4" />
      </Button>
      {renderRowMenu(row)}
    </div>
  );
}

export type ProviderRowMenuContext = {
  activeProviderId: string | undefined;
  t: TranslateFn;
  makeDefault: (id: string) => void;
  setDeleteTarget: Dispatch<SetStateAction<DeleteTarget | null>>;
};

/**
 * A row's "⋯" menu: the low-frequency actions, kept out of the row so a
 * list of six providers is not six red trash cans. Remove is last and the
 * only red item. "Set as default" turns into a disabled "Default provider"
 * on the default row, and stays disabled for a built-in that is not
 * connected — a default that cannot answer would break every new session.
 */
export function renderProviderRowMenu(
  {
    activeProviderId, t, makeDefault, setDeleteTarget
  }: ProviderRowMenuContext,
  row: AddedProviderRow,
) {
  const isDefault = row.id === activeProviderId;
  const canBeDefault = row.custom || row.connected;
  const itemClass =
    "flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-start text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-muted";
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground hover:text-foreground"
          data-testid={`models-provider-menu-${row.id}`}
          aria-label={t("settings.models.providerActionsAria", {
            name: row.label,
          })}
          title={t("settings.models.providerActionsAria", {
            name: row.label,
          })}
        >
          <MoreHorizontalIcon className="size-4" />
        </Button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="end"
          sideOffset={4}
          className="z-50 min-w-[10rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <DropdownMenuPrimitive.Item
            className={itemClass}
            disabled={isDefault || !canBeDefault}
            data-testid={`models-provider-set-default-${row.id}`}
            onSelect={() => makeDefault(row.id)}
          >
            <StarIcon className="size-4" />
            {isDefault
              ? t("settings.models.isDefaultProvider")
              : t("settings.models.setAsDefault")}
          </DropdownMenuPrimitive.Item>
          <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />
          <DropdownMenuPrimitive.Item
            className={cn(
              itemClass,
              "text-destructive data-[highlighted]:bg-destructive/10",
            )}
            data-testid={`models-provider-delete-${row.id}`}
            aria-label={t("settings.models.removeProviderAria", {
              name: row.label,
            })}
            onSelect={() =>
              setDeleteTarget({
                id: row.id,
                name: row.label,
                custom: row.custom,
              })
            }
          >
            <Trash2Icon className="size-4" />
            {t("settings.models.removeProvider")}
          </DropdownMenuPrimitive.Item>
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}
