import type {
  CodeHeaderProps,
  SyntaxHighlighterProps,
} from "@assistant-ui/react-markdown";
import { useAssistantState } from "@assistant-ui/react";
import { type FC, useLayoutEffect, useRef, useState } from "react";
import {
  CheckIcon,
  CopyIcon,
  LoaderIcon,
  PlayIcon,
  SquareTerminalIcon,
} from "lucide-react";

import {
  CodeHeader,
  useCopyToClipboard,
} from "@/components/assistant-ui/markdown-components";
import {
  rememberShellRun,
  runnableShellCommand,
  shellRunKey,
  useShellCommand,
  useShellRun,
} from "@/components/assistant-ui/shell-command";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { useTerminalRun } from "@/browser/webview/terminal/useTerminalRun";
import { useT } from "@/browser/webview/i18n";
import type { TerminalRunState } from "@/terminal/protocol";

/**
 * A shell-tagged fence in the chat (F-31). One runnable line renders as a
 * card — the command, Run and Copy — with the run's output under it once Run
 * was pressed; anything longer renders as an ordinary code block.
 */

/** No header row above a one-line command: the card carries its own buttons. */
export const ShellCodeHeader: FC<CodeHeaderProps> = (props) =>
  runnableShellCommand(props.code) === null ? <CodeHeader {...props} /> : null;

export const ShellSyntaxHighlighter: FC<SyntaxHighlighterProps> = ({
  node,
  components: { Pre, Code },
  code,
}) => {
  const command = runnableShellCommand(code);
  if (command === null) {
    return (
      <Pre>
        <Code node={node}>{code}</Code>
      </Pre>
    );
  }
  return <ShellCommandCard command={command} />;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ShellCommandCard({ command }: { command: string }) {
  const t = useT();
  const { run, openTerminal, connection, sessionId } = useShellCommand();
  const messageId = useAssistantState((s) => s.message.id);
  const key = shellRunKey(sessionId, messageId, command);
  const runId = useShellRun(key);
  const runState = useTerminalRun(connection, runId);
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const onRun = () => {
    if (!run || starting) return;
    setStarting(true);
    setFailure(null);
    void run(command).then(
      (result) => {
        setStarting(false);
        rememberShellRun(key, result.runId);
        openTerminal?.(result.id);
      },
      (error: unknown) => {
        setStarting(false);
        setFailure(messageOf(error));
      },
    );
  };

  return (
    <div className="aui-shell-command my-[0.75em]" data-shell-command="">
      <div className="flex items-center gap-1 rounded-lg border border-border/50 bg-muted/30 py-1 pr-1.5 pl-3">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre py-1 font-mono text-code">
          {command}
        </code>
        {run && (
          <TooltipIconButton
            tooltip={t("shellCommand.run")}
            onClick={onRun}
            disabled={starting}
            data-shell-command-run=""
          >
            {starting ? <LoaderIcon className="animate-spin" /> : <PlayIcon />}
          </TooltipIconButton>
        )}
        <TooltipIconButton
          tooltip={t("action.copy")}
          onClick={() => copyToClipboard(command)}
        >
          {isCopied ? <CheckIcon /> : <CopyIcon />}
        </TooltipIconButton>
      </div>
      {failure !== null && (
        <p role="alert" className="mt-1 text-caption text-destructive">
          {t("shellCommand.runFailed", { message: failure })}
        </p>
      )}
      {runState && (
        <ShellRunOutput
          state={runState}
          onShowTerminal={
            openTerminal ? () => openTerminal(runState.terminalId) : undefined
          }
        />
      )}
    </div>
  );
}

function ShellRunOutput({
  state,
  onShowTerminal,
}: {
  state: TerminalRunState;
  onShowTerminal: (() => void) | undefined;
}) {
  const t = useT();
  const outputRef = useRef<HTMLPreElement>(null);
  // While the command runs, keep its newest lines in view.
  useLayoutEffect(() => {
    const element = outputRef.current;
    if (element && state.status === "running") element.scrollTop = element.scrollHeight;
  }, [state.output, state.status]);

  const note =
    state.status === "running"
      ? t("shellCommand.running")
      : state.status === "ended"
        ? t("shellCommand.ended")
        : state.output === ""
          ? t("shellCommand.noOutput")
          : null;
  return (
    <div
      className="relative mt-1 rounded-lg border border-border/50 bg-background"
      data-shell-command-output={state.status}
    >
      {onShowTerminal && (
        <TooltipIconButton
          tooltip={t("shellCommand.showTerminal")}
          onClick={onShowTerminal}
          className="absolute top-1.5 right-1.5"
        >
          <SquareTerminalIcon />
        </TooltipIconButton>
      )}
      {state.truncated && (
        <p className="px-3 pt-2 text-caption text-muted-foreground">
          {t("shellCommand.truncated")}
        </p>
      )}
      {state.output !== "" && (
        <pre
          ref={outputRef}
          className="max-h-64 overflow-auto py-2 pr-10 pl-3 font-mono text-code whitespace-pre-wrap break-all"
        >
          {state.output}
        </pre>
      )}
      {note !== null && (
        <p className="py-2 pr-10 pl-3 text-caption text-muted-foreground">{note}</p>
      )}
    </div>
  );
}
