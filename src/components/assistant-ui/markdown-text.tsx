import "@assistant-ui/react-markdown/styles/dot.css";

import {
  MarkdownTextPrimitive,
  type SyntaxHighlighterProps,
  unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
} from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";
import { memo, useSyncExternalStore } from "react";
import { useAssistantState } from "@assistant-ui/react";

import { sharedMarkdownComponents } from "@/components/assistant-ui/markdown-components";
import { TURN_SETTLED_KEY } from "@/browser/webview/turnSettled";
import { remarkFilePaths } from "@/components/assistant-ui/remarkFilePaths";
import { MermaidDiagram } from "@/components/assistant-ui/mermaid-diagram";
import { GraphvizDiagram } from "@/components/assistant-ui/graphviz-diagram";
import {
  ShellCodeHeader,
  ShellSyntaxHighlighter,
} from "@/components/assistant-ui/shell-command-block";
import { SHELL_FENCE_LANGUAGES } from "@/components/assistant-ui/shell-command";
import { usePartLineAttrs, useRevealSelf } from "./part-line-context";

// ```mermaid / ```dot / ```graphviz fences render as SVG diagrams. The
// SyntaxHighlighter return value is mounted unwrapped (no enclosing <pre>), and
// the null CodeHeader drops the language/copy row above the diagram.
//
// Chat dispatch is keyed by the explicit language tag only — the streaming
// primitive cannot content-sniff a bare fence. Untagged DOT still renders as
// a graph on non-message surfaces (SkillPanel via StaticMarkdown), which is
// where skill bodies actually live.
const MermaidSyntaxHighlighter = ({ code }: SyntaxHighlighterProps) => (
  <MermaidDiagram code={code} />
);
const GraphvizSyntaxHighlighter = ({ code }: SyntaxHighlighterProps) => (
  <GraphvizDiagram code={code} />
);
const NullCodeHeader = () => null;
const diagramLanguage = (SyntaxHighlighter: typeof MermaidSyntaxHighlighter) => ({
  SyntaxHighlighter,
  CodeHeader: NullCodeHeader,
});
// A shell fence holding one runnable line renders as a Run card (F-31); the
// header drops out for it and stays for a longer script.
const shellLanguage = {
  SyntaxHighlighter: ShellSyntaxHighlighter,
  CodeHeader: ShellCodeHeader,
};
const componentsByLanguage = {
  mermaid: diagramLanguage(MermaidSyntaxHighlighter),
  dot: diagramLanguage(GraphvizSyntaxHighlighter),
  graphviz: diagramLanguage(GraphvizSyntaxHighlighter),
  ...Object.fromEntries(SHELL_FENCE_LANGUAGES.map((language) => [language, shellLanguage])),
};

// Smooth typing animates only while the turn runs in a visible page; rAF stops in hidden
// windows, so `smooth={false}` once `turnSettled` shows the whole text at once.
function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}
const pageVisible = () => document.visibilityState === "visible";
const serverVisible = () => true;

export function useSmoothText(): boolean {
  const isRunning = useAssistantState((s) => s.thread.isRunning);
  const settled = useAssistantState(
    (s) =>
      (s.message.metadata?.custom as Record<string, unknown> | undefined)?.[
        TURN_SETTLED_KEY
      ] === true,
  );
  const visible = useSyncExternalStore(subscribeVisibility, pageVisible, serverVisible);
  return isRunning && !settled && visible;
}

const MarkdownTextImpl = () => {
  // The transcript line this text came from, bound by the body when it
  // rendered this part. Lets a search jump land on this block instead of
  // the whole message.
  const lineAttrs = usePartLineAttrs();
  const revealRef = useRevealSelf<HTMLDivElement>();
  const smooth = useSmoothText();
  return (
    // `min-w-0` lets the bubble shrink; `wrap-break-word` keeps long tokens
    // (CJK runs, URLs, base64 — common in pasted formatted paragraphs) from
    // overflowing the chat's max width.
    <div
      ref={revealRef}
      className="min-w-0 max-w-full wrap-break-word"
      {...lineAttrs}
    >
      <MarkdownTextPrimitive
        remarkPlugins={[remarkGfm, remarkFilePaths]}
        className="aui-md"
        smooth={smooth}
        components={defaultComponents}
        componentsByLanguage={componentsByLanguage}
      />
    </div>
  );
};

export const MarkdownText = memo(MarkdownTextImpl);

const defaultComponents = memoizeMarkdownComponents(sharedMarkdownComponents);
