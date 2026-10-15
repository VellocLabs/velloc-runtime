import * as React from "react";
import { CheckIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

import { useT } from "../i18n";
import type { ImportableSkillRow } from "../../bridge/protocol/skills";
import type { ImportSource } from "../../bridge/protocol/sessionImport";
import type { NexusSettingsBridge } from "../nexusSettingsBridge";
import { useSkillImport, type SkillRowState } from "./useSkillImport";

/** The Skills tab: the source's on-disk skills (`~/.claude/skills/`), one
 *  Import button per row. Importing copies the skill directory into Velloc's
 *  managed store (`~/.velloc/skills/`); rows already there (per the server's
 *  live check) render the button disabled as "Imported". */
export function ImportSkillsTab({
  bridge,
  source,
  open,
}: {
  bridge: NexusSettingsBridge | null;
  source: ImportSource;
  open: boolean;
}) {
  const t = useT();
  const { list, rowStates, refresh, importRow } = useSkillImport(
    bridge,
    source,
    open,
  );

  if (list.status === "idle" || list.status === "loading") {
    return (
      <p
        className="flex h-full items-center justify-center text-center text-muted-foreground text-sm"
        data-testid="import-skills-loading"
      >
        {t("import.skills.loading")}
      </p>
    );
  }
  if (list.status === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p
          className="text-destructive text-sm"
          data-testid="import-skills-list-error"
        >
          {t("import.skills.listError", { message: list.message })}
        </p>
        <Button variant="outline" size="sm" onClick={refresh}>
          {t("import.retry")}
        </Button>
      </div>
    );
  }

  const { skills, rootPath } = list;

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-between gap-2 text-muted-foreground text-xs">
        <span className="truncate" data-testid="import-skills-source-line">
          {t("import.skills.sourceLine", { count: skills.length, path: rootPath })}
        </span>
        <Button
          variant="ghost"
          size="xs"
          data-testid="import-skills-refresh"
          aria-label={t("import.refresh")}
          onClick={refresh}
        >
          <RefreshCwIcon />
          {t("import.refresh")}
        </Button>
      </div>

      {skills.length === 0 ? (
        <p
          className="flex flex-1 items-center justify-center text-center text-muted-foreground text-sm"
          data-testid="import-skills-empty"
        >
          {t("import.skills.empty", { path: rootPath })}
        </p>
      ) : (
        <ul
          className="min-h-0 flex-1 divide-y overflow-y-auto rounded-md border"
          data-testid="import-skills-list"
        >
          {skills.map((row) => (
            <SkillRow
              key={row.dir}
              row={row}
              state={rowStates[row.dir]}
              onImport={() => void importRow(row.dir)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function SkillRow({
  row,
  state,
  onImport,
}: {
  row: ImportableSkillRow;
  state: SkillRowState | undefined;
  onImport: () => void;
}) {
  const t = useT();
  const imported =
    state?.status === "imported" ||
    (row.alreadyImported && state?.status !== "error");
  const importing = state?.status === "importing";

  return (
    <li
      className="flex items-center gap-3 px-3 py-2"
      data-testid="import-skills-row"
      data-skill-dir={row.dir}
      data-imported={imported ? "true" : "false"}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm" data-testid="import-skills-row-name">
          {row.name}
        </div>
        <div className="truncate text-muted-foreground text-xs">
          {row.description}
        </div>
        <div className="text-muted-foreground text-xs">
          {t("import.skills.fileCount", { count: row.fileCount })}
        </div>
        {state?.status === "error" ? (
          <div
            className="text-destructive text-xs"
            data-testid="import-skills-row-error"
          >
            {t("import.importError", { message: state.message })}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {imported ? (
          <Button
            variant="secondary"
            size="xs"
            disabled
            data-testid="import-skills-row-import"
            title={t("import.skills.alreadyImported")}
          >
            <CheckIcon />
            {t("import.imported")}
          </Button>
        ) : (
          <Button
            variant="outline"
            size="xs"
            data-testid="import-skills-row-import"
            disabled={importing}
            onClick={onImport}
          >
            {importing ? <Loader2Icon className="animate-spin" /> : null}
            {importing
              ? t("import.importing")
              : state?.status === "error"
                ? t("import.retry")
                : t("import.action")}
          </Button>
        )}
      </div>
    </li>
  );
}
