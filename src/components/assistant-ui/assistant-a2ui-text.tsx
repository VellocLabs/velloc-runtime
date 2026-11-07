/**
 * A reply text part holding `<a2ui>` blocks (F-1): its prose as Markdown, each
 * finished block as the inline card of the surfaces it draws, and a block the
 * model is still writing as the card of the surface it is drawing (a
 * placeholder until that is known). The Express source is never shown.
 */
import { lazy, memo, Suspense, useMemo } from "react";
import { LoaderCircleIcon } from "lucide-react";

import { a2uiBlockKey, splitA2uiText } from "@/toolkit/builtin/a2ui/express/a2uiBlocks";
import { useT } from "@/browser/webview/i18n";
import { StaticMarkdown } from "./static-markdown";

const A2uiBlockMention = lazy(() =>
  import("@/browser/webview/a2ui/A2uiBlockMention").then((m) => ({ default: m.A2uiBlockMention })),
);
const A2uiLiveBlockMention = lazy(() =>
  import("@/browser/webview/a2ui/A2uiBlockMention").then((m) => ({ default: m.A2uiLiveBlockMention })),
);

function A2uiBlockPending() {
  const t = useT();
  return (
    <div
      data-slot="a2ui-block-pending"
      className="my-2 flex w-full items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground"
    >
      <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin" />
      {t("a2ui.building")}
    </div>
  );
}

/**
 * A block's key is the row's `blockKeys` entry at its ordinal across the row's
 * text parts (`firstOrdinal` blocks come before this part), the key the
 * transcript derives; without one (a streaming row) it is keyed by the row id.
 */
const AssistantA2uiTextImpl = ({
  text,
  messageId,
  firstOrdinal,
  blockKeys,
}: {
  text: string;
  messageId: string;
  firstOrdinal: number;
  blockKeys?: readonly string[];
}) => {
  const segments = useMemo(() => splitA2uiText(text), [text]);
  return (
    <>
      {segments.map((segment, i) => {
        if (segment.kind === "text") return <StaticMarkdown key={i} content={segment.text} />;
        const ordinal = firstOrdinal + segment.index;
        const blockKey = blockKeys?.[ordinal] ?? a2uiBlockKey(messageId, ordinal);
        if (!segment.closed) {
          return (
            <Suspense key={i} fallback={<A2uiBlockPending />}>
              <A2uiLiveBlockMention body={segment.body} blockKey={blockKey} pending={<A2uiBlockPending />} />
            </Suspense>
          );
        }
        return (
          <Suspense key={i} fallback={<A2uiBlockPending />}>
            <A2uiBlockMention body={segment.body} blockKey={blockKey} />
          </Suspense>
        );
      })}
    </>
  );
};

export const AssistantA2uiText = memo(AssistantA2uiTextImpl);
