import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * The type-scale utilities `globals.css` declares in `@theme`, registered so
 * tailwind-merge files `text-<x>` as a font size, not a colour. Must list every
 * `@theme` size name.
 */
export const CUSTOM_FONT_SIZE_NAMES = [
  "prose",
  "body",
  "caption",
  "code",
  "composer",
] as const;

const twMerge = extendTailwindMerge({
  extend: { theme: { text: [...CUSTOM_FONT_SIZE_NAMES] } },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
