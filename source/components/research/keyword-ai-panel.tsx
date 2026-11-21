"use client";

import { useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { Bookmark, Check, Loader2, RefreshCw, Sparkles, Square } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { ChatGPTConnection } from "@/components/ai-workbench/chatgpt-connection";
import { OutputLanguageOptions, presetLanguage } from "@/components/ai-workbench/output-language";
import { taskText } from "@/components/ai-workbench/task-messages";
import { useSiteTasks } from "@/components/ai-workbench/use-site-tasks";
import {
  canGenerateKeywords,
  keywordTaskPayload,
  visibleKeywordIdeas,
  type KeywordInput,
  type KeywordJob,
  type KeywordWorkspace,
} from "./keyword-ai-model";
import { getResearchDefaults, ResearchMarketPresets, ResearchFocusPresets } from "./research-prompt-presets";
import { focusTooLongText, researchErrorText } from "./research-messages";
import { useResearchInput } from "./use-research-input";
import s from "./keyword-ai-panel.module.css";

export function KeywordAiPanel({ siteId, initialData }: { siteId: string; initialData?: KeywordWorkspace }) {
  const { t, locale } = useI18n();
  const { input, patch, chooseLanguage, addFocus } = useResearchInput<KeywordInput>(siteId, "KEYWORD_RESEARCH", () => {
    const language = locale === "zh" ? "zh-CN" : "en";
    return { seed: "", count: 12, language, ...getResearchDefaults("KEYWORD_RESEARCH", language) };
  });
  const tasks = useSiteTasks<KeywordJob, KeywordWorkspace>({ siteId, kind: "KEYWORD_RESEARCH", initialData, provider: "CHATGPT_APP" });
  const { data, jobs, selected, active, blocking, loading, refreshing, loadError, error, notice, busy, execution, setExecution } = tasks;
  const [planSelection, setPlanSelection] = useState<{ jobId: string; indexes: number[] } | null>(null);
  const [filter, setFilter] = useState("");
  const [funnel, setFunnel] = useState("");
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});
  const savingQueries = useRef(new Set<string>());
  const ideas = visibleKeywordIdeas(selected ?? undefined, filter, funnel);
  const allIdeas = selected?.result?.keywordIdeas ?? [];
  const planIndexes = planSelection && selected?.id === planSelection.jobId ? planSelection.indexes : [];
  const canGenerate = canGenerateKeywords(input, execution, tasks.gate);
  function focus(prompt: string) {
    if (!addFocus(prompt)) tasks.setError(focusTooLongText(t));
  }
  function chooseTask(id: string) {
    tasks.setSelectedId(id);
    setFilter("");
    setFunnel("");
  }
  async function generate(event: FormEvent) {
    event.preventDefault();
    if (!canGenerate) return;
    await tasks.start(keywordTaskPayload(input, execution), {
      errorText: message => researchErrorText(message, t),
      notice: t(
        "Task submitted. Results stay here for review; no keywords are saved automatically.",
        "任务已提交。结果将留在候选区供你检查，不会自动保存关键词。",
      ),
      onStarted: () => {
        setFilter("");
        setFunnel("");
      },
    });
  }
  const cancel = () => {
    if (selected) void tasks.cancel(selected);
  };
  async function save(query: string) {
    if (saved.has(query) || savingQueries.current.has(query)) return;
    savingQueries.current.add(query);
    setSaving(new Set(savingQueries.current));
    setSaveErrors(current => ({ ...current, [query]: "" }));
    try {
      const response = await fetch(`/api/sites/${encodeURIComponent(siteId)}/saved-keywords`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      if (!response.ok) throw new Error();
      setSaved(current => new Set(current).add(query));
    } catch {
      setSaveErrors(current => ({ ...current, [query]: t("Could not save. Please retry.", "保存未完成，请重试。") }));
    } finally {
      savingQueries.current.delete(query);
      setSaving(new Set(savingQueries.current));
    }
  }
  const status = (job: KeywordJob) =>
    ({
      QUEUED: t("Queued", "排队中"),
      RUNNING: t("Generating", "生成中"),
      SUCCEEDED: t("Ready for review", "待筛选"),
      FAILED: job.error?.startsWith("Canceled by user") ? t("Canceled", "已取消") : t("Failed", "未完成"),
    })[job.status];
  const intents = {
    INFORMATIONAL: t("Learn", "了解知识"),
    COMMERCIAL: t("Compare options", "比较选择"),
    TRANSACTIONAL: t("Take action", "采取行动"),
    NAVIGATIONAL: t("Find a site", "寻找特定网站"),
  };
  return (
    <section className={s.panel} aria-label={t("ChatGPT keyword suggestions", "ChatGPT 关键词建议")}>
      <header className={s.intro}>
        <div>
          <div className={s.kicker}>
            <Sparkles size={16} />
            CHATGPT · KEYWORD IDEAS
          </div>
          <h2>{t("Find useful angles around your topic", "从一个主题，找到值得验证的关键词")}</h2>
          <p>
            {t(
              "Use your connected ChatGPT plan to suggest long-tail keywords, intent, topic groups and TOFU / MOFU / BOFU stages, with saved site evidence as context. These are AI suggestions, not measured demand or ranking predictions.",
              "复用已连接的 ChatGPT 套餐，结合本地站点样本，扩展长尾词、搜索意图、主题分组及 TOFU / MOFU / BOFU 阶段。这些是 AI 建议，不是实测需求或排名预测。",
            )}
          </p>
        </div>
        <Link href={`/sites/${siteId}/assistant`}>{t("Workbench and usage →", "工作台与用量统计 →")}</Link>
      </header>
      <details className={s.connection} open>
        <summary>{t("ChatGPT connection and model", "ChatGPT 账号连接与模型")}</summary>
        <ChatGPTConnection siteId={siteId} disabled={busy || !!blocking} onChange={setExecution} returnPage="keyword-research" appOnly />
      </details>
      {(error || loadError) && (
        <p className={s.error} role="alert">
          {error || loadError}
        </p>
      )}
      {notice && (
        <p className={s.notice} role="status">
          {notice}
        </p>
      )}
      <div className={s.layout}>
        <form className={s.card} onSubmit={generate}>
          <h3>{t("1. Set your research scope", "1. 设置研究方向")}</h3>
          <p className={s.muted}>
            {t(
              "Each click creates a new task and uses your shared ChatGPT allowance.",
              "每次点击生成都会新建一个任务，使用你共享的 ChatGPT 套餐额度。",
            )}
          </p>
          <fieldset className={s.fields} disabled={busy}>
            <label className={s.field}>
              {t("Seed keyword or topic", "种子关键词或主题")}
              <input
                value={input.seed}
                required
                maxLength={250}
                placeholder={t("e.g. Apple ID region", "例如：Apple ID 地区")}
                onChange={e => patch({ seed: e.target.value })}
              />
            </label>
            <label className={s.field}>
              {t("Target market and audience", "目标市场与读者")}
              <input
                value={input.targetMarket}
                required
                maxLength={120}
                placeholder={t("e.g. Beginners in the United States", "例如：中国大陆，首次使用 iPhone 的用户")}
                onChange={e => patch({ targetMarket: e.target.value })}
              />
            </label>
            <ResearchMarketPresets
              language={presetLanguage(input.language)}
              onSelect={targetMarket => patch({ targetMarket })}
              disabled={busy}
            />
            <div className={s.pair}>
              <label className={s.field}>
                {t("Keyword language", "关键词语言")}
                <select value={input.language} onChange={e => chooseLanguage(e.target.value as KeywordInput["language"])}>
                  <OutputLanguageOptions />
                </select>
              </label>
              <label className={s.field}>
                {t("Maximum suggestions", "最多建议数量")}
                <select value={input.count} onChange={e => patch({ count: Number(e.target.value) as 12 | 24 })}>
                  <option value={12}>12</option>
                  <option value={24}>24</option>
                </select>
              </label>
            </div>
            <label className={s.field}>
              {t("Focus or exclusions (optional)", "业务方向或排除内容（选填）")}
              <textarea
                value={input.instructions}
                maxLength={6000}
                placeholder={t(
                  "What do your readers need? Which topics should be avoided?",
                  "想解决读者的什么问题？哪些话题不适合你的网站？",
                )}
                onChange={e => patch({ instructions: e.target.value })}
              />
            </label>
            <ResearchFocusPresets kind="KEYWORD_RESEARCH" language={presetLanguage(input.language)} onSelect={focus} disabled={busy} />
          </fieldset>
          <p className={`${s.notice} mt-5`}>
            {t(
              "Submission sends your topic, target market and a bounded sample of saved pages and GSC evidence to OpenAI through this ChatGPT connection. Missing evidence remains unknown. No website changes or paid data queries are made.",
              "提交后，将通过此 ChatGPT 连接向 OpenAI 发送主题、目标读者及本地已保存的页面和 GSC 样本。缺失依据保持未知，不修改网站，也不发起付费数据查询。",
            )}
          </p>
          {active && !blocking && <p className={s.muted}>{taskText.backgroundRunning(t)}</p>}
          {blocking && (
            <p className={s.muted}>
              {blocking.kind === "KEYWORD_RESEARCH"
                ? t(
                    "A keyword task is already active. Wait for it to finish or cancel it in history.",
                    "已有关键词任务正在进行，请等待完成或在任务记录中取消。",
                  )
                : t(
                    "A workbench task is active for this site. Wait for it to finish before generating keywords.",
                    "此站点的工作台任务正在进行，请等待完成后再生成关键词。",
                  )}
            </p>
          )}
          {!loading && !data?.worker.online && <p className={s.error}>{taskText.helperOffline(t)}</p>}
          <button type="submit" className={s.submit} disabled={!canGenerate}>
            {busy ? <Loader2 size={17} className={s.spinner} /> : <Sparkles size={17} />}
            {t("Generate with ChatGPT plan", "使用 ChatGPT 账号额度生成")}
          </button>
          {!execution.ready && <p className={`${s.muted} mt-3`}>{taskText.connectionNeeded(execution.provider, t)}</p>}
        </form>
        <aside className={s.card}>
          <div className={s.header}>
            <h3>{t("2. Review task history", "2. 查看任务记录")}</h3>
            <button
              type="button"
              className={s.secondary}
              aria-label={t("Refresh keyword tasks", "刷新关键词任务")}
              disabled={refreshing || busy}
              onClick={() => void tasks.refresh()}
            >
              <RefreshCw size={15} className={refreshing ? s.spinner : ""} />
            </button>
          </div>
          <p className={s.muted}>
            {t(
              "Latest 20 keyword tasks for this site. A failed task is never retried automatically.",
              "本网站最近 20 条关键词任务。失败不会自动重试。",
            )}
          </p>
          <label className={`${s.field} mt-5`}>
            {t("Saved task", "已保存的任务")}
            <select value={selected?.id ?? ""} disabled={!jobs.length} onChange={e => chooseTask(e.target.value)}>
              <option value="" disabled>
                {loading ? t("Loading…", "正在读取…") : t("No keyword tasks yet", "尚无关键词任务")}
              </option>
              {jobs.map(job => (
                <option key={job.id} value={job.id}>
                  {status(job)} · {job.title}
                </option>
              ))}
            </select>
          </label>
          {selected ? (
            <>
              <p className={s.status}>
                {(selected.status === "RUNNING" || selected.status === "QUEUED") && <Loader2 size={15} className={s.spinner} />}
                {status(selected)}
              </p>
              <p className={s.muted}>{new Date(selected.createdAt).toLocaleString(locale === "zh" ? "zh-CN" : "en-US")}</p>
              {selected.error && (
                <p role="alert" className={`${s.error} mt-4`}>
                  {researchErrorText(selected.error, t)}
                </p>
              )}
              {["QUEUED", "RUNNING"].includes(selected.status) && (
                <button type="button" className={`${s.secondary} mt-4`} disabled={busy} onClick={() => void cancel()}>
                  <Square size={13} />
                  {t("Cancel task", "取消任务")}
                </button>
              )}
              {selected.status === "SUCCEEDED" && (
                <p className={`${s.muted} mt-4`}>
                  {t(
                    "Review suggestions below and save the keywords you want to track.",
                    "在下方检查建议，将适合你网站的词保存到关键词列表。",
                  )}
                </p>
              )}
            </>
          ) : (
            <p className={`${s.muted} mt-6`}>
              {t(
                "Start with one specific topic. Save useful suggestions, validate demand with real search data, then plan content.",
                "先从一个具体主题开始，筛选有用的建议，再用真实搜索数据验证需求，最后安排内容。",
              )}
            </p>
          )}
          <p className={`${s.muted} mt-6`}>
            {t(
              "TOFU: learn a problem. MOFU: compare solutions. BOFU: decide and act. Stages and intent are AI judgments that need review.",
              "TOFU：认识问题；MOFU：比较方案；BOFU：决策行动。漏斗阶段和意图属于 AI 判断，需要你核对。",
            )}
          </p>
        </aside>
      </div>
      {selected?.status === "SUCCEEDED" && selected.result && (
        <section className={s.results} aria-label={t("Keyword candidates", "关键词候选结果")}>
          <div className={s.resultHeader}>
            <div>
              <h3>{selected.title}</h3>
              <p className={s.muted}>{selected.result.summary}</p>
            </div>
            <Link className={s.link} href={`/sites/${siteId}/saved-keywords`}>
              {t("Open saved keywords →", "查看已保存关键词 →")}
            </Link>
          </div>
          <p className={s.notice}>
            {t(
              "Search volume, difficulty and CPC are unknown here. ChatGPT does not supply measured keyword metrics. GSC observations describe only your site and period; they are not total market search volume.",
              "这里的搜索量、难度和 CPC 均为未知。ChatGPT 不提供实测关键词指标；GSC 观察只代表你的网站及对应时段，不是全市场搜索量。",
            )}
          </p>
          <div className={s.toolbar}>
            <input
              aria-label={t("Filter keyword candidates", "筛选关键词候选")}
              placeholder={t("Filter by keyword or topic group…", "按关键词或主题组筛选…")}
              value={filter}
              onChange={e => setFilter(e.target.value)}
            />
            <select aria-label={t("Filter funnel stage", "筛选漏斗阶段")} value={funnel} onChange={e => setFunnel(e.target.value)}>
              <option value="">{t("All funnel stages", "全部漏斗阶段")}</option>
              <option value="TOFU">TOFU</option>
              <option value="MOFU">MOFU</option>
              <option value="BOFU">BOFU</option>
            </select>
          </div>
          <p className={s.muted}>
            {t("Showing", "当前显示")} {ideas.length} / {selected.result.keywordIdeas?.length ?? 0}
          </p>
          <div className={s.resultHeader}>
            <span>{t("Selected for planning: {n}", "已选入规划：{n} 个词", { n: planIndexes.length })}</span>
            {planIndexes.length > 0 && (
              <Link
                className={s.secondary}
                prefetch={false}
                href={`/sites/${encodeURIComponent(siteId)}/content?researchJob=${encodeURIComponent(selected.id)}&ideas=${planIndexes.join(",")}`}
              >
                {t("Use selected ideas in content planning", "将所选词带入内容规划")}
              </Link>
            )}
          </div>
          <div className={s.ideas}>
            {ideas.map(idea => {
              const index = allIdeas.indexOf(idea);
              return (
                <article className={s.idea} key={index}>
                  <h4>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={planIndexes.includes(index)}
                        aria-label={t("Select {word} for planning", "将 {word} 选入规划", { word: idea.keyword })}
                        onChange={event => {
                          const checked = event.target.checked;
                          setPlanSelection(previous => {
                            const indexes = previous?.jobId === selected.id ? previous.indexes : [];
                            return { jobId: selected.id, indexes: checked ? [...indexes, index] : indexes.filter(i => i !== index) };
                          });
                        }}
                      />
                      {idea.keyword}
                    </label>
                  </h4>
                  <div className={s.tags}>
                    <span>{idea.funnel}</span>
                    <span>{intents[idea.intent]}</span>
                  </div>
                  <dl>
                    <div>
                      <dt>{t("Topic group", "主题分组")}</dt>
                      <dd>{idea.cluster}</dd>
                    </div>
                    <div>
                      <dt>{t("Content angle", "内容角度")}</dt>
                      <dd>{idea.angle}</dd>
                    </div>
                    <div>
                      <dt>{t("Why consider it (AI judgment)", "建议理由（AI 判断）")}</dt>
                      <dd>{idea.rationale}</dd>
                    </div>
                  </dl>
                  <div className={s.ideaFooter}>
                    <p className={s.metric}>
                      {t("Volume / Difficulty / CPC", "搜索量 / 难度 / CPC")}
                      <strong>{t("Unknown", "未知")}</strong>
                    </p>
                    <button
                      type="button"
                      className={s.save}
                      disabled={saved.has(idea.keyword) || saving.has(idea.keyword)}
                      onClick={() => void save(idea.keyword)}
                    >
                      {saved.has(idea.keyword) ? (
                        <Check size={15} />
                      ) : saving.has(idea.keyword) ? (
                        <Loader2 size={15} className={s.spinner} />
                      ) : (
                        <Bookmark size={15} />
                      )}
                      {saved.has(idea.keyword) ? t("Saved", "已保存") : t("Save keyword", "保存关键词")}
                    </button>
                  </div>
                  {saveErrors[idea.keyword] && (
                    <p className={s.error} role="alert">
                      {saveErrors[idea.keyword]}
                    </p>
                  )}
                </article>
              );
            })}
          </div>
          {!ideas.length && <p className={s.notice}>{t("No candidates match this filter.", "没有符合筛选条件的候选词。")}</p>}
          <details className={s.checks}>
            <summary>{t("Checks before using these suggestions", "使用这些建议前需要核对")}</summary>
            <ul>
              {selected.result.factChecks.map((check, index) => (
                <li key={index}>{check}</li>
              ))}
            </ul>
          </details>
        </section>
      )}
    </section>
  );
}
