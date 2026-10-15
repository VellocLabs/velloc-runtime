import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A provider's brand mark from the host catalog (`BrowserLlmProvider.iconSvg`,
 * an SVG string the C++ side ships from its bundled assets). Rendered verbatim
 * — the catalog is trusted, same source the Lit dropdown rendered. Shared by
 * the model picker, the Models settings page and the topbar import button.
 */
export function ProviderIcon({
  svg,
  className,
}: {
  svg?: string;
  className?: string;
}) {
  if (!svg) return null;
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center [&>svg]:size-4",
        className,
      )}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
