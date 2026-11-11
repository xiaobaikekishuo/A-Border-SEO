"use client";

import { useUiText, identityUiText, type UiTranslator } from "@/components/ui/ui-text";


import { useState } from "react";
import { Button } from "@/components/ui/button";

export function EvaluateAlertsButton() {
  const ui = useUiText();
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setMsg(null);
    try {
      const res = await fetch("/api/alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "evaluate" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || ui("Failed"));
      const n = data.fires?.length ?? 0;
      const channels = [data.webhookDeliveries > 0 && ui("your webhook"), data.emailDeliveries > 0 && ui("email")].filter(Boolean);
      const sent = channels.length ? ui(" Queued for {0}.", { "0": channels.join(ui.locale === "zh" ? "和" : " and ") }) : "";
      setMsg(
        n === 0
          ? ui("No alerts fired")
          : ui("{0} alert(s): {1}.{2}", { "0": n, "1": data.fires.map((f: { message: string }) => f.message).join(" · "), "2": sent })
      );
    } catch (e) {
      setMsg(e instanceof Error ? e.message : ui("Failed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-1 text-right">
      <Button size="sm" variant="outline" disabled={loading} onClick={run}>
        {loading ? ui("Checking…") : ui("Evaluate now")}
      </Button>
      {msg && (
        <p className="max-w-sm text-xs text-muted-foreground sm:ml-auto">{msg}</p>
      )}
    </div>
  );
}
