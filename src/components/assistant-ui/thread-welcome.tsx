import { NexusLoadingPage } from "@/components/assistant-ui/loading-page";
import { ThreadPrimitive } from "@assistant-ui/react";
import {
  type FC,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useT, useLocale } from "@/browser/webview/i18n";
import { getWelcome } from "@/prompting/templateCatalog";
import { isPluginTemplateId } from "@/mods/ui/uiManifest";
import { pluginWelcome, useModContributions } from "@/browser/webview/mods/modContributionsView";
import { visibleSuggestionCount } from "@/components/assistant-ui/welcomeSuggestionLayout";
import { getBootDiagnosticTraceId, installSessionTracer } from "@/utils/sessionTrace";

// Exported so it can be rendered at the AssistantUiThread level as a
// panel-wide overlay (covering ThreadHeader + main + Composer)
// instead of being constrained to the Viewport's inner area. Lifecycle
// effects (mount tracer, unmount CustomEvent that drives boot dispatch)
// are unchanged regardless of where the component is mounted.
export const ThreadWelcome: FC = () => {
  // Tracer events on mount/unmount, plus a one-shot DOM event on unmount that
  // MultiSessionShell uses as the "conversation is now visible" signal.
  useEffect(() => {
    const tracer = installSessionTracer({ context: "ui" });
    tracer.event("boot.threadWelcome.mounted", {
      traceId: getBootDiagnosticTraceId(),
    });
    // Boot instrumentation. Capture the moment of first ThreadWelcome
    // mount (effectively "React first paint inside MultiSessionShell").
    // Only set on the first mount — subsequent mounts (session switches)
    // are unrelated to the original boot timeline.
    const marks = (globalThis as { __nexusBootMarks?: Record<string, number> })
      .__nexusBootMarks ?? {};
    if (marks.threadWelcomeMountedMs == null) {
      marks.threadWelcomeMountedMs = Date.now();
      (globalThis as { __nexusBootMarks?: Record<string, number> })
        .__nexusBootMarks = marks;
    }
    return () => {
      tracer.event("boot.threadWelcome.unmounted", {
        traceId: getBootDiagnosticTraceId(),
      });
      // Capture the unmount moment too (only the first one — i.e. the
      // real "messages now visible" transition; the early loading→ready
      // transient unmount happens before threadWelcomeUnmountedMs is
      // ever the right answer, but the listener-arming logic in
      // MultiSessionShell ensures we only react to the right one).
      try {
        const um = (globalThis as { __nexusBootMarks?: Record<string, number> })
          .__nexusBootMarks ?? {};
        if (um.threadWelcomeFirstUnmountedMs == null) {
          um.threadWelcomeFirstUnmountedMs = Date.now();
          (globalThis as { __nexusBootMarks?: Record<string, number> })
            .__nexusBootMarks = um;
        }
        globalThis.dispatchEvent(
          new CustomEvent("nexus:threadWelcome:unmounted"),
        );
      } catch {
        // CustomEvent unavailable — ignore. Fallback paths in
        // MultiSessionShell handle a missed signal via timeout/other gates.
      }
    };
  }, []);
  return <ConversationSkeleton />;
};

/**
 * Conversation-shaped loading skeleton for the right panel's empty / loading state.
 */
const ConversationSkeleton: FC = () => {
  const t = useT();
  // The right-panel loading state is a single centered loading indicator.
  return (
    <div className="flex h-full w-full items-center justify-center bg-background text-foreground">
      <NexusLoadingPage label={t('thread.loadingConversation')} />
    </div>
  );
};

// Per-type welcome page — prompt-starter chips from
// `src/template/<type>/welcome.md`, locale-resolved via `getWelcome` (a
// plugin type's from its contribution, `pluginWelcome`). Rendered
// in the empty viewport (see `Thread`). A type with no `welcome.md` (or an
// empty `suggestions` list) renders nothing; defaults to `agent` (the boot
// default type). Clicking a chip loads its `prompt` (or `title`) into the
// composer to edit + send — prompts may be intentionally incomplete (e.g.
// "…sourced summary: "), so the chip fills rather than auto-sends.
export const ThreadSuggestions: FC<{ templateType?: string }> = ({ templateType }) => {
  const locale = useLocale();
  const contributions = useModContributions();
  const welcome = isPluginTemplateId(templateType)
    ? pluginWelcome(contributions, templateType, locale)
    : getWelcome(templateType ?? "agent", locale);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Measured inline size of the welcome root + the window height. Width comes
  // from a ResizeObserver on the root; height from the WINDOW rather than any
  // element, because every element in this subtree grows with the chip list —
  // measuring one would feed the count back into its own input and oscillate.
  const [fit, setFit] = useState<{ width: number; height: number }>(() => ({
    width: 0,
    height: typeof window === "undefined" ? 0 : window.innerHeight,
  }));

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () =>
      setFit((previous) => {
        const width = root.clientWidth;
        const height = window.innerHeight;
        // Bail on an unchanged measurement so a resize storm doesn't rerender.
        return previous.width === width && previous.height === height
          ? previous
          : { width, height };
      });
    measure();
    window.addEventListener("resize", measure);
    // ResizeObserver is absent in some test environments — the resize listener
    // plus the initial measure still covers window-driven changes there.
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(root);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, []);

  if (!welcome || welcome.suggestions.length === 0) return null;

  // Truncate to what fits (6 / 4 / 2) instead of overflowing the scroller,
  // where the bottom row would sit under the pinned composer.
  const visible = welcome.suggestions.slice(
    0,
    visibleSuggestionCount({
      rootInlinePx: fit.width,
      windowHeight: fit.height,
      total: welcome.suggestions.length,
    }),
  );

  return (
    <div
      ref={rootRef}
      className="aui-thread-welcome-root mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col items-center justify-center gap-8 px-4 pb-4"
    >
      {welcome.greeting && (
        <h2 className="aui-thread-welcome-message text-center font-semibold text-foreground text-2xl">
          {welcome.greeting}
        </h2>
      )}
      <div className="aui-thread-welcome-suggestions grid w-full gap-4 @md:grid-cols-2">
        {visible.map((suggestion, index) => (
          <ThreadPrimitive.Suggestion
            key={index}
            prompt={suggestion.prompt ?? suggestion.title}
            className="aui-thread-welcome-suggestion-display fade-in slide-in-from-bottom-2 flex h-auto w-full animate-in flex-col items-start justify-start gap-1 rounded-3xl border bg-background px-4 py-3 text-left text-sm transition-colors duration-200 fill-mode-both hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="aui-thread-welcome-suggestion-text-1 font-medium text-foreground">
              {suggestion.title}
            </span>
            {suggestion.description && (
              <span className="aui-thread-welcome-suggestion-text-2 text-muted-foreground empty:hidden">
                {suggestion.description}
              </span>
            )}
          </ThreadPrimitive.Suggestion>
        ))}
      </div>
    </div>
  );
};
