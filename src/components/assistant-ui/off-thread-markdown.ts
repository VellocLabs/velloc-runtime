import { useEffect, useState } from "react";
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
 * One part's off-thread state, kept by its key across remounts: whether it
 * is on the off-thread path, its newest finished tree, and the newest text
 * it wants parsed.
 */
type PartState = {
  offThread: boolean;
  parsed: ParsedMarkdown | null;
  wanted: string | null;
  inFlight: string | null;
  listeners: Set<(parsed: ParsedMarkdown) => void>;
};

const KEPT_PARTS = 16;

/**
 * Runs one parse at a time for the whole window and keeps, per part, only
 * the newest text it wants. Part states are kept for the most recent parts
 * only; a part with a listener is never dropped.
 */
class ParseQueue {
  private busy = false;
  private readonly parts = new Map<string, PartState>();

  constructor(private readonly parser: () => MarkdownParser) {}

  state(key: string): PartState {
    let part = this.parts.get(key);
    if (part) {
      this.parts.delete(key);
    } else {
      part = { offThread: false, parsed: null, wanted: null, inFlight: null, listeners: new Set() };
    }
    this.parts.set(key, part);
    this.trim();
    return part;
  }

  peek(key: string): PartState | undefined {
    return this.parts.get(key);
  }

  want(key: string, text: string): void {
    const part = this.state(key);
    if (part.parsed?.text === text || part.inFlight === text) {
      part.wanted = null;
      return;
    }
    part.wanted = text;
    this.pump();
  }

  private trim(): void {
    for (const [key, part] of this.parts) {
      if (this.parts.size <= KEPT_PARTS) return;
      if (part.listeners.size === 0) this.parts.delete(key);
    }
  }

  private pump(): void {
    if (this.busy) return;
    for (const [key, part] of this.parts) {
      const text = part.wanted;
      if (text === null) continue;
      part.wanted = null;
      part.inFlight = text;
      this.busy = true;
      this.parser()
        .parse(text)
        .then(
          (tree) => {
            const current = this.parts.get(key);
            if (!current) return;
            current.parsed = { text, tree };
            for (const listener of current.listeners) listener(current.parsed);
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
 * remount (F-9). A part first seen settled is not put on it.
 */
export function useOffThreadPath(key: string, large: boolean, streaming: boolean): boolean {
  const part = parseQueue().peek(key);
  if (part?.offThread) return true;
  if (!(large && streaming)) return false;
  parseQueue().state(key).offThread = true;
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
    () => parseQueue().peek(key)?.parsed ?? null,
  );

  useEffect(() => {
    const part = parseQueue().state(key);
    if (part.parsed) setParsed(part.parsed);
    part.listeners.add(setParsed);
    return () => {
      part.listeners.delete(setParsed);
    };
  }, [key]);

  useEffect(() => {
    if (text !== null) parseQueue().want(key, text);
  }, [key, text]);

  return parsed;
}
