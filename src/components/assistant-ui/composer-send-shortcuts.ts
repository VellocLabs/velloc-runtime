/**
 * The composer's send modes (Enter: send; Ctrl/⌘+Enter: queue, running only;
 * Ctrl/⌘+Alt/⌥+Enter: send in a forked session) and the Send button tooltip. Rows that
 * do not apply (queue when idle, fork in an empty session) are left out of the tooltip;
 * the key still sends as an ordinary send.
 */
import type { SlashCommandSummary } from "@/browser/worker/workerProtocol";

export type ComposerSendShortcutId = "send" | "queue" | "fork";

export type ComposerSendShortcut = {
  id: ComposerSendShortcutId;
  labelKey:
    | "composer.sendShortcut.send"
    | "composer.sendShortcut.queue"
    | "composer.sendShortcut.fork";
  keysKey:
    | "composer.sendShortcut.sendKeys"
    | "composer.sendShortcut.queueKeys"
    | "composer.sendShortcut.forkKeys";
};

const SEND: ComposerSendShortcut = {
  id: "send",
  labelKey: "composer.sendShortcut.send",
  keysKey: "composer.sendShortcut.sendKeys",
};
const QUEUE: ComposerSendShortcut = {
  id: "queue",
  labelKey: "composer.sendShortcut.queue",
  keysKey: "composer.sendShortcut.queueKeys",
};
const FORK: ComposerSendShortcut = {
  id: "fork",
  labelKey: "composer.sendShortcut.fork",
  keysKey: "composer.sendShortcut.forkKeys",
};

export function resolveComposerSendShortcuts(params: {
  isRunning: boolean;
  hasMessages: boolean;
}): ComposerSendShortcut[] {
  // An empty session has nothing to fork into a copy, so the fork row is
  // left out — sending there is an ordinary send.
  const fork = params.hasMessages ? [FORK] : [];
  return params.isRunning ? [SEND, QUEUE, ...fork] : [SEND, ...fork];
}

/** The platform glyphs the `{modifier}` / `{alt}` placeholders are filled with. */
export function composerShortcutModifiers(platform: string | undefined): {
  modifier: string;
  alt: string;
} {
  return platform && /Mac|iPhone|iPad/.test(platform)
    ? { modifier: "⌘", alt: "⌥" }
    : { modifier: "Ctrl", alt: "Alt" };
}

/**
 * The hint line beside the attachment button: none when empty, `send` for plain text,
 * `command-pick` / `command-usage` / `command-unknown` for a `/` command. A command is
 * only a command at the start of the input, where the dispatcher reads it.
 */
export type ComposerInputHint =
  | { kind: "send"; isRunning: boolean; hasMessages: boolean }
  | { kind: "command-pick" }
  | { kind: "command-usage"; name: string; usage: string; command: SlashCommandSummary }
  | { kind: "command-unknown"; name: string };

export function resolveComposerInputHint(params: {
  text: string;
  isRunning: boolean;
  hasMessages: boolean;
  commands: readonly SlashCommandSummary[];
}): ComposerInputHint | null {
  const text = params.text.trimStart();
  if (!text) return null;
  if (!text.startsWith("/"))
    return {
      kind: "send",
      isRunning: params.isRunning,
      hasMessages: params.hasMessages,
    };
  const match = /^\/(\S*)(\s?)/.exec(text);
  const name = match?.[1] ?? "";
  const typedPastName = (match?.[2] ?? "") !== "";
  const command = name
    ? params.commands.find((c) => c.name === name)
    : undefined;
  if (command) {
    const hint = command.argumentHint?.trim();
    return {
      kind: "command-usage",
      name,
      usage: hint ? `/${name} ${hint}` : `/${name}`,
      command,
    };
  }
  if (!typedPastName) return { kind: "command-pick" };
  return { kind: "command-unknown", name };
}

/**
 * Ctrl/Cmd+Alt+Enter → send in a forked session. Idle or running alike; the
 * same send gates as the Send button (an unanswered question blocks it). An
 * empty session has nothing to fork, so the caller degrades the fork to an
 * ordinary send (AssistantUiThread `resolveForkSendCutUuid` returns null) —
 * the tooltip and hint line simply stop advertising the shortcut there.
 */
export function shouldSendInForkOnModAltEnter(params: {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing: boolean;
  defaultPrevented: boolean;
  sendBlocked: boolean;
  hasContent: boolean;
}): boolean {
  if (params.defaultPrevented) return false;
  if (params.sendBlocked) return false;
  if (params.key !== "Enter") return false;
  if (!(params.ctrlKey || params.metaKey) || !params.altKey) return false;
  if (params.shiftKey) return false;
  if (params.isComposing) return false;
  return params.hasContent;
}
