import { describe, expect, it } from "vitest";
import {
  caretOnEdgeLine,
  historyStillActive,
  stepHistory,
  userMessageTexts,
} from "../components/assistant-ui/composer-history";

const entries = ["first", "second", "third"];
const at = (index: number) => ({ entries, index, shownText: entries[index - 1] });

describe("composer history", () => {
  it("ArrowUp on an empty composer opens the newest message as total/total", () => {
    expect(stepHistory(entries, null, "ArrowUp", "")).toEqual(at(3));
  });

  it("does not open on a non-empty composer, on ArrowDown, or with no history", () => {
    expect(stepHistory(entries, null, "ArrowUp", "x")).toBe("pass");
    expect(stepHistory(entries, null, "ArrowDown", "")).toBe("pass");
    expect(stepHistory([], null, "ArrowUp", "")).toBe("pass");
  });

  it("ArrowUp steps older and ArrowDown newer; at either end the key passes through", () => {
    expect(stepHistory(entries, at(3), "ArrowUp", "third")).toEqual(at(2));
    expect(stepHistory(entries, at(2), "ArrowDown", "second")).toEqual(at(3));
    expect(stepHistory(entries, at(1), "ArrowUp", "first")).toBe("pass");
    expect(stepHistory(entries, at(3), "ArrowDown", "third")).toBe("pass");
  });

  it("steps through the entries captured on opening, whatever the live list now holds", () => {
    const opened = stepHistory(entries, null, "ArrowUp", "");
    if (opened === "pass" || opened === null) throw new Error("expected to open");
    expect(stepHistory(["only"], opened, "ArrowUp", "third")).toEqual(at(2));
  });

  it("inside a multi-line entry the arrows move the caret until it reaches the edge line", () => {
    const multi = ["older", "line one\nline two"];
    const shown = { entries: multi, index: 2, shownText: multi[1] };
    const end = multi[1].length;
    expect(stepHistory(multi, shown, "ArrowUp", multi[1], { start: end, end })).toBe("pass");
    expect(stepHistory(multi, shown, "ArrowUp", multi[1], { start: 3, end: 3 })).toEqual({
      entries: multi,
      index: 1,
      shownText: "older",
    });
    expect(caretOnEdgeLine("a\nb", { start: 0, end: 0 }, "ArrowDown")).toBe(false);
    expect(caretOnEdgeLine("a\nb", { start: 3, end: 3 }, "ArrowDown")).toBe(true);
  });

  it("any edit of the shown text ends browsing", () => {
    const s = at(2);
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
