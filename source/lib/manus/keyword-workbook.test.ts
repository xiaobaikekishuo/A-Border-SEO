import { crc32, deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseKeywordWorkbook } from "./keyword-workbook";

function zip(parts: Record<string, string>) {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, xml] of Object.entries(parts)) {
    const filename = Buffer.from(name), data = Buffer.from(xml), packed = deflateRawSync(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    header.copy(entry, 8, 6, 30);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, filename);
    offset += header.length + filename.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function report(sheets: Array<[string, string]>, extras: Record<string, string> = {}) {
  const parts: Record<string, string> = {
    "xl/workbook.xml": `<workbook xmlns:r="urn:relationships"><sheets>${sheets.map(([name], i) =>
      `<sheet name="${name}" r:id="r${i}"/>`).join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships>${sheets.map((_, i) =>
      `<Relationship Id="r${i}" Type="urn:test/worksheet" Target="/xl/worksheets/sheet${i}.xml"/>`).join("")}</Relationships>`,
    ...extras,
  };
  sheets.forEach(([, rows], i) => {
    parts[`xl/worksheets/sheet${i}.xml`] = `<worksheet><sheetData>${rows}</sheetData></worksheet>`;
  });
  return zip(parts);
}
const row = (...values: string[]) => "<row>" + values.map(v => `<c t="inlineStr"><is><t>${v}</t></is></c>`).join("") + "</row>";
const parse = (bytes: Uint8Array) => parseKeywordWorkbook(bytes, "keywords.XLSX");

describe("Manus keyword workbooks", () => {
  it("reads bilingual term pairs, sparse metrics and supporting fields in workbook order", () => {
    const header = row("中文关键词", "美国市场英文表达", "主题集群", "搜索意图", "编辑优先级", "搜索量（美国）", "CPC（美国）", "难度（美国）", "优先级依据", "证据状态");
    const data = '<row><c r="A2" t="inlineStr"><is><t>咖啡杯</t></is></c><c r="B2" t="s"><v>0</v></c><c r="C2" t="inlineStr"><is><t>餐具</t></is></c><c r="G2"><v>0</v></c><c r="I2" t="inlineStr"><is><t>观察记录</t></is></c></row>';
    const sources = row("Keyword", "Source") + row("unrelated", "reference");
    expect(parse(report([
      ["候选", row("报告") + header + data], ["Sources", sources], ["主题集群", sources],
      ["More queries", row("Search query", "Search intent", "Editorial priority") + row("Affordable cups", "commercial", "High")],
    ], { "xl/sharedStrings.xml": "<sst><si><r><t>coffee</t></r><r><t> &amp; tea</t></r></si></sst>" }))).toEqual([
      { keyword: "咖啡杯", alternateKeyword: "coffee & tea", cluster: "餐具", cpc: "0", priorityBasis: "观察记录" },
      { keyword: "Affordable cups", intent: "commercial", priority: "High" },
    ]);
  });

  it("deduplicates case and whitespace, preserves English-only terms, and skips formula/error cells", () => {
    const data = row("English keyword", "Priority") + row("SEO  tools", "Medium") + row("ＳＥＯ tools", "Low")
      + "<row><c><f>CONCAT(A1,A2)</f><v>cached</v></c></row>"
      + '<row><c t="e"><v>#REF!</v></c></row>';
    expect(parse(report([["Sheet 1", data]]))).toEqual([{ keyword: "SEO  tools", priority: "Medium" }]);
  });

  it("imports the alternate Chinese layout and ignores relative-demand summary sheets", () => {
    const data = row("所属簇", "关键词", "搜索意图", "需求等级", "证据", "竞争强度（估计）", "建议落点", "优先级", "备注")
      + row("A", "咖啡杯", "交易", "高", "观察", "中", "分类页", "P1", "季节性");
    expect(parse(report([["01 关键词总表", data], ["02 相对需求指数", row("关键词", "指数") + row("summary", "23")]]))).toEqual([
      { keyword: "咖啡杯", cluster: "A", intent: "交易", demand: "高", source: "观察", competitionEstimate: "中", angle: "分类页", priority: "P1", notes: "季节性" },
    ]);
  });

  it("prefers the table header over a report title and preserves literal search terms", () => {
    const header = row("Keyword", "Search intent");
    const cells = row("关键词候选") + row("A short report description") + header
      + row("keyword", "informational") + header + row("Buy cups (keyword)", "commercial");
    expect(parse(report([["Sheet 1", cells], ["Keyword Clusters", header + row("example", "reference")]]))).toEqual([
      { keyword: "keyword", intent: "informational" },
      { keyword: "Buy cups (keyword)", intent: "commercial" },
    ]);
    const terms = Array.from({ length: 40 }, (_, index) => "term " + index);
    expect(parse(report([["Sheet 1", row("Keyword") + terms.map(term => row(term)).join("")]]))
      .map(candidate => candidate.keyword)).toEqual(terms);
  });

  it("reports missing headers and format errors explicitly", () => {
    expect(() => parse(report([["Sheet1", row("Source URL", "Evidence") + row("test", "sample")]]))).toThrow("no_keyword_rows");
    expect(() => parse(Buffer.from("corrupt"))).toThrow("invalid_workbook");
    expect(() => parseKeywordWorkbook(new Uint8Array(), "file.xlsm")).toThrow("unsupported_workbook");
    expect(() => parse(report([], { "xl/vbaProject.bin": "placeholder" }))).toThrow("unsupported_workbook");
    expect(() => parse(report([], { "xl/workbook.xml": "<!DOCTYPE workbook><workbook/>" }))).toThrow("invalid_workbook");
  });

  it("caps ZIP inflation even when the directory understates an uncompressed length", () => {
    const bytes = report([["Keywords", row("Keyword") + row("x".repeat(20_000))]]);
    const first = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt32LE(1, first + 24);
    expect(() => parse(bytes)).toThrow("invalid_workbook");
    expect(() => parse(report([["Keywords", '<row><c r="XFD1"><v>1</v></c></row>']]))).toThrow("workbook_too_large");
  });
});
