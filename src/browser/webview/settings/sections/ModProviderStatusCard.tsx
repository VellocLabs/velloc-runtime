/**
 * A provider mod's status view on its settings page (F-27): the rows the
 * runtime published for it, drawn from a fixed set of element kinds.
 *
 * Security: every value is drawn as a text node or a number formatted here.
 * Nothing a plugin wrote is parsed as markup, used as a class name, a link or
 * an attribute other than `title` text.
 */
import * as React from "react";
import { Loader2Icon, RefreshCwIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { resolveLocalizedText } from "../../../../config/localizedText";
import type {
  ProviderStatusCell,
  ProviderStatusEntry,
  ProviderStatusRow,
  ProviderStatusTone,
} from "../../../../mods/provider/providerStatusState";
import { useLocale, useT } from "../../i18n";
import type { MessageKey } from "../../i18n/messages/en";
import {
  getProviderStatusStore,
  useProviderStatus,
  type ProviderStatusJobAnswer,
} from "../../providerStatusStore";

const TONE_VARIANT: Record<ProviderStatusTone, "muted" | "success" | "warning" | "destructive"> = {
  neutral: "muted",
  ok: "success",
  warn: "warning",
  error: "destructive",
};

const ANSWER_KEY: Record<ProviderStatusJobAnswer, MessageKey> = {
  started: "settings.models.mod.status.actionStarted",
  unavailable: "settings.models.mod.status.actionUnavailable",
  busy: "settings.models.mod.status.actionBusy",
  cooldown: "settings.models.mod.status.actionCooldown",
  failed: "settings.models.mod.status.actionFailed",
};

function unit(locale: string, value: number, name: string, digits = 0): string {
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: name,
    unitDisplay: "narrow",
    maximumFractionDigits: digits,
  }).format(value);
}

/** A length of time in the two largest units that say something. */
export function formatStatusDuration(ms: number, locale: string): string {
  if (ms < 1000) return unit(locale, ms, "millisecond");
  const seconds = ms < 9_950 ? ms / 1000 : Math.round(ms / 1000);
  if (seconds < 60) return unit(locale, seconds, "second", seconds < 10 ? 1 : 0);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = Math.floor(seconds - minutes * 60);
    return rest > 0 ? `${unit(locale, minutes, "minute")} ${unit(locale, rest, "second")}` : unit(locale, minutes, "minute");
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    const rest = minutes - hours * 60;
    return rest > 0 ? `${unit(locale, hours, "hour")} ${unit(locale, rest, "minute")}` : unit(locale, hours, "hour");
  }
  const days = Math.floor(hours / 24);
  const rest = hours - days * 24;
  return rest > 0 ? `${unit(locale, days, "day")} ${unit(locale, rest, "hour")}` : unit(locale, days, "day");
}

export function formatStatusTime(at: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(at));
}

function Cell({ cell, locale }: { cell: ProviderStatusCell; locale: string }) {
  switch (cell.format) {
    case "text":
      return <span className="break-words whitespace-pre-wrap">{cell.text}</span>;
    case "count":
      return <span className="tabular-nums">{new Intl.NumberFormat(locale).format(cell.value)}</span>;
    case "time":
      return (
        <time className="tabular-nums" dateTime={new Date(cell.at).toISOString()}>
          {formatStatusTime(cell.at, locale)}
        </time>
      );
    case "duration":
      return <span className="tabular-nums">{formatStatusDuration(cell.ms, locale)}</span>;
    case "percent":
      return (
        <span className="tabular-nums">
          {new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(cell.value / 100)}
        </span>
      );
    case "badge":
      return (
        <Badge variant={TONE_VARIANT[cell.tone] ?? "muted"} size="sm" data-tone={cell.tone}>
          {cell.text}
        </Badge>
      );
    default:
      return null;
  }
}

function ListRow({
  row,
  locale,
  t,
}: {
  row: Extract<ProviderStatusRow, { kind: "list" }>;
  locale: string;
  t: ReturnType<typeof useT>;
}) {
  const headed = row.columns.some((column) => column.label !== undefined);
  return (
    <div className="flex flex-col gap-1" data-testid="mod-status-row" data-key={row.key} data-kind="list">
      <span className="font-medium text-xs">{resolveLocalizedText(row.label, locale)}</span>
      {row.items.length === 0 ? (
        <span className="text-muted-foreground text-xs" data-testid="mod-status-list-empty">
          {t("settings.models.mod.status.listEmpty")}
        </span>
      ) : (
        <div className="max-h-56 overflow-auto rounded-md border border-border/60">
          <table className="w-full text-left text-xs" data-testid="mod-status-list">
            {headed ? (
              <thead className="text-muted-foreground">
                <tr>
                  {row.columns.map((column) => (
                    <th key={column.key} scope="col" className="px-2 py-1 font-medium">
                      {resolveLocalizedText(column.label, locale)}
                    </th>
                  ))}
                </tr>
              </thead>
            ) : null}
            <tbody>
              {row.items.map((cells, index) => (
                <tr key={index} className="border-border/40 border-t first:border-t-0" data-testid="mod-status-list-item">
                  {row.columns.map((column, at) => {
                    const cell = cells[at];
                    return (
                      <td key={column.key} className="px-2 py-1 align-top">
                        {cell ? <Cell cell={cell} locale={locale} /> : null}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {row.total > row.items.length && row.items.length > 0 ? (
        <span className="text-muted-foreground text-xs" data-testid="mod-status-list-more">
          {t("settings.models.mod.status.listMore", { shown: row.items.length, total: row.total })}
        </span>
      ) : null}
    </div>
  );
}

function Rows({ entry, locale, t }: { entry: ProviderStatusEntry; locale: string; t: ReturnType<typeof useT> }) {
  const values = entry.rows.filter((row) => row.kind === "value");
  const lists = entry.rows.filter((row): row is Extract<ProviderStatusRow, { kind: "list" }> => row.kind === "list");
  return (
    <>
      {values.length > 0 ? (
        <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
          {values.map((row) =>
            row.kind === "value" ? (
              <React.Fragment key={row.key}>
                <dt className="text-muted-foreground">{resolveLocalizedText(row.label, locale)}</dt>
                <dd data-testid="mod-status-row" data-key={row.key} data-kind="value">
                  {row.cell ? (
                    <Cell cell={row.cell} locale={locale} />
                  ) : (
                    <span className="text-muted-foreground" data-testid="mod-status-no-value">
                      {t("settings.models.mod.status.noValue")}
                    </span>
                  )}
                </dd>
              </React.Fragment>
            ) : null,
          )}
        </dl>
      ) : null}
      {lists.map((row) => (
        <ListRow key={row.key} row={row} locale={locale} t={t} />
      ))}
    </>
  );
}

/** The card; nothing at all for a provider that declares no status view. */
export function ModProviderStatusCard({ providerId }: { providerId: string }) {
  const t = useT();
  const locale = useLocale();
  const entry = useProviderStatus(providerId);
  const store = getProviderStatusStore();
  const [runningJob, setRunningJob] = React.useState<string | null>(null);
  const [answer, setAnswer] = React.useState<{ job: string; answer: ProviderStatusJobAnswer } | null>(null);
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const shownProvider = React.useRef(providerId);
  shownProvider.current = providerId;
  React.useEffect(() => {
    setAnswer(null);
    setRunningJob(null);
  }, [providerId]);

  if (!entry) return null;

  const run = async (job: string) => {
    setRunningJob(job);
    setAnswer(null);
    const result = await store.runJob(providerId, job);
    // The card may show another provider by now.
    if (!alive.current || shownProvider.current !== providerId) return;
    setRunningJob(null);
    setAnswer({ job, answer: result });
  };

  const actions = store.can("runJob") ? entry.actions : [];
  return (
    <section
      className="flex flex-col gap-3 rounded-lg border border-border/60 p-3"
      aria-label={t("settings.models.mod.status.title")}
      data-testid="mod-status-card"
      data-provider={providerId}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-sm">{t("settings.models.mod.status.title")}</span>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-xs" data-testid="mod-status-updated">
            {t("settings.models.mod.status.updated", { time: formatStatusTime(entry.readAt, locale) })}
          </span>
          {store.can("refresh") ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("settings.models.mod.status.refresh")}
              title={t("settings.models.mod.status.refresh")}
              data-testid="mod-status-refresh"
              onClick={() => store.refresh(providerId)}
            >
              <RefreshCwIcon className="size-3.5" />
            </Button>
          ) : null}
        </div>
      </div>

      {entry.error ? (
        <span className="text-destructive text-xs" data-testid="mod-status-read-failed">
          {t("settings.models.mod.status.readFailed")}
        </span>
      ) : entry.empty ? (
        <span className="text-muted-foreground text-xs" data-testid="mod-status-empty">
          {t("settings.models.mod.status.noData")}
        </span>
      ) : (
        <Rows entry={entry} locale={locale} t={t} />
      )}

      {actions.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2" data-testid="mod-status-actions">
          {actions.map((action) => (
            <Button
              key={action.job}
              type="button"
              variant="outline"
              size="sm"
              disabled={runningJob !== null}
              data-testid="mod-status-action"
              data-job={action.job}
              onClick={() => void run(action.job)}
            >
              {runningJob === action.job ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
              {resolveLocalizedText(action.label, locale)}
            </Button>
          ))}
          {answer ? (
            <span
              className={answer.answer === "started" ? "text-muted-foreground text-xs" : "text-warning text-xs"}
              role="status"
              data-testid="mod-status-action-answer"
              data-answer={answer.answer}
            >
              {t(ANSWER_KEY[answer.answer])}
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
