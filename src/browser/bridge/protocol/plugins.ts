/**
 * Bridge namespace: `plugins` — the marketplace install pipeline surface, owned
 * by the SharedWorker. `listMarketplacePlugins` never fetches; `removeLocal` /
 * `setLocalEnabled` hold the path to `<…>/.velloc/plugins/<name>/` (never a link)
 * and hot-reload. Results carry a stable `ok: true`; `enabled` maps are sparse
 * (absence reads as default-on).
 */

import type { LocalPluginRoot, LocalPluginShadow } from '../../../pluginHost/localPluginList'
import type { PluginUserConfigField } from '../../../pluginHost/pluginModel'
import type {
  CatalogRecord,
  PluginSetupRecord,
  CatalogListing,
} from '../../../pluginHost/registryFormats'

/** One built-in mod in `plugins/listBuiltin` — whether it loads, by the
 *  person's settings.json `enabledPlugins[identifier]` when set, else by its
 *  own default. Switched with `plugins/setEnabled` on `identifier`. */
export type PluginBuiltinUiEntry = {
  name: string
  /** `<name>@builtin` — the `enabledPlugins` key. */
  identifier: string
  version?: string
  description?: string
  enabled: boolean
  /** `explicit`: settings.json names it; `default`: its default applies. */
  enabledSource: 'explicit' | 'default'
  onByDefault: boolean
}

export type PluginInstalledUiEntry = PluginSetupRecord & {
  /** Parsed left half of `<name>@<marketplace>`. */
  name: string
  /** Parsed right half of `<name>@<marketplace>`. */
  marketplace: string
  /** Effective enabled state with default-on semantics applied. */
  enabled: boolean
  /** `'explicit'` when the user has set an override; `'default'`
   *  when no entry exists in settings.json. Renders as
   *  "enabled (default)" vs "enabled (explicit)" in the UI. */
  enabledSource: 'explicit' | 'default'
  /** The plugin manifest's own description, when it has one. */
  description?: string
  /** True when its `hooks/hooks.json` names hooks modules — the plugin is a
   *  mod, whether or not a session has loaded it yet. */
  isMod?: boolean
  /** Enabled local copies of the same name, which load instead of this one
   *  (the user root's in every session, a project's in that project's).
   *  Absent when there are none. */
  shadowedBy?: LocalPluginShadow[]
}

/** One entry in `plugins/listMarketplaces` — the known-marketplaces file
 *  entry plus the name (which is the key in the file) and derived display
 *  flags (`isOfficial`). */
export type PluginMarketplaceUiEntry = CatalogRecord & {
  name: string
  isOfficial: boolean
  /** The product's own marketplace: registered on every profile, never removable. */
  isBuiltin: boolean
}

/** One entry in `plugins/listMarketplacePlugins`'s `plugins[]` — the
 *  marketplace.json's plugin entry plus an `installed` flag the UI uses
 *  to render Install vs Uninstall actions. */
export type PluginAvailableUiEntry = CatalogListing & {
  /** True when this plugin currently appears in the installed registry
   *  (any version). Distinct from `enabled`. */
  installed: boolean
}

export type PluginsBridgeActionMap = {
  listInstalled: {
    payload: Record<string, never>
    result: {
      plugins: PluginInstalledUiEntry[]
    }
  }
  listMarketplaces: {
    payload: Record<string, never>
    result: {
      marketplaces: PluginMarketplaceUiEntry[]
    }
  }
  listMarketplacePlugins: {
    payload: {
      marketplace: string
    }
    result: {
      marketplace: string
      /** Null when no local manifest exists yet (marketplace was added
       *  but never refreshed). UI shows "fetch first" prompt. */
      manifest: {
        name: string
        description?: string
        owner?: { name?: string; email?: string; url?: string }
        plugins: PluginAvailableUiEntry[]
      } | null
    }
  }
  install: {
    payload: {
      /** `<name>@<marketplace>` identifier — same shape the slash
       *  command accepts. */
      identifier: string
      /** When true, refresh the marketplace before installing. Useful
       *  when the user wants to install something they just added.
       *  Default false. */
      refreshFirst?: boolean
    }
    result: {
      ok: true
      /** The new installed-plugins.json entry, with enabled merged in. */
      entry: PluginInstalledUiEntry
      /** Number of files written to the cache slot — surfaced in the
       *  "Installed N files" confirmation. */
      fileCount: number
    }
  }
  uninstall: {
    payload: {
      identifier: string
      /** When true (default), the user's enabled-override in
       *  settings.json is cleared so a future re-install lands in the
       *  default-on state. Set false to PRESERVE a disabled override
       *  across reinstalls (a disable is sticky). */
      clearEnabledOverride?: boolean
    }
    result: {
      ok: true
      /** True when an installed entry was removed; false when the
       *  identifier wasn't installed in the first place (idempotent). */
      registryHadEntry: boolean
    }
  }
  removeLocal: {
    payload: {
      /** The plugin's directory, absolute — a mod row's `root`. */
      path: string
    }
    result: {
      ok: true
      /** The folder name removed (and dropped from enabled-plugins.json). */
      name: string
    }
  }
  listLocal: {
    /** No paths from the client: the host reads its own sidebar projects.
     *  `locale`: the page's language, for each plugin's description from
     *  its `locales/` files; absent, the manifest's own. */
    payload: { locale?: string }
    result: { roots: LocalPluginRoot[] }
  }
  listBuiltin: {
    payload: Record<string, never>
    result: { mods: PluginBuiltinUiEntry[] }
  }
  setLocalEnabled: {
    payload: {
      /** The plugin's directory, absolute — a mod row's `root`. */
      path: string
      enabled: boolean
    }
    result: {
      ok: true
      /** The folder name, as written to enabled-plugins.json. */
      name: string
    }
  }
  setEnabled: {
    payload: {
      identifier: string
      /** `true`/`false` sets the override; `null` clears (reverts to
       *  default-on). Same tri-state semantics as `features/setEnabled`. */
      enabled: boolean | null
    }
    result: {
      ok: true
      /** The plugin's effective state after the patch. */
      effectiveEnabled: boolean
    }
  }
  refreshMarketplace: {
    payload: {
      name: string
    }
    result: {
      ok: true
      /** Number of plugin entries in the refreshed marketplace.json.
       *  UI surfaces this as "Refreshed: N plugins available". */
      pluginCount: number
      /** SHA the fetch came from, when known. */
      sha?: string
      /** Full manifest from the just-refreshed marketplace with `installed` merged
       *  in (same shape as `listMarketplacePlugins.result.manifest`); non-null on
       *  `ok: true`. */
      manifest: {
        name: string
        description?: string
        owner?: { name?: string; email?: string; url?: string }
        plugins: PluginAvailableUiEntry[]
      } | null
    }
  }
  /** The settings a plugin declares `required: true` that hold no value yet
   *  (its `userConfig` and its providers' settings), asked for when it is
   *  turned on. `plugin` is its id (`<name>@<marketplace>`, `<name>@inline`);
   *  `path` is a directory plugin's folder, counted only when its manifest
   *  names the plugin. Values are never returned. */
  requiredSettings: {
    payload: { plugin: string; path?: string; locale?: string }
    result: {
      ok: true
      /** Missing fields by option name, text in `locale`; empty when none. */
      missing: Record<string, PluginUserConfigField>
    }
  }
  /** Store some of a plugin's declared settings over what is stored (the
   *  others kept; a blank value unsets one), then reload every session's
   *  plugins. Names the manifest does not declare are refused. */
  setSettings: {
    payload: {
      plugin: string
      path?: string
      values: Record<string, string | number | boolean | string[]>
    }
    result: {
      ok: true
      /** What is still missing afterwards. */
      missing: Record<string, PluginUserConfigField>
    }
  }
}
