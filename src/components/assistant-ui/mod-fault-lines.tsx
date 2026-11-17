"use client";

/**
 * Dev-folder mods' failures as dim lines (F-25): one per failure, naming
 * the plugin, what failed, and the source line. Drawn above the prompt while
 * they wait for the next request, and in the transcript once handed on.
 * `reason` is the mod's own text, shown as text.
 */
import { AlertTriangleIcon } from "lucide-react";
import type { ModsUiFault } from "@/browser/runtimeProtocol";
import { useT } from "@/browser/webview/i18n";

function faultText(t: ReturnType<typeof useT>, fault: ModsUiFault): string {
  const head =
    fault.kind === "hook"
      ? fault.timeout
        ? t("mods.fault.hookTimeout", { name: fault.plugin, event: fault.event ?? "" })
        : t("mods.fault.hook", { name: fault.plugin, event: fault.event ?? "", reason: fault.reason })
      : fault.kind === "load"
        ? t("mods.fault.load", { name: fault.plugin, reason: fault.reason })
        : t("mods.fault.runtime", { name: fault.plugin, reason: fault.reason });
  if (!fault.file) return head;
  const at = fault.line ? `${fault.file}:${fault.line}` : fault.file;
  return `${head} ${t("mods.fault.at", { at })}`;
}

export function ModFaultLines({
  faults,
  omitted = 0,
  testId,
}: {
  faults: readonly ModsUiFault[];
  omitted?: number;
  testId: string;
}) {
  const t = useT();
  if (faults.length === 0 && omitted === 0) return null;
  return (
    <ul
      aria-label={t("mods.fault.label")}
      data-testid={testId}
      className="mx-auto w-full max-w-(--thread-max-width) space-y-0.5 px-2 text-xs text-muted-foreground"
    >
      {faults.map((fault, index) => (
        <li key={index} data-testid="mod-fault-line" className="flex items-start gap-1.5">
          <AlertTriangleIcon aria-hidden className="mt-px size-3.5 shrink-0 opacity-70" />
          <span className="min-w-0 break-words">{faultText(t, fault)}</span>
        </li>
      ))}
      {omitted > 0 ? <li className="pl-5">{t("mods.fault.more", { count: omitted })}</li> : null}
    </ul>
  );
}
