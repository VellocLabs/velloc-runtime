import { describe, expect, it } from "vitest";

import { handleSkillsBridgeRequest } from "../browser/bridge/adapter/skillsBridgeAdapter";
import { createBridgeRoute } from "../browser/bridge/protocol/core";
import type {
  BrowserBridgeRequest,
  BrowserBridgeResponse,
} from "../browser/bridge/protocol/core";
import {
  importLocalSkill,
  listImportableSkills,
  skillImportSourceRoot,
} from "../skillLibrary/skillImport";
import {
  getSkillsDirectory,
  listInstalledSkills,
  uninstallSkill,
} from "../skillLibrary/skillInstall";
import { makeMemFs, type MemFs } from "./_helpers/memFs";

/**
 * Skill IMPORT — the Import dialog's Skills tab: copy a `claude-code` source
 * skill (`~/.claude/skills/<dir>/`) into the Velloc store (`~/.velloc/skills/<dir>/`).
 * A plain local-disk copy (no download), so these tests seed the source dir in
 * one in-memory fs and assert the copy + provenance land under the Velloc dir —
 * and that imported skills round-trip through the SAME `listInstalled` /
 * `uninstall` the marketplace uses.
 */

const HOME = "/home/user";
const SRC = skillImportSourceRoot("claude-code", HOME); // ~/.claude/skills
const DEST = getSkillsDirectory(HOME); // ~/.velloc/skills
const NOW = () => "2026-01-01T00:00:00.000Z";

async function seedSkill(
  fs: MemFs,
  dir: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    await fs.writeFile(`${SRC}/${dir}/${rel}`, content);
  }
}

const ctx = (fs: MemFs) => ({
  homeDir: HOME,
  fs,
  source: "claude-code" as const,
  now: NOW,
});

describe("skill import — listing importable skills", () => {
  it("lists source dirs that have a SKILL.md, with name/description/fileCount", async () => {
    const fs = makeMemFs();
    await seedSkill(fs, "pdf", {
      "SKILL.md": "---\nname: PDF Tools\ndescription: Work with PDF files\n---\nbody",
      "scripts/run.py": "print(1)",
    });
    // A dir without a SKILL.md is not a loadable skill — skipped.
    await seedSkill(fs, "notes", { "README.md": "# nope" });

    const rows = await listImportableSkills(SRC, DEST, fs);
    expect(rows.map((r) => r.dir)).toEqual(["pdf"]);
    const pdf = rows[0]!;
    expect(pdf.name).toBe("PDF Tools");
    expect(pdf.description).toBe("Work with PDF files");
    expect(pdf.fileCount).toBe(2);
    expect(pdf.alreadyImported).toBe(false);
  });

  it("falls back to the dir name + first body line when frontmatter is thin", async () => {
    const fs = makeMemFs();
    await seedSkill(fs, "foo", { "SKILL.md": "# Foo heading\n\ndetails" });
    const [row] = await listImportableSkills(SRC, DEST, fs);
    expect(row!.name).toBe("foo");
    expect(row!.description).toBe("Foo heading");
  });

  it("returns [] for a missing source folder (nothing to import)", async () => {
    const fs = makeMemFs();
    expect(await listImportableSkills(SRC, DEST, fs)).toEqual([]);
  });
});

describe("skill import — copying into the Velloc store", () => {
  it("copies the whole skill dir + writes a provenance sidecar", async () => {
    const fs = makeMemFs();
    await seedSkill(fs, "pdf", {
      "SKILL.md": "---\nname: pdf\n---\nbody",
      "scripts/run.py": "print(1)",
      "reference/guide.md": "guide",
    });

    const { entry, skipped, fileCount } = await importLocalSkill(
      "pdf",
      SRC,
      ctx(fs),
    );
    expect(skipped).toBe(false);
    expect(fileCount).toBe(3);
    expect(entry.id).toBe("imported/claude-code/pdf");
    expect(entry.dir).toBe("pdf");

    const written = fs.dump();
    expect(written).toContain(`${DEST}/pdf/SKILL.md`);
    expect(written).toContain(`${DEST}/pdf/scripts/run.py`);
    expect(written).toContain(`${DEST}/pdf/reference/guide.md`);

    const prov = JSON.parse(
      await fs.readFile(`${DEST}/pdf/.velloc-skill.json`, { encoding: "utf-8" }),
    );
    expect(prov).toMatchObject({
      id: "imported/claude-code/pdf",
      name: "pdf",
      dir: "pdf",
      importedFrom: { source: "claude-code", path: `${SRC}/pdf` },
    });
  });

  it("is idempotent — a second import is a no-op (skipped)", async () => {
    const fs = makeMemFs();
    await seedSkill(fs, "pdf", { "SKILL.md": "---\nname: pdf\n---\n" });
    await importLocalSkill("pdf", SRC, ctx(fs));
    const again = await importLocalSkill("pdf", SRC, ctx(fs));
    expect(again.skipped).toBe(true);
    expect(again.fileCount).toBe(0);
  });

  it("marks the row alreadyImported after an import", async () => {
    const fs = makeMemFs();
    await seedSkill(fs, "pdf", { "SKILL.md": "---\nname: pdf\n---\n" });
    await importLocalSkill("pdf", SRC, ctx(fs));
    const [row] = await listImportableSkills(SRC, DEST, fs);
    expect(row!.alreadyImported).toBe(true);
  });

  it("throws for a dir with no SKILL.md (not an importable skill)", async () => {
    const fs = makeMemFs();
    await seedSkill(fs, "notes", { "README.md": "# nope" });
    await expect(importLocalSkill("notes", SRC, ctx(fs))).rejects.toThrow(
      /SKILL\.md/,
    );
  });

  it.each(["..", "../other", "a/b", "a\\b", ".", ""])(
    "refuses a dir that is not one entry under the source root (%j)",
    async (dir) => {
      // `dir` arrives from a client, and a remote grant may import (F-24): a traversal would copy a directory from anywhere on the
      // host into the store. Seed one outside the root to prove nothing lands.
      const fs = makeMemFs();
      await fs.writeFile(`${HOME}/.claude/other/SKILL.md`, "---\nname: x\n---\n");
      await expect(importLocalSkill(dir, SRC, ctx(fs))).rejects.toThrow(
        /Invalid skill directory/,
      );
      expect(fs.dump().some((p) => p.startsWith(`${DEST}/`))).toBe(false);
    },
  );

  it("round-trips through listInstalled + uninstall by imported id", async () => {
    const fs = makeMemFs();
    await seedSkill(fs, "pdf", { "SKILL.md": "---\nname: pdf\n---\n" });
    await importLocalSkill("pdf", SRC, ctx(fs));

    const installed = await listInstalledSkills(HOME, fs);
    expect(installed.map((e) => e.id)).toContain("imported/claude-code/pdf");

    expect(await uninstallSkill("imported/claude-code/pdf", HOME, fs)).toBe(true);
    expect(fs.dump().some((p) => p.startsWith(`${DEST}/pdf/`))).toBe(false);
  });
});

describe("skills bridge adapter — import routes", () => {
  function okResult<T>(res: BrowserBridgeResponse): T {
    if (!res.ok) throw new Error(`bridge error: ${res.error.code}`);
    return res.result as T;
  }

  it("listImportable + importLocal dispatch through the adapter", async () => {
    const fs = makeMemFs();
    await fs.writeFile(`${SRC}/pdf/SKILL.md`, "---\nname: pdf\n---\n");
    const adapterCtx = { homeDir: HOME, fs, now: NOW };

    const listReq: BrowserBridgeRequest = {
      id: "req-list-importable",
      route: createBridgeRoute("skills", "listImportable"),
      payload: { source: "claude-code" },
    } as BrowserBridgeRequest;
    const list = okResult<{
      rootPath: string;
      skills: Array<{ dir: string; alreadyImported: boolean }>;
    }>(await handleSkillsBridgeRequest(listReq, adapterCtx));
    expect(list.rootPath).toBe(SRC);
    expect(list.skills.map((s) => s.dir)).toEqual(["pdf"]);
    expect(list.skills[0]!.alreadyImported).toBe(false);

    const importReq: BrowserBridgeRequest = {
      id: "req-import-local",
      route: createBridgeRoute("skills", "importLocal"),
      payload: { source: "claude-code", dir: "pdf" },
    } as BrowserBridgeRequest;
    const imported = okResult<{
      ok: true;
      skipped: boolean;
      entry: { id: string };
    }>(await handleSkillsBridgeRequest(importReq, adapterCtx));
    expect(imported.skipped).toBe(false);
    expect(imported.entry.id).toBe("imported/claude-code/pdf");
    expect(fs.dump()).toContain(`${DEST}/pdf/SKILL.md`);
  });
});

/**
 * Codex source (`~/.codex/skills/`). Codex keeps user skills in the SAME
 * `SKILL.md` layout as `~/.claude/skills/`, so the importer is unchanged — these tests
 * pin the Codex-specific behaviour: the root, that OpenAI's bundled `.system/`
 * built-ins are NOT offered, the `imported/codex/<dir>` provenance, and the
 * imported-state + idempotent-skip dedup (a re-import never duplicates).
 */
describe("skill import — Codex source (~/.codex/skills)", () => {
  const CODEX_SRC = skillImportSourceRoot("codex", HOME); // ~/.codex/skills
  const codexCtx = (fs: MemFs) => ({
    homeDir: HOME,
    fs,
    source: "codex" as const,
    now: NOW,
  });
  async function seedCodexSkill(
    fs: MemFs,
    relDir: string,
    files: Record<string, string>,
  ): Promise<void> {
    for (const [rel, content] of Object.entries(files)) {
      await fs.writeFile(`${CODEX_SRC}/${relDir}/${rel}`, content);
    }
  }

  it("roots at ~/.codex/skills", () => {
    expect(CODEX_SRC).toBe(`${HOME}/.codex/skills`);
  });

  it("lists the user's skills but skips the bundled `.system/` built-ins", async () => {
    const fs = makeMemFs();
    // A user-authored skill (direct child) — offered.
    await seedCodexSkill(fs, "pdf", {
      "SKILL.md":
        "---\nname: PDF Tools\ndescription: Work with PDF files\n---\nbody",
      "scripts/run.py": "print(1)",
    });
    // OpenAI's bundled built-ins: nested under `.system/<name>/`, with a marker
    // file directly under `.system/`. A dot-dir — never offered.
    await seedCodexSkill(fs, ".system", { ".codex-system-skills.marker": "" });
    await seedCodexSkill(fs, ".system/skill-creator", {
      "SKILL.md": "---\nname: skill-creator\ndescription: builtin\n---\nbody",
    });
    // The `.startsWith('.')` guard also excludes a dot-dir that DOES have a
    // direct SKILL.md — pinning the guard itself, not just the one-level scan.
    await seedCodexSkill(fs, ".hidden", {
      "SKILL.md": "---\nname: hidden\n---\nbody",
    });

    const rows = await listImportableSkills(CODEX_SRC, DEST, fs);
    expect(rows.map((r) => r.dir)).toEqual(["pdf"]);
    expect(rows[0]!.name).toBe("PDF Tools");
    expect(rows[0]!.alreadyImported).toBe(false);
  });

  it("imports with an `imported/codex/<dir>` provenance id", async () => {
    const fs = makeMemFs();
    await seedCodexSkill(fs, "pdf", {
      "SKILL.md": "---\nname: pdf\n---\nbody",
      "scripts/run.py": "print(1)",
    });
    const { entry, skipped, fileCount } = await importLocalSkill(
      "pdf",
      CODEX_SRC,
      codexCtx(fs),
    );
    expect(skipped).toBe(false);
    expect(fileCount).toBe(2);
    expect(entry.id).toBe("imported/codex/pdf");
    const prov = JSON.parse(
      await fs.readFile(`${DEST}/pdf/.velloc-skill.json`, { encoding: "utf-8" }),
    );
    expect(prov).toMatchObject({
      id: "imported/codex/pdf",
      importedFrom: { source: "codex", path: `${CODEX_SRC}/pdf` },
    });
  });

  it("detects an already-imported skill and a re-import is a no-op (no duplicate)", async () => {
    const fs = makeMemFs();
    await seedCodexSkill(fs, "pdf", { "SKILL.md": "---\nname: pdf\n---\n" });

    // First import lands; the row then reads as already imported (live check).
    await importLocalSkill("pdf", CODEX_SRC, codexCtx(fs));
    const [row] = await listImportableSkills(CODEX_SRC, DEST, fs);
    expect(row!.alreadyImported).toBe(true);

    // A second import is skipped — the existing (possibly customised) copy is
    // left untouched, so a double click cannot produce a duplicate.
    const again = await importLocalSkill("pdf", CODEX_SRC, codexCtx(fs));
    expect(again.skipped).toBe(true);
    expect(again.fileCount).toBe(0);
  });

  it("dispatches listImportable + importLocal through the adapter for source:codex", async () => {
    const fs = makeMemFs();
    await fs.writeFile(`${CODEX_SRC}/pdf/SKILL.md`, "---\nname: pdf\n---\n");
    const adapterCtx = { homeDir: HOME, fs, now: NOW };

    const listReq: BrowserBridgeRequest = {
      id: "req-codex-list",
      route: createBridgeRoute("skills", "listImportable"),
      payload: { source: "codex" },
    } as BrowserBridgeRequest;
    const listRes = await handleSkillsBridgeRequest(listReq, adapterCtx);
    if (!listRes.ok) throw new Error(`bridge error: ${listRes.error.code}`);
    const list = listRes.result as {
      rootPath: string;
      skills: Array<{ dir: string; alreadyImported: boolean }>;
    };
    expect(list.rootPath).toBe(CODEX_SRC);
    expect(list.skills.map((s) => s.dir)).toEqual(["pdf"]);

    const importReq: BrowserBridgeRequest = {
      id: "req-codex-import",
      route: createBridgeRoute("skills", "importLocal"),
      payload: { source: "codex", dir: "pdf" },
    } as BrowserBridgeRequest;
    const importRes = await handleSkillsBridgeRequest(importReq, adapterCtx);
    if (!importRes.ok) throw new Error(`bridge error: ${importRes.error.code}`);
    const imported = importRes.result as { skipped: boolean; entry: { id: string } };
    expect(imported.skipped).toBe(false);
    expect(imported.entry.id).toBe("imported/codex/pdf");
    expect(fs.dump()).toContain(`${DEST}/pdf/SKILL.md`);
  });
});
