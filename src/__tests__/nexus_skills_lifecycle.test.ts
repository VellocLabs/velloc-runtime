import { renderSkillListing } from '../skillLibrary/skillListing'
import { afterEach, describe, expect, it } from "vitest";

import { BrowserRuntimeConfig } from "../config/BrowserRuntimeConfig";
import { handleSkillsBridgeRequest } from "../browser/bridge/adapter/skillsBridgeAdapter";
import { createBridgeRoute } from "../browser/bridge/protocol/core";
import type {
  BrowserBridgeRequest,
  BrowserBridgeResponse,
} from "../browser/bridge/protocol/core";
import type { SkillCatalogInput } from "../browser/bridge/protocol/skills";
import {
  getModelInvocableCommands,
  loadLocalPromptCommands,
} from "../skillLibrary/skillDiscovery";
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from "../runtime/testing/noopAdapters";
import { SkillRunTool } from "../toolkit/builtin/skill";
import {
  installProcessFs,
  resetProcessFs,
} from "../utils/fs/runtimeFs";
import { makeFetch, makeMemFs } from "./_helpers/memFs";

/**
 * End-to-end skill lifecycle: the worker `skills` install/uninstall adapter through the real loader, the Tier-1
 * listing and the `Skill` tool. Tier 1: name + description, no body; Tier 2: the body via the Skill tool; Tier 3:
 * resource files stay on disk; gates: disable-model-invocation, user-invocable. One in-memory `RuntimeFs` serves
 * both install (`ctx.fs`) and the loader (`installProcessFs`).
 */

const HOME = "/home/user";

// --- bridge request builders (the web flow) --------------------------------
function installReq(skill: SkillCatalogInput): BrowserBridgeRequest {
  return {
    id: "req-install",
    route: createBridgeRoute("skills", "install"),
    payload: { skill },
  } as BrowserBridgeRequest;
}
function uninstallReq(id: string): BrowserBridgeRequest {
  return {
    id: "req-uninstall",
    route: createBridgeRoute("skills", "uninstall"),
    payload: { id },
  } as BrowserBridgeRequest;
}
function listReq(): BrowserBridgeRequest {
  return {
    id: "req-list",
    route: createBridgeRoute("skills", "listInstalled"),
    payload: {},
  } as BrowserBridgeRequest;
}

/** Narrow a bridge response to its success `result` (throws on error). */
function okResult<T>(res: BrowserBridgeResponse): T {
  if (!res.ok) {
    throw new Error(`bridge error: ${res.error.code}`);
  }
  return res.result as T;
}

// --- loader + Skill-tool context (skills come from the loader output) ------
async function loadCommands() {
  return loadLocalPromptCommands({
    cwd: "/workspace",
    runtimeConfig: new BrowserRuntimeConfig({ env: { HOME } }),
    includeBundled: false,
  });
}

function makeContext(commands: Awaited<ReturnType<typeof loadCommands>>) {
  return createNoopToolUseContext({
    tools: [SkillRunTool],
    platformCapabilities: new NoopPlatformCapabilities(),
    appState: createEmptyAppState(),
    setAppState: () => {},
    sessionId: "sess-1",
    commands,
  });
}

function extractInjectedText(messages: unknown[]): string {
  const first = messages[0] as {
    message: { content: string | Array<{ text: string }> };
  };
  const content = first.message.content;
  return typeof content === "string" ? content : content[0]!.text;
}

const ALLOW = async () => ({ behavior: "allow" as const });
const PARENT_MESSAGE = {
  type: "assistant",
  uuid: "assistant-1",
  message: { role: "assistant", content: [] },
} as never;

// --- fixtures --------------------------------------------------------------
// Distinctive markers let us assert which TIER each piece of content reaches.
const PDF_SKILL_MD = [
  "---",
  "name: pdf",
  "description: Work with PDF files — extract text, merge, and split.",
  "when_to_use: When the user mentions a .pdf or asks to produce one.",
  "---",
  "# PDF guide",
  "SKILL_BODY_MARKER: use pdfplumber to extract text.",
].join("\n");
const PDF_REFERENCE_MD = "REFERENCE_MARKER: detailed extraction recipes.";

function pdfSkill(over: Partial<SkillCatalogInput> = {}): SkillCatalogInput {
  return {
    id: "anthropic/pdf",
    name: "pdf",
    publisher: "anthropic",
    repo: "anthropics/skills",
    branch: "main",
    path: "skills/pdf",
    files: ["SKILL.md", "reference/guide.md"],
    ...over,
  };
}
const pdfFetch = () =>
  makeFetch({ "SKILL.md": PDF_SKILL_MD, "reference/guide.md": PDF_REFERENCE_MD });

describe("skills lifecycle — web install/uninstall + model surfacing tiers", () => {
  afterEach(() => resetProcessFs());

  it("install (web flow) → Tier-1 listing carries name+description+useWhen, NOT the body or resources", async () => {
    const fs = makeMemFs();
    installProcessFs(fs);

    const res = await handleSkillsBridgeRequest(installReq(pdfSkill()), {
      homeDir: HOME,
      fs,
      fetchImpl: pdfFetch(),
    });
    expect(res.ok).toBe(true);
    expect(okResult<{ fileCount: number }>(res).fileCount).toBe(2);

    // The runtime loader picks the installed skill up as a `user` skill.
    const commands = await loadCommands();
    const pdf = commands.find((c) => c.name === "pdf");
    expect(pdf, "installed skill is loaded from ~/.velloc/skills/").toBeTruthy();

    const listing = renderSkillListing(getModelInvocableCommands(commands));
    // Tier 1 present: name + description + useWhen.
    expect(listing).toContain("pdf");
    expect(listing).toContain("Work with PDF files");
    expect(listing).toContain("When to use");
    // Tier 1 must NOT contain the body (Tier 2) or the resource (Tier 3).
    expect(listing).not.toContain("SKILL_BODY_MARKER");
    expect(listing).not.toContain("REFERENCE_MARKER");
  });

  it("Skill tool invoke → Tier-2 loads the full body inline; Tier-3 resource stays on disk, un-loaded", async () => {
    const fs = makeMemFs();
    installProcessFs(fs);
    await handleSkillsBridgeRequest(installReq(pdfSkill()), {
      homeDir: HOME,
      fs,
      fetchImpl: pdfFetch(),
    });
    const commands = await loadCommands();

    const out = await SkillRunTool.call(
      { skill: "pdf", args: "" },
      makeContext(commands),
      ALLOW,
      PARENT_MESSAGE,
    );
    const text = extractInjectedText(out.extraRows ?? []);
    // Tier 2: the full SKILL.md body is now in context, with the base-dir header.
    expect(text).toContain("<command-name>/pdf</command-name>");
    expect(text).toContain("SKILL_BODY_MARKER");
    expect(text).toContain("Base directory for this skill:");
    // Tier 3: the bundled resource is NOT auto-injected on invoke …
    expect(text).not.toContain("REFERENCE_MARKER");
    // … yet it IS on disk for the model to Read/Bash on demand. A single
    // install keeps the natural skill-name dir (`pdf`); it only gets a
    // publisher prefix when a different publisher's same-named skill collides.
    const onDisk = await fs.readFile(
      "/home/user/.velloc/skills/pdf/reference/guide.md",
      { encoding: "utf-8" },
    );
    expect(onDisk).toContain("REFERENCE_MARKER");
  });

  it("gate: disable-model-invocation → absent from the model listing AND refused on invoke", async () => {
    const fs = makeMemFs();
    installProcessFs(fs);
    const md = [
      "---",
      "name: secret-skill",
      "description: internal only",
      "disable-model-invocation: true",
      "---",
      "SECRET_BODY",
    ].join("\n");
    await handleSkillsBridgeRequest(
      installReq({
        id: "anthropic/secret",
        name: "secret-skill",
        publisher: "anthropic",
        repo: "anthropics/skills",
        branch: "main",
        path: "skills/secret",
        files: ["SKILL.md"],
      }),
      { homeDir: HOME, fs, fetchImpl: makeFetch({ "SKILL.md": md }) },
    );

    const commands = await loadCommands();
    expect(commands.find((c) => c.name === "secret-skill")?.hiddenFromModel).toBe(
      true,
    );
    // Excluded from the model-facing listing …
    const listing = renderSkillListing(getModelInvocableCommands(commands));
    expect(listing).not.toContain("secret-skill");
    // … and refused if the model tries to invoke it anyway.
    const verdict = await SkillRunTool.checkInput?.(
      { skill: "secret-skill" },
      makeContext(commands),
    );
    expect(verdict).toMatchObject({ result: false, errorCode: 3 });
  });

  it("gate: user-invocable:false stays model-visible in the listing but is flagged not user-invocable", async () => {
    const fs = makeMemFs();
    installProcessFs(fs);
    const md = [
      "---",
      "name: auto-skill",
      "description: model-only helper",
      "user-invocable: false",
      "---",
      "BODY",
    ].join("\n");
    await handleSkillsBridgeRequest(
      installReq({
        id: "anthropic/auto",
        name: "auto-skill",
        publisher: "anthropic",
        repo: "anthropics/skills",
        branch: "main",
        path: "skills/auto",
        files: ["SKILL.md"],
      }),
      { homeDir: HOME, fs, fetchImpl: makeFetch({ "SKILL.md": md }) },
    );

    const commands = await loadCommands();
    expect(commands.find((c) => c.name === "auto-skill")?.userCallable).toBe(false);
    // Still visible to the model (the gate is user-picker visibility, not model).
    const listing = renderSkillListing(getModelInvocableCommands(commands));
    expect(listing).toContain("auto-skill");
  });

  it("Tier-1 entries are length-capped (truncated, not the full description)", async () => {
    const fs = makeMemFs();
    installProcessFs(fs);
    const longDesc = "X".repeat(400);
    const md = ["---", "name: verbose", `description: ${longDesc}`, "---", "BODY"].join(
      "\n",
    );
    await handleSkillsBridgeRequest(
      installReq({
        id: "anthropic/verbose",
        name: "verbose",
        publisher: "anthropic",
        repo: "anthropics/skills",
        branch: "main",
        path: "skills/verbose",
        files: ["SKILL.md"],
      }),
      { homeDir: HOME, fs, fetchImpl: makeFetch({ "SKILL.md": md }) },
    );
    const commands = await loadCommands();
    const listing = renderSkillListing(getModelInvocableCommands(commands));
    const line = listing.split("\n").find((l) => l.includes("verbose"))!;
    expect(line).toContain("…"); // truncated with an ellipsis
    expect(line).not.toContain(longDesc); // never the full 400-char description
    expect(line.length).toBeLessThan(300); // ≈ "- verbose: " + the 250-char cap
  });

  it("uninstall (web flow) removes the skill from disk AND from the model listing", async () => {
    const fs = makeMemFs();
    installProcessFs(fs);
    await handleSkillsBridgeRequest(installReq(pdfSkill()), {
      homeDir: HOME,
      fs,
      fetchImpl: pdfFetch(),
    });

    // Present after install.
    let commands = await loadCommands();
    expect(commands.some((c) => c.name === "pdf")).toBe(true);

    const un = await handleSkillsBridgeRequest(uninstallReq("anthropic/pdf"), {
      homeDir: HOME,
      fs,
    });
    expect(okResult<{ removed: boolean }>(un).removed).toBe(true);

    // Gone from listInstalled (the web flow's own view) …
    const listed = await handleSkillsBridgeRequest(listReq(), { homeDir: HOME, fs });
    expect(okResult<{ skills: unknown[] }>(listed).skills).toEqual([]);

    // … and gone from the loader + the model listing.
    commands = await loadCommands();
    expect(commands.some((c) => c.name === "pdf")).toBe(false);
    expect(
      renderSkillListing(getModelInvocableCommands(commands)),
    ).not.toContain("Work with PDF files");
  });
});
