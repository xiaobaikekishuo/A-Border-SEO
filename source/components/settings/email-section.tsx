"use client";

import { useUiText, identityUiText, type UiTranslator } from "@/components/ui/ui-text";


import { useId, useState } from "react";
import { CheckCircle2, Loader2, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatDay } from "@/lib/format";
import type { EmailStatus, LastEmail } from "@/lib/email/status";

const FORM_MAX_WIDTH = "max-w-[560px]";
const INPUT_CLASS =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-brand-500 focus:bg-bg focus:outline-none aria-invalid:border-danger";

/** The variables the operator sets, in the order the README lists them. */
const ENV_VARS = ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASSWORD", "SMTP_FROM"];

/** The latest alert email in one line. */
export function lastEmailLine(e: LastEmail, ui: UiTranslator = identityUiText): { ok: boolean; text: string } {
  const at = formatDay(e.at, { locale: ui.locale, year: true, time: true });
  switch (e.status) {
    case "sent":
      return { ok: true, text: ui("Last email: sent, {0}.", { "0": at }) };
    case "queued":
    case "running":
      return { ok: true, text: ui("Last email: sending now.") };
    case "retrying":
      return {
        ok: false,
        text: ui("Last email: attempt {0} failed{1} Next attempt {2}.", { "0": e.attempts, "1": e.error ? `: ${e.error}` : ".", "2": formatDay(e.nextAttemptAt ?? e.at, { locale: ui.locale, time: true }) }),
      };
    case "failed":
      return { ok: false, text: ui("Last email failed after {0} attempt(s), {1}{2}", { "0": e.attempts, "1": at, "2": e.error ? `: ${e.error}` : "." }) };
  }
}

/**
 * Settings > Email alerts: the addresses fired alerts are emailed to, through
 * the SMTP server the operator set in the environment, and an on/off switch.
 */
export function EmailSection({ initial }: { initial: EmailStatus }) {
  const ui = useUiText();
  const id = useId();
  const [status, setStatus] = useState(initial);
  const [recipients, setRecipients] = useState(initial.recipients.join(", "));
  const [on, setOn] = useState(initial.on || initial.recipients.length === 0);
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  if (!status.enabled) {
    return (
      <div className="panel p-5 text-[13px] leading-5 text-text">
        {ui("Alert emails are turned off on this server (")}<code className="font-data">ALERT_EMAILS_ENABLED=false</code>).
      </div>
    );
  }

  if (!status.configured) {
    return (
      <div className="panel space-y-2 p-5 text-[13px] leading-5 text-text">
        <p>
          {ui("Email is not set up on this server. To send alerts by email, the server owner sets an SMTP server of their own in the environment and restarts the app:")}</p>
        <p className="flex flex-wrap gap-x-2 gap-y-1">
          {ENV_VARS.map((v) => (
            <code key={v} className="font-data">
              {v}
            </code>
          ))}
        </p>
        <p className="text-muted-foreground">
          <code className="font-data">SMTP_HOST</code>{ui(" and ")}<code className="font-data">SMTP_FROM</code>{ui(" are required. The login stays in the environment: it is never stored or shown here.")}</p>
      </div>
    );
  }

  async function call(kind: "save" | "test") {
    setBusy(kind);
    setMessage(null);
    setInvalid(false);
    try {
      const res = await fetch(kind === "test" ? "/api/user/email/test" : "/api/user/email", {
        method: kind === "test" ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(kind === "test" ? { recipients } : { recipients, on }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setInvalid(data.field === "recipients");
        setMessage({ ok: false, text: data.error || ui("That did not work. Try again.") });
        return;
      }
      if (kind === "test") {
        setMessage(
          data.ok
            ? { ok: true, text: ui("Test email sent. Check the inbox, and the spam folder.") }
            : { ok: false, text: data.error || ui("The test email was not sent.") }
        );
        return;
      }
      const next = data as EmailStatus;
      setStatus(next);
      setRecipients(next.recipients.join(", "));
      setOn(next.on);
      setMessage({ ok: true, text: next.on ? ui("Saved. Fired alerts are emailed.") : ui("Saved. Alert emails are off.") });
    } catch {
      setMessage({ ok: false, text: ui("That did not work. Try again.") });
    } finally {
      setBusy(null);
    }
  }

  const last = status.lastEmail ? lastEmailLine(status.lastEmail, ui) : null;

  return (
    <form
      noValidate
      className="panel p-5"
      onSubmit={(e) => {
        e.preventDefault();
        void call("save");
      }}
    >
      <div className="flex items-start gap-3.5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-bg-soft text-text-strong">
          <Mail className="size-4" aria-hidden />
        </span>
        <div className={`min-w-0 flex-1 space-y-3 ${FORM_MAX_WIDTH}`}>
          <p className="text-[13px] leading-5 text-muted-foreground">
            {ui("When alerts fire, this server emails them through its own SMTP server: plain text and simple HTML, with no tracking and no links except to this app. A failed email is retried a few times and never holds up a crawl or a sync.")}</p>
          <div>
            <label htmlFor={`${id}-to`} className="mb-1 block text-xs font-medium text-muted-foreground">
              {ui("Send to")}</label>
            <input
              id={`${id}-to`}
              name="recipients"
              type="text"
              inputMode="email"
              autoComplete="email"
              spellCheck={false}
              placeholder={ui("you@example.com, team@example.com")}
              value={recipients}
              aria-invalid={invalid || undefined}
              aria-describedby={`${id}-to-help`}
              onChange={(e) => {
                setRecipients(e.target.value);
                setInvalid(false);
              }}
              className={INPUT_CLASS}
            />
            <p id={`${id}-to-help`} className="mt-1.5 text-xs leading-[18px] text-muted-foreground">
              {ui("Up to 5 addresses, separated by commas.")}</p>
          </div>
          <label className="flex items-center gap-2 text-[13px] text-text">
            <input
              type="checkbox"
              name="on"
              checked={on}
              onChange={(e) => setOn(e.target.checked)}
              className="size-4 accent-brand-500"
            />
            {ui("Email fired alerts")}</label>

          {message && (
            <p
              role={message.ok ? "status" : "alert"}
              className={message.ok ? "flex items-center gap-1.5 text-xs text-success" : "text-xs text-danger"}
            >
              {message.ok && <CheckCircle2 className="size-3.5 shrink-0" aria-hidden />}
              {message.text}
            </p>
          )}
          {last && !message && <p className={last.ok ? "text-xs text-muted-foreground" : "text-xs text-danger"}>{last.text}</p>}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button type="submit" size="sm" disabled={busy !== null}>
              {busy === "save" && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
              {ui("Save")}</Button>
            <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => void call("test")}>
              {busy === "test" && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
              {ui("Send test")}</Button>
          </div>
        </div>
      </div>
    </form>
  );
}
