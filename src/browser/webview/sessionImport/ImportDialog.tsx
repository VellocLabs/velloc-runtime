import * as React from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { useT } from "../i18n";
import type { ImportSource } from "../../bridge/protocol/sessionImport";
import { useSettingsBridge } from "../nexusSettingsBridge";
import { ImportMemoryTab } from "./ImportMemoryTab";
import { ImportSessionsTab } from "./ImportSessionsTab";
import { ImportSkillsTab } from "./ImportSkillsTab";
import { IMPORT_SOURCE_META } from "./sourceMeta";

type ImportTab = "sessions" | "memory" | "plugins" | "skills";

/**
 * The Import dialog, opened from the topbar's per-source button. One dialog
 * for every kind of import — Sessions / Memory / Plugins / Skills tabs — of
 * which Sessions, Memory and Skills are implemented; Plugins is a disabled
 * placeholder so the surface is already the one later work fills in.
 */
export function ImportDialog({
  source,
  open,
  onOpenChange,
  onOpenSession,
}: {
  source: ImportSource | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const t = useT();
  const bridge = useSettingsBridge();
  const [tab, setTab] = React.useState<ImportTab>("sessions");
  const label = source ? IMPORT_SOURCE_META[source].label : "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Fixed height so the dialog does not resize when switching between tabs
          whose content differs in length (Sessions is a paged 50-row list;
          Skills is short). The active tab's list fills the space and scrolls
          internally. */}
      <DialogContent
        className="flex h-[70vh] max-w-2xl flex-col"
        data-testid="import-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t("import.title", { source: label })}</DialogTitle>
          <DialogDescription>{t("import.description")}</DialogDescription>
        </DialogHeader>
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as ImportTab)}
          className="min-h-0 flex-1"
        >
          <TabsList>
            <TabsTrigger value="sessions" data-testid="import-tab-sessions">
              {t("import.tab.sessions")}
            </TabsTrigger>
            <TabsTrigger value="memory" data-testid="import-tab-memory">
              {t("import.tab.memory")}
            </TabsTrigger>
            <TabsTrigger
              value="plugins"
              data-testid="import-tab-plugins"
              disabled
              title={t("import.tab.comingSoon")}
            >
              {t("import.tab.plugins")}
            </TabsTrigger>
            <TabsTrigger value="skills" data-testid="import-tab-skills">
              {t("import.tab.skills")}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="sessions" className="flex min-h-0 flex-col">
            {source ? (
              <ImportSessionsTab
                bridge={bridge}
                source={source}
                open={open}
                onOpenSession={onOpenSession}
              />
            ) : null}
          </TabsContent>
          <TabsContent value="memory" className="flex min-h-0 flex-col">
            {source ? (
              <ImportMemoryTab bridge={bridge} source={source} open={open} />
            ) : null}
          </TabsContent>
          <TabsContent value="skills" className="flex min-h-0 flex-col">
            {source ? (
              <ImportSkillsTab bridge={bridge} source={source} open={open} />
            ) : null}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
