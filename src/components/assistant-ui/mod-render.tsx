/**
 * The mod sites Velloc raises `ui.render` for (F-25): a `Pane`, the `AbovePrompt` band
 * and the transcript rows (`UserMessage`, `AssistantMessage`, `CommandOutput`, `ToolUse`,
 * `ToolResult`, `ToolGroup`), and the mapper from a render tree to React. A site pulls
 * its tree (`mods.render`) on mount, on a props/viewport change and when the runtime
 * marks it stale. Units are character cells; input goes back as `mods.uiInput`. The
 * text is the mod's own, drawn as is.
 */
import { XIcon } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";
import { useT } from "@/browser/webview/i18n";
import { ACTION_WORDS } from "@/mods/modEngineActions";
import { drawsContent } from "@/mods/modRender";
import { FOOTER_BAR_FRAME } from "./footer-bar-frame";
import { ICON_SLOT_PX, ModPluginFrame } from "./mod-ui";
import { TooltipProvider } from "@/components/ui/tooltip";
import { StaticMarkdown } from "./static-markdown";
import {
  isSiteHooked,
  ModToolUseRewriteContext,
  staleKeyOf,
  useModUi,
  type ModUiPaneRow,
  type ModUiEngineRewrite,
  type ModUiPromptHintRewrite,
  type ModUiToolUseRewrite,
  type ModUiRenderResult,
  type ModUiRenderSite,
  type ModUiViewport,
} from "./mod-ui-context";

/** How a tree's `{ type: "engine", ref }` node is drawn: the site's own
 *  drawing, with the props that node's `next` carried. Nothing, where the
 *  site has no engine drawing (a Pane, the band). */
type EngineDraw = (ref: number) => React.ReactNode;
const EngineDrawContext = React.createContext<EngineDraw | null>(null);

type Node = string | Element;
type Element = {
  type: string;
  props?: Record<string, unknown>;
  children?: Node[];
  press?: { plugin: string; handle: number };
  ref?: number;
};

/** `PromptHint`'s one instance (`mods/modRender.ts` `PROMPT_HINT_ID`), as
 *  the band's is `band`. */
export const MOD_PROMPT_HINT_ID = "hint";

/** One drawn cell down: the line height the container draws with. */
const ROW = "1.5em";
function cells(value: unknown): string | undefined {
  if (typeof value === "number") return `${value}ch`;
  if (typeof value === "string") return value;
  return undefined;
}
function rows(value: unknown): string | undefined {
  if (typeof value === "number") return `calc(${value} * ${ROW})`;
  if (typeof value === "string") return value;
  return undefined;
}

/** A Box's spacing steps on this surface's own scale, the same across and down. */
const SPACE_STEPS: Record<string, string> = { xs: "0.25rem", sm: "0.5rem", md: "0.75rem", lg: "1rem", xl: "1.5rem" };
function isSpaceStep(value: unknown): value is string {
  return typeof value === "string" && Object.hasOwn(SPACE_STEPS, value);
}
/** A spacing prop: a step, or a count measured by `measure`. */
function space(value: unknown, measure: (value: unknown) => string | undefined): string | undefined {
  return isSpaceStep(value) ? SPACE_STEPS[value] : measure(value);
}

/** A Text's `size` steps. `body` is the tree container's own size (`text-xs`). */
const TEXT_SIZES: Record<string, string> = {
  caption: "0.625rem",
  footnote: "0.6875rem",
  body: "0.75rem",
  heading: "0.9375rem",
  title: "1.125rem",
};
const TEXT_WEIGHTS: Record<string, number> = { regular: 400, medium: 500, semibold: 600, bold: 700 };

/** The terminal's named colors, as Ink takes them, on Velloc's token layer
 *  (`styles/globals.css`), so a mod's `color="red"` follows the theme; a raw
 *  color the mod wrote (a hex or functional notation) is its own palette,
 *  passed through. */
const MOD_PALETTE_WORDS: Record<string, string> = {
  black: "var(--background)",
  red: "var(--destructive)",
  green: "var(--success)",
  yellow: "var(--warning)",
  blue: "var(--info)",
  magenta: "var(--primary)",
  cyan: "var(--info-emphasis)",
  white: "var(--foreground)",
  gray: "var(--muted-foreground)",
  grey: "var(--muted-foreground)",
  redBright: "var(--destructive)",
  greenBright: "var(--success-emphasis)",
  yellowBright: "var(--warning-emphasis)",
  blueBright: "var(--info-emphasis)",
  magentaBright: "var(--primary)",
  cyanBright: "var(--info-emphasis)",
  whiteBright: "var(--foreground)",
};
/** "Colors are a theme key or a raw color": the plugin API's theme keys
 *  on the same token layer, by what each one means — the
 *  external diff mod draws its todo bar in `success` / `inactive` and its word
 *  marks in `diffAddedWord` / `diffRemovedWord`. A key not listed draws in the
 *  text's own color, as an unknown name does. */
const THEME_COLORS: Record<string, string> = {
  text: "var(--foreground)",
  inverseText: "var(--background)",
  background: "var(--background)",
  inactive: "var(--muted-foreground)",
  subtle: "var(--muted-foreground)",
  promptBorder: "var(--muted-foreground)",
  success: "var(--success)",
  error: "var(--destructive)",
  warning: "var(--warning)",
  diffAdded: "var(--success)",
  diffRemoved: "var(--destructive)",
  diffAddedWord: "var(--success-emphasis)",
  diffRemovedWord: "var(--destructive)",
  claude: "var(--primary)",
  permission: "var(--info)",
  suggestion: "var(--info)",
  remember: "var(--info)",
  ide: "var(--info)",
  professionalBlue: "var(--info)",
  planMode: "var(--info-emphasis)",
  autoAccept: "var(--primary)",
  merged: "var(--primary)",
  fastMode: "var(--warning-emphasis)",
};
function colorOf(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  if (Object.hasOwn(MOD_PALETTE_WORDS, value)) return MOD_PALETTE_WORDS[value];
  if (Object.hasOwn(THEME_COLORS, value)) return THEME_COLORS[value];
  if (/^#[0-9a-fA-F]{3,8}$/.test(value) || /^(rgb|hsl)a?\([^)]*\)$/.test(value)) return value;
  return undefined;
}

function boxStyle(props: Record<string, unknown> = {}, children: readonly Node[] = []): React.CSSProperties {
  const style: React.CSSProperties = {
    display: props.display === "none" ? "none" : "flex",
    flexDirection: (props.flexDirection as React.CSSProperties["flexDirection"]) ?? "row",
    minWidth: 0,
  };
  if (props.position === "absolute") style.position = "absolute";
  for (const side of ["top", "left", "right", "bottom"] as const) {
    const value = props[side];
    if (typeof value === "number") style[side] = side === "top" || side === "bottom" ? rows(value) : cells(value);
  }
  if (typeof props.flexGrow === "number") style.flexGrow = props.flexGrow;
  if (typeof props.flexShrink === "number") style.flexShrink = props.flexShrink;
  if (typeof props.flexWrap === "string") style.flexWrap = props.flexWrap as React.CSSProperties["flexWrap"];
  if (typeof props.alignItems === "string") style.alignItems = props.alignItems as React.CSSProperties["alignItems"];
  if (typeof props.alignSelf === "string") style.alignSelf = props.alignSelf as React.CSSProperties["alignSelf"];
  if (typeof props.justifyContent === "string") style.justifyContent = props.justifyContent as React.CSSProperties["justifyContent"];
  const gap = space(props.gap, cells);
  if (gap) style.gap = gap;
  const columnGap = space(props.columnGap, cells);
  if (columnGap) style.columnGap = columnGap;
  const rowGap = space(props.rowGap, rows);
  if (rowGap) style.rowGap = rowGap;
  // A row of Buttons with no gap of its own is drawn `xs` apart.
  const isRow = style.flexDirection === "row" || style.flexDirection === "row-reverse";
  if (isRow && !gap && !columnGap && children.some((child) => typeof child !== "string" && child.type === "Button")) {
    style.columnGap = SPACE_STEPS.xs;
  }
  const width = cells(props.width);
  if (width) style.width = width;
  const height = rows(props.height);
  if (height) style.height = height;
  const minWidth = cells(props.minWidth);
  if (minWidth) style.minWidth = minWidth;
  const minHeight = rows(props.minHeight);
  if (minHeight) style.minHeight = minHeight;
  const spacing = (name: "margin" | "padding") => {
    const all = props[name];
    const x = props[`${name}X`];
    const y = props[`${name}Y`];
    const top = props[`${name}Top`] ?? y ?? all;
    const bottom = props[`${name}Bottom`] ?? y ?? all;
    const left = props[`${name}Left`] ?? x ?? all;
    const right = props[`${name}Right`] ?? x ?? all;
    const counted = (value: unknown) => typeof value === "number" || isSpaceStep(value);
    if (counted(top)) style[`${name}Top`] = space(top, rows);
    if (counted(bottom)) style[`${name}Bottom`] = space(bottom, rows);
    if (counted(left)) style[`${name}Left`] = space(left, cells);
    if (counted(right)) style[`${name}Right`] = space(right, cells);
  };
  spacing("margin");
  spacing("padding");
  if (typeof props.borderStyle === "string" && props.borderStyle !== "") {
    style.border = `1px ${props.borderStyle === "double" ? "double" : "solid"} ${colorOf(props.borderColor) ?? "currentColor"}`;
    style.borderRadius = props.borderStyle === "round" ? "0.375rem" : undefined;
    if (props.borderDimColor === true) style.opacity = 0.7;
  }
  const background = colorOf(props.backgroundColor);
  if (background) style.backgroundColor = background;
  if (props.overflow === "hidden") style.overflow = "hidden";
  return style;
}

function textStyle(props: Record<string, unknown> = {}): React.CSSProperties {
  const style: React.CSSProperties = { whiteSpace: "pre-wrap", overflowWrap: "anywhere" };
  const color = colorOf(props.color);
  if (color) style.color = color;
  const background = colorOf(props.backgroundColor);
  if (background) style.backgroundColor = background;
  if (props.dimColor === true) style.opacity = 0.6;
  if (typeof props.size === "string" && Object.hasOwn(TEXT_SIZES, props.size)) style.fontSize = TEXT_SIZES[props.size];
  // `bold` is the older spelling of `semibold`; an explicit `weight` outranks it.
  if (typeof props.weight === "string" && Object.hasOwn(TEXT_WEIGHTS, props.weight)) style.fontWeight = TEXT_WEIGHTS[props.weight];
  else if (props.bold === true) style.fontWeight = TEXT_WEIGHTS.semibold;
  if (props.mono === true) style.fontFamily = "var(--font-mono)";
  if (props.tabular === true) style.fontVariantNumeric = "tabular-nums";
  // Right-to-left text reads in that direction and sits flush right.
  if (props.dir === "rtl") {
    style.display = "block";
    style.textAlign = "right";
  }
  if (props.italic === true) style.fontStyle = "italic";
  const decorations = [props.underline === true ? "underline" : "", props.strikethrough === true ? "line-through" : ""]
    .filter(Boolean)
    .join(" ");
  if (decorations) style.textDecoration = decorations;
  if (props.inverse === true) style.filter = "invert(1)";
  if (typeof props.wrap === "string" && props.wrap.startsWith("truncate")) {
    style.whiteSpace = "nowrap";
    style.overflow = "hidden";
    style.textOverflow = "ellipsis";
    style.display = "block";
  }
  return style;
}

type SiteRef = { component: ModUiRenderSite; requestId: string; plugin?: string };

/**
 * A Button's words. A terminal surface answers a Button that carries an
 * engine keybinding `action` and no label of its own through the action's
 * chord alone (the diff mod's base switch: an empty Button on
 * `app:cycleDiffBase`, `ctrl+x b`); Velloc binds no chord, so such a Button
 * is drawn with the action's words (`mods/modEngineActions.ts`), else the
 * action's name, and answers a click — never an invisible control.
 */
function ModButtonLabel({ label, action }: { label: string; action: unknown }) {
  const t = useT();
  if (label !== "" || typeof action !== "string") return <>{label}</>;
  const key = Object.hasOwn(ACTION_WORDS, action) ? ACTION_WORDS[action] : undefined;
  return <>{key ? t(key) : action}</>;
}

function ModNode({ node, site }: { node: Node; site: SiteRef }): React.ReactElement | null {
  if (typeof node === "string") return <span style={{ whiteSpace: "pre-wrap" }}>{node}</span>;
  const { uiInput } = useModUi();
  const props = node.props ?? {};
  const press = node.press;
  const owner = press?.plugin ?? site.plugin ?? "";
  const send = (input: Omit<Parameters<NonNullable<typeof uiInput>>[0], "plugin" | "component" | "requestId" | "handle">) => {
    if (!uiInput || !press) return;
    void uiInput({ ...input, plugin: owner, component: site.component, requestId: site.requestId, handle: press.handle });
  };
  switch (node.type) {
    case "Box":
      return (
        <div
          style={boxStyle(props, node.children)}
          data-mod-key={typeof props.key === "string" ? props.key : undefined}
          data-mod-plugin={typeof props.key === "string" ? owner : undefined}
        >
          {(node.children ?? []).map((child, i) => (
            <ModNode key={i} node={child} site={site} />
          ))}
        </div>
      );
    case "Text":
      return (
        <span style={textStyle(props)} dir={props.dir === "rtl" || props.dir === "ltr" ? props.dir : undefined}>
          {(node.children ?? []).map((child, i) =>
            typeof child === "string" ? <React.Fragment key={i}>{child}</React.Fragment> : <ModNode key={i} node={child} site={site} />,
          )}
        </span>
      );
    case "Button": {
      const key = String(props.key ?? "");
      const plain = props.plain === true;
      // Children that draw nothing leave the label (or the action's words) drawn.
      const children = (node.children ?? []).some(drawsContent) ? (node.children ?? []) : [];
      // Drawn children: the `label`, when given, names the control.
      const named = props.role === "dismiss" || (children.length > 0 && typeof props.label === "string");
      return (
        <button
          type="button"
          data-testid={`mod-button-${key}`}
          data-mod-key={key}
          data-mod-plugin={owner}
          aria-label={named ? String(props.label ?? "") : undefined}
          className={cn(
            "inline-flex items-center rounded-md text-xs leading-5",
            plain
              ? "px-0 hover:underline"
              : props.variant === "primary"
                ? "bg-primary px-2 text-primary-foreground hover:bg-primary/90"
                : "border border-border/70 bg-background px-2 hover:bg-accent",
            props.dimColor === true && "opacity-60 hover:opacity-100",
          )}
          onClick={() => send({ kind: "press", element: key })}
        >
          {plain && typeof props.hotkey === "string" ? <span className="mr-1 text-primary">{props.hotkey}:</span> : null}
          {children.length > 0 ? (
            children.map((child, i) => <ModNode key={i} node={child} site={site} />)
          ) : (
            <ModButtonLabel label={String(props.label ?? "")} action={props.action} />
          )}
        </button>
      );
    }
    case "Input":
      return <ModInput props={props} owner={owner} send={send} />;
    case "Select": {
      const key = String(props.key ?? "");
      const options = Array.isArray(props.options) ? (props.options as Array<{ value: string; label?: string }>) : [];
      return (
        <label className="inline-flex items-center gap-1 text-xs">
          {typeof props.label === "string" ? <span>{props.label}</span> : null}
          <select
            data-testid={`mod-select-${key}`}
            data-mod-key={key}
            data-mod-plugin={owner}
            className="rounded-md border border-border/70 bg-background px-1 py-0.5 text-xs"
            defaultValue={typeof props.value === "string" ? props.value : undefined}
            onChange={(event) => send({ kind: "select", element: key, value: event.currentTarget.value })}
          >
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label ?? option.value}
              </option>
            ))}
          </select>
        </label>
      );
    }
    case "Link": {
      const href = String(props.href ?? "");
      const children = node.children ?? [];
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" className="underline">
          {children.length > 0
            ? children.map((child, i) => <ModNode key={i} node={child} site={site} />)
            : String(props.label ?? href)}
        </a>
      );
    }
    case "Code": {
      const source = String(props.source ?? "");
      const startLine = typeof props.startLine === "number" ? props.startLine : undefined;
      const lines = source.split("\n");
      return (
        <pre
          className={cn("rounded-md bg-muted/60 px-2 py-1 font-mono text-xs", props.wrap === "truncate-end" ? "overflow-hidden" : "whitespace-pre-wrap")}
          data-mod-language={typeof props.language === "string" ? props.language : undefined}
        >
          {startLine === undefined
            ? source
            : lines.map((line, i) => (
                <div key={i} className="flex gap-2">
                  <span className="w-8 shrink-0 select-none text-right opacity-50">{startLine + i}</span>
                  <span>{line}</span>
                </div>
              ))}
        </pre>
      );
    }
    case "Markdown":
      return (
        <div className={cn("text-sm", props.dimColor === true && "opacity-60")}>
          <StaticMarkdown content={String(props.text ?? "")} />
        </div>
      );
    case "Svg": {
      const source = String(props.source ?? "");
      const style: React.CSSProperties = {};
      if (typeof props.width === "number") style.width = props.width;
      if (typeof props.height === "number") style.height = props.height;
      // Drawn as an image: the markup never reaches the page, no script runs.
      return <img alt={String(props.alt ?? "")} style={style} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`} />;
    }
    case "engine":
      return <EngineNode nodeRef={node.ref} />;
    default:
      return null;
  }
}

function EngineNode({ nodeRef }: { nodeRef: number | undefined }) {
  const draw = React.useContext(EngineDrawContext);
  if (!draw || typeof nodeRef !== "number") return null;
  // The engine's drawing in its own type, not the tree's monospace cells.
  return <div className="font-sans text-prose" style={{ lineHeight: "normal" }}>{draw(nodeRef)}</div>;
}

function ModInput({
  props,
  owner,
  send,
}: {
  props: Record<string, unknown>;
  owner: string;
  send: (input: { kind: "input"; element: string; inputKind: "change" | "submit"; value: string }) => void;
}) {
  const key = String(props.key ?? "");
  const drawn = typeof props.value === "string" ? props.value : "";
  const [value, setValue] = React.useState(drawn);
  // "The person's typing replaces it until the hook draws another."
  React.useEffect(() => setValue(drawn), [drawn]);
  const change = (next: string) => {
    setValue(next);
    send({ kind: "input", element: key, inputKind: "change", value: next });
  };
  const field = {
    "data-testid": `mod-input-${key}`,
    "data-mod-key": key,
    "data-mod-plugin": owner,
    className: "rounded-md border border-border/70 bg-background px-1.5 py-0.5 font-mono text-xs",
    placeholder: typeof props.placeholder === "string" ? props.placeholder : undefined,
    value,
    autoFocus: props.autoFocus === true,
  };
  const rows = typeof props.rows === "number" && props.rows >= 1 ? props.rows : undefined;
  return (
    <label className={cn("inline-flex gap-1 text-xs", rows === undefined ? "items-center" : "items-start")}>
      {typeof props.label === "string" ? <span>{props.label}</span> : null}
      {rows === undefined ? (
        <input
          {...field}
          onChange={(event) => change(event.currentTarget.value)}
          onKeyDown={(event) => {
            // The Enter that commits an input method's candidate is not a submit.
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            send({ kind: "input", element: key, inputKind: "submit", value });
          }}
        />
      ) : (
        // Several lines: Enter submits; Shift+Enter, or a backslash before Enter, starts a new line.
        <textarea
          {...field}
          rows={rows}
          className={cn(field.className, "resize-none")}
          onChange={(event) => change(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            const area = event.currentTarget;
            const at = area.selectionStart;
            if (at === area.selectionEnd && at > 0 && value[at - 1] === "\\") {
              change(`${value.slice(0, at - 1)}\n${value.slice(at)}`);
              setTimeout(() => area.setSelectionRange(at, at), 0);
              return;
            }
            send({ kind: "input", element: key, inputKind: "submit", value });
          }}
        />
      )}
      {typeof props.submitLabel === "string" ? <span className="opacity-60">⏎ {props.submitLabel}</span> : null}
    </label>
  );
}

/** A render tree as React: a monospace, cell-metric container. `engine`
 *  draws the site's own drawing where the tree holds an engine node. */
export function ModRenderTree({ tree, site, engine }: { tree: unknown; site: SiteRef; engine?: EngineDraw }) {
  if (!tree || typeof tree !== "object") return null;
  return (
    // Clipped to its own box: a mod's absolute positions and negative offsets
    // never reach past it onto the transcript or the engine's controls.
    <div data-mod-tree="" className="relative overflow-hidden font-mono text-xs leading-6" style={{ lineHeight: ROW }}>
      <EngineDrawContext.Provider value={engine ?? null}>
        <ModNode node={tree as Element} site={site} />
      </EngineDrawContext.Provider>
    </div>
  );
}

/** A box's padding across and down, in px. */
function paddingOf(node: HTMLElement): { across: number; down: number } {
  const style = getComputedStyle(node);
  const px = (value: string) => parseFloat(value) || 0;
  return {
    across: px(style.paddingLeft) + px(style.paddingRight),
    down: px(style.paddingTop) + px(style.paddingBottom),
  };
}

/** The site's width in character cells and height in rows, from the window or the
 *  site's own box (`node`), measured inside the tree box's padding; a default where
 *  nothing measures. */
function useCellViewport(
  ref: React.RefObject<HTMLElement | null>,
  rowsFrom: "window" | "node" = "window",
  cellsRef?: React.RefObject<HTMLElement | null>,
): ModUiViewport {
  const [viewport, setViewport] = React.useState<ModUiViewport>({ columns: 80, rows: 24, isFullscreen: false });
  React.useLayoutEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const box = cellsRef?.current ?? node;
    const measure = () => {
      const probe = document.createElement("div");
      probe.textContent = "0000000000";
      probe.style.position = "absolute";
      probe.style.visibility = "hidden";
      probe.style.whiteSpace = "pre";
      probe.style.width = "max-content";
      probe.style.lineHeight = ROW;
      probe.className = "font-mono text-xs";
      box.appendChild(probe);
      const rect = probe.getBoundingClientRect();
      const ch = rect.width / 10 || 7;
      const lineHeight = rect.height || 18;
      box.removeChild(probe);
      const columns = Math.max(20, Math.floor((box.clientWidth - paddingOf(box).across) / ch));
      const bodyHeight = node.clientHeight - paddingOf(node).down - (box === node ? 0 : paddingOf(box).down);
      const screenRows =
        rowsFrom === "node"
          ? Math.max(1, Math.floor(bodyHeight / lineHeight))
          : Math.max(10, Math.floor((typeof window !== "undefined" ? window.innerHeight : 600) / lineHeight));
      setViewport((prev) =>
        prev.columns === columns && prev.rows === screenRows ? prev : { columns, rows: screenRows, isFullscreen: false },
      );
    };
    measure();
    const observer = new ResizeObserver(() => measure());
    observer.observe(node);
    if (box !== node) observer.observe(box);
    return () => observer.disconnect();
  }, [ref, rowsFrom, cellsRef]);
  return viewport;
}

/**
 * One site's drawing: asked for when hooked, and again when its props, the
 * viewport's width, or the runtime's stale counter for it change. A result
 * that arrives after a newer ask is dropped.
 */
export function useModRender(
  component: ModUiRenderSite,
  requestId: string,
  props: Record<string, unknown>,
  viewport: ModUiViewport,
): ModUiRenderResult | undefined {
  const { hooked, stale, render } = useModUi();
  const isHooked = isSiteHooked(hooked, component, requestId);
  const staleCount = stale.sites[staleKeyOf(component, requestId)] ?? 0;
  const propsDigest = JSON.stringify(props);
  const [result, setResult] = React.useState<ModUiRenderResult | undefined>(undefined);
  const askRef = React.useRef(0);
  React.useEffect(() => {
    if (!isHooked || !render) {
      setResult(undefined);
      return;
    }
    const ask = ++askRef.current;
    void render({ component, requestId, props: JSON.parse(propsDigest) as Record<string, unknown>, viewport: { ...viewport, rows: viewport.rows } }).then(
      (drawn) => {
        if (askRef.current === ask) setResult(drawn);
      },
      () => {
        if (askRef.current === ask) setResult({ kind: "engine" });
      },
    );
    // `viewport.rows`: "a change of height alone re-draws nothing".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHooked, render, component, requestId, propsDigest, viewport.columns, staleCount, stale.all]);
  return result;
}

/** The props of a `UserMessage` row, as the page knows them. */
export type ModUserMessageProps = {
  text: string;
  origin: { kind: "plugin"; name: string; asUser?: true } | { kind: "unclassified" };
  isExpanded: boolean;
};

/** The props of one text block of an assistant reply, as the page knows
 *  them: the part's text, and whether it is the row's first. */
export type ModAssistantMessageProps = {
  text: string;
  isFirstOfReply: boolean;
};

/** The props of a slash command's output row, as the page knows them
 *  `command` without the slash, `args` as typed. */
export type ModCommandOutputProps = {
  command: string;
  args: string;
  text: string;
  isErrored: boolean;
};

/** The props of the composer's hint line, as the page knows them: whether
 *  the prompt holds text, whether a turn runs, and the line as drawn (`""`
 *  where it draws nothing). */
export type ModPromptHintProps = {
  isDraft: boolean;
  isWorking: boolean;
  hint: string;
};

/** The props of a tool call's row, as the page knows them:
 *  `input` and `output` as the transcript stores them — a slimmed preview
 *  for a tool whose payload lives in the detail sidecar. */
export type ModToolUseProps = {
  tool_use_id: string;
  tool: string;
  input: unknown;
  isRunning: boolean;
  isErrored: boolean;
  isInterrupted: boolean;
  output?: unknown;
};

/** A tool-call part's fields, as the card and the plan row receive them. */
export type ModToolUsePart = {
  toolCallId: string;
  toolName: string;
  args: unknown;
  result?: unknown;
  status?: { type: string; reason?: string } | undefined;
  isError?: boolean | undefined;
};

/**
 * A tool-call part as `ToolUse` props: running while it runs or waits on a
 * person (a part with no status yet runs until it has a result), interrupted
 * when cancelled, errored when it failed or ended incomplete for another
 * reason. `output` is absent while it runs.
 */
export function modToolUseProps(part: ModToolUsePart): ModToolUseProps {
  const type = part.status?.type;
  const isRunning =
    type === "running" || type === "requires-action" || (type === undefined && part.result === undefined);
  const isInterrupted = type === "incomplete" && part.status?.reason === "cancelled";
  const isErrored = !isInterrupted && (part.isError === true || type === "incomplete");
  return {
    tool_use_id: part.toolCallId,
    tool: part.toolName,
    input: part.args ?? null,
    isRunning,
    isErrored,
    isInterrupted,
    ...(isRunning ? {} : { output: part.result ?? null }),
  };
}

/** A site whose engine drawing is a transcript row, asked for while some
 *  hook selects it: the row as the engine draws it until the answer comes,
 *  then the answer — the row with its props rewritten, or a hook's tree
 *  with each engine node drawn with its own rewrite. `as: "li"` seats it in
 *  a plan list, the engine's own `<li>` row inside a list of its own. */
function ModEngineSiteBody({
  component,
  requestId,
  props,
  drawEngine,
  slot,
  className,
  as = "div",
}: {
  component: "UserMessage" | "AssistantMessage" | "CommandOutput" | "ToolUse" | "ToolResult" | "ToolGroup" | "PromptHint";
  requestId: string;
  props:
    | ModUserMessageProps
    | ModAssistantMessageProps
    | ModCommandOutputProps
    | ModToolUseProps
    | ModToolResultProps
    | ModToolGroupProps
    | ModPromptHintProps;
  drawEngine: (rewrite?: ModUiEngineRewrite) => React.ReactNode;
  slot: string;
  className: string;
  as?: "div" | "li";
}) {
  const ref = React.useRef<HTMLElement | null>(null);
  const viewport = useCellViewport(ref);
  const drawn = useModRender(component, requestId, props, viewport);
  const engine = (rewrite?: ModUiEngineRewrite) =>
    as === "li" ? <ul className="m-0 list-none p-0">{drawEngine(rewrite)}</ul> : drawEngine(rewrite);
  let body: React.ReactNode;
  if (drawn?.kind === "tree") {
    const rewrites = drawn.rewrites ?? {};
    body = (
      <ModRenderTree
        tree={drawn.tree}
        site={{ component, requestId, plugin: drawn.plugin }}
        engine={(nodeRef) => engine(rewrites[String(nodeRef)])}
      />
    );
  } else {
    // Asked for and not yet answered, or answered `engine`: the row as the
    // engine draws it, its props rewritten when a hook rewrote them.
    body = engine(drawn?.kind === "engine" ? drawn.rewrite : undefined);
  }
  const Tag = as;
  return (
    <Tag
      ref={ref as React.Ref<HTMLDivElement & HTMLLIElement>}
      data-slot={slot}
      data-mod-drawn={drawn?.kind ?? "pending"}
      data-mod-request-id={requestId}
      className={cn(as === "li" && "list-none", className)}
    >
      {body}
    </Tag>
  );
}

/** A `text` rewrite alone: what the `UserMessage`, `AssistantMessage` and
 *  `CommandOutput` rows draw with. */
function textRewriteOf(rewrite: ModUiEngineRewrite | undefined): { text: string } | undefined {
  return rewrite && "text" in rewrite ? rewrite : undefined;
}

/** An `input` / `output` rewrite alone: what a `ToolUse` row draws with. */
function toolUseRewriteOf(rewrite: ModUiEngineRewrite | undefined): ModUiToolUseRewrite | undefined {
  return rewrite && ("input" in rewrite || "output" in rewrite) ? rewrite : undefined;
}

/**
 * A person's row in the transcript, drawn through `ui.render` when some
 * loaded hook selects `UserMessage` — "a rewrite of `text` draws in the row
 * alone: the stored message … stays as it was". Unhooked, it is the
 * engine's drawing and asks for nothing.
 */
export function ModUserMessageSite({
  requestId,
  props,
  drawEngine,
}: {
  requestId: string;
  props: ModUserMessageProps;
  drawEngine: (rewrite?: { text: string }) => React.ReactNode;
}) {
  const { hooked } = useModUi();
  if (!isSiteHooked(hooked, "UserMessage", requestId)) return <>{drawEngine()}</>;
  return (
    <ModEngineSiteBody
      component="UserMessage"
      requestId={requestId}
      props={props}
      drawEngine={(rewrite) => drawEngine(textRewriteOf(rewrite))}
      slot="mod-user-message"
      className="flex min-w-0 max-w-full flex-col items-end"
    />
  );
}

/**
 * One text block of an assistant reply, drawn through `ui.render` when some
 * loaded hook selects `AssistantMessage` — "a rewrite changes the drawing and
 * leaves the stored message alone". `requestId` is `<row id>:<part index>`.
 * Unhooked, it is the engine's drawing and asks for nothing.
 */
export function ModAssistantMessageSite({
  requestId,
  props,
  drawEngine,
}: {
  requestId: string;
  props: ModAssistantMessageProps;
  drawEngine: (rewrite?: { text: string }) => React.ReactNode;
}) {
  const { hooked } = useModUi();
  if (!isSiteHooked(hooked, "AssistantMessage", requestId)) return <>{drawEngine()}</>;
  return (
    <ModEngineSiteBody
      component="AssistantMessage"
      requestId={requestId}
      props={props}
      drawEngine={(rewrite) => drawEngine(textRewriteOf(rewrite))}
      slot="mod-assistant-message"
      className="min-w-0 max-w-full"
    />
  );
}

/**
 * A slash command's output row, drawn through `ui.render` when some loaded
 * hook selects `CommandOutput` — "a rewrite of `text` draws there and the
 * stored row keeps what the model reads; a hook's own tree draws in the
 * row's place, the transcript's width". Unhooked, it is the engine's
 * drawing and asks for nothing.
 */
export function ModCommandOutputSite({
  requestId,
  props,
  drawEngine,
}: {
  requestId: string;
  props: ModCommandOutputProps;
  drawEngine: (rewrite?: { text: string }) => React.ReactNode;
}) {
  const { hooked } = useModUi();
  if (!isSiteHooked(hooked, "CommandOutput", requestId)) return <>{drawEngine()}</>;
  return (
    <ModEngineSiteBody
      component="CommandOutput"
      requestId={requestId}
      props={props}
      drawEngine={(rewrite) => drawEngine(textRewriteOf(rewrite))}
      slot="mod-command-output"
      className="min-w-0 max-w-full space-y-2.5"
    />
  );
}

/** A `hint` / `tail` rewrite alone: what the composer's hint line draws
 *  with. */
function promptHintRewriteOf(rewrite: ModUiEngineRewrite | undefined): ModUiPromptHintRewrite | undefined {
  return rewrite && "hint" in rewrite ? rewrite : undefined;
}

/**
 * The composer's hint line (`PromptHint`) as a mod site, raised with the empty prompt
 * too (`hint: ""`). Never takes the keys: a Button in it answers a click, not a
 * `hotkey`. Unhooked, it is the engine's line and asks for nothing.
 */
export function ModPromptHintSite({
  props,
  drawEngine,
}: {
  props: ModPromptHintProps;
  drawEngine: (rewrite?: ModUiPromptHintRewrite) => React.ReactNode;
}) {
  const { hooked } = useModUi();
  if (!isSiteHooked(hooked, "PromptHint", MOD_PROMPT_HINT_ID)) return <>{drawEngine()}</>;
  return (
    <ModEngineSiteBody
      component="PromptHint"
      requestId={MOD_PROMPT_HINT_ID}
      props={props}
      drawEngine={(rewrite) => drawEngine(promptHintRewriteOf(rewrite))}
      slot="mod-prompt-hint"
      className="flex min-w-0 flex-1 items-center overflow-hidden whitespace-nowrap"
    />
  );
}

/**
 * A tool call's row as the `ToolUse` mod site: a rewritten `input` / `output` changes
 * the drawing only, never the stored call or what the model reads. Bodies read the
 * rewrite again from `ModToolUseRewriteContext`.
 */
export function ModToolUseSite({
  part,
  drawEngine,
  as = "div",
}: {
  part: ModToolUsePart;
  drawEngine: (rewrite?: ModUiToolUseRewrite) => React.ReactNode;
  as?: "div" | "li";
}) {
  const { hooked } = useModUi();
  if (!isSiteHooked(hooked, "ToolUse", part.toolCallId)) return <>{drawEngine()}</>;
  return (
    <ModEngineSiteBody
      component="ToolUse"
      requestId={part.toolCallId}
      props={modToolUseProps(part)}
      drawEngine={(rewrite) => {
        const toolRewrite = toolUseRewriteOf(rewrite);
        return (
          <ModToolUseRewriteContext.Provider value={toolRewrite}>
            {drawEngine(toolRewrite)}
          </ModToolUseRewriteContext.Provider>
        );
      }}
      slot="mod-tool-use"
      className="min-w-0 max-w-full"
      as={as}
    />
  );
}

/** The props of a lone card's result block, as the page knows them
 *  `output` the result the card draws — the loaded payload for a
 *  tool whose payload lives in the detail sidecar, after any `ToolUse`
 *  rewrite. */
export type ModToolResultProps = {
  tool_use_id: string;
  tool: string;
  output: unknown;
  isErrored: boolean;
};

/** Velloc's bound on a result it raises `ToolResult` for, as JSON: a longer
 *  one is drawn by the engine and not raised (F-25). The same
 *  bound as a rewrite's (`modRender.TOOL_USE_REWRITE_MAX_CHARS`). */
export const MOD_TOOL_RESULT_MAX_CHARS = 100_000;

/** Whether a result is raised: one JSON carries within the bound. */
export function isRaisableToolResult(output: unknown): boolean {
  if (output === undefined) return false;
  try {
    const json = JSON.stringify(output);
    return json !== undefined && json.length <= MOD_TOOL_RESULT_MAX_CHARS;
  } catch {
    return false;
  }
}

/** An `output` rewrite alone: what a `ToolResult` block draws with. */
function toolResultRewriteOf(rewrite: ModUiEngineRewrite | undefined): { output: unknown } | undefined {
  return rewrite && "output" in rewrite ? { output: rewrite.output } : undefined;
}

function ModToolResultSiteBody({
  props,
  drawEngine,
}: {
  props: ModToolResultProps;
  drawEngine: (rewrite?: { output: unknown }) => React.ReactNode;
}) {
  const raisable = React.useMemo(() => isRaisableToolResult(props.output), [props.output]);
  if (!raisable) return <>{drawEngine()}</>;
  return (
    <ModEngineSiteBody
      component="ToolResult"
      requestId={props.tool_use_id}
      props={props}
      drawEngine={(rewrite) => drawEngine(toolResultRewriteOf(rewrite))}
      slot="mod-tool-result"
      className="min-w-0 max-w-full"
    />
  );
}

/**
 * The result block under a lone tool card, drawn through `ui.render` when
 * some loaded hook selects `ToolResult`: "the result block drawn under a
 * standalone tool row … the stored result is untouched". A plan row is a
 * group's row and raises none. Unhooked, or with no result yet, or one
 * longer than the bound, it is the engine's block and asks for nothing.
 */
export function ModToolResultSite({
  props,
  drawEngine,
}: {
  props: ModToolResultProps;
  drawEngine: (rewrite?: { output: unknown }) => React.ReactNode;
}) {
  const { hooked } = useModUi();
  if (!isSiteHooked(hooked, "ToolResult", props.tool_use_id)) return <>{drawEngine()}</>;
  return <ModToolResultSiteBody props={props} drawEngine={drawEngine} />;
}

/** The props of a run's plan card, as the page knows them: its
 *  tool calls as `ToolUse` props, in the order the model made them;
 *  `isActive` the card's; `isExpanded` whether its rows are shown. */
export type ModToolGroupProps = {
  calls: ModToolUseProps[];
  isActive: boolean;
  isExpanded: boolean;
};

/** An `isExpanded` rewrite alone: what a `ToolGroup` card draws with. */
function toolGroupRewriteOf(rewrite: ModUiEngineRewrite | undefined): { isExpanded: boolean } | undefined {
  return rewrite && "isExpanded" in rewrite ? { isExpanded: rewrite.isExpanded } : undefined;
}

function ModToolGroupSiteBody({
  requestId,
  calls,
  isActive,
  isExpanded,
  drawEngine,
}: {
  requestId: string;
  calls: readonly ModToolUsePart[];
  isActive: boolean;
  isExpanded: boolean;
  drawEngine: (rewrite?: { isExpanded: boolean }) => React.ReactNode;
}) {
  const props = React.useMemo<ModToolGroupProps>(
    () => ({ calls: calls.map(modToolUseProps), isActive, isExpanded }),
    [calls, isActive, isExpanded],
  );
  return (
    <ModEngineSiteBody
      component="ToolGroup"
      requestId={requestId}
      props={props}
      drawEngine={(rewrite) => drawEngine(toolGroupRewriteOf(rewrite))}
      slot="mod-tool-group"
      className="w-full min-w-0"
    />
  );
}

/**
 * A run of tool calls as the `ToolGroup` mod site; `requestId` is the run's first
 * call's id, and a run with no call yet is not raised. An `isExpanded` rewrite holds
 * the card open or shut over the person's own toggle.
 */
export function ModToolGroupSite({
  requestId,
  calls,
  isActive,
  isExpanded,
  drawEngine,
}: {
  requestId: string | undefined;
  calls: readonly ModToolUsePart[];
  isActive: boolean;
  isExpanded: boolean;
  drawEngine: (rewrite?: { isExpanded: boolean }) => React.ReactNode;
}) {
  const { hooked } = useModUi();
  if (requestId === undefined || calls.length === 0 || !isSiteHooked(hooked, "ToolGroup", requestId)) {
    return <>{drawEngine()}</>;
  }
  return (
    <ModToolGroupSiteBody
      requestId={requestId}
      calls={calls}
      isActive={isActive}
      isExpanded={isExpanded}
      drawEngine={drawEngine}
    />
  );
}

/** "Cells across the band: the terminal's width." The band is as wide as
 *  the composer footer. Two or more plugins' parts draw as sections, one
 *  under the other with a rule between, each with its own plugin's icon at
 *  its right (F-25). */
function ModAbovePromptBody() {
  const { openPluginSettings } = useModUi();
  const ref = React.useRef<HTMLDivElement | null>(null);
  const cellsRef = React.useRef<HTMLDivElement | null>(null);
  const viewport = useCellViewport(ref, "window", cellsRef);
  const maxRows = 8;
  const props = React.useMemo(
    () => ({
      hasSurvey: false,
      isWorking: false,
      maxRows,
      bodyColumns: viewport.columns,
      scroll: { offset: 0, bodyRows: maxRows },
      view: {},
    }),
    [viewport.columns],
  );
  const drawn = useModRender("AbovePrompt", "band", props, viewport);
  const isDrawn = drawn?.kind === "tree";
  // Framed like the status bar above it, but only once a tree is drawn: an
  // empty frame would be a blank bar. The icons are those of every plugin whose
  // hook drew some of the tree (`plugins`), handles or not; an older runtime
  // names only the one whose handles are in it.
  const plugins = isDrawn ? (drawn.plugins ?? (drawn.plugin ? [drawn.plugin] : [])) : [];
  const sections = isDrawn && drawn.sections && drawn.sections.length > 1 ? drawn.sections : undefined;
  // Every section keeps the band's own 4 px edge on both sides, so a plugin
  // sits as far from a dashed rule as from the frame.
  // The cells are measured on a sizer as wide as a drawing's box: inside the
  // frame's padding and the icon strip, or a section's when split.
  const sizerStyle = sections
    ? { marginLeft: 12, marginRight: 12 + (openPluginSettings ? ICON_SLOT_PX : 0) }
    : undefined;
  return (
    <ModPluginFrame
      slot="mod-above-prompt"
      framed={isDrawn}
      hoverGroup={!sections}
      plugins={sections ? [] : plugins}
      frameClassName={sections ? FOOTER_BAR_FRAME : undefined}
      data-plugin-sections={sections ? String(sections.length) : undefined}
    >
      <div ref={ref} data-testid="mod-band" data-mod-component="AbovePrompt" data-mod-site="band" className="max-h-[30vh] overflow-auto">
        <div ref={cellsRef} aria-hidden="true" className="h-0" style={sizerStyle} />
        {sections
          ? sections.map((section, index) => (
              <React.Fragment key={`${index}:${section.plugin}`}>
                {index > 0 ? <div role="separator" data-testid="mod-band-divider" className="mx-3 border-t border-dashed border-border/70" /> : null}
                <ModPluginFrame
                  slot="mod-band-section"
                  frameClassName="px-3 py-1"
                  plugins={[section.plugin]}
                  data-plugin={section.plugin}
                >
                  <ModRenderTree tree={section.tree} site={{ component: "AbovePrompt", requestId: "band", plugin: section.plugin }} />
                </ModPluginFrame>
              </React.Fragment>
            ))
          : isDrawn
            ? <ModRenderTree tree={drawn.tree} site={{ component: "AbovePrompt", requestId: "band", plugin: drawn.plugin }} />
            : null}
      </div>
    </ModPluginFrame>
  );
}

/** The band above the prompt, when some loaded hook draws it. */
export function ModAbovePrompt() {
  const { hooked } = useModUi();
  if (!isSiteHooked(hooked, "AbovePrompt", "band")) return null;
  return <ModAbovePromptBody />;
}

/** A pane's `ui.render` props: "Where the surface seated the pane: `dock`
 *  beside the transcript … or `inline` above the prompt." */
function useModPaneProps(pane: ModUiPaneRow, placement: "dock" | "inline", bodyColumns: number, bodyRows: number) {
  return React.useMemo(
    () => ({
      title: pane.title,
      isFocused: false,
      bodyColumns,
      placement,
      scroll: { offset: 0, bodyRows },
      view: {},
    }),
    [pane.title, placement, bodyColumns, bodyRows],
  );
}

/**
 * A pane docked in the session card stack (`placement: 'dock'`, "beside the
 * transcript"): its card's whole body, sized by the card — the columns and
 * the rows are the card's, `rows` asked at open is ignored ("the dock
 * ignores it"). Mounted only while its card is open, so a closed pane is
 * never asked for.
 */
export function ModDockedPane({ plugin, id }: { plugin: string; id: string }) {
  const { panes } = useModUi();
  const pane = panes.find((row) => row.plugin === plugin && row.id === id);
  if (!pane) return null;
  return <ModDockedPaneBody pane={pane} />;
}

function ModDockedPaneBody({ pane }: { pane: ModUiPaneRow }) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  // Rows down the tab's body; cells across the inset the tree is drawn in,
  // inside the plugin icon's gutter. The scrollbar's room is kept whether it
  // shows or not: a tree drawn past the foot (the diff pane's scroll margin)
  // would otherwise narrow the cells it was drawn for.
  const cellsRef = React.useRef<HTMLDivElement | null>(null);
  const viewport = useCellViewport(ref, "node", cellsRef);
  const props = useModPaneProps(pane, "dock", viewport.columns, viewport.rows);
  const drawn = useModRender("Pane", pane.id, props, viewport);
  return (
    <div
      ref={ref}
      data-testid={`mod-pane-${pane.plugin}-${pane.id}`}
      data-mod-component="Pane"
      data-mod-site={pane.id}
      data-mod-owner={pane.plugin}
      data-mod-placement="dock"
      className="min-h-0 flex-1 overflow-auto [scrollbar-gutter:stable]"
    >
      {/* The plugin icon on the frame is a Tooltip; the body carries its own
          provider so it draws wherever it is mounted. */}
      <TooltipProvider>
        <ModPluginFrame slot="mod-pane-body" frameClassName="" plugins={[pane.plugin]}>
          <div ref={cellsRef} className="px-2 py-1.5">
            {drawn?.kind === "tree" ? <ModRenderTree tree={drawn.tree} site={{ component: "Pane", requestId: pane.id, plugin: drawn.plugin ?? pane.plugin }} /> : null}
          </div>
        </ModPluginFrame>
      </TooltipProvider>
    </div>
  );
}

function ModPaneBody({ pane }: { pane: ModUiPaneRow }) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const viewport = useCellViewport(ref);
  const bodyRows = pane.rows ?? 12;
  const props = useModPaneProps(pane, "inline", viewport.columns, bodyRows);
  const drawn = useModRender("Pane", pane.id, props, viewport);
  // The pane carries its own frame; its body takes the plugin icons the band
  // and the ask cards take, clear of the header's close mark.
  return (
    <ModPluginFrame slot="mod-pane-body" frameClassName="" plugins={[pane.plugin]}>
      <div
        ref={ref}
        data-testid={`mod-pane-${pane.plugin}-${pane.id}`}
        data-mod-component="Pane"
        data-mod-site={pane.id}
        data-mod-owner={pane.plugin}
        className="max-h-[40vh] overflow-auto px-2 py-1.5 [scrollbar-gutter:stable]"
        style={{ maxHeight: `calc(${bodyRows} * ${ROW} + 0.75rem)` }}
      >
        {drawn?.kind === "tree" ? <ModRenderTree tree={drawn.tree} site={{ component: "Pane", requestId: pane.id, plugin: drawn.plugin ?? pane.plugin }} /> : null}
      </div>
    </ModPluginFrame>
  );
}

/** "The framed region a plugin opened … one instance per id, its body the
 *  hook's tree, one shown, the rest tabs." Seated inline above the prompt;
 *  the person's close mark raises `ui.close` with origin `person`. */
export function ModPanes() {
  const t = useT();
  const { panes, closePane, showPane, panesDocked } = useModUi();
  // Docked in the Right Panel instead (`ModDockedPane`).
  if (panesDocked || panes.length === 0) return null;
  const shown = panes.find((pane) => pane.isShown) ?? panes[panes.length - 1]!;
  return (
    <div data-slot="mod-panes" className="w-full rounded-lg border border-border/70 bg-card text-sm shadow-sm">
      <div className="flex items-center gap-1 border-b border-border/60 px-2 py-1" role={panes.length > 1 ? "tablist" : undefined} aria-label={panes.length > 1 ? t("mods.pane.tabs") : undefined}>
        {panes.length > 1 ? (
          panes.map((pane) => (
            <button
              key={`${pane.plugin}\u0000${pane.id}`}
              type="button"
              role="tab"
              aria-selected={pane === shown}
              data-testid={`mod-pane-tab-${pane.plugin}-${pane.id}`}
              className={cn(
                "rounded px-2 py-0.5 text-xs",
                pane === shown ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => void showPane?.(pane.plugin, pane.id)}
            >
              {pane.title}
            </button>
          ))
        ) : (
          <span className="px-1 text-xs text-muted-foreground" data-testid={`mod-pane-title-${shown.plugin}-${shown.id}`}>
            <span className="mr-1.5 font-mono text-[11px] opacity-80">{shown.plugin}</span>
            {shown.title}
          </span>
        )}
        <button
          type="button"
          aria-label={t("mods.pane.close")}
          data-testid={`mod-pane-close-${shown.plugin}-${shown.id}`}
          className="ml-auto rounded p-0.5 text-muted-foreground hover:text-foreground"
          onClick={() => void closePane?.(shown.plugin, shown.id)}
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
      <ModPaneBody key={`${shown.plugin}\u0000${shown.id}`} pane={shown} />
    </div>
  );
}
