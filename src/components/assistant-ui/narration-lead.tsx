import { type FC } from "react";
import { MessagePrimitive, useAssistantState } from "@assistant-ui/react";
import { isCompactNarration } from "../../utils/narrationLead";
import { AssistantText } from "./assistant-text";
import { PartLineProvider } from "./part-line-context";

// A narration is always a text part; a text part is a mod's
// `AssistantMessage` site (F-25).
const NARRATION_COMPONENTS = { Text: AssistantText } as const;

export type ToolRunState = "running" | "cancelled" | "failed" | "settled";

/** The text part that introduces a tool run, drawn by that run (F-22). */
export const NarrationPart: FC<{
  index: number;
  line: number | null;
  isRevealTarget?: boolean;
}> = ({ index, line, isRevealTarget = false }) => (
  <PartLineProvider line={line} isRevealTarget={isRevealTarget}>
    <MessagePrimitive.PartByIndex index={index} components={NARRATION_COMPONENTS} />
  </PartLineProvider>
);

/** Whether the text part at `index` is short enough to be the run's line. */
export function useCompactNarration(index: number | undefined): boolean {
  return useAssistantState(({ message }) => {
    if (index === undefined) return false;
    const part = message.parts[index] as { text?: unknown } | undefined;
    return isCompactNarration(typeof part?.text === "string" ? part.text : undefined);
  });
}

/**
 * Whether a compact narration stands in for the run's summary line. A failed
 * or cancelled run keeps its summary line: that line is where the outcome is
 * written.
 */
export function narrationLeadsRun(compact: boolean, state: ToolRunState): boolean {
  return compact && (state === "running" || state === "settled");
}
