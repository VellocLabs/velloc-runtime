import { createContext, useContext, useSyncExternalStore } from "react";

import type { RuntimeConnection } from "@/browser/runtimeClient/RuntimeConnection";
import { isRunnableCommand, type TerminalRunResult } from "@/terminal/protocol";

/**
 * Runnable shell blocks in the chat (F-31): which fences count, the command a
 * block holds, the thread's handle for running it, and which run each card
 * last started (page memory, so a card scrolled away and back keeps its output).
 */

/** Fence tags whose one-line blocks get a Run button. */
export const SHELL_FENCE_LANGUAGES = [
  "bash",
  "sh",
  "shell",
  "zsh",
  "powershell",
  "pwsh",
  "ps1",
  "cmd",
] as const;

/** The block's command when it is one runnable line (a trailing newline aside); otherwise null. */
export function runnableShellCommand(code: string): string | null {
  const command = code.replace(/(\r?\n)+$/, "");
  return command.includes("\n") || !isRunnableCommand(command) ? null : command;
}

export type ShellCommandContextValue = {
  /** Run `command` in the thread's session terminal. Absent where no terminal can run it. */
  run?: (command: string) => Promise<TerminalRunResult>;
  /** Bring the Terminal pane forward on `terminalId`. */
  openTerminal?: (terminalId: string) => void;
  /** Where a run's output topic is read. */
  connection: RuntimeConnection | null;
  sessionId: string | null;
};

export const ShellCommandContext = createContext<ShellCommandContextValue>({
  connection: null,
  sessionId: null,
});

export function useShellCommand(): ShellCommandContextValue {
  return useContext(ShellCommandContext);
}

const runsByCard = new Map<string, string>();
const listeners = new Set<() => void>();

/**
 * One card: a command at one place in one message of one session. `at` is the
 * block's offset in the message text, so two identical blocks keep separate runs.
 */
export function shellRunKey(
  sessionId: string | null,
  messageId: string,
  command: string,
  at: number | null = null,
): string {
  return `${sessionId ?? ""}\u0000${messageId}\u0000${at ?? ""}\u0000${command}`;
}

export function rememberShellRun(key: string, runId: string): void {
  runsByCard.set(key, runId);
  for (const listener of Array.from(listeners)) listener();
}

function subscribeShellRuns(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The run the card last started, or null. */
export function useShellRun(key: string): string | null {
  return useSyncExternalStore(
    subscribeShellRuns,
    () => runsByCard.get(key) ?? null,
    () => null,
  );
}

export function resetShellRunsForTests(): void {
  runsByCard.clear();
}
