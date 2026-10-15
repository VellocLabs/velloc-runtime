// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { createElement, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";

import { SettingsBridgeContext } from "../browser/webview/nexusSettingsBridge";
import {
  useSkillsCatalog,
  type CatalogSkill,
} from "../browser/webview/settings/sections/SkillsMarketplace";
import { makeMockSettingsBridge } from "./_helpers/mockSettingsBridge";

/**
 * The marketplace install flow through the real `useSkillsCatalog` hook: when an install's request times out but
 * the worker finished, the hook reconciles against `listInstalled` and reports success.
 */

const PDF: CatalogSkill = {
  id: "anthropic/pdf",
  name: "pdf",
  description: "Work with PDF files.",
  publisher: "anthropic",
  publisherLabel: "Anthropic",
  repo: "anthropics/skills",
  branch: "main",
  path: "skills/pdf",
  files: ["SKILL.md"],
};

/** Stub `globalThis.fetch` so the hook's catalog load resolves to `skills`. */
function stubCatalogFetch(skills: CatalogSkill[]): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("skills-catalog.json")) {
      return new Response(JSON.stringify({ skills }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function wrapperFor(bridge: ReturnType<typeof makeMockSettingsBridge>) {
  return ({ children }: { children: ReactNode }) =>
    createElement(SettingsBridgeContext.Provider, { value: bridge }, children);
}

const installedListing = [
  { id: "anthropic/pdf", name: "pdf", dir: "anthropic-pdf" },
];

describe("skills marketplace hook — installed skills the catalog does not know", () => {
  let restoreFetch = () => {};
  afterEach(() => restoreFetch());

  it("shows a manually-placed and an imported skill in Installed (not only catalog ∩ installed)", async () => {
    restoreFetch = stubCatalogFetch([PDF]);
    const bridge = makeMockSettingsBridge({
      "skills.listInstalled": async () => ({
        skills: [
          ...installedListing,
          {
            id: "local/xiaohongshu-skills",
            name: "xiaohongshu-skills",
            dir: "xiaohongshu-skills",
            description: "Automation pack.",
          },
          { id: "imported/claude-code/notes", name: "notes", dir: "notes" },
        ],
      }),
    });

    const { result } = renderHook(() => useSkillsCatalog(), {
      wrapper: wrapperFor(bridge),
    });

    await waitFor(() => expect(result.current.installed).toHaveLength(3));
    // Sorted by name with the catalog rows, one flat list.
    expect(result.current.installed.map((s) => s.id)).toEqual([
      "imported/claude-code/notes",
      "anthropic/pdf",
      "local/xiaohongshu-skills",
    ]);
    const local = result.current.installed[2]!;
    expect(local).toMatchObject({
      name: "xiaohongshu-skills",
      description: "Automation pack.",
      publisherLabel: "Local",
      origin: "local",
    });
    expect(result.current.installed[0]).toMatchObject({
      publisherLabel: "Imported",
      origin: "imported",
      description: "",
    });
    // The catalog row is untouched, and an off-catalog skill is never offered
    // for install.
    expect(result.current.installed[1]!.origin).toBeUndefined();
    expect(result.current.available).toHaveLength(0);
  });

  it("keeps a marketplace install the catalog dropped uninstallable, badged with its publisher", async () => {
    restoreFetch = stubCatalogFetch([PDF]);
    const bridge = makeMockSettingsBridge({
      "skills.listInstalled": async () => ({
        skills: [
          ...installedListing,
          // Sidecar-bearing install whose id the catalog no longer lists.
          {
            id: "anthropic/retired",
            name: "retired",
            dir: "anthropic-retired",
            publisher: "anthropic",
            repo: "anthropics/skills",
          },
          { id: "openai/gone", name: "gone", dir: "openai-gone", publisher: "openai" },
        ],
      }),
    });

    const { result } = renderHook(() => useSkillsCatalog(), {
      wrapper: wrapperFor(bridge),
    });

    await waitFor(() => expect(result.current.installed).toHaveLength(3));
    const byId = new Map(result.current.installed.map((s) => [s.id, s]));
    // Not "Local": the catalog's label for its publisher, and no origin — the
    // row keeps the Uninstall a Velloc-written install always has.
    expect(byId.get("anthropic/retired")).toMatchObject({
      publisher: "anthropic",
      publisherLabel: "Anthropic",
    });
    expect(byId.get("anthropic/retired")!.origin).toBeUndefined();
    // A publisher the catalog does not name is shown as-is.
    expect(byId.get("openai/gone")).toMatchObject({ publisherLabel: "openai" });
    expect(byId.get("openai/gone")!.origin).toBeUndefined();
  });

  it("still shows a local skill when the catalog fails to load", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("", { status: 500 })) as typeof fetch;
    restoreFetch = () => {
      globalThis.fetch = original;
    };
    const bridge = makeMockSettingsBridge({
      "skills.listInstalled": async () => ({
        skills: [
          ...installedListing, // catalog id, catalog unknown → not mislabelled
          { id: "local/mine", name: "mine", dir: "mine" },
        ],
      }),
    });

    const { result } = renderHook(() => useSkillsCatalog(), {
      wrapper: wrapperFor(bridge),
    });

    await waitFor(() => expect(result.current.catalogError).toBe(true));
    await waitFor(() =>
      expect(result.current.installed.map((s) => s.id)).toEqual(["local/mine"]),
    );
  });
});

describe("skills marketplace hook — install (true E2E via the real hook)", () => {
  let restoreFetch = () => {};
  afterEach(() => restoreFetch());

  it("reconciles a timed-out install to SUCCESS when the worker actually landed it", async () => {
    restoreFetch = stubCatalogFetch([PDF]);
    let landed = false;
    const bridge = makeMockSettingsBridge({
      "skills.listInstalled": async () => ({
        skills: landed ? installedListing : [],
      }),
      // The bridge request rejects (transport timeout) — but the worker
      // finished, so a fresh listInstalled now shows the skill.
      "skills.install": async () => {
        landed = true;
        throw new Error("request timed out");
      },
    });

    const { result } = renderHook(() => useSkillsCatalog(), {
      wrapper: wrapperFor(bridge),
    });

    // Catalog loaded → pdf is available, nothing installed yet.
    await waitFor(() =>
      expect(result.current.available.map((s) => s.id)).toContain(
        "anthropic/pdf",
      ),
    );
    expect(result.current.installed).toHaveLength(0);

    await act(async () => {
      await result.current.install(result.current.available[0]!);
    });

    // Despite the rejected request, the hook reconciled → moved to installed.
    await waitFor(() => {
      expect(result.current.installed.map((s) => s.id)).toContain(
        "anthropic/pdf",
      );
    });
    expect(result.current.available.map((s) => s.id)).not.toContain(
      "anthropic/pdf",
    );
    expect(result.current.toast).toBe("Installed pdf");
  });

  it("reports a genuine failure when the worker did NOT install it", async () => {
    restoreFetch = stubCatalogFetch([PDF]);
    const bridge = makeMockSettingsBridge({
      "skills.listInstalled": async () => ({ skills: [] }), // never lands
      "skills.install": async () => {
        throw new Error("HTTP 404");
      },
    });

    const { result } = renderHook(() => useSkillsCatalog(), {
      wrapper: wrapperFor(bridge),
    });
    await waitFor(() => expect(result.current.available).toHaveLength(1));

    await act(async () => {
      await result.current.install(result.current.available[0]!);
    });

    await waitFor(() =>
      expect(result.current.toast).toBe("Install failed: HTTP 404"),
    );
    expect(result.current.installed).toHaveLength(0);
    expect(result.current.available.map((s) => s.id)).toContain("anthropic/pdf");
  });

  it("a normal install moves the skill from Available to Installed", async () => {
    restoreFetch = stubCatalogFetch([PDF]);
    let landed = false;
    const bridge = makeMockSettingsBridge({
      "skills.listInstalled": async () => ({
        skills: landed ? installedListing : [],
      }),
      "skills.install": async () => {
        landed = true;
        return { ok: true, entry: installedListing[0], fileCount: 1 };
      },
    });

    const { result } = renderHook(() => useSkillsCatalog(), {
      wrapper: wrapperFor(bridge),
    });
    await waitFor(() => expect(result.current.available).toHaveLength(1));

    await act(async () => {
      await result.current.install(result.current.available[0]!);
    });

    await waitFor(() =>
      expect(result.current.installed.map((s) => s.id)).toContain(
        "anthropic/pdf",
      ),
    );
    expect(result.current.toast).toBe("Installed pdf");
  });
});
