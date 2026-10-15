import {
  unconfiguredFs,
  type RuntimeFsEntry,
  type RuntimeFs,
} from "../../utils/fs/runtimeFs";

/**
 * In-memory writable `RuntimeFs` for the skill/plugin install pipeline and the runtime loaders. Implements
 * `mkdir`/`writeFile`/`readFile`/`rm`/`readdir`; any other op throws (`unconfiguredFs`). Paths are normalized
 * `\`→`/`.
 */
export type MemFs = RuntimeFs & {
  /** Sorted list of every written path — for asserting exactly-what-landed. */
  dump(): string[];
};

export function makeMemFs(): MemFs {
  const files = new Map<string, Uint8Array>();
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const enc = new TextEncoder();
  return {
    ...unconfiguredFs,
    async mkdir() {
      /* no-op: writeFile creates parents implicitly here */
    },
    async writeFile(path: string, data: string | Uint8Array) {
      files.set(norm(path), typeof data === "string" ? enc.encode(data) : data);
    },
    async readFile(path: string) {
      const bytes = files.get(norm(path));
      if (!bytes) throw new Error(`ENOENT: ${path}`);
      return new TextDecoder("utf-8").decode(bytes);
    },
    async readFileBytes(path: string) {
      const bytes = files.get(norm(path));
      if (!bytes) throw new Error(`ENOENT: ${path}`);
      return bytes;
    },
    async rm(path: string) {
      const base = norm(path);
      for (const key of [...files.keys()]) {
        if (key === base || key.startsWith(base + "/")) files.delete(key);
      }
    },
    async readdir(path: string): Promise<RuntimeFsEntry[]> {
      const base = norm(path);
      const prefix = base + "/";
      const present = [...files.keys()].some(
        (k) => k === base || k.startsWith(prefix),
      );
      if (!present) throw new Error(`ENOENT: ${path}`);
      const children = new Set<string>();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        children.add(key.slice(prefix.length).split("/")[0]!);
      }
      return [...children].map((name) => {
        const isDir = [...files.keys()].some((k) =>
          k.startsWith(prefix + name + "/"),
        );
        return {
          name,
          isDirectory: () => isDir,
          isFile: () => !isDir,
          isSymbolicLink: () => false,
        };
      });
    },
    dump: () => [...files.keys()].sort(),
  } as MemFs;
}

/**
 * Fetch fake that serves per-file bytes keyed by the relative path at the tail
 * of the request URL (e.g. `SKILL.md`, `reference/guide.md`). 404s anything not
 * in `contents`. Used by the skill-install pipeline tests (each file pulled from
 * `raw.githubusercontent.com/<repo>/<branch>/<path>/<rel>`).
 */
export function makeFetch(contents: Record<string, string>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const hit = Object.keys(contents).find((rel) => url.endsWith("/" + rel));
    if (!hit) return new Response("not found", { status: 404 });
    return new Response(new TextEncoder().encode(contents[hit]!), {
      status: 200,
    });
  }) as typeof fetch;
}
