"use client";

/**
 * The mods' virtual text in the prompt box (F-25): drawn dim after the draft, over the
 * textarea, and never part of what the box holds or sends. A layer copying the
 * textarea's metrics lays the draft out unseen so the text lands where the draft ends.
 */
import { type FC, type RefObject, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

const COPIED: readonly (keyof CSSStyleDeclaration)[] = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "letterSpacing",
  "lineHeight",
  "textTransform",
  "textIndent",
  "wordSpacing",
  "tabSize",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "boxSizing",
];

function layerStyleOf(element: HTMLTextAreaElement): CSSProperties {
  const computed = window.getComputedStyle(element);
  const style: Record<string, string> = {};
  for (const key of COPIED) style[key as string] = String(computed[key] ?? "");
  return {
    ...style,
    position: "absolute",
    top: element.offsetTop,
    left: element.offsetLeft,
    width: element.offsetWidth,
    height: element.offsetHeight,
    borderStyle: "solid",
    borderColor: "transparent",
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
    overflow: "hidden",
    pointerEvents: "none",
  };
}

export const ModPromptVirtualText: FC<{
  input: RefObject<HTMLTextAreaElement | null>;
  /** The virtual text and the draft it follows; null draws nothing. */
  shown: { draft: string; text: string } | null;
}> = ({ input, shown }) => {
  const text = shown?.draft ?? "";
  const virtualText = shown?.text ?? null;
  const layer = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties | null>(null);

  useLayoutEffect(() => {
    const element = input.current;
    if (!element || virtualText === null) {
      setStyle(null);
      return;
    }
    const measure = () => setStyle(layerStyleOf(element));
    measure();
    const follow = () => {
      if (layer.current) layer.current.scrollTop = element.scrollTop;
    };
    element.addEventListener("scroll", follow);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", follow);
      observer?.disconnect();
    };
  }, [input, virtualText, text]);

  useLayoutEffect(() => {
    const element = input.current;
    if (layer.current && element) layer.current.scrollTop = element.scrollTop;
  });

  if (virtualText === null || style === null) return null;
  return (
    <div ref={layer} aria-hidden="true" data-testid="composer-virtual-text" style={style}>
      <span style={{ visibility: "hidden" }}>{text}</span>
      <span className="text-muted-foreground/80">{virtualText}</span>
    </div>
  );
};
