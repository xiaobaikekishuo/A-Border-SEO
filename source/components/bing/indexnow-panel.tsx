"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n/client";
import type { IndexNowView, KeyCheck, SubmitResult } from "@/lib/indexnow/service";

type ApiReply = IndexNowView & { check?: KeyCheck; result?: SubmitResult; error?: string };

/**
 * IndexNow: create a key, publish it as a file on the site, check the file,
 * then submit the pages that changed in the latest crawl (or a list of URLs)
 * to Bing and the other IndexNow engines. Google does not take part.
 */
export function IndexNowPanel({ siteId, disabled = false }: { siteId: string; disabled?: boolean }) {
  const { t, locale } = useI18n();
  const [state, setState] = useState<IndexNowView | null>(null);
  const [busy, setBusy] = useState<"key" | "verify" | "submit" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [source, setSource] = useState<"changed" | "list">("changed");
  const [list, setList] = useState("");
  const endpoint = `/api/sites/${encodeURIComponent(siteId)}/indexnow`;

  useEffect(() => {
    let live = true;
    fetch(endpoint, { cache: "no-store" })
      .then(async res => { const body = await res.json().catch(() => null); if (!res.ok) throw new Error(body?.error ?? "load"); if (live) setState(body as IndexNowView); })
      .catch(() => { if (live) setError(t("Could not load the IndexNow settings.", "无法读取 IndexNow 设置。")); });
    return () => { live = false; };
  }, [endpoint, t]);

  async function act(action: "key" | "verify" | "submit") {
    if (action === "key" && state?.key && !window.confirm(t("Replace the key? Submissions need the new key file on the site.", "要更换密钥吗？之后的提交需要网站上放置新的密钥文件。"))) return;
    setBusy(action); setError(""); setNotice("");
    try {
      const payload = action === "submit"
        ? { action, source, ...(source === "list" ? { urls: list.split(/\s+/).map(v => v.trim()).filter(Boolean) } : {}) }
        : { action };
      const res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const body = await res.json().catch(() => null) as ApiReply | null;
      if (!res.ok || !body) throw new Error(body?.error ?? t("The request failed.", "请求失败。"));
      setState(body);
      if (action === "verify" && body.check) {
        const { reason, status } = body.check;
        if (reason === "MATCH") setNotice(t("The key file answers with the key.", "密钥文件内容正确。"));
        else setError(reason === "MISMATCH" ? t("The file was found but does not contain exactly the key.", "找到了文件，但内容与密钥不一致。")
          : reason === "HTTP_ERROR" ? t("The key file answered with HTTP {status}.", "密钥文件返回 HTTP {status}。", { status: status ?? "?" })
            : t("The site could not be reached.", "无法访问网站。"));
      }
      if (action === "submit" && body.result) {
        const { submitted, rejected, truncated } = body.result;
        setNotice(t("{n} URLs submitted.", "已提交 {n} 个网址。", { n: submitted }) +
          (rejected ? " " + t("{n} skipped: not on this site.", "跳过 {n} 个：不属于本站。", { n: rejected }) : "") +
          (truncated ? " " + t("{n} over the 10,000 limit left out.", "超出 10,000 上限的 {n} 个未提交。", { n: truncated }) : ""));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return <section className="panel mt-6 space-y-3 p-5">
    <div>
      <h3 className="text-[15px] leading-5 font-semibold">IndexNow</h3>
      <p className="mt-1 text-sm text-muted-foreground">{t("Tell Bing and the other IndexNow engines (Yandex, Naver, Seznam, Yep) which pages are new or changed, so they recrawl them sooner. Google does not use IndexNow.", "通知必应及其他 IndexNow 搜索引擎（Yandex、Naver、Seznam、Yep）哪些页面是新的或有更新，让它们更快重新抓取。Google 不使用 IndexNow。")}</p>
    </div>
    {error && <p className="text-sm text-danger" role="alert">{error}</p>}
    {notice && <p className="text-sm text-success" role="status">{notice}</p>}
    {state && <>
      {!state.key ? <div className="space-y-2 text-sm">
        <p>{t("Start by creating a key. You then put a small text file with it on your site.", "先创建密钥，然后把含有该密钥的小文本文件放到网站上。")}</p>
        <Button type="button" size="sm" disabled={busy !== null} onClick={() => void act("key")}>{busy === "key" ? t("Creating…", "创建中…") : t("Create a key", "创建密钥")}</Button>
      </div> : <div className="space-y-2 text-sm">
        <ol className="list-decimal space-y-1 pl-5">
          <li>{t("Create a text file named", "创建一个文本文件，文件名为")} <code>{state.key}.txt</code> {t("whose only content is", "，内容只有")} <code>{state.key}</code></li>
          <li>{t("Publish it at", "把它发布到")} <code className="break-all">{state.keyUrl}</code> {t("(the root of the site, served as plain text).", "（网站根目录，以纯文本返回）。")}</li>
          <li>{t("Check it here, then submit.", "在这里检查通过后再提交。")}</li>
        </ol>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="outline" disabled={busy !== null || disabled} onClick={() => void act("verify")}>{busy === "verify" ? t("Checking…", "检查中…") : t("Check the key file", "检查密钥文件")}</Button>
          <span className={state.verifiedAt ? "text-success" : "text-muted-foreground"}>{state.verifiedAt ? t("Checked {date}", "已于 {date} 通过检查", { date: new Date(state.verifiedAt).toLocaleString(locale === "zh" ? "zh-CN" : "en-US") }) : t("Not checked yet", "尚未检查")}</span>
          <button type="button" className="text-xs text-muted-foreground hover:underline" disabled={busy !== null} onClick={() => void act("key")}>{t("Replace the key", "更换密钥")}</button>
        </div>
        <fieldset className="space-y-2 pt-2">
          <legend className="text-xs text-muted-foreground">{t("What to submit", "提交内容")}</legend>
          <label className="flex items-center gap-2"><input type="radio" checked={source === "changed"} onChange={() => setSource("changed")} />
            {state.changed
              ? state.changed.firstCrawl
                ? t("All {n} indexable pages of the latest crawl ({date})", "最近一次抓取（{date}）中全部 {n} 个可索引页面", { n: state.changed.count, date: state.changed.crawlDate ?? "" })
                : t("{n} pages new or changed in the latest crawl ({date})", "最近一次抓取（{date}）中新增或有变化的 {n} 个页面", { n: state.changed.count, date: state.changed.crawlDate ?? "" })
              : t("Pages changed in the latest crawl (no completed crawl yet)", "最近一次抓取中有变化的页面（尚无完成的抓取）")}
          </label>
          <label className="flex items-center gap-2"><input type="radio" checked={source === "list"} onChange={() => setSource("list")} />{t("These URLs", "下面这些网址")}</label>
          {source === "list" && <textarea className="min-h-20 w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs" placeholder={t("One URL of this site per line", "每行一个本站网址")} value={list} onChange={e => setList(e.target.value)} />}
          <Button type="button" size="sm" disabled={busy !== null || disabled || !state.verifiedAt || (source === "changed" ? !state.changed?.count : !list.trim())} onClick={() => void act("submit")}>{busy === "submit" ? t("Submitting…", "提交中…") : t("Submit to IndexNow", "提交到 IndexNow")}</Button>
          <p className="text-xs text-muted-foreground">{t("Submit pages when they are published or changed, not on a timer: engines may slow down sites that resubmit unchanged URLs.", "页面发布或更新时再提交，不要定时重复提交：反复提交未变化的网址可能被搜索引擎降低处理频率。")}</p>
        </fieldset>
        {state.last && <p className="text-xs text-muted-foreground">{t("Last submission {date}: {count} URLs, HTTP {status}. {message}", "上次提交 {date}：{count} 个网址，HTTP {status}。{message}", {
          date: new Date(state.last.at).toLocaleString(locale === "zh" ? "zh-CN" : "en-US"), count: state.last.count ?? 0, status: state.last.status ?? "?", message: lastMessage(state.last.message, t),
        })}</p>}
      </div>}
    </>}
  </section>;
}

function lastMessage(message: string | null, t: (en: string, zh: string) => string): string {
  const zh: Record<string, string> = {
    "Submitted.": "提交成功。",
    "Received; the engines are still checking the key file.": "已接收，搜索引擎仍在核验密钥文件。",
    "IndexNow rejected the request format.": "IndexNow 拒绝了请求格式。",
    "The key file was not found or does not contain the key.": "未找到密钥文件，或文件内容不是该密钥。",
    "Some URLs do not belong to the host, or the key does not match the protocol.": "部分网址不属于该主机，或密钥不符合协议要求。",
    "Too many submissions: IndexNow asks to slow down.": "提交过于频繁，IndexNow 要求放慢。",
    "IndexNow did not accept the submission.": "IndexNow 未接受这次提交。",
  };
  return message ? t(message, zh[message] ?? message) : "";
}
