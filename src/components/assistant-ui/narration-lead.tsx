import { type FC } from "react";
import { MessagePrimitive } from "@assistant-ui/react";
import { AssistantText } from "./assistant-text";
import { PartLineProvider } from "./part-line-context";
import { cn } from "../../lib/utils";

// A narration is always a text part; a text part is a mod's
// `AssistantMessage` site (F-25).
const NARRATION_COMPONENTS = { Text: AssistantText } as const;

export type ToolRunState = "running" | "cancelled" | "failed" | "settled";

/**
 * The text part that introduces a tool run, drawn by that run as ordinary
 * prose above the run's summary line (F-22). `running` sweeps the sheen over
 * it while the run is the turn's current work.
 */
export const NarrationPart: FC<{
  index: number;
  line: number | null;
  isRevealTarget?: boolean;
  running?: boolean;
}> = ({ index, line, isRevealTarget = false, running = false }) => (
  <div
    data-slot="tool-run-narration"
    data-running={running ? "true" : undefined}
    className={cn("min-w-0", running && "nexus-sheen")}
  >
    <PartLineProvider line={line} isRevealTarget={isRevealTarget}>
      <MessagePrimitive.PartByIndex index={index} components={NARRATION_COMPONENTS} />
    </PartLineProvider>
  </div>
);
