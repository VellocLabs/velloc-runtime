/**
 * A mod's `Svg` node as the page shows it (F-25): the image URL of its
 * source, and a still copy of a drawing that moves. Pure but for two small
 * caches, so one drawing shown by several conversations is encoded once.
 * Security: the source only ever becomes an image URL; a still copy is parsed
 * into a detached document that is never attached to the page.
 */
import * as React from "react";

/** How many drawings each cache keeps; the oldest is dropped first. */
export const SVG_IMAGE_CACHE_SIZE = 8;

const SVG_NS = "http://www.w3.org/2000/svg";

/** The elements that move an SVG drawing by themselves. */
const MOTION_ELEMENTS = "animate, animateTransform, animateMotion, set";

/** What stops the drawing's own style sheet from moving it. */
const STILL_STYLE = "*{animation:none!important;transition:none!important}";

function remembered(cache: Map<string, string>, key: string, make: (key: string) => string): string {
  const held = cache.get(key);
  if (held !== undefined) {
    // Read again: the newest entry is the last one dropped.
    cache.delete(key);
    cache.set(key, held);
    return held;
  }
  const made = make(key);
  cache.set(key, made);
  if (cache.size > SVG_IMAGE_CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  return made;
}

const urls = new Map<string, string>();
const stills = new Map<string, string>();

/** The image URL of an SVG source. */
export function svgImageUrl(source: string): string {
  return remembered(urls, source, (svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
}

function stillOf(source: string): string {
  if (typeof DOMParser === "undefined" || typeof XMLSerializer === "undefined") return source;
  let parsed: Document;
  try {
    parsed = new DOMParser().parseFromString(source, "image/svg+xml");
  } catch {
    return source;
  }
  const root = parsed.documentElement;
  if (!root || root.localName !== "svg" || parsed.getElementsByTagName("parsererror").length > 0) return source;
  for (const node of Array.from(root.querySelectorAll(MOTION_ELEMENTS))) node.remove();
  const style = parsed.createElementNS(SVG_NS, "style");
  style.textContent = STILL_STYLE;
  root.appendChild(style);
  return new XMLSerializer().serializeToString(root);
}

/** `source` as a drawing that never moves: each element at its own base
 *  value, with no animation element and no style-sheet animation. A source
 *  that does not parse is returned as it is. */
export function stillSvgOf(source: string): string {
  return remembered(stills, source, stillOf);
}

/** True where the `Svg` nodes beneath are shown as still copies. */
export const ModSvgStillContext = React.createContext(false);
