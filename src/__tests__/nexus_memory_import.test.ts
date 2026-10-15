import { describe, expect, it } from "vitest";

import { handleMemoryBridgeRequest } from "../browser/bridge/adapter/memoryBridgeAdapter";
import { createBridgeRoute } from "../browser/bridge/protocol/core";
import type {
  BrowserBridgeRequest,
  BrowserBridgeResponse,
} from "../browser/bridge/protocol/core";
import { projectsHome } from "../utils/conversationStoragePaths";
import {
  importMemoryProject,
  listImportableMemoryProjects,
  memoryImportProjectsRoot,
  mergeMemoryIndex,
} from "../memory/import/memoryImport";
import { makeMemFs, type MemFs } from "./_helpers/memFs";

/**
 * Memory IMPORT — the Import dialog's Memory tab: copy a `claude-code` source
 * project's memory (`~/.claude/projects/<slug>/memory/`) into its Velloc store
 * (`~/.velloc/projects/<slug>/memory/`). Topic `.md` files are overwritten;
 * `MEMORY.md` is merged. A plain local-disk copy, so these tests seed source
 * (and sometimes destination) dirs in one in-memory fs and assert the merge +
 * copy land under the Velloc dir.
 */

const HOME = "/home/user";
const SRC = memoryImportProjectsRoot("claude-code", HOME); // ~/.claude/projects
const VELLOC = projectsHome(HOME); // ~/.velloc/projects

async function seed(
  fs: MemFs,
  root: string,
  slug: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    await fs.writeFile(`${root}/${slug}/memory/${rel}`, content);
  }
}
const seedSource = (fs: MemFs, slug: string, files: Record<string, string>) =>
  seed(fs, SRC, slug, files);
const seedDest = (fs: MemFs, slug: string, files: Record<string, string>) =>
  seed(fs, VELLOC, slug, files);

const ctx = (fs: MemFs) => ({
  homeDir: HOME,
  fs,
  source: "claude-code" as const,
});

describe("mergeMemoryIndex", () => {
  it("adopts the source index verbatim when the destination has none", () => {
    const source = "# Memory\n- [A](a.md) — a\n";
    expect(mergeMemoryIndex(null, source)).toBe("# Memory\n- [A](a.md) — a\n");
    expect(mergeMemoryIndex("", source)).toBe("# Memory\n- [A](a.md) — a\n");
  });

  it("keeps every destination line and appends only the source's NEW pointers", () => {
    // Add-only: the destination's own [Old A](a.md) entry is NOT replaced (its
    // topic file was not overwritten either), only the brand-new [C] is added.
    const dest = "# Memory\n- [Old A](a.md) — old\n- [B](b.md) — b\n";
    const source = "- [New A](a.md) — new\n- [C](c.md) — c\n";
    expect(mergeMemoryIndex(dest, source)).toBe(
      "# Memory\n- [Old A](a.md) — old\n- [B](b.md) — b\n- [C](c.md) — c\n",
    );
  });

  it("keys on the linked file's basename, so ./a.md and a.md collide (dest kept)", () => {
    // The destination line links ./a.md, the source a.md — same basename, so the
    // source line is a collision and is DROPPED; the destination's line stands.
    const dest = "- [Old](./a.md) — old\n";
    const source = "- [New](a.md) — new\n";
    expect(mergeMemoryIndex(dest, source)).toBe("- [Old](./a.md) — old\n");
  });

  it("leaves the destination unchanged when the source adds no new pointers", () => {
    const dest = "- [A](a.md) — a\n";
    expect(mergeMemoryIndex(dest, "- [A](a.md) — a\n")).toBe("- [A](a.md) — a\n");
  });
});

describe("memory import — listing importable projects", () => {
  it("lists projects that have memory, with per-file imported flags and status", async () => {
    const fs = makeMemFs();
    await seedSource(fs, "D--proj-a", {
      "MEMORY.md": "- [T1](t1.md) — one\n",
      "t1.md": "one",
      "t2.md": "two",
    });
    // A project dir with no memory/ subdir is not listed.
    await fs.writeFile(`${SRC}/D--proj-b/session.jsonl`, "{}");
    // A memory dir with no .md files is not listed either.
    await fs.writeFile(`${SRC}/D--proj-c/memory/.consolidate-lock`, "x");

    const rows = await listImportableMemoryProjects(SRC, VELLOC, fs);
    expect(rows.map((r) => r.slug)).toEqual(["D--proj-a"]);
    const row = rows[0]!;
    expect(row.status).toBe("import");
    expect(row.files.map((f) => f.relPath)).toEqual([
      "MEMORY.md",
      "t1.md",
      "t2.md",
    ]);
    expect(row.files.every((f) => !f.imported)).toBe(true);
  });

  it("reports status=update when only some topic files are already imported", async () => {
    const fs = makeMemFs();
    await seedSource(fs, "D--proj", {
      "MEMORY.md": "- [T1](t1.md)\n- [T2](t2.md)\n",
      "t1.md": "one",
      "t2.md": "two",
    });
    await seedDest(fs, "D--proj", { "t1.md": "one" });

    const [row] = await listImportableMemoryProjects(SRC, VELLOC, fs);
    expect(row!.status).toBe("update");
    const byName = Object.fromEntries(row!.files.map((f) => [f.relPath, f.imported]));
    expect(byName).toEqual({ "MEMORY.md": false, "t1.md": true, "t2.md": false });
  });

  it("reports status=imported when every topic file is present (MEMORY.md aside)", async () => {
    const fs = makeMemFs();
    await seedSource(fs, "D--proj", {
      "MEMORY.md": "- [T1](t1.md)\n",
      "t1.md": "one",
      "t2.md": "two",
    });
    // Only the topics need to be present — MEMORY.md is merged, not matched.
    await seedDest(fs, "D--proj", { "t1.md": "x", "t2.md": "y" });

    const [row] = await listImportableMemoryProjects(SRC, VELLOC, fs);
    expect(row!.status).toBe("imported");
  });

  it("returns [] for a missing source root (nothing to import)", async () => {
    const fs = makeMemFs();
    expect(await listImportableMemoryProjects(SRC, VELLOC, fs)).toEqual([]);
  });
});

describe("memory import — copying into the Velloc store", () => {
  it("add-only: copies NEW topic files, leaves an existing one untouched, merges MEMORY.md", async () => {
    const fs = makeMemFs();
    await seedSource(fs, "D--proj", {
      "MEMORY.md": "- [A](a.md) — a\n",
      "a.md": "alpha",
      "b.md": "beta",
    });
    await seedDest(fs, "D--proj", {
      "MEMORY.md": "- [Z](z.md) — z\n",
      "z.md": "zeta",
      "a.md": "OLD alpha",
    });

    const res = await importMemoryProject("D--proj", SRC, ctx(fs));
    // a.md already present → skipped (not overwritten); b.md is new → copied.
    expect(res).toEqual({
      slug: "D--proj",
      filesCopied: 1,
      filesSkipped: 1,
      indexMerged: true,
    });

    const dest = `${VELLOC}/D--proj/memory`;
    // a.md is Velloc's own — NOT covered ("should not cover the velloc's memory").
    expect(await fs.readFile(`${dest}/a.md`, { encoding: "utf-8" })).toBe("OLD alpha");
    expect(await fs.readFile(`${dest}/b.md`, { encoding: "utf-8" })).toBe("beta");
    expect(await fs.readFile(`${dest}/z.md`, { encoding: "utf-8" })).toBe("zeta");
    // MEMORY.md merged: the destination's own entry survives, the source's new
    // pointer is appended.
    expect(await fs.readFile(`${dest}/MEMORY.md`, { encoding: "utf-8" })).toBe(
      "- [Z](z.md) — z\n- [A](a.md) — a\n",
    );
  });

  it("union + sync: keeps Velloc's own memory, adds the source's, and re-import restores a deleted file", async () => {
    const fs = makeMemFs();
    // Source project: 5 topics + its index.
    await seedSource(fs, "D--proj", {
      "MEMORY.md": "- [C1](c1.md)\n- [C2](c2.md)\n- [C3](c3.md)\n- [C4](c4.md)\n- [C5](c5.md)\n",
      "c1.md": "cc1",
      "c2.md": "cc2",
      "c3.md": "cc3",
      "c4.md": "cc4",
      "c5.md": "cc5",
    });
    // Velloc already has 3 of its OWN (disjoint) topics + its own index.
    await seedDest(fs, "D--proj", {
      "MEMORY.md": "- [V1](v1.md)\n- [V2](v2.md)\n- [V3](v3.md)\n",
      "v1.md": "velloc1",
      "v2.md": "velloc2",
      "v3.md": "velloc3",
    });

    const res = await importMemoryProject("D--proj", SRC, ctx(fs));
    expect(res.filesCopied).toBe(5);
    expect(res.filesSkipped).toBe(0);

    const dest = `${VELLOC}/D--proj/memory`;
    // 3 Velloc + 5 source = 8 topic files; Velloc's own untouched, the source's added.
    expect(await fs.readFile(`${dest}/v2.md`, { encoding: "utf-8" })).toBe("velloc2");
    expect(await fs.readFile(`${dest}/c3.md`, { encoding: "utf-8" })).toBe("cc3");
    // Index keeps Velloc's pointers and appends the source's.
    expect(await fs.readFile(`${dest}/MEMORY.md`, { encoding: "utf-8" })).toBe(
      "- [V1](v1.md)\n- [V2](v2.md)\n- [V3](v3.md)\n" +
        "- [C1](c1.md)\n- [C2](c2.md)\n- [C3](c3.md)\n- [C4](c4.md)\n- [C5](c5.md)\n",
    );

    // All 5 source topics present → the row reads `imported` (button disabled).
    let rows = await listImportableMemoryProjects(SRC, VELLOC, fs);
    expect(rows[0]!.status).toBe("imported");

    // Delete one source-origin file from Velloc → the row now reads `update`, so the
    // user can sync the lost one back.
    await fs.rm(`${dest}/c3.md`);
    rows = await listImportableMemoryProjects(SRC, VELLOC, fs);
    expect(rows[0]!.status).toBe("update");

    // Re-import (the Update action): only the missing c3.md is re-copied; the
    // other four are already present (add-only), Velloc's own stay put.
    const res2 = await importMemoryProject("D--proj", SRC, ctx(fs));
    expect(res2.filesCopied).toBe(1);
    expect(res2.filesSkipped).toBe(4);
    expect(await fs.readFile(`${dest}/c3.md`, { encoding: "utf-8" })).toBe("cc3");
    rows = await listImportableMemoryProjects(SRC, VELLOC, fs);
    expect(rows[0]!.status).toBe("imported");
  });

  it("adopts the source MEMORY.md verbatim on a fresh destination", async () => {
    const fs = makeMemFs();
    await seedSource(fs, "D--proj", {
      "MEMORY.md": "- [A](a.md) — a\n",
      "a.md": "alpha",
    });
    await importMemoryProject("D--proj", SRC, ctx(fs));
    expect(
      await fs.readFile(`${VELLOC}/D--proj/memory/MEMORY.md`, { encoding: "utf-8" }),
    ).toBe("- [A](a.md) — a\n");
  });

  it("flips the row to imported after a full import", async () => {
    const fs = makeMemFs();
    await seedSource(fs, "D--proj", {
      "MEMORY.md": "- [A](a.md)\n",
      "a.md": "alpha",
    });
    await importMemoryProject("D--proj", SRC, ctx(fs));
    const [row] = await listImportableMemoryProjects(SRC, VELLOC, fs);
    expect(row!.status).toBe("imported");
  });

  it("throws for a project with no memory files", async () => {
    const fs = makeMemFs();
    await fs.writeFile(`${SRC}/D--proj/session.jsonl`, "{}");
    await expect(importMemoryProject("D--proj", SRC, ctx(fs))).rejects.toThrow(
      /No memory files/,
    );
  });

  it("rejects a slug that could escape the projects dir", async () => {
    const fs = makeMemFs();
    await expect(importMemoryProject("../evil", SRC, ctx(fs))).rejects.toThrow(
      /Invalid project slug/,
    );
  });
});

describe("memory bridge adapter — import routes", () => {
  function okResult<T>(res: BrowserBridgeResponse): T {
    if (!res.ok) throw new Error(`bridge error: ${res.error.code}`);
    return res.result as T;
  }

  it("listImportableProjects + importProject dispatch through the adapter", async () => {
    const fs = makeMemFs();
    await seedSource(fs, "D--proj", {
      "MEMORY.md": "- [A](a.md)\n",
      "a.md": "alpha",
    });
    const adapterCtx = { homeDir: HOME, fs };

    const listReq: BrowserBridgeRequest = {
      id: "req-list-mem",
      route: createBridgeRoute("memory", "listImportableProjects"),
      payload: { source: "claude-code" },
    } as BrowserBridgeRequest;
    const list = okResult<{
      rootPath: string;
      projects: Array<{ slug: string; status: string }>;
    }>(await handleMemoryBridgeRequest(listReq, adapterCtx));
    expect(list.rootPath).toBe(SRC);
    expect(list.projects.map((p) => p.slug)).toEqual(["D--proj"]);
    expect(list.projects[0]!.status).toBe("import");

    const importReq: BrowserBridgeRequest = {
      id: "req-import-mem",
      route: createBridgeRoute("memory", "importProject"),
      payload: { source: "claude-code", slug: "D--proj" },
    } as BrowserBridgeRequest;
    const imported = okResult<{
      ok: true;
      slug: string;
      filesCopied: number;
      filesSkipped: number;
      indexMerged: boolean;
    }>(await handleMemoryBridgeRequest(importReq, adapterCtx));
    expect(imported.slug).toBe("D--proj");
    expect(imported.filesCopied).toBe(1);
    expect(imported.filesSkipped).toBe(0);
    expect(imported.indexMerged).toBe(true);
    expect(fs.dump()).toContain(`${VELLOC}/D--proj/memory/a.md`);
  });
});
