// @vitest-environment happy-dom
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { I18nProvider, createTranslate, type Locale } from "../browser/webview/i18n";
import { SettingsBridgeContext } from "../browser/webview/nexusSettingsBridge";
import {
  CommandSentence,
  FeaturesSection,
} from "../browser/webview/settings/sections/FeaturesSection";
import { makeMockSettingsBridge } from "./_helpers/mockSettingsBridge";

/**
 * Features page, catalog-unavailable empty state: the sentence is one catalog key with a `{command}` placeholder
 * (G-1), so the paragraph equals that key's interpolation in each locale and the command renders in monospace
 * wherever the translation puts it.
 */

const CATALOG_FILE = "skills-catalog.json";

/** Fail the catalog fetch so the section renders its error empty state. */
function stubFailingCatalogFetch(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("skills-catalog.json")) {
      return new Response("", { status: 404 });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function renderFeatures(locale: Locale) {
  const bridge = makeMockSettingsBridge({
    "features.catalog": async () => ({ features: [] }),
    "features.snapshot": async () => ({ enabled: {}, source: "default" }),
    "skills.listInstalled": async () => ({ skills: [] }),
  });
  return render(
    createElement(
      I18nProvider,
      { locale },
      createElement(
        SettingsBridgeContext.Provider,
        { value: bridge },
        createElement(FeaturesSection),
      ),
    ),
  );
}

describe("Features page — skill catalog unavailable", () => {
  let restoreFetch = () => {};
  afterEach(() => {
    restoreFetch();
    cleanup();
  });

  // Every locale that ships the guest web app. The point is not the wording but
  // that the whole sentence comes from ONE key, so the translation — not the
  // JSX — decides where the command sits.
  for (const locale of ["en", "zh", "es", "fr", "de", "ja", "ko"] as const) {
    it(`${locale}: renders the whole sentence from one catalog key`, async () => {
      restoreFetch = stubFailingCatalogFetch();
      renderFeatures(locale);

      const expected = createTranslate(locale)(
        "settings.features.catalogUnavailable",
        { command: CATALOG_FILE },
      );
      // Sanity: the catalog value is a full sentence with the placeholder, not
      // a fragment the call site has to complete.
      expect(expected).toContain(CATALOG_FILE);

      // A function matcher, not a string one: the sentence is deliberately
      // split across text nodes and the <code>, and `getByText`'s default
      // matcher only sees an element's DIRECT text children.
      const paragraph = await waitFor(() =>
        screen.getByText(
          (_content, element) =>
            element?.tagName === "P" && element.textContent === expected,
        ),
      );
      // …and the command is still monospace, wherever the sentence puts it.
      expect(paragraph.querySelector("code")?.textContent).toBe(CATALOG_FILE);
    });
  }
});

describe("CommandSentence", () => {
  afterEach(cleanup);

  it("puts the command where the sentence puts it, not where English does", () => {
    // A locale whose grammar leads with the command — the case the two-key
    // split could not express at all.
    const { container } = render(
      createElement(CommandSentence, {
        text: `${CATALOG_FILE} を読み込めませんでした。`,
        command: CATALOG_FILE,
      }),
    );

    expect(container.textContent).toBe(
      `${CATALOG_FILE} を読み込めませんでした。`,
    );
    const code = container.querySelector("code");
    expect(code?.textContent).toBe(CATALOG_FILE);
    // Nothing rendered before the command.
    expect(container.firstChild).toBe(code);
  });

  it("renders the sentence unchanged when the command is absent", () => {
    const { container } = render(
      createElement(CommandSentence, {
        text: "Skill catalog unavailable.",
        command: CATALOG_FILE,
      }),
    );

    expect(container.textContent).toBe("Skill catalog unavailable.");
    expect(container.querySelector("code")).toBeNull();
  });
});
