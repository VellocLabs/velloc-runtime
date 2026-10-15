import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";

import { cn } from "@/lib/utils";
import { MARKDOWN_PRE_CLASS } from "@/components/assistant-ui/markdown-components";

/**
 * Renders a ```mermaid fence as SVG. `mermaid` is loaded only by dynamic `import()`;
 * never add it to `resolveManualChunk`. Renders are debounced, parse errors fall back
 * to the raw code, and `suppressErrorRendering` keeps mermaid's error SVG out of the DOM.
 */

/** Debounce window before attempting a render — long enough to skip most
 *  mid-stream (per-token) code updates, short enough to feel immediate. */
const RENDER_DEBOUNCE_MS = 150;

type MermaidModule = typeof import("mermaid").default;

let initializedTheme: string | null = null;

/**
 * Lazily import mermaid, caching the promise so N diagrams share one load —
 * but a REJECTED import clears the cache so the next render retries: a single
 * transient chunk-load failure must not poison every future diagram for the
 * page lifetime. Factored as a factory so the retry contract is unit-testable
 * with an injected importer (`markdown-mermaid.render.test.ts`).
 */
export function createMermaidLoader(
  importer: () => Promise<{ default: MermaidModule }>,
): () => Promise<MermaidModule> {
  let cached: Promise<MermaidModule> | null = null;
  return () => {
    cached ??= importer().then(
      (m) => m.default,
      (err) => {
        cached = null;
        throw err;
      },
    );
    return cached;
  };
}

const loadMermaid = createMermaidLoader(() => import("mermaid"));

/** (Re-)initialize mermaid when first loaded or when the app theme flips.
 *  Module-level so N diagrams share one init per theme. */
function primeMermaidTheme(mermaid: MermaidModule, dark: boolean): void {
  const theme = dark ? "dark" : "default";
  if (initializedTheme === theme) return;
  initializedTheme = theme;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    theme,
  });
}

const darkClassListeners = new Set<() => void>();
let darkClassObserver: MutationObserver | null = null;

function subscribeDarkClass(listener: () => void): () => void {
  darkClassListeners.add(listener);
  if (!darkClassObserver && typeof document !== "undefined") {
    darkClassObserver = new MutationObserver(() => {
      for (const l of darkClassListeners) l();
    });
    darkClassObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }
  return () => {
    darkClassListeners.delete(listener);
    if (darkClassListeners.size === 0 && darkClassObserver) {
      darkClassObserver.disconnect();
      darkClassObserver = null;
    }
  };
}

/** Whether the host-injected `.dark` class is on <html> right now; subscribes
 *  to class-attribute mutations so diagrams re-theme live. */
export function useIsDarkTheme(): boolean {
  return useSyncExternalStore(
    subscribeDarkClass,
    () =>
      typeof document !== "undefined" &&
      document.documentElement.classList.contains("dark"),
    () => false,
  );
}

type RenderState =
  | { status: "pending" }
  | { status: "rendered" }
  | { status: "error" };

export function MermaidDiagram({
  code,
  className,
}: {
  code: string;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<RenderState>({ status: "pending" });
  const isDark = useIsDarkTheme();
  // Mermaid's render() needs a document-unique, selector-safe id. React's
  // useId is stable per instance but emits `:r0:` — strip the colons.
  const reactId = useId();
  const diagramId = `mmd-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void loadMermaid()
        .then(async (mermaid) => {
          if (cancelled) return;
          primeMermaidTheme(mermaid, isDark);
          const { svg } = await mermaid.render(diagramId, code);
          if (cancelled || !containerRef.current) return;
          containerRef.current.innerHTML = svg;
          setState({ status: "rendered" });
        })
        .catch(() => {
          // Parse/render failure — mid-stream partial code or a genuinely
          // invalid diagram. Show the raw source instead.
          if (!cancelled) setState({ status: "error" });
        });
    }, RENDER_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code, isDark, diagramId]);

  // The raw-source fallback and the ref'd container are BOTH mounted during
  // the error state (container hidden): a mid-stream pause routinely renders
  // a partial fence → parse error, and the next code update's SUCCESSFUL
  // render must be able to commit into the container and clear the error.
  // Returning the <pre> INSTEAD of the container made 'error' a one-way trap
  // — every later success bailed at `!containerRef.current` before setState,
  // permanently showing raw source even after the fence completed validly.
  return (
    <>
      {state.status === "error" ? (
        <pre
          data-slot="mermaid-diagram-fallback"
          className={cn(
            MARKDOWN_PRE_CLASS,
            "whitespace-pre-wrap break-words font-mono",
            className,
          )}
        >
          {code}
        </pre>
      ) : null}
      <div
        data-slot="mermaid-diagram"
        ref={containerRef}
        className={cn(
          "aui-mermaid-diagram my-2.5 flex justify-center overflow-x-auto [&_svg]:h-auto [&_svg]:max-w-full",
          state.status === "pending" && "min-h-8",
          state.status === "error" && "hidden",
          className,
        )}
      />
    </>
  );
}
