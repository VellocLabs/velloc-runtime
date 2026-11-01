import { createContext, useContext } from "react";

/**
 * Whether the transcript a surface sits in is the one on screen. A hidden
 * thread stays mounted (`display: none`), and a popover left open in it is
 * portaled to the body and measured against a zero rect, so it jumps to the
 * window's corner: such a surface closes while this is false.
 */
export const ThreadForegroundContext = createContext<boolean>(true);

export function useThreadForeground(): boolean {
  return useContext(ThreadForegroundContext);
}
