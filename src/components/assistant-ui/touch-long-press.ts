/**
 * A touch long-press opens what a right-click would: a still finger held
 * `LONG_PRESS_MS` dispatches `contextmenu` at the touch point (M9).
 */
export const LONG_PRESS_MS = 500;
export const LONG_PRESS_SLOP_PX = 10;
const NATIVE_ECHO_MS = 1000;

/**
 * Contract: returns the cleanup. Mouse and pen are left alone; moving more
 * than `LONG_PRESS_SLOP_PX`, lifting, or a cancelled pointer ends the press.
 * A browser's own `contextmenu` for the same press wins, one arriving right
 * after ours is swallowed, and so is the click that ends a long-press.
 */
export function attachTouchLongPress(target: HTMLElement): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let origin: { x: number; y: number; pointerId: number } | null = null;
  let firedAt = -Infinity;
  let dispatching = false;
  let swallowClick = false;

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    origin = null;
  };

  const onPointerDown = (event: PointerEvent) => {
    clear();
    swallowClick = false;
    if (event.pointerType !== "touch" || !event.isPrimary) return;
    const pressed = event.target;
    if (!(pressed instanceof Element)) return;
    origin = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    const { clientX, clientY } = event;
    timer = setTimeout(() => {
      timer = null;
      origin = null;
      firedAt = Date.now();
      swallowClick = true;
      dispatching = true;
      try {
        pressed.dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX, clientY }),
        );
      } finally {
        dispatching = false;
      }
    }, LONG_PRESS_MS);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!origin || event.pointerId !== origin.pointerId) return;
    if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > LONG_PRESS_SLOP_PX) clear();
  };

  const onContextMenu = (event: MouseEvent) => {
    if (dispatching) return;
    if (timer !== null) {
      clear();
      return;
    }
    if (Date.now() - firedAt < NATIVE_ECHO_MS) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };

  const onClick = (event: MouseEvent) => {
    if (!swallowClick) return;
    swallowClick = false;
    event.preventDefault();
    event.stopPropagation();
  };

  target.addEventListener("pointerdown", onPointerDown);
  target.addEventListener("pointermove", onPointerMove);
  target.addEventListener("pointerup", clear);
  target.addEventListener("pointercancel", clear);
  target.addEventListener("contextmenu", onContextMenu, true);
  target.addEventListener("click", onClick, true);
  return () => {
    clear();
    target.removeEventListener("pointerdown", onPointerDown);
    target.removeEventListener("pointermove", onPointerMove);
    target.removeEventListener("pointerup", clear);
    target.removeEventListener("pointercancel", clear);
    target.removeEventListener("contextmenu", onContextMenu, true);
    target.removeEventListener("click", onClick, true);
  };
}
