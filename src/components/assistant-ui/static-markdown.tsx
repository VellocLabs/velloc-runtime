import { isValidElement, memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { unstable_memoizeMarkdownComponents as memoizeMarkdownComponents } from "@assistant-ui/react-markdown";

import { cn } from "@/lib/utils";
import {
  MARKDOWN_INLINE_CODE_CLASS,
  MARKDOWN_PRE_CLASS,
  sharedMarkdownComponents,
} from "@/components/assistant-ui/markdown-components";
import { MermaidDiagram } from "@/components/assistant-ui/mermaid-diagram";
import {
  GraphvizDiagram,
  looksLikeDot,
} from "@/components/assistant-ui/graphviz-diagram";
import { remarkFilePaths } from "@/components/assistant-ui/remarkFilePaths";

/**
 * Markdown renderer for non-message surfaces, using `react-markdown` with the shared
 * styling map. `code`/`pre` are overridden locally because the shared `code` needs
 * assistant-ui's PreContext; ```mermaid fences render as diagrams via `pre`.
 */

/** Extract `{ language, text }` from a react-markdown `<pre>` child, which is
 *  the `<code className="language-xxx">` element for fenced blocks. */
function fencedCodeInfo(
  children: ReactNode,
): { language: string | undefined; text: string } | null {
  if (!isValidElement(children)) return null;
  const props = children.props as {
    className?: unknown;
    children?: unknown;
  };
  const className = typeof props.className === "string" ? props.className : "";
  const language = /language-([\w-]+)/.exec(className)?.[1];
  const text = typeof props.children === "string" ? props.children : null;
  if (text === null) return null;
  return { language, text };
}

const staticComponents = memoizeMarkdownComponents({
  ...sharedMarkdownComponents,
  pre: ({ className, children, ...props }) => {
    const fenced = fencedCodeInfo(children);
    if (fenced?.language === "mermaid") {
      // Replace the whole code block — no <pre> box around the diagram.
      return <MermaidDiagram code={fenced.text} />;
    }
    // Graphviz DOT: an explicit `dot`/`graphviz` tag, or an untagged fence
    // whose body is unambiguous DOT (skills often paste a bare `digraph { … }`).
    if (
      fenced &&
      (fenced.language === "dot" ||
        fenced.language === "graphviz" ||
        (fenced.language === undefined && looksLikeDot(fenced.text)))
    ) {
      return <GraphvizDiagram code={fenced.text} />;
    }
    return (
      <pre
        // Non-message surfaces have no CodeHeader row above the block, so
        // restore the top rounding/border the shared class removes.
        className={cn(
          MARKDOWN_PRE_CLASS,
          "mt-2.5 rounded-t-lg border-t",
          className,
        )}
        {...props}
      >
        {children}
      </pre>
    );
  },
  code: ({ className, children, ...props }) => {
    // Fenced blocks arrive with a language-* class (and live under our pre
    // override); a language-less fence still carries its newlines. Anything
    // else is inline code.
    const isBlock =
      /language-/.test(typeof className === "string" ? className : "") ||
      (typeof children === "string" && children.includes("\n"));
    return (
      <code
        className={cn(!isBlock && MARKDOWN_INLINE_CODE_CLASS, className)}
        {...props}
      >
        {children}
      </code>
    );
  },
});

function StaticMarkdownImpl({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  return (
    <div className={cn("aui-md text-body", className)}>
      {/* remarkFilePaths marks prose file paths; `sharedMarkdownComponents`
          already carries the FILE_PATH_TAG renderer, so plan text and `.md`
          previews get the same `>>` open affordance as the chat — provided the
          surface sits under a FilePathContext/RightPanelContentContext (the
          shell provides both around the Right Panel; a surface without them
          renders paths as plain text, unchanged). */}
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkFilePaths]}
        components={staticComponents}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export const StaticMarkdown = memo(StaticMarkdownImpl);
