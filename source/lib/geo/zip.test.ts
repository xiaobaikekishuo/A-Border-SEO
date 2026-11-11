import { deflateRawSync, inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { zipCsvEntries } from "./zip";

/** A minimal zip writer for the tests: stored or deflated entries, no data descriptors. */
function zip(entries: { name: string; text: string; deflate?: boolean; flags?: number }[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const raw = Buffer.from(entry.text, "utf8");
    const data = entry.deflate ? deflateRawSync(raw) : raw;
    const name = Buffer.from(entry.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(entry.flags ?? 0x0800, 6);
    local.writeUInt16LE(entry.deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.flags ?? 0x0800, 8);
    central.writeUInt16LE(entry.deflate ? 8 : 0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

const inflate = async (data: Uint8Array) => new Uint8Array(inflateRawSync(data));
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("zip exports", () => {
  it("returns the CSV entries, stored or deflated, without folders or other files", async () => {
    const archive = zip([
      { name: "Dates.csv", text: "Date,Impressions\n2026-10-01,3\n", deflate: true },
      { name: "report/Pages.csv", text: "Top pages,Impressions\n" },
      { name: "readme.txt", text: "hello" },
      { name: "__MACOSX/._Dates.csv", text: "junk" },
    ]);
    const entries = await zipCsvEntries(archive, inflate);
    expect(entries.map(e => e.name)).toEqual(["Dates.csv", "Pages.csv"]);
    expect(text(entries[0].bytes)).toBe("Date,Impressions\n2026-10-01,3\n");
  });

  it("refuses damaged, encrypted and non-zip files", async () => {
    await expect(zipCsvEntries(new TextEncoder().encode("Date,Impressions\n2026-10-01,3\n"), inflate)).rejects.toThrow("zip_invalid");
    await expect(zipCsvEntries(zip([{ name: "a.csv", text: "x", flags: 1 }]), inflate)).rejects.toThrow("zip_unsupported");
    const broken = zip([{ name: "a.csv", text: "x" }]);
    broken[broken.length - 6] = 0xff; // the central directory offset
    await expect(zipCsvEntries(broken, inflate)).rejects.toThrow("zip_invalid");
  });
});
