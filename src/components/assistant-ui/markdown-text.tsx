import "@assistant-ui/react-markdown/styles/dot.css";

import {
  MarkdownTextPrimitive,
  type SyntaxHighlighterProps,
  unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
} from "@assistant-ui/react-markdown";
import { memo, useDeferredValue, useId, useMemo, useRef, useSyncExternalStore } from "react";
import { TextMessagePartProvider, useAssistantState, useAui } from "@assistant-ui/react";
import type { Root } from "hast";

import { sharedMarkdownComponents } from "@/components/assistant-ui/markdown-components";
import { TURN_SETTLED_KEY } from "@/browser/webview/turnSettled";
import { CONVERSATION_REMARK_PLUGINS } from "@/components/assistant-ui/markdown-hast";
import { MermaidDiagram } from "@/components/assistant-ui/mermaid-diagram";
import { GraphvizDiagram } from "@/components/assistant-ui/graphviz-diagram";
import {
  ShellCodeHeader,
  ShellSyntaxHighlighter,
} from "@/components/assistant-ui/shell-command-block";
import { SHELL_FENCE_LANGUAGES } from "@/components/assistant-ui/shell-command";
import { usePartLineAttrs, useRevealSelf } from "./part-line-context";
import { HeavyTextBlock } from "./heavy-text-block";
import { isHeavyText, measureText, parsesOffThread } from "@/utils/textHeaviness";
import {
  type ParsedMarkdown,
  useOffThreadMarkdown,
  useOffThreadPath,
} from "./off-thread-markdown";

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
  const text = useAssistantState((s) => {
    const value = (s.part as { text?: unknown }).text;
    return typeof value === "string" ? value : "";
  });
  const measure = useMemo(() => measureText(text), [text]);
  // A heavy part is never handed to the Markdown parser, which re-parses the
  // whole text on every streamed update (F-9).
  const heavy = isHeavyText(measure);
  // A large part that streams is parsed in a Worker and drawn from the newest
  // tree, so no update re-parses it on the main thread. It stays there once it
  // settles, across a remount; a settled part loaded later renders inline,
  // once (F-9).
  const running = useAssistantState((s) => s.part.status?.type === "running");
  const partKey = usePartKey();
  const onPath = useOffThreadPath(partKey, parsesOffThread(measure), running);
  const offThread = onPath && !heavy;
  // A landed tree or a status flip redraws the whole part; deferring both lets
  // React split that render across tasks while the text keeps updating.
  const parsed = useDeferredValue(useOffThreadMarkdown(partKey, offThread ? text : null));
  const drawnRunning = useDeferredValue(running);
  // The last text drawn inline, still under the off-thread limits: it keeps
  // its formatting until the first tree lands.
  const lastInline = useRef<string | null>(null);
  if (heavy) {
    return (
      <div ref={revealRef} className="min-w-0 max-w-full" {...lineAttrs}>
        <HeavyTextBlock text={text} />
      </div>
    );
  }
  if (offThread) {
    return (
      <div
        ref={revealRef}
        className="min-w-0 max-w-full wrap-break-word"
        {...lineAttrs}
      >
        {parsed && text.startsWith(parsed.text) ? (
          <>
            <ParsedMarkdownText parsed={parsed} running={drawnRunning} />
            <UnparsedText text={text.slice(parsed.text.length)} />
          </>
        ) : lastInline.current !== null && text.startsWith(lastInline.current) ? (
          <>
            <InlineMarkdownText text={lastInline.current} running={drawnRunning} />
            <UnparsedText text={text.slice(lastInline.current.length)} />
          </>
        ) : (
          <UnparsedText text={text} />
        )}
      </div>
    );
  }
  lastInline.current = text;
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
        remarkPlugins={CONVERSATION_REMARK_PLUGINS}
        className="aui-md"
        smooth={smooth}
        preprocess={parsableText}
        components={defaultComponents}
        componentsByLanguage={componentsByLanguage}
      />
    </div>
  );
};

export const MarkdownText = memo(MarkdownTextImpl);

// The primitive reads the part on its own, so a render can hand it text newer
// than the check above saw; it parses nothing heavy either way (F-9).
function parsableText(text: string): string {
  return isHeavyText(measureText(text)) ? "" : text;
}

const defaultComponents = memoizeMarkdownComponents(sharedMarkdownComponents);

/** A part's identity across remounts: its message and its index in it. */
function usePartKey(): string {
  const aui = useAui();
  const messageId = useAssistantState((s) => s.message.id);
  const ownId = useId();
  const part = aui.part;
  const query = part.source === "message" ? (part.query as { type?: string; index?: unknown }) : null;
  return query?.type === "index" && typeof query.index === "number"
    ? `${messageId}:${query.index}`
    : ownId;
}

function UnparsedText({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div data-slot="markdown-unparsed" className="whitespace-pre-wrap">
      {text}
    </div>
  );
}

const NO_PLUGINS: never[] = [];

/** A rehype step that swaps in a tree parsed elsewhere. */
function treeOf(tree: Root) {
  return () => () => tree;
}

/** A fixed small text parsed in the render once, while the first tree is on its way. */
const InlineMarkdownText = memo(function InlineMarkdownText({
  text,
  running,
}: {
  text: string;
  running: boolean;
}) {
  return (
    <TextMessagePartProvider text={text} isRunning={running}>
      <MarkdownTextPrimitive
        remarkPlugins={CONVERSATION_REMARK_PLUGINS}
        className="aui-md"
        smooth={false}
        components={defaultComponents}
        componentsByLanguage={componentsByLanguage}
      />
    </TextMessagePartProvider>
  );
});

/**
 * Draws a finished off-thread parse through the same primitive, components
 * and status as the inline path; the primitive itself is handed no text.
 */
const ParsedMarkdownText = memo(function ParsedMarkdownText({
  parsed,
  running,
}: {
  parsed: ParsedMarkdown;
  running: boolean;
}) {
  const rehypePlugins = useMemo(() => [treeOf(parsed.tree)], [parsed.tree]);
  return (
    <TextMessagePartProvider text="" isRunning={running}>
      <MarkdownTextPrimitive
        remarkPlugins={NO_PLUGINS}
        rehypePlugins={rehypePlugins}
        className="aui-md"
        smooth={false}
        components={defaultComponents}
        componentsByLanguage={componentsByLanguage}
      />
    </TextMessagePartProvider>
  );
});
