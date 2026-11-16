/**
 * The session's mod theme on the page (F-25 `$.theme.set`): the palette as
 * Velloc's CSS tokens on the thread, a scene or a still ground behind the
 * conversation, and the app's own look kept where it must stand (permission
 * prompts). Display only: presses pass through the backdrop.
 */
import * as React from "react";
import type { ModsUiTheme } from "@/browser/runtimeProtocol";
import { BACKDROP_REQUEST_ID } from "@/mods/modTheme";
import { useModUi } from "./mod-ui-context";
import { ModRenderTree, useCellViewport, useModRender } from "./mod-render";
import {
  THEME_TOKENS,
  glassTokensOf,
  groundStyleOf,
  groundVectorOf,
  paletteTokensOf,
  sceneGlassOf,
  type GroundVector,
  type ThemeMode,
} from "./mod-theme-paint";

function subscribeRoot(listener: () => void): () => void {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") return () => {};
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-host-theme"] });
  return () => observer.disconnect();
}

function pageModeNow(): ThemeMode {
  return typeof document !== "undefined" && document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/** The page's own light/dark mode, live. */
export function usePageMode(): ThemeMode {
  return React.useSyncExternalStore(subscribeRoot, pageModeNow, () => "light");
}

let ownTokensKey = "";
let ownTokens: Record<string, string> = {};

function ownTokensNow(): Record<string, string> {
  if (typeof document === "undefined" || typeof getComputedStyle === "undefined") return ownTokens;
  const style = getComputedStyle(document.documentElement);
  const next: Record<string, string> = {};
  for (const token of THEME_TOKENS) {
    const value = style.getPropertyValue(token).trim();
    if (value) next[token] = value;
  }
  const key = JSON.stringify(next);
  if (key !== ownTokensKey) {
    ownTokensKey = key;
    ownTokens = next;
  }
  return ownTokens;
}

/** The app's own token values, as the page root holds them, live. */
function useOwnTokens(enabled: boolean): Record<string, string> {
  const subscribe = React.useCallback((listener: () => void) => (enabled ? subscribeRoot(listener) : () => {}), [enabled]);
  const tokens = React.useSyncExternalStore(subscribe, ownTokensNow, () => ownTokens);
  return enabled ? tokens : EMPTY_TOKENS;
}

const EMPTY_TOKENS: Record<string, string> = {};

/** What the thread root carries for the standing theme. */
export type ModThemeLook = {
  theme: ModsUiTheme | undefined;
  /** CSS custom properties for the thread root. */
  style: Record<string, string>;
  /** Data attributes for the thread root. */
  attributes: Record<string, string>;
};

/** The standing theme as the thread root paints it. */
export function useModThemeLook(): ModThemeLook {
  const { theme } = useModUi();
  const mode = usePageMode();
  const glass = theme ? sceneGlassOf(theme.backdrop) : undefined;
  const own = useOwnTokens(glass !== undefined);
  return React.useMemo(() => {
    if (!theme) return { theme, style: {}, attributes: {} };
    const palette = theme.colors ? paletteTokensOf(theme.colors, mode) : ({ kind: "none" } as const);
    const painted = palette.kind === "painted" ? palette.tokens : {};
    const style: Record<string, string> = { ...painted };
    const attributes: Record<string, string> = {
      "data-mod-theme": theme.plugin,
      "data-mod-theme-palette": palette.kind,
    };
    if (theme.backdrop) style.isolation = "isolate";
    if (glass) {
      Object.assign(style, glassTokensOf(glass, painted, own));
      style["--mod-glass-blur"] = `${glass.blur}px`;
      attributes["data-mod-glass"] = "";
    }
    return { theme, style, attributes };
  }, [theme, mode, glass?.blur, glass?.tint, glass?.opacity, own]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Keeps the app's own look for what it wraps (permission prompts), under
 *  any theme. */
export function ModAppLook({ children }: { children: React.ReactNode }) {
  const { theme } = useModUi();
  const own = useOwnTokens(theme !== undefined);
  if (!theme) return <>{children}</>;
  return (
    <div data-slot="mod-app-look" className="contents" style={own as React.CSSProperties}>
      {children}
    </div>
  );
}

function VectorGround({ vector }: { vector: GroundVector }) {
  const patternId = React.useId();
  const paths = vector.paths.map((path, index) =>
    path.strokeWidth !== undefined ? (
      <path key={index} d={path.d} style={{ fill: "none", stroke: path.color, strokeWidth: path.strokeWidth }} vectorEffect="non-scaling-stroke" />
    ) : (
      <path key={index} d={path.d} fillRule="evenodd" style={{ fill: path.color }} />
    ),
  );
  if (vector.repeat) {
    const [width, height] = vector.size ?? [vector.width, vector.height];
    return (
      <svg width="100%" height="100%" aria-hidden="true">
        <defs>
          <pattern id={patternId} width={width} height={height} patternUnits="userSpaceOnUse">
            <svg width={width} height={height} viewBox={`0 0 ${vector.width} ${vector.height}`} preserveAspectRatio="none">
              {paths}
            </svg>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill={`url(#${patternId})`} />
      </svg>
    );
  }
  return (
    <svg width="100%" height="100%" viewBox={`0 0 ${vector.width} ${vector.height}`} preserveAspectRatio="none" aria-hidden="true">
      {paths}
    </svg>
  );
}

function SceneBackdrop({ theme }: { theme: ModsUiTheme }) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const viewport = useCellViewport(ref, "node");
  const backdrop = theme.backdrop ?? {};
  const props = React.useMemo(
    () => ({
      scene: String(backdrop.scene),
      plugin: theme.plugin,
      glass: backdrop.glass === false ? false : (sceneGlassOf(backdrop) ?? false),
      ...(theme.overrideColorScheme ? { overrideColorScheme: theme.overrideColorScheme } : {}),
    }),
    [backdrop, theme.plugin, theme.overrideColorScheme],
  );
  const drawn = useModRender("Backdrop", BACKDROP_REQUEST_ID, props, viewport);
  return (
    <div
      ref={ref}
      data-slot="mod-backdrop"
      data-testid="mod-backdrop"
      data-mod-backdrop-kind="scene"
      data-mod-drawn={drawn?.kind ?? "pending"}
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden [&_[data-mod-tree]]:h-full [&_[data-mod-tree]]:w-full [&_img]:h-full [&_img]:w-full [&_img]:object-cover"
      aria-hidden="true"
    >
      {drawn?.kind === "tree" ? (
        <ModRenderTree tree={drawn.tree} site={{ component: "Backdrop", requestId: BACKDROP_REQUEST_ID, plugin: drawn.plugin ?? theme.plugin }} />
      ) : null}
    </div>
  );
}

/** What stands behind the conversation: the theme's scene, drawn by the
 *  `ui.render` hooks on `Backdrop`, or its still ground. An image ground is
 *  not drawn: the app keeps its own. */
export function ModBackdrop() {
  const { theme } = useModUi();
  const backdrop = theme?.backdrop;
  if (!theme || !backdrop) return null;
  if (typeof backdrop.scene === "string") return <SceneBackdrop theme={theme} />;
  const style = groundStyleOf(backdrop);
  const vector = style ? undefined : groundVectorOf(backdrop);
  if (!style && !vector) return null;
  return (
    <div
      data-slot="mod-backdrop"
      data-testid="mod-backdrop"
      data-mod-backdrop-kind={vector ? "vector" : backdrop.color !== undefined ? "color" : "gradient"}
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
      style={style}
      aria-hidden="true"
    >
      {vector ? <VectorGround vector={vector} /> : null}
    </div>
  );
}
