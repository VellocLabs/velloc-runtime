import { useMemo } from "react";

import { cn } from "@/lib/utils";
import { useT } from "@/browser/webview/i18n";
import { isHeavyText, measureText } from "@/utils/textHeaviness";

/** True when `text` is over a heavy-text limit; measured once per distinct text (F-9). */
export function useHeavyText(text: string): boolean {
  return useMemo(() => isHeavyText(measureText(text)), [text]);
}

/**
 * Text too large to parse as Markdown, shown as-is: a notice over one
 * height-bounded, scrollable `<pre>` holding a single text node (F-9).
 */
export function HeavyTextBlock({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const t = useT();
  return (
    <div data-slot="heavy-text" className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <p role="note" className="text-muted-foreground text-body">
        {t("markdown.tooLargeShowingText")}
      </p>
      <pre
        tabIndex={0}
        className="max-h-[60vh] overflow-auto whitespace-pre rounded-md border bg-muted/30 px-3 py-2 font-mono text-code"
      >
        {text}
      </pre>
    </div>
  );
}
