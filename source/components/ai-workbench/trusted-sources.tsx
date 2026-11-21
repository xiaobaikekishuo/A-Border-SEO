"use client";

import { useCallback, useEffect, useState } from "react";
import { BookOpen, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import type { LinkReviewEntry } from "@/lib/ai-workbench/schema";
import type { TrustedSourceView } from "@/lib/ai-workbench/trusted-sources";
import s from "./workbench.module.css";

const LIMIT = 300;

export type TrustedSourcesApi = {
  sources: TrustedSourceView[] | null;
  busy: string | null;
  error: string | null;
  notice: string | null;
  add: (lines: { url: string; title?: string }[]) => Promise<boolean>;
  remove: (id: string) => Promise<void>;
  check: (id: string) => Promise<void>;
};

/** The site's trusted sources and the requests that change them. */
export function useTrustedSources(siteId: string): TrustedSourcesApi {
  const { t } = useI18n();
  const [sources, setSources] = useState<TrustedSourceView[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const endpoint = `/api/sites/${encodeURIComponent(siteId)}/assistant/trusted-sources`;
  useEffect(() => {
    const controller = new AbortController();
    fetch(endpoint, { signal: controller.signal, cache: "no-store" })
      .then(async response => {
        if (!response.ok) throw new Error();
        setSources(((await response.json()) as { sources: TrustedSourceView[] }).sources);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(t("Could not load the trusted sources.", "无法读取可信来源。"));
      });
    return () => controller.abort();
  }, [endpoint, t]);
  const post = useCallback(
    async (key: string, body: Record<string, unknown>) => {
      setBusy(key);
      setError(null);
      setNotice(null);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
        if (!response.ok || !data) {
          setError(
            response.status === 403
              ? t("Checking pages is paused by the current policy or an update.", "当前策略或更新期间暂不能检查网页。")
              : t("The request failed. Try again.", "操作失败，请重试。"),
          );
          return null;
        }
        if (Array.isArray(data.sources)) setSources(data.sources as TrustedSourceView[]);
        return data;
      } catch {
        setError(t("The request failed. Try again.", "操作失败，请重试。"));
        return null;
      } finally {
        setBusy(null);
      }
    },
    [endpoint, t],
  );
  return {
    sources,
    busy,
    error,
    notice,
    add: async lines => {
      const data = await post("add", { action: "add", sources: lines.slice(0, 100) });
      if (!data) return false;
      const added = Number(data.added) || 0,
        existing = Number(data.existing) || 0;
      const invalid = Array.isArray(data.invalid) ? data.invalid.length : 0;
      setNotice(
        [
          t("{v0} added", "已加入 {v0} 条", { v0: added }),
          existing ? t("{v0} already listed", "{v0} 条已在库中", { v0: existing }) : "",
          invalid ? t("{v0} not a web page address", "{v0} 条不是网页地址", { v0: invalid }) : "",
          data.full ? t("the list is full ({v0})", "来源库已满（{v0} 条）", { v0: LIMIT }) : "",
        ]
          .filter(Boolean)
          .join(t(", ", "，")),
      );
      return true;
    },
    remove: async id => {
      await post(`remove:${id}`, { action: "remove", id });
    },
    check: async id => {
      const data = await post(`check:${id}`, { action: "check", id });
      const status = (data?.check as { status?: unknown } | undefined)?.status;
      if (data)
        setNotice(
          typeof status === "number"
            ? t("The page answered with status {v0}.", "网页返回状态 {v0}。", { v0: status })
            : t("The page could not be reached.", "无法打开这个网页。"),
        );
    },
  };
}

/** Lines of "URL" or "URL title". */
function parseLines(text: string): { url: string; title?: string }[] {
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [url, ...rest] = line.split(/\s+/);
      const title = rest.join(" ").trim();
      return title ? { url, title: title.slice(0, 200) } : { url };
    });
}

/** The site's trusted sources, inside the task form: every control is a plain button, so nothing submits the form. */
export function TrustedSourcesPanel({ api, disabled }: { api: TrustedSourcesApi; disabled: boolean }) {
  const { t, locale } = useI18n();
  const [text, setText] = useState("");
  const count = api.sources?.length ?? 0;
  const day = (value: string) =>
    new Date(value).toLocaleDateString(locale === "zh" ? "zh-CN" : "en-US", { month: "short", day: "numeric" });
  return (
    <details className={s.sources}>
      <summary>
        <BookOpen size={16} />
        {t("Trusted sources", "可信来源库")} · {count}
      </summary>
      <p className={s.sourceHint}>
        {t(
          "Drafts may cite these pages as sources. Other links in a draft are replaced by a “verify source” marker and listed under the result. Add exact pages, not whole sites: the model cannot open pages to check a deep link.",
          "草稿可以把这些网页作为出处引用。草稿里库外的链接会被替换成“〔待核实〕”标记，并列在结果下方。请添加具体网页而不是整个网站：模型无法打开网页核对深层链接。",
        )}
      </p>
      <label className={s.field}>
        <span>{t("Add pages", "添加网页")}</span>
        <textarea
          rows={3}
          maxLength={20000}
          value={text}
          disabled={disabled || !!api.busy}
          onChange={event => setText(event.target.value)}
          placeholder={t("One address per line; a title may follow after a space", "每行一个网址，网址后空一格可写标题")}
        />
        <small>
          {t("{v0} of {v1} used. Addresses are saved for this site only.", "已用 {v0} / {v1} 条，只保存在当前站点。", {
            v0: count,
            v1: LIMIT,
          })}
        </small>
      </label>
      <div className={s.actions}>
        <button
          type="button"
          disabled={disabled || !!api.busy || !text.trim()}
          onClick={async () => {
            if (await api.add(parseLines(text))) setText("");
          }}
        >
          {api.busy === "add" ? <Loader2 size={14} className={s.spinning} /> : <Plus size={14} />}
          {t("Add", "加入")}
        </button>
      </div>
      {api.notice && (
        <p className={s.sourceHint} role="status">
          {api.notice}
        </p>
      )}
      {api.error && (
        <p className={s.validation} role="alert">
          {api.error}
        </p>
      )}
      {!!api.sources?.length && (
        <ul className={s.trustedList}>
          {api.sources.map(source => (
            <li key={source.id}>
              <div>
                <strong>{source.title || source.url}</strong>
                {source.title && <span className={s.sourceUrl}>{source.url}</span>}
                <small>
                  {source.checkedAt
                    ? source.lastStatus === null
                      ? t("Checked {v0}: could not be reached", "{v0} 检查：无法打开", { v0: day(source.checkedAt) })
                      : t("Checked {v0}: status {v1}", "{v0} 检查：状态 {v1}", { v0: day(source.checkedAt), v1: source.lastStatus })
                    : t("Not checked", "未检查")}
                  {source.note ? ` · ${source.note}` : ""}
                </small>
              </div>
              <div className={s.actions}>
                <button
                  type="button"
                  disabled={disabled || !!api.busy}
                  onClick={() => void api.check(source.id)}
                  aria-label={t("Check {v0}", "检查 {v0}", { v0: source.url })}
                >
                  {api.busy === `check:${source.id}` ? <Loader2 size={14} className={s.spinning} /> : <RefreshCw size={14} />}
                  {t("Check", "检查")}
                </button>
                <button
                  type="button"
                  disabled={disabled || !!api.busy}
                  onClick={() => void api.remove(source.id)}
                  aria-label={t("Remove {v0}", "删除 {v0}", { v0: source.url })}
                >
                  <Trash2 size={14} />
                  {t("Remove", "删除")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

/** Links of a finished draft that need the owner's check, with a shortcut into the trusted sources. */
export function LinkReviewList({ entries, api, disabled }: { entries: LinkReviewEntry[]; api: TrustedSourcesApi; disabled: boolean }) {
  const { t } = useI18n();
  if (!entries.length) return null;
  const listed = new Set((api.sources ?? []).map(source => source.url));
  const action = (entry: LinkReviewEntry) =>
    entry.action === "REPLACED"
      ? t("replaced by a marker in the draft", "已在草稿中替换为标记")
      : entry.action === "DROPPED"
        ? t("internal link suggestion removed", "已移除这条内链建议")
        : entry.action === "KEPT_IN_CODE"
          ? t("kept in a code sample", "保留在代码示例中")
          : t("kept in the notes as text", "保留在说明文字中");
  return (
    <>
      <h4>{t("Sources to verify", "待核实来源")}</h4>
      <p className={s.sourceHint}>
        {t(
          "These links are not verified pages of this site or trusted sources. Open and check each one before citing it. Adding one to the trusted sources lets later drafts cite it.",
          "这些链接不是本站已核实的页面，也不在可信来源库中。引用前请逐个打开核对；加入来源库后，之后的草稿可以引用。",
        )}
      </p>
      <ul className={s.trustedList}>
        {entries.map((entry, index) => (
          <li key={`${entry.field}:${entry.url}:${index}`}>
            <div>
              <span className={s.sourceUrl}>{entry.url}</span>
              <small>
                {entry.status === "UNSAFE" ? t("Unsafe link, removed", "不安全的链接，已移除") : action(entry)} · {entry.field}
              </small>
            </div>
            {entry.status === "UNVERIFIED" && /^https?:\/\//i.test(entry.url) && (
              <div className={s.actions}>
                <button
                  type="button"
                  disabled={disabled || !!api.busy || listed.has(entry.url)}
                  onClick={() => void api.add([{ url: entry.url }])}
                >
                  <Plus size={14} />
                  {listed.has(entry.url) ? t("In trusted sources", "已在来源库") : t("Add to trusted sources", "加入可信来源")}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
