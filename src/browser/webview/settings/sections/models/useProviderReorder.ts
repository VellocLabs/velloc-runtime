import * as React from "react";

import { providersSetOrder } from "../../clients";
import type { useSettingsBridge } from "../../../nexusSettingsBridge";
import type { ProviderDragState } from "./modelsPageTypes";
import {
  sameOrder,
  MAX_UNECHOED_ORDERS,
  KEYBOARD_REORDER_COMMIT_MS,
} from "./providerOrder";

/**
 * The Models home list's order and its in-flight reorder (pointer drag or
 * arrow keys): the state the list renders from and the refs the gesture
 * handlers read.
 */
export function useProviderOrderState() {
  /** The user's provider order (settings.json `providers.order`). */
  const [order, setOrder] = React.useState<string[]>([]);
  /**
   * The home list's order WHILE a row is dragged — rows move live under the
   * pointer, and nothing is written until the drop. `null` when idle.
   */
  const [dragPreview, setDragPreview] = React.useState<string[] | null>(null);
  const [draggingId, setDraggingId] = React.useState<string | null>(null);
  /**
   * The drag in flight, for the HANDLERS. State drives the rendering, but a
   * pointermove can arrive before React has re-rendered from the pointerdown
   * (events dispatched back to back — the e2e does exactly that), and a
   * handler reading state would still see "not dragging" and drop the move.
   */
  const dragRef = React.useRef<ProviderDragState | null>(null);
  React.useEffect(() => () => dragRef.current?.detach(), []);
  /**
   * An arrow-key reorder not yet written (see `KEYBOARD_REORDER_COMMIT_MS`):
   * the order at the gesture's first key, the order to write, and the timer
   * that writes it.
   */
  const keyboardOrderRef = React.useRef<{
    start: string[];
    order: string[];
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  /** Orders written here whose echo has not arrived (`settleEchoedOrder`). */
  const unechoedOrdersRef = React.useRef<string[][]>([]);
  /** The latest `writeOrder` / `flushKeyboardOrder`, for the reorder timer
   *  and the unmount flush, which outlive the render that armed them. */
  const writeOrderRef = React.useRef<(order: string[]) => void>(() => {});
  const flushKeyboardOrderRef = React.useRef<() => void>(() => {});
  // Leaving the page mid-gesture still writes the order the list shows.
  React.useEffect(() => () => flushKeyboardOrderRef.current(), []);
  return {
    order, setOrder, dragPreview, setDragPreview, draggingId, setDraggingId,
    dragRef, keyboardOrderRef, unechoedOrdersRef, writeOrderRef,
    flushKeyboardOrderRef,
  };
}

export type ProviderOrderState = ReturnType<typeof useProviderOrderState>;

/**
 * The reorder actions on `useProviderOrderState`'s state: write an order
 * (optimistic, re-read on failure), stage and flush an arrow-key gesture,
 * and the pointer-drag helpers the list rows use.
 */
export function useProviderReorder(
  {
    order, setOrder, setDragPreview, setDraggingId, dragRef, keyboardOrderRef,
    unechoedOrdersRef, writeOrderRef, flushKeyboardOrderRef,
  }: ProviderOrderState,
  {
    bridge,
    reload,
  }: {
    bridge: NonNullable<ReturnType<typeof useSettingsBridge>>;
    reload: () => Promise<void>;
  },
) {
  /**
   * Persist a new home-list order. `ids` is what the list shows; ids the
   * stored order names but the list does not (a provider removed for now, a
   * broker entry not loaded yet) are kept after them, so re-adding one puts
   * it back where the user had it. Optimistic: the list moves at once, and a
   * failed write re-reads the stored order rather than leaving a lie up.
   */
  /** `ids` (what the list shows) followed by the stored ids it does not show. */
  const fullOrderFor = (ids: string[]): string[] => [
    ...ids,
    ...order.filter((id) => !ids.includes(id)),
  ];
  const nextOrderFor = (ids: string[]): string[] | null => {
    const next = fullOrderFor(ids);
    return sameOrder(next, order) ? null : next;
  };
  const writeOrder = (next: string[]) => {
    const written = unechoedOrdersRef.current;
    written.push(next);
    if (written.length > MAX_UNECHOED_ORDERS) written.shift();
    void providersSetOrder(bridge, next).catch(() => {
      // Nothing will echo a failed write; the re-read shows the stored order.
      unechoedOrdersRef.current = [];
      void reload();
    });
  };
  const commitOrder = (ids: string[]) => {
    const next = nextOrderFor(ids);
    if (!next) return;
    setOrder(next);
    writeOrder(next);
  };
  /**
   * An arrow-key move: shown at once like `commitOrder`, written once per
   * gesture — when the keys have been still for `KEYBOARD_REORDER_COMMIT_MS`,
   * or the grip loses focus. A gesture that ends where it began writes
   * nothing — with no stored order yet, writing would freeze today's order.
   * `shown` is the list before this key's move.
   */
  const flushKeyboardOrder = () => {
    const pending = keyboardOrderRef.current;
    if (!pending) return;
    clearTimeout(pending.timer);
    keyboardOrderRef.current = null;
    if (!sameOrder(pending.order, pending.start)) writeOrderRef.current(pending.order);
  };
  const stageKeyboardOrder = (shown: string[], ids: string[]) => {
    const next = nextOrderFor(ids);
    if (!next) return;
    setOrder(next);
    const pending = keyboardOrderRef.current;
    if (pending) clearTimeout(pending.timer);
    keyboardOrderRef.current = {
      start: pending?.start ?? fullOrderFor(shown),
      order: next,
      timer: setTimeout(() => flushKeyboardOrderRef.current(), KEYBOARD_REORDER_COMMIT_MS),
    };
  };

  /** For the drag's window listeners, which outlive the render that added them. */
  const commitOrderRef = React.useRef(commitOrder);
  commitOrderRef.current = commitOrder;
  writeOrderRef.current = writeOrder;
  flushKeyboardOrderRef.current = flushKeyboardOrder;

  /** `ids` with `moving` placed where `target` is. */
  const moveId = (ids: string[], moving: string, target: string): string[] => {
    const from = ids.indexOf(moving);
    const to = ids.indexOf(target);
    if (from < 0 || to < 0 || from === to) return ids;
    const next = [...ids];
    next.splice(from, 1);
    next.splice(to, 0, moving);
    return next;
  };

  const endDrag = () => {
    dragRef.current?.detach();
    dragRef.current = null;
    setDraggingId(null);
    setDragPreview(null);
  };

  /**
   * The home-list row under a viewport point, by its `data-provider-row` id —
   * how a pointer drag finds its target (the events themselves land on the
   * grip while it holds capture, and anywhere once it has lost it).
   */
  const providerRowAt = (x: number, y: number): string | null => {
    const el = document.elementFromPoint(x, y);
    return (
      el?.closest<HTMLElement>("[data-provider-row]")?.dataset.providerRow ??
      null
    );
  };

  return {
    commitOrderRef, flushKeyboardOrder, stageKeyboardOrder, moveId, endDrag,
    providerRowAt,
  };
}
