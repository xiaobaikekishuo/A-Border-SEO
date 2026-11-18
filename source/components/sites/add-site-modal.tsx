"use client";

import { useCallback, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useUiText } from "@/components/ui/ui-text";
import { useI18n } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { GoogleConnection } from "./google-connection";

interface GSCProperty { siteUrl: string; permissionLevel: string; }

export function AddSiteModal({ triggerLabel = "Add site", handle }: {
  triggerLabel?: string;
  /** Opened from the workspace switcher without a second trigger. */
  handle?: DialogPrimitive.Handle<unknown>;
}) {
  const ui = useUiText();
  const { t } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"manual" | "google">("manual");
  const [domain, setDomain] = useState("");
  const [properties, setProperties] = useState<GSCProperty[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedProperty, setSelectedProperty] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const loadId = useRef(0);

  function handleOpenChange(value: boolean) {
    if (adding) return;
    loadId.current++;
    setOpen(value); setError(""); setLoading(false);
    if (value) { setMode("manual"); setSelectedProperty(""); setProperties([]); }
  }

  const loadGSCProperties = useCallback(async () => {
    const sequence = ++loadId.current;
    setLoading(true); setError(""); setSelectedProperty("");
    try {
      const response = await fetch("/api/gsc/properties", { cache: "no-store" });
      const body = await response.json();
      if (sequence !== loadId.current) return;
      if (!response.ok) {
        setProperties([]);
        if (["REAUTH_REQUIRED", "GOOGLE_CONNECTION_REQUIRED", "GOOGLE_CONNECTION_NOT_CONFIGURED"].includes(body.code)) return;
        throw new Error(t("Could not read Search Console properties. Check the Google connection and try again.", "无法读取 Search Console 资源，请检查 Google 连接后重试。"));
      }
      if (!Array.isArray(body)) throw new Error(t("Invalid Search Console response.", "Search Console 返回格式异常。"));
      const verified = body.filter((item: GSCProperty) => typeof item.siteUrl === "string" && item.permissionLevel !== "siteUnverifiedUser");
      setProperties(verified);
      if (!verified.length) setError(ui("No GSC properties found. Verify this Google account has Search Console access."));
    } catch (cause) {
      if (sequence === loadId.current) setError(cause instanceof Error ? cause.message : ui("Failed to load GSC properties"));
    } finally { if (sequence === loadId.current) setLoading(false); }
  }, [t, ui]);

  function selectMode(value: "manual" | "google") {
    loadId.current++; setLoading(false); setMode(value); setError("");
  }

  function addError(message: string) {
    switch (message) {
      case "Site already exists": return t("This website is already in your account. Select it from All sites.", "此网站已在你的账号中，请从“全部网站”选择。");
      case "Domain must resolve to a public IP address": return t("Enter a website whose domain resolves to a public address.", "请输入能解析到公网地址的网站域名。");
      case "Missing domain": case "Invalid domain": case "Missing domain or gscProperty":
      case "Enter a website domain or URL": case "Enter a valid public website domain or URL":
      case "Could not derive a domain from domain": case "Could not derive a domain from gscProperty":
        return t("Enter a valid domain, such as example.com.", "请输入有效域名，例如 example.com。");
      default: return message || ui("Failed to add site");
    }
  }

  async function handleAddSite(event: FormEvent) {
    event.preventDefault();
    if (adding || (mode === "manual" ? !domain.trim() : !selectedProperty)) return;
    setAdding(true); setError("");
    try {
      const response = await fetch("/api/sites", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "manual" ? { domain: domain.trim() } : { gscProperty: selectedProperty }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (body.code === "REAUTH_REQUIRED") throw new Error(t("Reconnect Google before importing a website.", "请重新连接 Google 后再导入网站。"));
        if (body.code === "GSC_PROPERTY_UNAVAILABLE") throw new Error(t("Your Google account cannot access this property. Refresh the list.", "当前 Google 账号无权访问此资源，请刷新网站列表。"));
        if (body.code === "GSC_PROPERTIES_UNAVAILABLE") throw new Error(t("Could not check Google access. Try again, or add the domain manually.", "暂时无法核对 Google 权限，请重试或切换到“输入域名”添加。"));
        throw new Error(addError(body.error));
      }
      setDomain(""); setSelectedProperty(""); setOpen(false);
      router.refresh();
      if (body.id) router.push("/sites/" + encodeURIComponent(body.id));
    } catch (cause) { setError(cause instanceof Error ? cause.message : ui("Failed to add site")); }
    finally { setAdding(false); }
  }

  return <Dialog open={open} onOpenChange={handleOpenChange} handle={handle}>
    {!handle && <DialogTrigger render={<Button />}>{ui(triggerLabel)}</DialogTrigger>}
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{ui("Add site")}</DialogTitle>
        <DialogDescription>{t("Add a website by domain, or import a property from Google Search Console.", "直接输入域名添加网站，也可以从 Google Search Console 导入。")}</DialogDescription>
      </DialogHeader>
      <div className="flex gap-2" role="group" aria-label={t("How to add a website", "添加方式")}>
        <Button type="button" variant={mode === "manual" ? "default" : "outline"} aria-pressed={mode === "manual"} onClick={() => selectMode("manual")} disabled={adding}>{t("Enter domain", "输入域名")}</Button>
        <Button type="button" variant={mode === "google" ? "default" : "outline"} aria-pressed={mode === "google"} onClick={() => selectMode("google")} disabled={adding}>{t("Import from Google", "从 Google 导入")}</Button>
      </div>
      <form className="space-y-4" onSubmit={handleAddSite}>
        {mode === "manual" ? <>
          <label className="block text-sm font-medium" htmlFor="add-site-domain">{t("Website domain", "网站域名")}</label>
          <input id="add-site-domain" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" value={domain} onChange={event => setDomain(event.target.value)} placeholder="example.com" autoComplete="url" autoFocus required maxLength={2048} disabled={adding} />
          <p className="text-sm text-muted-foreground">{t("Google authorization is optional. You can use the Codex workbench and site crawl after adding a domain. Search clicks and rankings need a Search Console connection.", "无需先授权 Google。添加后即可进入 Codex 工作台和网站抓取；搜索点击与排名数据需要连接 Search Console。")}</p>
        </> : <>
          <GoogleConnection onConnected={loadGSCProperties} disabled={adding} />
          <Button type="button" variant="outline" size="sm" disabled={loading || adding} onClick={() => void loadGSCProperties()}>{t("Refresh properties", "刷新网站列表")}</Button>
          {loading && <p role="status" className="text-sm text-muted-foreground">{ui("Loading properties from Google…")}</p>}
          {properties.length > 0 && <Select value={selectedProperty} onValueChange={value => value !== null && setSelectedProperty(value)}>
            <SelectTrigger className="w-full"><SelectValue placeholder={ui("Select a GSC property…")} /></SelectTrigger>
            <SelectContent>{properties.map(property => <SelectItem key={property.siteUrl} value={property.siteUrl}>{property.siteUrl}</SelectItem>)}</SelectContent>
          </Select>}
        </>}
        {error && <p role="alert" className="rounded-lg border border-danger/30 bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={adding}>{ui("Cancel")}</Button>
          <Button type="submit" disabled={adding || loading || (mode === "manual" ? !domain.trim() : !selectedProperty)}>{adding ? t("Adding…", "正在添加…") : ui("Add site")}</Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}
