import type { PluginBuiltinUiEntry, PluginInstalledUiEntry } from "../../../../bridge/protocol/plugins";
import type { LocalPluginRoot, LocalPluginUiEntry } from "../../../../../pluginHost/localPluginList";
import { dirnameRuntimePath, normalizeRuntimePath } from "../../../../../utils/runtimePaths";
import { isLocalMod, isUserMod, type ModPluginSummary } from "../../../mods/modsStateView";

/** What the uninstall modal is confirming: an installed plugin, which leaves
 *  the install registry, or a directory plugin, whose folder is deleted. */
export type UninstallTarget =
  | { kind: "installed"; name: string; identifier: string }
  | { kind: "folder"; name: string; path: string };

/**
 * One row of the merged "Installed plugins & mods" list: an installed
 * plugin, with its hooks module's state when it has one, or a mod whose
 * plugin is not in the install registry (a directory plugin or a bundled
 * one), keyed by the plugin name the two share.
 */
export type InstalledRow =
  | { kind: "plugin"; name: string; plugin: PluginInstalledUiEntry; mod?: ModPluginSummary }
  | { kind: "mod"; name: string; mod: ModPluginSummary }
  | { kind: "local"; name: string; entry: LocalPluginUiEntry; mod?: ModPluginSummary }
  | { kind: "builtin"; name: string; entry: PluginBuiltinUiEntry; mod?: ModPluginSummary };

function mergeInstalledRows(
  installed: readonly PluginInstalledUiEntry[],
  mods: readonly ModPluginSummary[],
): InstalledRow[] {
  const claimed = new Set<string>();
  const rows: InstalledRow[] = installed.map((plugin) => {
    const identifier = `${plugin.name}@${plugin.marketplace}`;
    const mod =
      mods.find((m) => m.provenance === identifier) ??
      mods.find((m) => m.plugin === plugin.name && !m.provenance?.endsWith("@builtin"));
    if (mod) claimed.add(mod.plugin);
    return mod
      ? { kind: "plugin", name: plugin.name, plugin, mod }
      : { kind: "plugin", name: plugin.name, plugin };
  });
  const rest = mods.filter((m) => !claimed.has(m.plugin));
  // A person's own mods before the bundled and managed ones.
  for (const mod of [...rest.filter(isUserMod), ...rest.filter((m) => !isUserMod(m))]) {
    rows.push({ kind: "mod", name: mod.plugin, mod });
  }
  return rows;
}

/**
 * The installed list grouped by where a plugin takes effect: Global, one group per
 * project, and the bundled mods. `localRoots` (`plugins/listLocal`) and `builtins`
 * (`plugins/listBuiltin`) are null when not listed; those rows then come from the
 * sessions' state alone.
 */
export type InstalledGroup = {
  key: string;
  kind: "global" | "project" | "builtin";
  project?: string;
  rows: InstalledRow[];
};

const sameFolder = (a: string, b: string) =>
  normalizeRuntimePath(a).toLowerCase() === normalizeRuntimePath(b).toLowerCase();

/** `<base>` of a directory plugin at `<base>/.velloc/plugins/<folder>`. */
const pluginBase = (root: string) =>
  dirnameRuntimePath(dirnameRuntimePath(dirnameRuntimePath(normalizeRuntimePath(root))));

export function groupInstalledRows(
  installed: readonly PluginInstalledUiEntry[],
  localRoots: readonly LocalPluginRoot[] | null,
  mods: readonly ModPluginSummary[],
  builtins: readonly PluginBuiltinUiEntry[] | null = null,
): InstalledGroup[] {
  const claimed = new Set<ModPluginSummary>();
  const builtinRows: InstalledRow[] = (builtins ?? []).map((entry) => {
    const mod = mods.find((m) => m.provenance === entry.identifier);
    if (mod) claimed.add(mod);
    return mod
      ? { kind: "builtin", name: entry.name, entry, mod }
      : { kind: "builtin", name: entry.name, entry };
  });
  const localRow = (entry: LocalPluginUiEntry): InstalledRow => {
    const mod = mods.find((m) => m.root !== undefined && sameFolder(m.root, entry.path));
    if (mod) claimed.add(mod);
    return mod
      ? { kind: "local", name: entry.name, entry, mod }
      : { kind: "local", name: entry.name, entry };
  };
  const userLocal = (localRoots?.find((r) => r.project === undefined)?.plugins ?? []).map(localRow);
  const projects = (localRoots ?? [])
    .filter((r) => r.project !== undefined)
    .map((r) => ({ project: r.project as string, rows: r.plugins.map(localRow) }));
  const merged = mergeInstalledRows(installed, mods.filter((m) => !claimed.has(m)));
  const plugins: InstalledRow[] = [];
  const otherMods: InstalledRow[] = [];
  const builtin: InstalledRow[] = [...builtinRows];
  for (const row of merged) {
    if (row.kind !== "mod") plugins.push(row);
    else if (!isUserMod(row.mod)) builtin.push(row);
    else if (localRoots && isLocalMod(row.mod) && row.mod.root) {
      // A directory mod the listing does not name: a session's project that
      // is not in the sidebar. Its group is named by its folder.
      const base = pluginBase(row.mod.root);
      let group = projects.find((p) => sameFolder(p.project, base));
      if (!group) {
        group = { project: base, rows: [] };
        projects.push(group);
      }
      group.rows.push(row);
    } else otherMods.push(row);
  }
  const global = [...plugins, ...userLocal, ...otherMods];
  return [
    ...(global.length > 0 ? [{ key: "global", kind: "global" as const, rows: global }] : []),
    ...projects
      .filter((p) => p.rows.length > 0)
      .map((p) => ({ key: `project:${p.project}`, kind: "project" as const, project: p.project, rows: p.rows })),
    ...(builtin.length > 0 ? [{ key: "builtin", kind: "builtin" as const, rows: builtin }] : []),
  ];
}
