import * as React from "react";
import { RUNTIME_DIR_NAME } from "../../../../../branding/runtimeDir";
import { basenameRuntimePath } from "../../../../../utils/runtimePaths";
import type { TranslateFn } from "../../../i18n";
import { SettingsGroupLabel } from "../../SettingsSubpageLayout";
import type { InstalledGroup } from "./installedRows";

/** One group's heading — its name, where its plugins live, and whom they
 *  reach — above its cards. */
export function InstalledGroupBlock({
  group,
  t,
  children,
}: {
  group: InstalledGroup;
  t: TranslateFn;
  children: React.ReactNode;
}) {
  const title =
    group.kind === "global"
      ? t("settings.plugins.scope.global")
      : group.kind === "builtin"
        ? t("settings.plugins.mods.builtin")
        : basenameRuntimePath(group.project ?? "") || group.project;
  const path =
    group.kind === "global"
      ? `~/${RUNTIME_DIR_NAME}/plugins`
      : group.kind === "project"
        ? group.project
        : undefined;
  // The built-in group's name already says where its plugins come from.
  const hint =
    group.kind === "global"
      ? t("settings.plugins.scope.globalHint")
      : group.kind === "project"
        ? t("settings.plugins.scope.projectHint")
        : undefined;
  return (
    <div
      data-testid={`plugins-group-${group.kind}`}
      {...(group.project ? { "data-project": group.project } : {})}
      className="flex flex-col gap-3 [&:not(:first-child)]:mt-3"
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <SettingsGroupLabel className="mt-0 mb-0 shrink-0">{title}</SettingsGroupLabel>
          {path ? (
            <span title={path} className="truncate font-mono text-muted-foreground text-xs">
              {path}
            </span>
          ) : null}
        </div>
        {hint ? <span className="shrink-0 text-muted-foreground text-xs">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}
