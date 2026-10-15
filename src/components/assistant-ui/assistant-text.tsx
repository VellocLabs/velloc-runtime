/**
 * An assistant reply's text part as a mod's `AssistantMessage` site (F-25): a rewrite
 * changes the drawing and leaves the stored message alone. Raised only for a settled
 * block of a model's reply; streaming parts, system rows, command output, error cards
 * and reasoning are not raised.
 */
import { memo, useMemo } from "react";
import { useAssistantState, useAui } from "@assistant-ui/react";

import { MarkdownText } from "./markdown-text";
import { ModAssistantMessageSite, type ModAssistantMessageProps } from "./mod-render";
import { StaticMarkdown } from "./static-markdown";

/** The index of the part being drawn, when it was drawn by index from its
 *  message (`PartByIndex`); null otherwise. */
function usePartIndex(): number | null {
  const aui = useAui();
  const part = aui.part;
  if (part.source !== "message") return null;
  const query = part.query as { type?: string; index?: unknown };
  return query.type === "index" && typeof query.index === "number" ? query.index : null;
}

/** Whether a row is the model's reply: a persisted one carries no
 *  `sourceType`; a live one carries `live_events` and, unlike a live system
 *  row, no `subtype`. Every other `sourceType` is a row the adapter made of
 *  something else (`system`, `interrupt`, `provider_api_error`, …). */
export function isModelReplyRow(custom: Record<string, unknown> | undefined): boolean {
  const sourceType = custom?.sourceType;
  if (sourceType === undefined) return true;
  return sourceType === "live_events" && custom?.subtype === undefined;
}

const AssistantTextImpl = () => {
  const index = usePartIndex();
  const messageId = useAssistantState((s) => s.message.id);
  const isReply = useAssistantState(
    (s) =>
      s.message.role === "assistant" &&
      isModelReplyRow(s.message.metadata?.custom as Record<string, unknown> | undefined),
  );
  const text = useAssistantState((s) => (s.part.type === "text" ? s.part.text : ""));
  const isSettled = useAssistantState((s) => s.part.status.type !== "running");
  const firstText = useAssistantState((s) => s.message.content.findIndex((p) => p.type === "text"));
  const props = useMemo<ModAssistantMessageProps>(
    () => ({ text, isFirstOfReply: index !== null && index === firstText }),
    [text, index, firstText],
  );
  if (index === null || !isReply || !isSettled) return <MarkdownText />;
  return (
    <ModAssistantMessageSite
      requestId={`${messageId}:${index}`}
      props={props}
      drawEngine={(rewrite) =>
        // A mod's rewrite draws in the block alone, markdown as the block is.
        rewrite ? <StaticMarkdown content={rewrite.text} /> : <MarkdownText />
      }
    />
  );
};

export const AssistantText = memo(AssistantTextImpl);
