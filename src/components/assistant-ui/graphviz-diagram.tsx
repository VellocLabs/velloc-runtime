import { useEffect, useRef, useState } from "react";

import type { Viz } from "@viz-js/viz";

import { cn } from "@/lib/utils";
import { MARKDOWN_PRE_CLASS } from "@/components/assistant-ui/markdown-components";

/**
 * Renders a Graphviz DOT fence as SVG. `@viz-js/viz` is loaded only by dynamic
 * `import()`; never add it to `resolveManualChunk`. Renders are debounced and failures
 * fall back to the raw code; dark mode is CSS recolouring in `globals.css`.
 */

/** Debounce window before attempting a render — long enough to skip most
 *  mid-stream (per-token) code updates, short enough to feel immediate. */
const RENDER_DEBOUNCE_MS = 150;

/**
 * Whether a bare (untagged) fence body should be treated as Graphviz DOT.
 * Deliberately tight: only the unambiguous DOT openers `digraph …`, `strict
 * digraph/graph …`, and `graph <id> {`. A bare mermaid `graph TD` fence is NOT
 * matched (no `{`), and even if a stray one slipped through it renders as raw
 * text today anyway — so this never regresses an existing surface. Explicitly
 * tagged `dot`/`graphviz` fences bypass this check.
 */
export function looksLikeDot(text: string): boolean {
  return /^\s*(strict\s+)?(digraph\b|graph\b[^\n]*\{)/.test(text);
}

type VizModule = { instance: () => Promise<Viz> };

/**
 * Lazily import + instantiate Viz, caching the promise so N graphs share one
 * load — but a REJECTED load (chunk fetch OR wasm init) clears the cache so the
 * next render retries: a single transient failure must not poison every future
 * graph for the page lifetime. Factored as a factory so the retry contract is
 * unit-testable with an injected importer (`graphviz.render.test.ts`).
 */
export function createGraphvizLoader(
  importer: () => Promise<VizModule>,
): () => Promise<Viz> {
  let cached: Promise<Viz> | null = null;
  return () => {
    cached ??= importer()
      .then((m) => m.instance())
      .catch((err) => {
        cached = null;
        throw err;
      });
    return cached;
  };
}

const loadGraphviz = createGraphvizLoader(() => import("@viz-js/viz"));

/** Elements a DOT source can make Graphviz emit (or that could only arrive
 *  through it) that fetch, run, or animate anything. Removed with their
 *  subtree. `animate`/`set` can rewrite an `href` after the fact. */
const UNSAFE_SVG_ELEMENTS = new Set([
  "script",
  "foreignobject",
  "image",
  "use",
  "style",
  "iframe",
  "object",
  "embed",
  "animate",
  "animatetransform",
  "animatemotion",
  "set",
]);

/**
 * Security: the DOT is model-controlled, and Graphviz emits live `<a xlink:href>` anchors
 * (`javascript:` included) and copies `id` / `class` verbatim, so the tree is scrubbed
 * here, where it enters the DOM: every `<a>` is unwrapped; fetching / scripting /
 * animating elements are removed; `on*`, `href` / `xlink:href`, `target`, `class` and
 * `style` are stripped; every `id` gets a per-diagram prefix and `url(#…)` references
 * are rewritten to it, while a `url(…)` naming anything else is removed.
 */
let graphvizIdSeq = 0;
const URL_REF_RE = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;

export function sanitizeGraphvizSvg(svg: Element): void {
  const idPrefix = `gv${++graphvizIdSeq}-`;
  for (const el of Array.from(svg.querySelectorAll("*"))) {
    // Already gone with a removed ancestor.
    if (!svg.contains(el)) continue;
    const name = el.localName.toLowerCase();
    if (UNSAFE_SVG_ELEMENTS.has(name)) {
      el.remove();
      continue;
    }
    if (name === "a") {
      el.replaceWith(...Array.from(el.childNodes));
    }
  }
  const elements = [svg, ...Array.from(svg.querySelectorAll("*"))];
  const ids = new Set<string>();
  for (const el of elements) {
    const id = el.getAttribute("id");
    if (id) ids.add(id);
  }
  for (const el of elements) {
    for (const attr of Array.from(el.attributes)) {
      const attrName = attr.localName.toLowerCase();
      if (
        attrName.startsWith("on") ||
        attrName === "href" ||
        attrName === "target" ||
        attrName === "class" ||
        attrName === "style"
      ) {
        el.removeAttributeNode(attr);
        continue;
      }
      if (attrName === "id") {
        attr.value = idPrefix + attr.value;
        continue;
      }
      if (!/url\(/i.test(attr.value)) continue;
      let local = true;
      const rewritten = attr.value.replace(URL_REF_RE, (_m, _q, target: string) => {
        const ref = target.trim();
        if (!ref.startsWith("#") || !ids.has(ref.slice(1))) {
          local = false;
          return "none";
        }
        return `url(#${idPrefix}${ref.slice(1)})`;
      });
      if (local && !/url\(/i.test(rewritten.replace(URL_REF_RE, ""))) {
        attr.value = rewritten;
      } else {
        el.removeAttributeNode(attr);
      }
    }
  }
}

type RenderState =
  | { status: "pending" }
  | { status: "rendered" }
  | { status: "error" };

export function GraphvizDiagram({
  code,
  className,
}: {
  code: string;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<RenderState>({ status: "pending" });

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void loadGraphviz()
        .then((viz) => {
          if (cancelled) return;
          // renderSVGElement throws on invalid DOT — caught below.
          const svg = viz.renderSVGElement(code);
          sanitizeGraphvizSvg(svg);
          svg.style.maxWidth = "100%";
          svg.style.height = "auto";
          if (cancelled || !containerRef.current) return;
          containerRef.current.replaceChildren(svg);
          setState({ status: "rendered" });
        })
        .catch(() => {
          // Render failure — mid-stream partial code or genuinely invalid DOT.
          // Show the raw source instead.
          if (!cancelled) setState({ status: "error" });
        });
    }, RENDER_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code]);

  // Both the raw-source fallback and the ref'd container stay mounted during
  // the error state (container hidden): a mid-stream pause routinely renders a
  // partial fence → parse error, and the next code update's SUCCESSFUL render
  // must be able to commit into the container and clear the error. Returning
  // the <pre> INSTEAD of the container would make 'error' a one-way trap (see
  // the mermaid renderer's matching comment).
  return (
    <>
      {state.status === "error" ? (
        <pre
          data-slot="graphviz-diagram-fallback"
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
        data-slot="graphviz-diagram"
        ref={containerRef}
        className={cn(
          "aui-graphviz-diagram my-2.5 flex justify-center overflow-x-auto [&_svg]:h-auto [&_svg]:max-w-full",
          state.status === "pending" && "min-h-8",
          state.status === "error" && "hidden",
          className,
        )}
      />
    </>
  );
}
