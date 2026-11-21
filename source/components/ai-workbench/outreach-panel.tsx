"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { Copy, Download, Loader2, Play, Sparkles } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import type { Translator } from "@/lib/i18n/shared";
import type { OutreachEmail } from "@/lib/ai-workbench/tools/schema";
import { OutputLanguageOptions, useOutputLanguage } from "./output-language";
import { copyText, ToolPanel, toolErrorText, useToolTasks, type ToolTasks } from "./tool-panel";
import { csvText, datedName, downloadText, type ToolJob } from "./tool-model";
import k from "@/components/research/keyword-ai-panel.module.css";
import s from "./tool-panel.module.css";

type Prospect = {
  domain: string;
  url: string;
  prospectType: string;
  relevance: string;
  approach: string;
  pitchAngle: string;
  contactUrl: string | null;
};
type LinkTask = { id: string; status: string; createdAt: string; input: { topic?: string }; rows: Prospect[] };
const LIMIT = 10;

function warningText(code: NonNullable<OutreachEmail["warnings"]>[number], t: Translator) {
  return {
    MENTIONS_PAYMENT: t(
      "Mentions payment or a link exchange: Google treats paid links as spam unless marked",
      "提到付费或交换链接：未标注的付费链接属于 Google 认定的垃圾链接",
    ),
    LONG_BODY: t("Long: shorten before sending", "篇幅偏长，发送前可删减"),
    URL_REMOVED: t("A link was replaced: verify it", "有网址被替换，请核实"),
  }[code];
}

/** Outreach drafts for prospects a Manus link research task found, written with the owner's ChatGPT allowance. Nothing is sent. */
export function OutreachPanel({ siteId, initialJobId }: { siteId: string; initialJobId?: string }) {
  const { t, locale } = useI18n();
  const api = useToolTasks(siteId, "OUTREACH_EMAILS", initialJobId);
  const { language, choose } = useOutputLanguage(siteId);
  const [tasks, setTasks] = useState<LinkTask[] | null>(null);
  const [taskError, setTaskError] = useState("");
  const [taskId, setTaskId] = useState("");
  const [rows, setRows] = useState<number[]>([]);
  const [senderName, setSenderName] = useState("");
  const [senderRole, setSenderRole] = useState("");
  const [offer, setOffer] = useState("");
  const [offerPageId, setOfferPageId] = useState("");
  const [instructions, setInstructions] = useState("");
  const [pool, setPool] = useState<{ busy: boolean; notice: string; error: string; off: boolean }>({
    busy: false,
    notice: "",
    error: "",
    off: false,
  });
  useEffect(() => {
    let alive = true;
    fetch(`/api/sites/${encodeURIComponent(siteId)}/manus-research?kind=LINK_PROSPECTS`, { cache: "no-store" })
      .then(async response => {
        const body = await response.json();
        if (!response.ok || !Array.isArray(body.tasks)) throw new Error("load_failed");
        if (!alive) return;
        const done = (body.tasks as LinkTask[]).filter(
          task => task.status === "completed" && Array.isArray(task.rows) && task.rows.length > 0,
        );
        setTasks(done);
        setTaskId(done[0]?.id ?? "");
      })
      .catch(() => {
        if (alive) {
          setTasks([]);
          setTaskError(t("Could not load the Manus link research tasks.", "无法读取 Manus 外链调研任务。"));
        }
      });
    return () => {
      alive = false;
    };
  }, [siteId, t]);
  const task = useMemo(() => tasks?.find(item => item.id === taskId) ?? null, [tasks, taskId]);
  const toggle = (index: number) =>
    setRows(current =>
      current.includes(index) ? current.filter(item => item !== index) : current.length >= LIMIT ? current : [...current, index],
    );
  const pages = api.data?.pages ?? [];
  const canSubmit = !!task && rows.length > 0 && !!senderName.trim() && !!offer.trim();
  const canQueue = !!task && !!senderName.trim() && !!offer.trim();
  /** Every prospect of the chosen task into the background pool, 10 to a task, written when the local Codex is idle. */
  async function queueAll() {
    if (!task || !canQueue || pool.busy) return;
    setPool({ busy: true, notice: "", error: "", off: false });
    try {
      const response = await fetch(`/api/sites/${encodeURIComponent(siteId)}/assistant/pool`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "batchOutreach",
          taskId: task.id,
          senderName: senderName.trim(),
          senderRole: senderRole.trim(),
          offer: offer.trim(),
          ...(offerPageId ? { offerPageId } : {}),
          language,
          instructions: instructions.trim(),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.status === 403)
        throw new Error(t("The background task pool is not available on this server or plan.", "这台服务器或这个套餐没有后台任务池。"));
      if (!response.ok) throw new Error(toolErrorText(body.error || t("Could not queue the prospects.", "没能排进任务池。"), t));
      const done = t(
        `All ${body.prospects} prospects are in the background pool: ${body.queued} new tasks of up to 10.`,
        `全部 ${body.prospects} 个机会已排进后台任务池：新加 ${body.queued} 项，每项最多 10 个。`,
      );
      const known = body.existing
        ? t(` ${body.existing} were there already with the same details.`, `另有 ${body.existing} 项之前已用同样的内容排过。`)
        : "";
      setPool({ busy: false, notice: done + known, error: "", off: !body.enabled });
    } catch (reason) {
      setPool({
        busy: false,
        notice: "",
        error: reason instanceof Error ? reason.message : t("Could not queue the prospects.", "没能排进任务池。"),
        off: false,
      });
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!task || !canSubmit) return;
    await api.start({
      title: t(`Outreach drafts · ${rows.length} sites`, `外链联络邮件 · ${rows.length} 个网站`),
      language,
      instructions: instructions.trim(),
      outreach: {
        taskId: task.id,
        rows,
        senderName: senderName.trim(),
        senderRole: senderRole.trim(),
        offer: offer.trim(),
        ...(offerPageId ? { offerPageId } : {}),
      },
    });
  }
  const form = (
    <form onSubmit={submit}>
      <h3>{t("1. Choose prospects", "1. 选择外链机会")}</h3>
      <p className={k.muted}>
        {t(
          "From a finished Manus link prospect task above. Manus credits are spent only on finding them; the drafts use your ChatGPT allowance.",
          "来自上方已完成的 Manus 外链调研任务。Manus 积分只花在找机会上，写邮件用你的 ChatGPT 额度。",
        )}
      </p>
      {taskError && <p className={`${k.error} mt-3`}>{taskError}</p>}
      {tasks && !tasks.length && !taskError && (
        <p className={`${k.notice} mt-3`}>
          {t(
            "No finished link prospect task yet. Run one in the Manus research panel above first.",
            "还没有已完成的外链调研任务。请先在上方 Manus 调研面板里找外链机会。",
          )}
        </p>
      )}
      {!!tasks?.length && (
        <fieldset className={k.fields} disabled={api.busy}>
          <label className={k.field}>
            {t("Manus task", "Manus 任务")}
            <select
              value={taskId}
              onChange={event => {
                setTaskId(event.target.value);
                setRows([]);
              }}
            >
              {tasks.map(item => (
                <option key={item.id} value={item.id}>
                  {new Date(item.createdAt).toLocaleDateString(locale === "zh" ? "zh-CN" : "en-US")} ·{" "}
                  {item.input.topic || t("Link prospects", "外链机会")} · {item.rows.length}
                </option>
              ))}
            </select>
          </label>
          {task && (
            <div className={s.picker}>
              {task.rows.map((row, index) => (
                <label key={`${row.url}-${index}`} className={s.check}>
                  <input
                    type="checkbox"
                    checked={rows.includes(index)}
                    disabled={!rows.includes(index) && rows.length >= LIMIT}
                    onChange={() => toggle(index)}
                  />
                  <span>
                    <strong>{row.domain}</strong> <span className={s.badge}>{row.prospectType}</span>
                    <br />
                    <span className={s.url}>{row.url}</span>
                    <br />
                    <span className={s.url}>{row.pitchAngle}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
          <p className={k.muted}>{t(`${rows.length} of up to ${LIMIT} chosen.`, `已选 ${rows.length} 个，最多 ${LIMIT} 个。`)}</p>
          <div className={k.pair}>
            <label className={k.field}>
              {t("Your name", "署名")}{" "}
              <input required maxLength={80} value={senderName} onChange={event => setSenderName(event.target.value)} />
            </label>
            <label className={k.field}>
              {t("Role and company (optional)", "职位与公司（选填）")}{" "}
              <input maxLength={160} value={senderRole} onChange={event => setSenderRole(event.target.value)} />
            </label>
          </div>
          <label className={k.field}>
            {t("What you offer", "你能提供什么")}{" "}
            <textarea
              required
              maxLength={1500}
              value={offer}
              onChange={event => setOffer(event.target.value)}
              placeholder={t(
                "e.g. our free sizing guide with measured data from 40 models",
                "例如：我们免费的尺码指南，含 40 个型号的实测数据",
              )}
            />
          </label>
          <label className={k.field}>
            {t("Page to offer (optional)", "推荐的页面（选填）")}
            <select value={offerPageId} onChange={event => setOfferPageId(event.target.value)}>
              <option value="">{t("None: the homepage only", "不指定，只用首页")}</option>
              {pages.map(page => (
                <option key={page.id} value={page.id}>
                  {page.title || page.url}
                </option>
              ))}
            </select>
          </label>
          <label className={k.field}>
            {t("Email language", "邮件语言")}
            <select value={language} onChange={event => choose(event.target.value)}>
              <OutputLanguageOptions />
            </select>
          </label>
          <label className={k.field}>
            {t("Requirements (optional)", "补充要求（选填）")}
            <textarea maxLength={6000} value={instructions} onChange={event => setInstructions(event.target.value)} />
          </label>
        </fieldset>
      )}
      <button type="submit" className={k.submit} disabled={!api.ready || !canSubmit}>
        {api.busy ? <Loader2 size={17} className={k.spinner} /> : <Sparkles size={17} />}
        {t("Draft with my ChatGPT allowance", "使用 ChatGPT 额度写草稿")}
      </button>
      {!!task && (
        <div className="mt-4">
          <p className={k.muted}>
            {t(
              `Or queue all ${task.rows.length} prospects of this task in the background pool, 10 to a task: your local Codex writes them when it is idle, with the details above.`,
              `也可以把这个任务的全部 ${task.rows.length} 个机会排进后台任务池，每 10 个一项，本机 Codex 空闲时按上面填的内容来写。`,
            )}
          </p>
          <button
            type="button"
            className={`${k.secondary} mt-2`}
            disabled={!canQueue || pool.busy || api.busy}
            onClick={() => void queueAll()}
          >
            {pool.busy ? <Loader2 size={14} className={k.spinner} /> : <Play size={14} />}
            {t("Queue all in the background pool", "全部排进后台任务池")}
          </button>
          {pool.error && (
            <p className={`${k.error} mt-2`} role="alert">
              {pool.error}
            </p>
          )}
          {pool.notice && (
            <p className={`${k.notice} mt-2`} role="status">
              {pool.notice}{" "}
              <Link href={`/sites/${encodeURIComponent(siteId)}/assistant`}>
                {pool.off
                  ? t("The pool is off: turn it on in the Codex workbench.", "任务池还没开启，请到 Codex 工作台打开。")
                  : t("See the pool", "查看任务池")}
              </Link>
            </p>
          )}
        </div>
      )}
      <p className={`${k.muted} mt-3`}>
        {t(
          "Drafts only: nothing is sent. Never offer payment or a link exchange for a link.",
          "只生成草稿，不会发送。不要为链接提供报酬或交换链接。",
        )}
      </p>
    </form>
  );
  return (
    <ToolPanel
      siteId={siteId}
      api={api}
      kicker="CHATGPT · OUTREACH"
      returnPage="backlinks"
      label={t("Outreach drafts", "外链联络邮件草稿")}
      title={t("Turn link prospects into outreach drafts", "把外链机会写成联络邮件")}
      description={t(
        "One tailored email per chosen prospect, based on what Manus recorded about it. Links other than your offered page, your homepage and the prospect's own pages are replaced for you to verify.",
        "每个选中的外链机会写一封有针对性的邮件，依据是 Manus 记录的对方信息。除了你推荐的页面、首页和对方自己的页面，其他网址都会替换成待核实标记。",
      )}
      form={form}
      result={job => <OutreachResult key={job.id} api={api} job={job} />}
    />
  );
}

export function OutreachResult({ api, job }: { api: ToolTasks; job: ToolJob }) {
  const { t } = useI18n();
  const emails = job.result?.outreachEmails ?? [];
  function exportCsv() {
    downloadText(
      datedName("outreach-drafts", "csv"),
      csvText([
        ["Site", "Page", "Contact", "Subject", "Body", "Follow-up", "Warnings"],
        ...emails.map(email => [
          email.domain,
          email.url,
          email.contactUrl,
          email.subject,
          email.body,
          email.followUp,
          (email.warnings ?? []).join(" | "),
        ]),
      ]),
      "text/csv;charset=utf-8",
    );
  }
  return (
    <>
      <div className={s.toolbar}>
        <div>
          <h3>{job.title}</h3>
        </div>
        <div>
          <button type="button" className={k.secondary} onClick={exportCsv}>
            <Download size={15} />
            {t("Download CSV", "下载 CSV")}
          </button>
        </div>
      </div>
      <p className={`${k.muted} mb-4`}>{job.result?.summary}</p>
      <div className={s.drafts}>
        {emails.map(email => (
          <article key={email.prospectId} className={s.block}>
            <h4>
              {email.domain}
              {email.contactUrl && (
                <a className={s.url} href={email.contactUrl} target="_blank" rel="noreferrer nofollow">
                  {t("contact page", "联系页面")}
                </a>
              )}
            </h4>
            <div className={s.badges}>
              {(email.warnings ?? []).map(code => (
                <span key={code} className={`${s.badge} ${code === "MENTIONS_PAYMENT" ? s.bad : s.warn}`}>
                  {warningText(code, t)}
                </span>
              ))}
              {(email.placeholders ?? []).map(item => (
                <span key={item} className={s.badge}>
                  {t(`Fill in ${item}`, `替换 ${item}`)}
                </span>
              ))}
            </div>
            <p>
              <strong>{email.subject}</strong>{" "}
              <button
                type="button"
                className={s.copy}
                onClick={() => void copyText(api, email.subject, t)}
                aria-label={t("Copy subject", "复制主题")}
              >
                <Copy size={12} />
              </button>
            </p>
            <div className={s.body}>{email.body}</div>
            <div>
              <button type="button" className={s.copy} onClick={() => void copyText(api, email.body, t)}>
                <Copy size={12} />
                {t("Copy email", "复制正文")}
              </button>
            </div>
            <details>
              <summary className={s.url}>{t("Follow-up and basis", "跟进邮件与依据")}</summary>
              <div className={`${s.body} mt-2`}>{email.followUp}</div>
              <ul className={s.list}>
                {email.basis.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </details>
          </article>
        ))}
      </div>
      {!!job.result?.factChecks.length && (
        <details className={`${k.checks} mt-4`}>
          <summary>{t("Check before sending", "发送前核对")}</summary>
          <ul>
            {job.result.factChecks.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
