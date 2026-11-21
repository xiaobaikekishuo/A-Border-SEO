import { describe, expect, it } from "vitest";
import { cjkCount, contentUnits, displayWidth, SNIPPET_WIDTH, withinWidth } from "./text-units";

describe("text units", () => {
  it("counts each CJK character once and other text by words", () => {
    // 81 Chinese characters read as one whitespace-separated "word" before.
    const zh = "我们专注于手工陶瓷杯的设计与制作，每一件作品都由经验丰富的匠人在景德镇的工作室里完成，从选泥、拉坯到施釉和烧制，全程手工，保证每个杯子都独一无二。";
    expect(zh.split(/\s+/).filter(Boolean)).toHaveLength(1);
    expect(contentUnits(zh)).toBe(cjkCount(zh));
    expect(cjkCount(zh)).toBeGreaterThan(60);
    expect(contentUnits("Hello world - 2026 edition")).toBe(4);
    expect(contentUnits("用 iPhone 15 拍摄")).toBe(5);
    expect(contentUnits("こんにちは 世界")).toBe(7);
    expect(contentUnits("")).toBe(0);
  });

  it("measures display width with wide characters counting two", () => {
    expect(displayWidth("Best ceramic mugs")).toBe(17);
    expect(displayWidth("手工陶瓷杯")).toBe(10);
    expect(displayWidth("ＡＢＣ")).toBe(6);
    expect(displayWidth("é")).toBe(1);
    expect(displayWidth("한국어")).toBe(6);
  });

  it("applies the snippet ranges by width, so CJK titles are not scored as Latin ones", () => {
    // 40 Chinese characters: within 15 to 65 characters, but as wide as 80 Latin letters.
    const longZh = "手工陶瓷杯".repeat(8);
    expect(longZh.length).toBe(40);
    expect(withinWidth(longZh, SNIPPET_WIDTH.title)).toBe(false);
    expect(withinWidth("手工陶瓷杯推荐：景德镇匠人出品", SNIPPET_WIDTH.title)).toBe(true);
    expect(withinWidth("Handmade ceramic mugs from Jingdezhen", SNIPPET_WIDTH.title)).toBe(true);
    expect(withinWidth("Mugs", SNIPPET_WIDTH.title)).toBe(false);
    expect(withinWidth(null, SNIPPET_WIDTH.title)).toBe(false);
    expect(withinWidth("这是一段中文描述，".repeat(4), SNIPPET_WIDTH.description)).toBe(true);
  });
});
