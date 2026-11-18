"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { siteDomainFromProperty } from "@/lib/site-domain";
import { Button } from "@/components/ui/button";
import { GoogleConnection } from "@/components/sites/google-connection";
import { SyncButton } from "@/components/sites/sync-button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Property = { siteUrl: string; permissionLevel: string };

export function GscSiteSection({ siteId, domain, gscProperty }: { siteId: string; domain: string; gscProperty: string | null }) {
  const { t } = useI18n();
  const router = useRouter();
  const [properties, setProperties] = useState<Property[]>([]);
  const [selected, setSelected] = useState(gscProperty ?? "");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const response = await fetch("/api/gsc/properties", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) {
        if (response.status === 401 || body.code === "GOOGLE_CONNECTION_REQUIRED") {
          throw new Error(t("Connect Google below, then refresh the properties.", "请先在下方连接 Google，再刷新资源列表。"));
        }
        throw new Error(t("Could not load Search Console properties. Check the Google connection and try again.", "无法读取 Search Console 资源，请检查 Google 连接后重试。"));
      }
      if (!Array.isArray(body)) throw new Error(t("Invalid property list. Please refresh.", "资源列表格式异常，请刷新重试。"));
      const matching = (body as Property[]).filter(property =>
        property.permissionLevel !== "siteUnverifiedUser" && siteDomainFromProperty(property.siteUrl) === domain);
      setProperties(matching); setLoaded(true);
      setSelected(current => matching.some(property => property.siteUrl === current) ? current : matching[0]?.siteUrl ?? "");
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("Could not load properties.", "无法读取资源。")); }
    finally { setLoading(false); }
  }, [domain, t]);

  async function save() {
    if (!selected || saving) return;
    setSaving(true); setError(null); setSaved(false);
    try {
      const response = await fetch(`/api/sites/${encodeURIComponent(siteId)}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ gscProperty: selected }),
      });
      const body = await response.json();
      if (!response.ok) {
        if (body.code === "GSC_PROPERTY_MISMATCH") throw new Error(t("Choose a property for this site's domain.", "请选择与当前网站域名相符的资源。"));
        if (body.code === "GSC_PROPERTY_UNAVAILABLE") throw new Error(t("Your Google account cannot access this property. Refresh the list.", "当前 Google 账号无法访问此资源，请刷新列表。"));
        if (response.status === 401) throw new Error(t("Reconnect Google, then try again.", "请重新连接 Google 后重试。"));
        throw new Error(t("Could not connect the property. Please try again.", "无法绑定资源，请重试。"));
      }
      setSaved(true); router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("Could not connect the property.", "无法绑定资源。")); }
    finally { setSaving(false); }
  }

  return <section id="gsc-connection" className="panel scroll-mt-6 p-5">
    <h3 className="text-[15px] leading-5 font-semibold text-text-strong">{t("Google Search Console", "Google Search Console")}</h3>
    <p className="mt-2 text-sm text-muted-foreground">{t("Connect Google, then choose a property for {domain}. Crawling and the Codex workbench are available without Search Console.", "连接 Google 后，选择 {domain} 对应的资源。未连接 Search Console 也可以抓取网站和使用 Codex 工作台。", { domain })}</p>
    <div className="mt-4"><GoogleConnection disabled={saving} onConnected={() => void load()} /></div>
    {gscProperty ? <div className="mt-4 flex flex-wrap items-center gap-3">
      <span className="text-sm text-success">{t("Connected property: {property}", "已绑定资源：{property}", { property: gscProperty })}</span>
      <SyncButton siteId={siteId} variant="outline" size="sm" />
    </div> : <div className="mt-4 space-y-3">
      <Button type="button" variant="outline" disabled={loading || saving} onClick={() => void load()}>
        {loading ? t("Loading…", "正在读取…") : t("Refresh properties", "刷新资源列表")}
      </Button>
      {properties.length > 0 && <div className="flex flex-wrap items-center gap-2">
        <Select value={selected} onValueChange={value => setSelected(value ?? "")} disabled={saving}>
          <SelectTrigger className="w-full sm:w-80"><SelectValue placeholder={t("Choose a property", "选择资源")} /></SelectTrigger>
          <SelectContent>{properties.map(property => <SelectItem key={property.siteUrl} value={property.siteUrl}>{property.siteUrl}</SelectItem>)}</SelectContent>
        </Select>
        <Button type="button" disabled={!selected || loading || saving} onClick={() => void save()}>{saving ? t("Connecting…", "正在绑定…") : t("Connect property", "绑定资源")}</Button>
      </div>}
      {loaded && !properties.length && <p className="text-sm text-muted-foreground">{t("This Google account has no verified Search Console property matching {domain}. Verify the site in Search Console or connect the correct Google account.", "此 Google 账号没有与 {domain} 匹配的已验证 Search Console 资源。请先在 Search Console 验证网站，或连接正确的 Google 账号。", { domain })}</p>}
    </div>}
    {saved && <p role="status" className="mt-3 text-sm text-success">{t("Property connected. You can now sync Search Console.", "资源已绑定，现在可以同步 Search Console。")}</p>}
    {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
  </section>;
}
