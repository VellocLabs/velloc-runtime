import { describe, expect, it } from "vitest";

import { handleMemoryBridgeRequest } from "../browser/bridge/adapter/memoryBridgeAdapter";
import { createBridgeRoute } from "../browser/bridge/protocol/core";
import type {
  BrowserBridgeRequest,
  BrowserBridgeResponse,
} from "../browser/bridge/protocol/core";
import {
  globalMemorySourceFiles,
  importGlobalMemory,
  listImportableGlobalMemory,
  mergeGlobalMemoryBlock,
  userInstructionFilePath,
} from "../memory/import/globalMemoryImport";
import { makeMemFs, type MemFs } from "./_helpers/memFs";

/**
 * GLOBAL memory import — the Import dialog's Memory tab "global memory" row.
 * Codex keeps memory globally (not per-project), so it is merged ADD-ONLY into
 * the user-tier `~/.velloc/AGENTS.md` inside a provenance-marked block. These
 * tests pin the source layout, the block merge (append / idempotent replace /
 * user content preserved), the import/imported/update status, and the copy.
 */

const HOME = "/home/user";
const CODEX_AGENTS = `${HOME}/.codex/AGENTS.md`;
const CODEX_SUMMARY = `${HOME}/.codex/memories/memory_summary.md`;
const CODEX_MEMORY = `${HOME}/.codex/memories/MEMORY.md`;
const USER_AGENTS = `${HOME}/.velloc/AGENTS.md`;

const BEGIN = "<!-- velloc:imported source=codex kind=memory begin -->";
const END = "<!-- velloc:imported source=codex kind=memory end -->";

async function seedCodexMemory(fs: MemFs): Promise<void> {
  await fs.writeFile(CODEX_AGENTS, "Be concise.\n");
  await fs.writeFile(CODEX_SUMMARY, "Summary: user builds Velloc.\n");
  await fs.writeFile(CODEX_MEMORY, "- likes tests\n");
}

describe("global memory import — source layout", () => {
  it("codex roots its global memory under ~/.codex (AGENTS.md + memories/*.md)", () => {
    const spec = globalMemorySourceFiles("codex", HOME);
    expect(spec.map((f) => f.path)).toEqual([
      CODEX_AGENTS,
      CODEX_SUMMARY,
      CODEX_MEMORY,
    ]);
  });

  it("claude-code has no global memory (its memory is per-project)", () => {
    expect(globalMemorySourceFiles("claude-code", HOME)).toEqual([]);
  });

  it("merges into the user-tier ~/.velloc/AGENTS.md", async () => {
    expect(await userInstructionFilePath(makeMemFs(), HOME)).toBe(USER_AGENTS);
  });

  // The user keeps only ~/.claude/CLAUDE.md: that is the loaded user file, so
  // the import merges into it — an AGENTS.md beside it would hide it.
  it("merges into ~/.claude/CLAUDE.md where only it exists, creating no AGENTS.md", async () => {
    const fs = makeMemFs();
    const FALLBACK_FILE = `${HOME}/.claude/CLAUDE.md`;
    await fs.writeFile(FALLBACK_FILE, "# Mine\n");
    await seedCodexMemory(fs);
    expect(await userInstructionFilePath(fs, HOME)).toBe(FALLBACK_FILE);
    const res = await importGlobalMemory("codex", { homeDir: HOME, fs });
    expect(res.destPath).toBe(FALLBACK_FILE);
    const written = await fs.readFile(FALLBACK_FILE, { encoding: "utf-8" });
    expect(written).toContain("# Mine");
    expect(written).toContain(BEGIN);
    await expect(fs.readFile(USER_AGENTS, { encoding: "utf-8" })).rejects.toThrow();
  });
});

describe("global memory import — listing", () => {
  it("returns null for claude-code (no global-memory concept → no row)", async () => {
    const fs = makeMemFs();
    expect(await listImportableGlobalMemory("claude-code", HOME, fs)).toBeNull();
  });

  it("returns null for codex with no memory files (nothing accrued yet)", async () => {
    const fs = makeMemFs();
    expect(await listImportableGlobalMemory("codex", HOME, fs)).toBeNull();
  });

  it("returns null for codex whose files are all empty", async () => {
    const fs = makeMemFs();
    await fs.writeFile(CODEX_AGENTS, "\n");
    await fs.writeFile(CODEX_MEMORY, "   \n");
    expect(await listImportableGlobalMemory("codex", HOME, fs)).toBeNull();
  });

  it("lists the non-empty files with status 'import' when AGENTS.md has no block", async () => {
    const fs = makeMemFs();
    await seedCodexMemory(fs);
    const row = await listImportableGlobalMemory("codex", HOME, fs);
    expect(row).not.toBeNull();
    expect(row!.source).toBe("codex");
    expect(row!.destPath).toBe(USER_AGENTS);
    expect(row!.files.map((f) => f.label)).toEqual([
      "AGENTS.md",
      "memories/memory_summary.md",
      "memories/MEMORY.md",
    ]);
    expect(row!.status).toBe("import");
  });

  it("skips an absent/empty source file in the listed files", async () => {
    const fs = makeMemFs();
    await fs.writeFile(CODEX_SUMMARY, "Summary only.\n"); // no AGENTS.md, no MEMORY.md
    const row = await listImportableGlobalMemory("codex", HOME, fs);
    expect(row!.files.map((f) => f.label)).toEqual(["memories/memory_summary.md"]);
  });

  it("reads 'imported' after an import and 'update' once the source changes", async () => {
    const fs = makeMemFs();
    await seedCodexMemory(fs);
    await importGlobalMemory("codex", { homeDir: HOME, fs });
    expect((await listImportableGlobalMemory("codex", HOME, fs))!.status).toBe(
      "imported",
    );

    // Codex regenerated its memory — the row becomes syncable again.
    await fs.writeFile(CODEX_MEMORY, "- likes tests\n- and docs\n");
    expect((await listImportableGlobalMemory("codex", HOME, fs))!.status).toBe(
      "update",
    );
  });
});

describe("global memory import — mergeGlobalMemoryBlock (add-only)", () => {
  it("creates the block on a fresh (null) destination", () => {
    const out = mergeGlobalMemoryBlock(null, "codex", "INNER");
    expect(out).toBe(`${BEGIN}\n## Imported from Codex memory\n\nINNER\n${END}\n`);
  });

  it("appends after the user's own content, leaving it untouched", () => {
    const user = "# My rules\n\nAlways use tabs.\n";
    const out = mergeGlobalMemoryBlock(user, "codex", "INNER");
    expect(out.startsWith("# My rules\n\nAlways use tabs.")).toBe(true);
    expect(out).toContain(BEGIN);
    expect(out).toContain(END);
    // The user's line is above the imported block.
    expect(out.indexOf("Always use tabs.")).toBeLessThan(out.indexOf(BEGIN));
  });

  it("is idempotent — re-merging identical content replaces, never duplicates", () => {
    const once = mergeGlobalMemoryBlock("# Mine\n", "codex", "INNER");
    const twice = mergeGlobalMemoryBlock(once, "codex", "INNER");
    expect(twice).toBe(once);
    expect(twice.match(new RegExp(BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))!.length)
      .toBe(1);
    expect(twice.startsWith("# Mine")).toBe(true);
  });

  it("replaces stale block content while keeping the user's lines", () => {
    const first = mergeGlobalMemoryBlock("# Mine\n", "codex", "OLD");
    const second = mergeGlobalMemoryBlock(first, "codex", "NEW");
    expect(second).toContain("NEW");
    expect(second).not.toContain("OLD");
    expect(second.startsWith("# Mine")).toBe(true);
    expect(second.match(new RegExp(END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))!.length)
      .toBe(1);
  });

  it("leaves a DIFFERENT source's block in place", () => {
    const ccBlock =
      "<!-- velloc:imported source=claude-code kind=memory begin -->\nX\n" +
      "<!-- velloc:imported source=claude-code kind=memory end -->\n";
    const out = mergeGlobalMemoryBlock(ccBlock, "codex", "INNER");
    expect(out).toContain("source=claude-code");
    expect(out).toContain(BEGIN);
  });

  it("leaves user content after an UNPAIRED begin marker (no strip-to-EOF)", () => {
    // A begin marker with NO matching end (a hand edit that removed it, or stray
    // marker text). The old code stripped from the marker to EOF, deleting the
    // user's content below it; now the malformed marker is left untouched.
    const dest = `${BEGIN}\nstale\n\n# My notes\nkeep me\n`;
    const out = mergeGlobalMemoryBlock(dest, "codex", "INNER");
    expect(out).toContain("keep me");
    expect(out).toContain("# My notes");
    expect(out).toContain("INNER");
  });
});

describe("global memory import — importGlobalMemory (copy)", () => {
  it("writes the block into ~/.velloc/AGENTS.md with the source content", async () => {
    const fs = makeMemFs();
    await seedCodexMemory(fs);
    const res = await importGlobalMemory("codex", { homeDir: HOME, fs });
    expect(res.imported).toBe(true);
    expect(res.filesImported).toBe(3);
    expect(res.destPath).toBe(USER_AGENTS);

    const written = await fs.readFile(USER_AGENTS, { encoding: "utf-8" });
    expect(written).toContain(BEGIN);
    expect(written).toContain("Be concise.");
    expect(written).toContain("Summary: user builds Velloc.");
    expect(written).toContain("- likes tests");
    expect(written).toContain("### Instructions (AGENTS.md)");
  });

  it("is add-only — a pre-existing AGENTS.md keeps its own content", async () => {
    const fs = makeMemFs();
    await fs.writeFile(USER_AGENTS, "# My own memory\n\nKeep me.\n");
    await seedCodexMemory(fs);
    await importGlobalMemory("codex", { homeDir: HOME, fs });
    const written = await fs.readFile(USER_AGENTS, { encoding: "utf-8" });
    expect(written).toContain("# My own memory");
    expect(written).toContain("Keep me.");
    expect(written.indexOf("Keep me.")).toBeLessThan(written.indexOf(BEGIN));
  });

  it("re-import is idempotent (no duplicate block)", async () => {
    const fs = makeMemFs();
    await seedCodexMemory(fs);
    await importGlobalMemory("codex", { homeDir: HOME, fs });
    const first = await fs.readFile(USER_AGENTS, { encoding: "utf-8" });
    await importGlobalMemory("codex", { homeDir: HOME, fs });
    const second = await fs.readFile(USER_AGENTS, { encoding: "utf-8" });
    expect(second).toBe(first);
  });

  it("throws for codex with no memory to import", async () => {
    const fs = makeMemFs();
    await expect(
      importGlobalMemory("codex", { homeDir: HOME, fs }),
    ).rejects.toThrow(/no global memory/i);
  });

  it("throws for claude-code (no global memory concept)", async () => {
    const fs = makeMemFs();
    await expect(
      importGlobalMemory("claude-code", { homeDir: HOME, fs }),
    ).rejects.toThrow(/no global memory/i);
  });

  it("neutralizes an import marker embedded in source content (status stable, no accumulation)", async () => {
    const fs = makeMemFs();
    // A source memory file whose body contains the literal end marker.
    await fs.writeFile(CODEX_AGENTS, `note ${END} tail\n`);
    await importGlobalMemory("codex", { homeDir: HOME, fs });

    // The embedded marker did not forge a boundary: the row reads 'imported'.
    expect((await listImportableGlobalMemory("codex", HOME, fs))!.status).toBe(
      "imported",
    );
    const first = await fs.readFile(USER_AGENTS, { encoding: "utf-8" });
    // Exactly ONE real end marker (the embedded one was defused).
    const endCount = first.match(
      new RegExp(END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
    )!.length;
    expect(endCount).toBe(1);
    // Re-import stays idempotent — no malformed, duplicated block fragments.
    await importGlobalMemory("codex", { homeDir: HOME, fs });
    expect(await fs.readFile(USER_AGENTS, { encoding: "utf-8" })).toBe(first);
  });

  it("caps a large multibyte file by BYTES, not characters", async () => {
    const fs = makeMemFs();
    // ~200k characters but ~600 KB of bytes (> the 256 KB cap). The old code
    // measured/sliced by string length, so this was NOT truncated.
    await fs.writeFile(CODEX_MEMORY, `${"中".repeat(200_000)}\n`);
    await importGlobalMemory("codex", { homeDir: HOME, fs });
    const written = await fs.readFile(USER_AGENTS, { encoding: "utf-8" });
    expect(written).toContain("…(truncated on import)");
  });
});

describe("global memory import — bridge adapter routes", () => {
  function ok<T>(res: BrowserBridgeResponse): T {
    if (!res.ok) throw new Error(`bridge error: ${res.error.code}`);
    return res.result as T;
  }

  it("listImportableGlobalMemory + importGlobalMemory dispatch for source:codex", async () => {
    const fs = makeMemFs();
    await seedCodexMemory(fs);
    const ctx = { homeDir: HOME, fs };

    const listReq: BrowserBridgeRequest = {
      id: "m-list",
      route: createBridgeRoute("memory", "listImportableGlobalMemory"),
      payload: { source: "codex" },
    } as BrowserBridgeRequest;
    const list = ok<{
      source: string;
      global: { status: string; destPath: string } | null;
    }>(await handleMemoryBridgeRequest(listReq, ctx));
    expect(list.global).not.toBeNull();
    expect(list.global!.status).toBe("import");
    expect(list.global!.destPath).toBe(USER_AGENTS);

    const impReq: BrowserBridgeRequest = {
      id: "m-imp",
      route: createBridgeRoute("memory", "importGlobalMemory"),
      payload: { source: "codex" },
    } as BrowserBridgeRequest;
    const imp = ok<{ imported: boolean; filesImported: number }>(
      await handleMemoryBridgeRequest(impReq, ctx),
    );
    expect(imp.imported).toBe(true);
    expect(imp.filesImported).toBe(3);
    expect(fs.dump()).toContain(USER_AGENTS);

    // A follow-up list now reads `imported` (the block matches the source).
    const list2 = ok<{ global: { status: string } | null }>(
      await handleMemoryBridgeRequest(listReq, ctx),
    );
    expect(list2.global!.status).toBe("imported");
  });

  it("listImportableGlobalMemory returns null for claude-code", async () => {
    const fs = makeMemFs();
    const req: BrowserBridgeRequest = {
      id: "m-cc",
      route: createBridgeRoute("memory", "listImportableGlobalMemory"),
      payload: { source: "claude-code" },
    } as BrowserBridgeRequest;
    const res = ok<{ global: unknown | null }>(
      await handleMemoryBridgeRequest(req, { homeDir: HOME, fs }),
    );
    expect(res.global).toBeNull();
  });
});
