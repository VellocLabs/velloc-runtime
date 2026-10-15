import { useState, type FC } from "react";
import {
  CheckCircle2Icon,
  ChevronRightIcon,
  TerminalSquareIcon,
  XCircleIcon,
} from "lucide-react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { StaticMarkdown } from "@/components/assistant-ui/static-markdown";
import { cn } from "@/lib/utils";
import { useT, type TranslateFn } from "@/browser/webview/i18n";
import { ccTaskTypeFromSummary } from "@/browser/webview/assistantUiAdapterParts";

type BackgroundResultsCardProps = {
  kind: "shell" | "subagent";
  text: string;
};

export type ParsedNotification = {
  taskId: string;
  taskType: "local_agent" | "local_bash";
  status: "completed" | "failed";
  summary: string;
  outputFile?: string;
};

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function parseTaskNotifications(text: string): ParsedNotification[] {
  const blocks = text.split(/<task-notification>/).filter((b) => b.trim());
  return blocks.map((block) => {
    const taskId = block.match(/<task-id>([\s\S]*?)<\/task-id>/)?.[1]?.trim() ?? "";
    const rawSummary = block.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] ?? "";
    // Native nexus notifications carry `<task-type>`; imported Claude Code ones
    // do not, so fall back to inferring the kind from the summary prefix (the
    // same rule the render gatekeeper `backgroundResultKind` uses).
    const taskType = (block.match(/<task-type>([\s\S]*?)<\/task-type>/)?.[1]?.trim() ??
      ccTaskTypeFromSummary(rawSummary)) as "local_agent" | "local_bash";
    const status = (block.match(/<status>([\s\S]*?)<\/status>/)?.[1]?.trim() ??
      "completed") as "completed" | "failed";
    const summary = unescapeXml(rawSummary);
    const outputFile = block
      .match(/<output-file>([\s\S]*?)<\/output-file>/)?.[1]
      ?.trim();
    return { taskId, taskType, status, summary, outputFile };
  });
}

/** Shell summaries follow `Background command "<cmd>" <status>\n<output>`.
 *  Extract the command so it can be shown in a monospace header. */
function extractShellCommand(summary: string): {
  command: string | null;
  rest: string;
} {
  const match = summary.match(/^Background command "(.+?)" \w+\n?/);
  if (!match) return { command: null, rest: summary };
  return { command: match[1], rest: summary.slice(match[0].length) };
}

/** Agent summaries follow `<description> (<type>): <summary>` or
 *  `<description>: <summary>`. Extract the description as a title. */
function extractAgentTitle(summary: string): {
  title: string | null;
  rest: string;
} {
  const match = summary.match(/^(.+?):\s/);
  if (!match) return { title: null, rest: summary };
  return { title: match[1], rest: summary.slice(match[0].length) };
}

// Pure helper: takes the translate fn rather than importing a catalog,
// so it stays unit-testable with createTranslate('en').
function summarize(
  text: string,
  kind: "shell" | "subagent",
  t: TranslateFn,
): { title: string; detail: string } {
  const count = (text.match(/<task-notification>/g) ?? []).length;
  const title =
    kind === "shell"
      ? t("backgroundTasks.shellResults")
      : t("backgroundTasks.subAgentResults");
  return {
    title,
    detail:
      count > 1
        ? t("backgroundTasks.resultCountPlural", { count })
        : count === 1
          ? t("backgroundTasks.resultCountSingular", { count })
          : t("backgroundTasks.completed"),
  };
}

export const NotificationEntry: FC<{ notification: ParsedNotification }> = ({
  notification,
}) => {
  const isShell = notification.taskType === "local_bash";
  const isCompleted = notification.status === "completed";
  const shell = isShell ? extractShellCommand(notification.summary) : null;
  const agent = !isShell ? extractAgentTitle(notification.summary) : null;

  return (
    <div className="flex gap-2.5 py-2.5 first:pt-0 last:pb-0">
      {isCompleted ? (
        <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
      ) : (
        <XCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
      )}
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-caption text-muted-foreground">
          <span className="font-mono">{notification.taskId}</span>
          <span
            className={cn(
              "rounded-full px-1.5 py-px text-[10px] font-medium",
              isCompleted
                ? "bg-success/10 text-success"
                : "bg-destructive/10 text-destructive",
            )}
          >
            {notification.status}
          </span>
        </div>
        {shell?.command && (
          <div className="rounded-md bg-muted/60 px-2 py-1 font-mono text-code text-foreground/80">
            {shell.command}
          </div>
        )}
        {agent?.title && (
          <div className="text-body font-medium text-foreground/80">{agent.title}</div>
        )}
        <div className="max-h-72 overflow-auto">
          <StaticMarkdown
            content={shell?.rest ?? agent?.rest ?? notification.summary}
          />
        </div>
      </div>
    </div>
  );
};

export const BackgroundResultsCard: FC<BackgroundResultsCardProps> = ({
  kind,
  text,
}) => {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { title, detail } = summarize(text, kind, t);
  const notifications = parseTaskNotifications(text);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="aui-background-results-card-root mx-auto w-full max-w-(--thread-max-width) px-2"
      data-role="background-results-card"
      data-kind={kind}
    >
      <Card className="w-full gap-0 py-0">
        <CardHeader className="px-4 py-3">
          <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-2 text-left text-body">
            {kind === "shell" ? (
              <TerminalSquareIcon
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            ) : (
              <CheckCircle2Icon
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            )}
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium">{title}</span>
              <span className="ml-2 text-muted-foreground">{detail}</span>
            </span>
            <ChevronRightIcon
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
                open && "rotate-90",
              )}
              aria-hidden="true"
            />
          </CollapsibleTrigger>
        </CardHeader>
        <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
          <CardContent className="px-4 pb-4 pt-0">
            <div className="divide-y divide-border/50">
              {notifications.map((n, i) => (
                <NotificationEntry key={`${n.taskId}-${i}`} notification={n} />
              ))}
            </div>
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
};
