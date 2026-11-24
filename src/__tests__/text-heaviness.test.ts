import { describe, expect, it } from "vitest";
import { HEAVY_TEXT_LIMITS, isHeavyText, measureText } from "../utils/textHeaviness";

describe("measureText", () => {
  it("counts UTF-8 bytes like TextEncoder", () => {
    for (const s of ["", "abc", "é", "文件较大", "😀x", "a\r\nb"]) {
      expect(measureText(s).bytes).toBe(new TextEncoder().encode(s).byteLength);
    }
  });

  it("counts lines with and without a trailing newline", () => {
    expect(measureText("").lines).toBe(0);
    expect(measureText("a").lines).toBe(1);
    expect(measureText("a\n").lines).toBe(1);
    expect(measureText("a\nb").lines).toBe(2);
    expect(measureText("a\r\nb\r\n").lines).toBe(2);
  });

  it("counts table rows by the first non-blank character, fences included", () => {
    const text = "| h |\n  | indented |\n\t|tab|\ntext | not a row\n```\n| in fence |\n```\n\r\n|crlf|\r\n";
    expect(measureText(text).tableRows).toBe(5);
  });
});

describe("isHeavyText", () => {
  const at = { bytes: HEAVY_TEXT_LIMITS.bytes, lines: HEAVY_TEXT_LIMITS.lines, tableRows: HEAVY_TEXT_LIMITS.tableRows };

  it("is light exactly at every limit", () => {
    expect(isHeavyText(at)).toBe(false);
  });

  it("is heavy one past any single limit", () => {
    expect(isHeavyText({ ...at, bytes: at.bytes + 1 })).toBe(true);
    expect(isHeavyText({ ...at, lines: at.lines + 1 })).toBe(true);
    expect(isHeavyText({ ...at, tableRows: at.tableRows + 1 })).toBe(true);
  });

  it("measures a 9 000-row table document as heavy", () => {
    const doc = "# Data\n\n| a | b |\n| --- | --- |\n" + "| x/y | z |\n".repeat(9000);
    expect(isHeavyText(measureText(doc))).toBe(true);
  });
});
