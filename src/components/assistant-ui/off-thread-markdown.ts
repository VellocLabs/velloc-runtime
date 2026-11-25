import { useEffect, useState } from "react";
import type { Root } from "hast";

import { isHeavyText, measureText } from "@/utils/textHeaviness";

/**
 * Off-thread Markdown parse for large conversation parts (F-9): one module
 * Worker per window, spawned on first use and kept. Where no Worker can be
 * made, or it fails, the same pipeline runs inline after a task boundary.
 */

type Reply = { id: number; tree?: Root; error?: string };
type Pending = { text: string; resolve(tree: Root): void; reject(error: Error): void };

const RECENT_TREES = 8;

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
export type MarkdownParser = {
  cached(text: string): Root | undefined;
  parse(text: string): Promise<Root>;
};

export class MarkdownParseClient implements MarkdownParser {
  private worker: Worker | null = null;
  private inline = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** Newest finished trees by text, so a remounted part draws at once. */
  private readonly recent = new Map<string, Root>();

  constructor(private readonly spawn: () => Worker = defaultSpawn) {}

  cached(text: string): Root | undefined {
    return this.recent.get(text);
  }

  parse(text: string): Promise<Root> {
    const known = this.recent.get(text);
    if (known) return Promise.resolve(known);
    const worker = this.ensureWorker();
    const result = worker ? this.post(worker, text) : parseInline(text);
    return result.then((tree) => this.remember(text, tree));
  }

  private post(worker: Worker, text: string): Promise<Root> {
    const id = this.nextId++;
    return new Promise<Root>((resolve, reject) => {
      this.pending.set(id, { text, resolve, reject });
      worker.postMessage({ id, text });
    });
  }

  private remember(text: string, tree: Root): Root {
    this.recent.delete(text);
    this.recent.set(text, tree);
    if (this.recent.size > RECENT_TREES) {
      this.recent.delete(this.recent.keys().next().value as string);
    }
    return tree;
  }

  private ensureWorker(): Worker | null {
    if (this.inline) return null;
    if (this.worker) return this.worker;
    try {
      const worker = this.spawn();
      worker.onmessage = (event: MessageEvent<Reply>) => this.settle(event.data);
      worker.onerror = () => this.fallBackInline();
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
    if (reply.tree) entry.resolve(reply.tree);
    else entry.reject(new Error(reply.error ?? "markdown parse failed"));
  }

  /** A Worker that failed is not used again; its requests re-run inline. */
  private fallBackInline(): void {
    this.inline = true;
    this.worker?.terminate();
    this.worker = null;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) parseInline(entry.text).then(entry.resolve, entry.reject);
  }
}

type Want = { text: string; deliver(tree: Root): void };

/**
 * Runs one parse at a time for all mounted parts and keeps, per part, only
 * the newest text it wants. A part that unmounts drops its wish, so a part
 * that remounts on every update still costs one parse in flight.
 */
class ParseQueue {
  private busy = false;
  private readonly wants = new Map<object, Want>();

  constructor(private readonly parser: () => MarkdownParser) {}

  want(owner: object, text: string, deliver: (tree: Root) => void): void {
    this.wants.set(owner, { text, deliver });
    this.pump();
  }

  drop(owner: object): void {
    this.wants.delete(owner);
  }

  private pump(): void {
    if (this.busy) return;
    const next = this.wants.entries().next();
    if (next.done) return;
    const [owner, want] = next.value;
    this.wants.delete(owner);
    this.busy = true;
    this.parser()
      .parse(want.text)
      .then(want.deliver, () => {})
      .finally(() => {
        this.busy = false;
        this.pump();
      });
  }
}

let sharedClient: MarkdownParser | null = null;

function client(): MarkdownParser {
  sharedClient ??= new MarkdownParseClient();
  return sharedClient;
}

let queue: ParseQueue | null = null;

function parseQueue(): ParseQueue {
  queue ??= new ParseQueue(client);
  return queue;
}

/** Test seam: the client the hook uses, with a fresh queue; `null` restores the default. */
export function setMarkdownParseClient(next: MarkdownParser | null): void {
  sharedClient = next;
  queue = null;
}

/** True when a finished off-thread parse of exactly `text` is at hand. */
export function hasParsedMarkdown(text: string): boolean {
  return client().cached(text) !== undefined;
}

export type ParsedMarkdown = { text: string; tree: Root };

/**
 * The newest finished parse of `text` for one part, or `null` before the
 * first. `null` parses nothing. Parses run one at a time; updates that
 * arrive meanwhile are coalesced to the newest. Heavy text is never sent.
 */
export function useOffThreadMarkdown(text: string | null): ParsedMarkdown | null {
  const [owner] = useState(() => ({}));
  const [parsed, setParsed] = useState<ParsedMarkdown | null>(() => {
    const tree = text === null ? undefined : client().cached(text);
    return tree && text !== null ? { text, tree } : null;
  });

  useEffect(() => () => parseQueue().drop(owner), [owner]);

  useEffect(() => {
    if (text === null || isHeavyText(measureText(text))) {
      parseQueue().drop(owner);
      return;
    }
    const known = client().cached(text);
    if (known) {
      setParsed((current) => (current?.tree === known ? current : { text, tree: known }));
      return;
    }
    parseQueue().want(owner, text, (tree) => setParsed({ text, tree }));
  }, [owner, text]);

  return parsed;
}
