import { createContext } from "react";

/**
 * Whether a tool card with no remembered open state starts opened. True only
 * under a lone-call line that already states what the call does, so opening
 * that line lands on the call's detail.
 */
export const ToolCardOpenDefault = createContext(false);
