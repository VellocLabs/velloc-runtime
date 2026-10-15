import * as React from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { resolveLocalizedText } from "../../../../config/localizedText";
import {
  isTerminalStep,
  loginUrlProblem,
  type ProviderLoginAnswerValue,
  type ProviderLoginFailureCode,
  type ProviderLoginSession,
} from "../../../../mods/provider/login/loginProtocol";
import { useLocale, useT } from "../../i18n";
import { getProviderLoginStore } from "../../providerLoginStore";

const FAILURE_KEY = {
  timeout: "settings.models.mod.signIn.failedTimeout",
  unavailable: "settings.models.mod.signIn.failedUnavailable",
  unanswered: "settings.models.mod.signIn.failedUnanswered",
  no_hook: "settings.models.mod.signIn.failedNoHook",
  invalid_result: "settings.models.mod.signIn.failedInvalid",
  write_failed: "settings.models.mod.signIn.failedWrite",
} as const satisfies Record<Exclude<ProviderLoginFailureCode, "module">, string>;

/**
 * The sign-in dialog of a provider mod, DRAWN from the runtime's `providers/login`
 * session alone; answers go back as `providerLogin.answer`. Security: the page keeps
 * no copy of an answer — a typed secret lives in the field until it is sent.
 */
export function ProviderSignInDialog({
  name,
  session,
}: {
  /** The provider's display name. */
  name: string;
  /** The runtime's session; the dialog is open while there is one. */
  session: ProviderLoginSession | undefined;
}) {
  const t = useT();
  const store = getProviderLoginStore();
  const terminal = session ? isTerminalStep(session.step) : false;
  // Closing a running sign-in cancels it; closing an ended one dismisses it.
  const close = () => {
    if (session) void store.cancel(session.loginId).catch(() => undefined);
  };
  return (
    <Dialog
      open={session !== undefined}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      {session ? (
        <DialogContent data-testid="provider-signin-dialog" data-step={session.step.kind}>
          <DialogHeader>
            <DialogTitle>{t("settings.models.mod.signIn.title", { name })}</DialogTitle>
            <DialogDescription className="sr-only">
              {t("settings.models.mod.signIn.description", { name })}
            </DialogDescription>
          </DialogHeader>
          <StepBody key={session.stepId} session={session} />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="provider-signin-cancel"
              onClick={close}
            >
              {terminal ? t("settings.models.mod.signIn.close") : t("settings.models.mod.signIn.cancel")}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function StepBody({ session }: { session: ProviderLoginSession }) {
  const t = useT();
  const locale = useLocale();
  const store = getProviderLoginStore();
  const { step } = session;
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const answer = async (value: ProviderLoginAnswerValue) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await store.answer(session.loginId, session.stepId, value);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const problem = error ? (
    <span className="text-destructive text-xs" data-testid="provider-signin-error">
      {t("settings.models.mod.signIn.answerFailed", { error })}
    </span>
  ) : null;

  switch (step.kind) {
    case "working":
      return (
        <p className="text-muted-foreground text-sm" data-testid="provider-signin-working">
          {t("settings.models.mod.signIn.working")}
        </p>
      );
    case "progress":
      return (
        <p className="text-sm" data-testid="provider-signin-progress">
          {resolveLocalizedText(step.text, locale)}
        </p>
      );
    case "openUrl": {
      const safe = loginUrlProblem(step.url) === null;
      return (
        <div className="flex flex-col gap-3" data-testid="provider-signin-openurl">
          <p className="text-sm">{t("settings.models.mod.signIn.openUrlText")}</p>
          {safe ? (
            <>
              <span className="break-all text-muted-foreground text-xs" data-testid="provider-signin-host">
                {new URL(step.url).host}
              </span>
              {/* A plain link: the window's own safe opener takes the click
                  (http / https only) - the module opened nothing itself. */}
              <a
                href={step.url}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(buttonVariants({ size: "sm" }), "self-start")}
                data-testid="provider-signin-open"
                onClick={() => void answer({ kind: "ack" })}
              >
                {t("settings.models.mod.signIn.openUrlButton")}
              </a>
            </>
          ) : null}
          {problem}
        </div>
      );
    }
    case "code": {
      const safe = loginUrlProblem(step.url) === null;
      return (
        <div className="flex flex-col gap-3" data-testid="provider-signin-code">
          <p className="text-sm">{t("settings.models.mod.signIn.codeText")}</p>
          <code
            className="select-all rounded-md border bg-muted/40 px-3 py-2 text-center font-mono text-lg tracking-widest"
            data-testid="provider-signin-code-value"
          >
            {step.code}
          </code>
          {safe ? (
            <a
              href={step.url}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(buttonVariants({ size: "sm", variant: "outline" }), "self-start")}
              data-testid="provider-signin-code-open"
            >
              {t("settings.models.mod.signIn.openUrlButton")}
            </a>
          ) : null}
          <span className="text-muted-foreground text-xs">{t("settings.models.mod.signIn.codeWaiting")}</span>
        </div>
      );
    }
    case "prompt":
      return (
        <PromptStep
          label={resolveLocalizedText(step.label, locale)}
          secret={step.secret}
          busy={busy}
          problem={problem}
          onSubmit={(text) => void answer({ kind: "text", text })}
        />
      );
    case "choose":
      return (
        <ChooseStep
          label={resolveLocalizedText(step.label, locale)}
          options={step.options.map((option) => resolveLocalizedText(option.label, locale))}
          busy={busy}
          problem={problem}
          onSubmit={(index) => void answer({ kind: "choice", index })}
        />
      );
    case "done":
      return (
        <div className="flex flex-col gap-1" data-testid="provider-signin-done">
          <p className="font-medium text-sm">{t("settings.models.mod.signIn.doneTitle")}</p>
          {step.account ? (
            <p className="text-muted-foreground text-sm">
              {t("settings.models.mod.keptAccount", { account: step.account })}
            </p>
          ) : null}
        </div>
      );
    case "failed":
      return (
        <div className="flex flex-col gap-1" data-testid="provider-signin-failed" data-code={step.code}>
          <p className="font-medium text-destructive text-sm">{t("settings.models.mod.signIn.failedTitle")}</p>
          <p className="break-words text-sm">
            {/* The module's own words, as given; the runtime's reasons are the catalog's. */}
            {step.code === "module" ? step.reason : t(FAILURE_KEY[step.code])}
          </p>
        </div>
      );
  }
}

function PromptStep({
  label,
  secret,
  busy,
  problem,
  onSubmit,
}: {
  label: string;
  secret: boolean;
  busy: boolean;
  problem: React.ReactNode;
  onSubmit: (text: string) => void;
}) {
  const t = useT();
  const [text, setText] = React.useState("");
  const id = React.useId();
  return (
    <form
      noValidate
      className="flex flex-col gap-3"
      data-testid="provider-signin-prompt"
      onSubmit={(event) => {
        event.preventDefault();
        if (text !== "") onSubmit(text);
      }}
    >
      <label htmlFor={id} className="font-medium text-sm">
        {label}
      </label>
      <Input
        id={id}
        data-testid="provider-signin-input"
        type={secret ? "password" : "text"}
        autoComplete="off"
        autoFocus
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
      />
      {problem}
      <Button
        type="submit"
        size="sm"
        className="self-end"
        disabled={busy || text === ""}
        data-testid="provider-signin-submit"
      >
        {t("settings.models.mod.signIn.continue")}
      </Button>
    </form>
  );
}

function ChooseStep({
  label,
  options,
  busy,
  problem,
  onSubmit,
}: {
  label: string;
  options: string[];
  busy: boolean;
  problem: React.ReactNode;
  onSubmit: (index: number) => void;
}) {
  const t = useT();
  const [picked, setPicked] = React.useState<number | null>(null);
  return (
    <form
      noValidate
      className="flex flex-col gap-3"
      data-testid="provider-signin-choose"
      onSubmit={(event) => {
        event.preventDefault();
        if (picked !== null) onSubmit(picked);
      }}
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 font-medium text-sm">{label}</legend>
        {options.map((text, index) => (
          <label key={index} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="provider-signin-choice"
              checked={picked === index}
              onChange={() => setPicked(index)}
              data-testid={`provider-signin-option-${index}`}
            />
            <span>{text}</span>
          </label>
        ))}
      </fieldset>
      {problem}
      <Button
        type="submit"
        size="sm"
        className="self-end"
        disabled={busy || picked === null}
        data-testid="provider-signin-submit"
      >
        {t("settings.models.mod.signIn.continue")}
      </Button>
    </form>
  );
}
