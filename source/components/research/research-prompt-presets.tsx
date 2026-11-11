"use client";

import s from "./research-prompt-presets.module.css";

export type PromptKind = "KEYWORD_RESEARCH" | "DOMAIN_ANALYSIS" | "BACKLINK_ANALYSIS";
type PromptLanguage = "zh-CN" | "en";
type Preset = { label: string; value: string };

export function appendResearchFocus(current: string, prompt: string): string | null {
  if (current.includes(prompt)) return current;
  const next = current ? `${current}\n${prompt}` : prompt;
  return next.length <= 6000 ? next : null;
}

export function getResearchDefaults(kind: PromptKind, language: PromptLanguage): { targetMarket: string; instructions: string } {
  const zh = language === "zh-CN";
  const instructions: Record<PromptKind, string> = zh ? {
    KEYWORD_RESEARCH: "结合已保存的站点证据，围绕主题扩展有实际用途的长尾词，说明搜索意图、主题分组和漏斗阶段。区分已有观察与推断，缺失搜索量等指标保持未知。",
    DOMAIN_ANALYSIS: "结合已保存的 GSC 与抓取证据，按可验证依据列出优化优先级、具体建议和人工核查步骤。区分观察与推断，不推测缺失流量或承诺排名提升。",
    BACKLINK_ANALYSIS: "区分抓取的出站链接和用户提供的入站样本，检查相关性、锚文本及需要人工核查的问题。注明样本范围和未核验之处，不推测反链总量或权威评分。",
  } : {
    KEYWORD_RESEARCH: "Use saved site evidence to suggest useful long-tail keywords, search intent, topic groups and funnel stages. Distinguish observations from inferences; keep missing metrics such as search volume unknown.",
    DOMAIN_ANALYSIS: "Use saved GSC and crawl evidence to prioritize improvements, propose specific actions and list manual checks. Distinguish observations from inferences; do not invent missing traffic or promise ranking gains.",
    BACKLINK_ANALYSIS: "Distinguish crawled outgoing links from user-supplied incoming samples. Review relevance, anchor text and issues needing manual checks. State sample limits and unverified details; do not infer total backlinks or authority scores.",
  };
  return {
    targetMarket: zh ? "对本站产品、服务或相关问题感兴趣的中文读者" : "English-speaking readers interested in this site's products, services or related questions",
    instructions: instructions[kind],
  };
}

function marketPresets(language: PromptLanguage): Preset[] {
  return language === "zh-CN" ? [
    { label: "中国大陆新手", value: "中国大陆的中文读者，首次了解相关产品、服务或问题，需要基础解释和操作前检查" },
    { label: "海外中文读者", value: "居住在海外的中文读者，关注相关产品、服务及不同地区的使用条件" },
    { label: "美国英语读者", value: "美国的英语读者，关注相关产品、服务、使用方法和选择依据" },
    { label: "B2B 决策者", value: "企业采购和业务决策者，关注方案适配、实施条件、成本及风险" },
  ] : [
    { label: "Mainland Chinese beginners", value: "Chinese-speaking beginners in mainland China learning about related products, services or practical questions" },
    { label: "Overseas Chinese readers", value: "Chinese-speaking readers overseas comparing related products, services and regional requirements" },
    { label: "US English readers", value: "English-speaking readers in the United States comparing related products, services and practical uses" },
    { label: "B2B decision-makers", value: "Business buyers and decision-makers assessing solution fit, implementation, cost and risk" },
  ];
}

function focusPresets(kind: PromptKind, language: PromptLanguage): Preset[] {
  const zh = language === "zh-CN";
  const presets: Record<PromptKind, Preset[]> = zh ? {
    KEYWORD_RESEARCH: [
      { label: "新手问题", value: "优先围绕新手常见问题扩展长尾词，给出适合解释概念和解决具体困惑的内容角度。没有需求数据时注明待验证。" },
      { label: "比较与决策", value: "重点寻找比较方案、判断适用条件和决策前核查的关键词，区分 MOFU 与 BOFU，不编造产品优势或价格。" },
      { label: "已有内容补充", value: "参考已有页面样本，寻找可补充的长尾问题和主题分组。样本中未出现的内容只列为待核查，不判定网站缺失。" },
    ],
    DOMAIN_ANALYSIS: [
      { label: "优先修什么", value: "依据已保存的证据，优先列出影响范围明确、能够人工验证的问题；为每项建议说明依据、修改方向和复核步骤。" },
      { label: "搜索表现", value: "重点解读已保存时段的 GSC 表现，检查点击、曝光和排名观察是否支持建议；区分数据不足与真实变化，不把点击量当作全站访问量。" },
      { label: "内容与结构", value: "重点审阅页面主题、标题、内容组织和链接结构的已保存样本，给出可执行改进方向，并注明哪些判断需要查看完整页面。" },
    ],
    BACKLINK_ANALYSIS: [
      { label: "链接方向", value: "先区分出站链接与用户提供的入站样本，再说明各自能支持哪些判断。不要用出站链接数推断网站反链规模。" },
      { label: "锚文本与相关性", value: "重点检查样本锚文本与来源、目标页面主题的相关性；没有页面内容依据时标记待核查，不仅凭域名判断质量。" },
      { label: "人工复核清单", value: "整理逐项人工复核清单，检查链接是否仍存在、目标是否正确及内容是否相关。粘贴样本保持未核验，不自动建议删除或拒绝链接。" },
    ],
  } : {
    KEYWORD_RESEARCH: [
      { label: "Beginner questions", value: "Prioritize long-tail questions from beginners and content angles that explain concepts or solve specific confusion. Mark demand as unverified when search evidence is missing." },
      { label: "Compare and decide", value: "Focus on comparing options, checking suitability and preparing for a decision. Distinguish MOFU from BOFU without inventing product advantages or prices." },
      { label: "Extend existing content", value: "Use saved page samples to suggest complementary long-tail questions and topic groups. Treat topics absent from the sample as needing review, not proof that the site lacks them." },
    ],
    DOMAIN_ANALYSIS: [
      { label: "Prioritize fixes", value: "Prioritize observed issues with a clear scope and a manual way to verify them. For each recommendation, state the evidence, proposed change and validation steps." },
      { label: "Search performance", value: "Interpret GSC observations for the saved period. Check whether clicks, impressions and positions support recommendations. Distinguish missing data from real changes; clicks are not total site visits." },
      { label: "Content and structure", value: "Review saved samples of page topics, titles, content organization and link structure. Suggest practical improvements and identify judgments that require reading full pages." },
    ],
    BACKLINK_ANALYSIS: [
      { label: "Link direction", value: "Separate outgoing links from user-supplied incoming samples before explaining what each supports. Do not infer the site's backlink profile from outgoing link counts." },
      { label: "Anchors and relevance", value: "Review how sample anchor text relates to source and target topics. Mark relevance as needing review when page content is missing; do not judge quality from domain names alone." },
      { label: "Manual checks", value: "List manual checks for whether links still exist, targets are correct and content is relevant. Keep pasted samples unverified; do not automatically recommend removing or disavowing links." },
    ],
  };
  return presets[kind];
}

function PresetButtons({ presets, label, hint, onSelect, disabled }: {
  presets: Preset[]; label: string; hint: string; onSelect: (value: string) => void; disabled?: boolean;
}) {
  return <div className={s.presets}>
    <div className={s.heading}><span>{label}</span><small>{hint}</small></div>
    <div className={s.buttons} role="group" aria-label={label}>{presets.map(preset => <button
      key={preset.label} type="button" title={preset.value} disabled={disabled}
      onClick={() => onSelect(preset.value)}
    >{preset.label}</button>)}</div>
  </div>;
}

export function ResearchMarketPresets({ language, onSelect, disabled }: { language: PromptLanguage; onSelect: (value: string) => void; disabled?: boolean }) {
  const zh = language === "zh-CN";
  return <PresetButtons presets={marketPresets(language)} label={zh ? "常用读者" : "Audience presets"}
    hint={zh ? "点击填入，仍可编辑" : "Click to fill, then edit"} onSelect={onSelect} disabled={disabled} />;
}

export function ResearchFocusPresets({ kind, language, onSelect, disabled }: { kind: PromptKind; language: PromptLanguage; onSelect: (value: string) => void; disabled?: boolean }) {
  const zh = language === "zh-CN";
  return <PresetButtons presets={focusPresets(kind, language)} label={zh ? "常用重点" : "Focus presets"}
    hint={zh ? "点击加入，仍可编辑" : "Click to add, then edit"} onSelect={onSelect} disabled={disabled} />;
}
