import { describe, expect, it } from "vitest";
import {
  historyStillActive,
  stepHistory,
  userMessageTexts,
} from "../components/assistant-ui/composer-history";

const entries = ["first", "second", "third"];

describe("composer history", () => {
  it("ArrowUp on an empty composer opens the newest message as total/total", () => {
    expect(stepHistory(entries, null, "ArrowUp", "")).toEqual({ index: 3, shownText: "third" });
  });

  it("does not open on a non-empty composer, on ArrowDown, or with no history", () => {
    expect(stepHistory(entries, null, "ArrowUp", "x")).toBe("pass");
    expect(stepHistory(entries, null, "ArrowDown", "")).toBe("pass");
    expect(stepHistory([], null, "ArrowUp", "")).toBe("pass");
  });

  it("ArrowUp steps older and ArrowDown newer, clamped at both ends", () => {
    let s = stepHistory(entries, { index: 3, shownText: "third" }, "ArrowUp", "third");
    expect(s).toEqual({ index: 2, shownText: "second" });
    s = stepHistory(entries, { index: 1, shownText: "first" }, "ArrowUp", "first");
    expect(s).toEqual({ index: 1, shownText: "first" });
    s = stepHistory(entries, { index: 3, shownText: "third" }, "ArrowDown", "third");
    expect(s).toEqual({ index: 3, shownText: "third" });
  });

  it("any edit of the shown text ends browsing", () => {
    const s = { index: 2, shownText: "second" };
    expect(historyStillActive(s, "second")).toBe(true);
    expect(historyStillActive(s, "second!")).toBe(false);
    expect(historyStillActive(s, "")).toBe(false);
  });

  it("collects user text messages only, oldest first", () => {
    const texts = userMessageTexts([
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
      { role: "user", content: [{ type: "image" }] },
      { role: "user", content: [{ type: "text", text: "b" }, { type: "text", text: "c" }] },
    ]);
    expect(texts).toEqual(["a", "b\nc"]);
  });
});
