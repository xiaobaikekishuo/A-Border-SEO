import { SaxesParser } from "saxes";
import { MAX_WORKBOOK_BYTES } from "./workbook-limits";
import { invalid, KeywordWorkbookError, tooLarge, workbookArchive } from "./keyword-workbook-zip";

export { KeywordWorkbookError, MAX_WORKBOOK_BYTES };

export type ManusKeywordCandidate = {
  keyword: string; alternateKeyword?: string; cluster?: string; intent?: string; priority?: string;
  rationale?: string; angle?: string; source?: string; volume?: string; difficulty?: string; cpc?: string;
  priorityBasis?: string; metricEvidence?: string; evidenceStatus?: string;
  demand?: string; competitionEstimate?: string; notes?: string;
};

type Field = keyof ManusKeywordCandidate;
const aliases: Record<Field, string[]> = {
  keyword: ["keyword", "keywords", "keyword candidate", "keyword candidates", "search query", "query", "search term", "target keyword", "primary keyword", "关键词", "关键字", "搜索词", "候选关键词", "关键词候选", "中文关键词", "核心关键词", "长尾关键词"],
  alternateKeyword: ["美国市场英文表达", "英文表达", "英文关键词", "English keyword", "English search term", "US English keyword"],
  cluster: ["cluster", "topic cluster", "keyword cluster", "topic", "主题", "主题集群", "主题簇", "所属簇", "关键词分组", "关键词集群"],
  intent: ["intent", "search intent", "搜索意图", "用户意图"],
  priority: ["priority", "editorial priority", "优先级", "编辑优先级"],
  rationale: ["rationale", "reason", "keyword rationale", "关键词/需求 rationale", "理由", "推荐理由", "需求依据"],
  angle: ["content angle", "content format", "content format or angle", "recommended content", "内容角度", "内容形式", "内容格式或角度", "建议落点"],
  source: ["source", "sources", "source URL", "source URLs", "evidence", "来源", "来源URL", "证据", "来源与证据"],
  volume: ["volume", "search volume", "monthly search volume", "搜索量", "月搜索量"],
  difficulty: ["difficulty", "keyword difficulty", "KD", "难度", "关键词难度"],
  cpc: ["CPC", "cost per click", "每次点击费用", "单次点击成本"],
  priorityBasis: ["priority basis", "priority rationale", "优先级依据"],
  metricEvidence: ["metric evidence", "metrics evidence", "指标证据说明"],
  evidenceStatus: ["evidence status", "证据状态"],
  demand: ["demand level", "需求等级"],
  competitionEstimate: ["estimated competition", "竞争强度（估计）"],
  notes: ["notes", "备注"],
};
const normalize = (value: string) => value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
const fields = new Map<string, Field>();
for (const key of Object.keys(aliases) as Field[]) {
  for (const alias of aliases[key]) fields.set(normalize(alias), key);
}
function headerField(text: string): Field | undefined {
  const label = normalize(text);
  const exact = fields.get(label);
  if (exact) return exact;
  // A bilingual header may put the second label in parentheses or after a slash.
  // Market qualifiers in metric headers do not change the cell's original value.
  for (const part of label.split(/[()\/|\n]/u)) {
    const value = fields.get(part.trim());
    if (value) return value;
  }
}

type XmlVisitor = {
  open?: (name: string, attrs: Record<string, string>, parents: string[]) => void;
  text?: (text: string, parents: string[]) => void;
  close?: (name: string, parents: string[]) => void;
};
function visitXml(xml: string, root: string, visitor: XmlVisitor) {
  const parser = new SaxesParser({ xmlns: false as const });
  const stack: string[] = [];
  parser.on("doctype", invalid);
  parser.on("opentag", tag => {
    const name = tag.name.split(":").at(-1)!;
    if (stack.length > 48) tooLarge();
    if (!stack.length && name !== root) invalid();
    visitor.open?.(name, tag.attributes, stack);
    stack.push(name);
  });
  parser.on("closetag", () => {
    const name = stack.pop()!;
    visitor.close?.(name, stack);
  });
  const text = (value: string) => visitor.text?.(value, stack);
  parser.on("text", text);
  parser.on("cdata", text);
  parser.write(xml).close();
}

function sharedStrings(xml: string) {
  const strings: string[] = [];
  let value = "";
  visitXml(xml, "sst", {
    open(name) { if (name === "si") value = ""; },
    text(text, parents) {
      if (parents.at(-1) === "t" && !parents.includes("rPh")) value += text;
    },
    close(name) {
      if (name !== "si") return;
      if (strings.length >= 100_000 || value.length > 32767) tooLarge();
      strings.push(value);
    },
  });
  return strings;
}

function columnNumber(ref: string): number {
  const letters = /^([A-Z]{1,3})[1-9]\d*$/u.exec(ref)?.[1];
  if (!letters) return invalid();
  let number = 0;
  for (const ch of letters) number = number * 26 + ch.charCodeAt(0) - 64;
  if (number > 512) tooLarge();
  return number - 1;
}

function visitSheet(xml: string, strings: string[], visitRow: (values: string[]) => void) {
  let row: string[] | null = null;
  let col = -1;
  let type = "", value = "", formula = false;
  let rows = 0;
  let chars = 0;
  visitXml(xml, "worksheet", {
    open(name, attrs, parents) {
      if (name === "row" && parents.at(-1) === "sheetData") {
        if (++rows > 10000) tooLarge();
        row = []; col = -1;
      } else if (name === "c" && row && parents.at(-1) === "row") {
        col = attrs.r ? columnNumber(attrs.r) : col + 1;
        if (col >= 512) tooLarge();
        type = attrs.t || "n"; value = ""; formula = false;
      } else if (name === "f" && parents.at(-1) === "c") formula = true;
    },
    text(text, parents) {
      if (!row || col < 0) return;
      if (parents.at(-1) === "v" || (type === "inlineStr" && parents.at(-1) === "t" && !parents.includes("rPh"))) {
        value += text;
        if (value.length > 32767) tooLarge();
      }
    },
    close(name, parents) {
      if (name === "c" && row && parents.at(-1) === "row") {
        if (formula || type === "e") return;
        if (type === "s") {
          if (!/^\d+$/u.test(value) || strings[Number(value)] === undefined) invalid();
          value = strings[Number(value)];
        }
        chars += value.length;
        if (chars > 2_000_000) tooLarge();
        row[col] = value.trim();
      } else if (name === "row" && row && parents.at(-1) === "sheetData") {
        visitRow(row);
        row = null;
      }
    },
  });
}

// Summary and evidence sheets sometimes repeat an example query as a column.
function isReferenceSheet(name: string) {
  const label = name.trim().replace(/^\d+[\s._-]*/u, "");
  return /^(?:来源|证据清单|主题集群|关键词集群|集群总览|指标说明|相对需求指数|数据口径|参考资料)|^(?:sources?|references?|evidence|(?:topic |keyword )?clusters?|metrics?|methodology|summary|overview)(?:\b|$)/iu.test(label);
}

function headerColumns(cells: string[]) {
  const header = new Map<Field, number>();
  cells.forEach((value, index) => {
    const field = headerField(value);
    if (field && !header.has(field)) header.set(field, index);
  });
  if (!header.has("keyword") && header.has("alternateKeyword")) {
    header.set("keyword", header.get("alternateKeyword")!);
    header.delete("alternateKeyword");
  }
  return header;
}

function workbookRows(bytes: Buffer) {
  const zip = workbookArchive(bytes);
  const sheets: string[] = [];
  visitXml(zip.xml("xl/workbook.xml"), "workbook", {
    open(name, attrs, parents) {
      if (name !== "sheet" || parents.at(-1) !== "sheets" || isReferenceSheet(attrs.name ?? "") || ["hidden", "veryHidden"].includes(attrs.state)) return;
      const id = Object.entries(attrs).find(([key]) => key.endsWith(":id"))?.[1];
      if (id) sheets.push(id);
    },
  });
  if (sheets.length > 32) tooLarge();
  const paths = new Map<string, string>();
  visitXml(zip.xml("xl/_rels/workbook.xml.rels"), "Relationships", {
    open(name, attrs) {
      if (name !== "Relationship" || !attrs.Type?.endsWith("/worksheet") || attrs.TargetMode === "External") return;
      const path = attrs.Target?.replace(/^\/xl\//u, "").replace(/^\.\//u, "");
      if (path && /^worksheets\/[\w.-]+\.xml$/iu.test(path)) paths.set(attrs.Id, "xl/" + path);
    },
  });
  const strings = zip.has("xl/sharedStrings.xml") ? sharedStrings(zip.xml("xl/sharedStrings.xml")) : [];
  const seenParts = new Set<string>();
  const seenRows = new Set<string>();
  const candidates: ManusKeywordCandidate[] = [];
  let totalChars = 0;
  for (const id of sheets) {
    const path = paths.get(id);
    if (!path || seenParts.has(path)) continue;
    seenParts.add(path);
    let columns: Map<Field, number> | undefined;
    let pending: string[][] = [];
    let headerConfirmed = false;
    function accept(cells: string[]) {
      if (!columns) return;
      const keyword = cells[columns.get("keyword")!];
      if (!keyword) return;
      if (columns.size > 1 && headerField(keyword) === "keyword" &&
        [...columns].every(([field, col]) => headerField(cells[col] || "") === field)) return;
      const item: ManusKeywordCandidate = { keyword };
      for (const [field, index] of columns) {
        if (cells[index]) item[field] = cells[index];
      }
      if (keyword.length > 512 || (item.alternateKeyword?.length ?? 0) > 512) tooLarge();
      const key = normalize(keyword) + "\u0000" + normalize(item.alternateKeyword || "");
      if (seenRows.has(key)) return;
      seenRows.add(key);
      totalChars += Object.values(item).reduce((size, text) => size + text.length, 0);
      if (candidates.length >= 2000 || totalChars > 1_000_000) tooLarge();
      candidates.push(item);
    }
    visitSheet(zip.xml(path), strings, cells => {
      // A one-cell title can itself say "Keyword candidates". Give the real
      // table header precedence, while retaining legitimate one-column sheets.
      if (!headerConfirmed) {
        const header = headerColumns(cells);
        if (header.has("keyword") && (!columns || header.size > columns.size)) {
          columns = header;
          pending = [];
          headerConfirmed = header.size > 1;
          return;
        }
        if (columns) pending.push(cells);
        if (pending.length === 24) headerConfirmed = true;
        return;
      }
      if (pending.length) { pending.forEach(accept); pending = []; }
      accept(cells);
    });
    pending.forEach(accept);
  }
  if (!candidates.length) throw new KeywordWorkbookError("no_keyword_rows");
  return candidates;
}

export function parseKeywordWorkbook(bytes: Uint8Array, filename: string): ManusKeywordCandidate[] {
  if (!/\.xlsx$/iu.test(filename)) throw new KeywordWorkbookError("unsupported_workbook");
  if (bytes.byteLength > MAX_WORKBOOK_BYTES) tooLarge();
  try {
    return workbookRows(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  } catch (error) {
    if (error instanceof KeywordWorkbookError) throw error;
    return invalid();
  }
}
