import { useEffect, useRef, useState } from "react";
import type { Root } from "hast";

/**
 * Off-thread Markdown parse for large conversation parts (F-9): one module
 * Worker per window, spawned on first use and kept. Where no Worker can be
 * made, or it fails or stops answering, the same pipeline runs inline after
 * a task boundary.
 */

type Reply = { id: number; tree?: Root; error?: string };
type Pending = {
  text: string;
  resolve(tree: Root): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

const DEFAULT_TIMEOUT_MS = 30_000;

function defaultSpawn(): Worker {
  return new Worker(new URL("./markdown-parse.worker.ts", import.meta.url), {
    type: "module",
    name: "nexus-markdown-parse",
  });
}

async function parseInline(text: string): Promise<Root> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  const { markdownToHast } = await import("./markdown-hast");
  return markdownToHast(text);
}

/** What the hook needs from a parser; the client below is the real one. */
export type MarkdownParser = { parse(text: string): Promise<Root> };

export class MarkdownParseClient implements MarkdownParser {
  private worker: Worker | null = null;
  private inline = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(
    private readonly spawn: () => Worker = defaultSpawn,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  parse(text: string): Promise<Root> {
    const worker = this.ensureWorker();
    return worker ? this.post(worker, text) : parseInline(text);
  }

  private post(worker: Worker, text: string): Promise<Root> {
    const id = this.nextId++;
    return new Promise<Root>((resolve, reject) => {
      const timer = setTimeout(() => this.fallBackInline(), this.timeoutMs);
      this.pending.set(id, { text, resolve, reject, timer });
      worker.postMessage({ id, text });
    });
  }

  private ensureWorker(): Worker | null {
    if (this.inline) return null;
    if (this.worker) return this.worker;
    try {
      const worker = this.spawn();
      worker.onmessage = (event: MessageEvent<Reply>) => this.settle(event.data);
      worker.onerror = () => this.fallBackInline();
      worker.onmessageerror = () => this.fallBackInline();
      this.worker = worker;
      return worker;
    } catch {
      this.inline = true;
      return null;
    }
  }

  private settle(reply: Reply): void {
    const entry = this.pending.get(reply.id);
    if (!entry) return;
    this.pending.delete(reply.id);
    clearTimeout(entry.timer);
    if (reply.tree) entry.resolve(reply.tree);
    else entry.reject(new Error(reply.error ?? "markdown parse failed"));
  }

  /** A Worker that failed or hung is not used again; its requests re-run inline. */
  private fallBackInline(): void {
    this.inline = true;
    this.worker?.terminate();
    this.worker = null;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      clearTimeout(entry.timer);
      parseInline(entry.text).then(entry.resolve, entry.reject);
    }
  }
}

export type ParsedMarkdown = { text: string; tree: Root };

/**
 * One part's off-thread state, kept by its key across remounts: the start
 * of the text it was opened for, its newest finished tree, and the newest
 * text it wants parsed.
 */
type PartState = {
  head: string;
  parsed: ParsedMarkdown | null;
  wanted: string | null;
  inFlight: string | null;
  listeners: Set<(parsed: ParsedMarkdown) => void>;
};

const KEPT_PARTS = 16;
const HEAD_CHARS = 256;

/**
 * Runs one parse at a time for the whole window and keeps, per part, only
 * the newest text it wants. Only parts on the off-thread path have a state;
 * the most recent are kept, and one with a listener is never dropped.
 */
class ParseQueue {
  private busy = false;
  private readonly parts = new Map<string, PartState>();

  constructor(private readonly parser: () => MarkdownParser) {}

  /**
   * The state of `key` when `text` is the same reply, that is, it begins
   * with the text the state was opened for; else none. A hit counts as use.
   */
  find(key: string, text: string): PartState | undefined {
    const part = this.parts.get(key);
    if (!part) return undefined;
    if (!text.startsWith(part.head)) {
      if (part.listeners.size === 0) this.parts.delete(key);
      return undefined;
    }
    this.parts.delete(key);
    this.parts.set(key, part);
    return part;
  }

  open(key: string, text: string): PartState {
    return this.find(key, text) ?? this.create(key, text);
  }

  create(key: string, text: string): PartState {
    const part: PartState = {
      head: text.slice(0, HEAD_CHARS),
      parsed: null,
      wanted: null,
      inFlight: null,
      listeners: new Set(),
    };
    this.parts.set(key, part);
    this.trim(key);
    return part;
  }

  want(part: PartState, text: string): void {
    if (part.parsed?.text === text || part.inFlight === text) {
      part.wanted = null;
      return;
    }
    part.wanted = text;
    this.pump();
  }

  /** A part no one draws any more parses nothing further. */
  release(part: PartState, listener: (parsed: ParsedMarkdown) => void): void {
    part.listeners.delete(listener);
    if (part.listeners.size === 0) part.wanted = null;
  }

  private trim(keep: string): void {
    for (const [key, part] of this.parts) {
      if (this.parts.size <= KEPT_PARTS) return;
      if (key !== keep && part.listeners.size === 0) this.parts.delete(key);
    }
  }

  private pump(): void {
    if (this.busy) return;
    for (const part of this.parts.values()) {
      const text = part.wanted;
      if (text === null) continue;
      part.wanted = null;
      part.inFlight = text;
      this.busy = true;
      this.parser()
        .parse(text)
        .then(
          (tree) => {
            part.parsed = { text, tree };
            for (const listener of part.listeners) listener(part.parsed);
          },
          () => {},
        )
        .finally(() => {
          part.inFlight = null;
          this.busy = false;
          this.pump();
        });
      return;
    }
  }
}

let sharedClient: MarkdownParser | null = null;
let queue: ParseQueue | null = null;

function client(): MarkdownParser {
  sharedClient ??= new MarkdownParseClient();
  return sharedClient;
}

function parseQueue(): ParseQueue {
  queue ??= new ParseQueue(client);
  return queue;
}

/** Test seam: the client the hook uses, with fresh part states; `null` restores the default. */
export function setMarkdownParseClient(next: MarkdownParser | null): void {
  sharedClient = next;
  queue = null;
}

/**
 * Whether the part with `key` is on the off-thread path. It joins when it
 * is `large` while it streams, and stays on it for good, also across a
 * remount, while its key shows the same reply (F-9). A part first seen
 * settled is not put on it.
 */
export function useOffThreadPath(
  key: string,
  text: string,
  large: boolean,
  streaming: boolean,
): boolean {
  if (parseQueue().find(key, text)) return true;
  if (!(large && streaming)) return false;
  parseQueue().create(key, text);
  return true;
}

/**
 * The newest finished parse for the part with `key`, or `null` before the
 * first. `text` null parses nothing; the caller passes only text under the
 * heavy-text limits. Updates that arrive while a parse runs are coalesced
 * to the newest.
 */
export function useOffThreadMarkdown(key: string, text: string | null): ParsedMarkdown | null {
  const [parsed, setParsed] = useState<ParsedMarkdown | null>(
    () => (text === null ? null : (parseQueue().find(key, text)?.parsed ?? null)),
  );
  const subscribed = useRef<PartState | null>(null);

  useEffect(() => {
    const previous = subscribed.current;
    const part = text === null ? null : parseQueue().open(key, text);
    if (part !== previous) {
      if (previous) parseQueue().release(previous, setParsed);
      subscribed.current = part;
      if (part) {
        part.listeners.add(setParsed);
        if (part.parsed) setParsed(part.parsed);
      }
    }
    if (part) parseQueue().want(part, text!);
  }, [key, text]);

  useEffect(
    () => () => {
      if (subscribed.current) parseQueue().release(subscribed.current, setParsed);
      subscribed.current = null;
    },
    [],
  );

  return parsed;
}
