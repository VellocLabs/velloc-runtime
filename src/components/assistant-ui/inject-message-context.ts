import { createContext } from "react";

/**
 * Mid-turn input contexts. `ComposerDeliveryContext`: the composer names how the next
 * send is delivered (`inject` / `next` / `fork`) before `composer.send()`; `onNew` reads
 * and clears it. `InjectMessagesContext`: inject texts the worker's Stop dropped, and
 * the × handler on a pending bubble.
 */
export type ComposerDelivery = "inject" | "next" | "fork";

export const ComposerDeliveryContext = createContext<{
  setNextDelivery: (delivery: ComposerDelivery) => void;
}>({ setNextDelivery: () => {} });

/** `files`: the attachments this page sent with the dropped messages. */
export type InjectRestore = { id: string; text: string; files?: readonly File[] };

export type InjectMessagesContextValue = {
  /** Inject texts Stop dropped (client state `injectRestore`). */
  restore?: InjectRestore | null;
  /** Resolves `ok:true` with the text (and the files this page attached)
   *  when this page removed it. */
  removeInjectMessage?: (
    uuid: string,
  ) => Promise<{ ok: boolean; text?: string; files?: readonly File[] }>;
};

export const InjectMessagesContext = createContext<InjectMessagesContextValue>({});

export type InjectMessageState = "pending" | "landed";

/**
 * A user row's mid-turn-input state, from its `metadata.custom`: `pending`
 * (not yet handed to the model), `landed` (state-backed bubble, or rendered
 * from its `queued_command` attachment: `injectLanded`), or null for an
 * ordinary user message.
 */
export function injectStateOfCustom(custom: unknown): InjectMessageState | null {
  const c = custom as { injectState?: unknown; injectLanded?: unknown } | undefined;
  if (c?.injectState === "pending" || c?.injectState === "landed") return c.injectState;
  return c?.injectLanded === true ? "landed" : null;
}

/**
 * Rewind / Fork cut the transcript at the row's id. An inject row's id is the
 * bubble uuid (a pending one is not in the transcript at all; a landed one is
 * the attachment's `source_uuid`, not the attachment entry's uuid), so the cut
 * finds nothing and the action silently does nothing. Offered only on
 * ordinary user messages.
 */
export function userMessageOffersCutActions(custom: unknown): boolean {
  return injectStateOfCustom(custom) === null;
}

const appliedRestoreIds = new Set<string>();
const appliedRestoreFileIds = new Set<string>();

/**
 * The composer text after handing Stop's dropped inject texts back: they go
 * BEFORE what is already there (the strip batch restored at the click — the
 * inject messages were sent earlier in intent). Null when this restore was
 * already applied (a remount re-reads the same state), or carries no text (an
 * attachment-only send: its files come back through `takeInjectRestoreFiles`).
 */
export function applyInjectRestore(
  current: string,
  restore: InjectRestore | null | undefined,
): string | null {
  if (!restore || appliedRestoreIds.has(restore.id)) return null;
  appliedRestoreIds.add(restore.id);
  if (!restore.text) return null;
  return current ? `${restore.text}\n${current}` : restore.text;
}

/**
 * The files of Stop's dropped inject messages to re-attach to the composer —
 * once per restore, like `applyInjectRestore`'s text (a remount re-reads the
 * same state). Empty when there are none or they were already taken.
 */
export function takeInjectRestoreFiles(
  restore: InjectRestore | null | undefined,
): readonly File[] {
  if (!restore?.files?.length || appliedRestoreFileIds.has(restore.id)) return [];
  appliedRestoreFileIds.add(restore.id);
  return restore.files;
}

/** Ctrl/Cmd+Enter while the agent runs → queue for the next turn. */
export function shouldQueueOnRunningModEnter(params: {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing: boolean;
  defaultPrevented: boolean;
  isRunning: boolean;
  sendBlocked: boolean;
  hasContent: boolean;
}): boolean {
  if (params.defaultPrevented) return false;
  if (!params.isRunning) return false;
  if (params.sendBlocked) return false;
  if (params.key !== "Enter") return false;
  if (!(params.ctrlKey || params.metaKey)) return false;
  if (params.shiftKey || params.altKey) return false;
  if (params.isComposing) return false;
  return params.hasContent;
}
