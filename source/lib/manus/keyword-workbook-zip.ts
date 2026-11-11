import { crc32, inflateRawSync } from "node:zlib";

export class KeywordWorkbookError extends Error {
  readonly code: "unsupported_workbook" | "invalid_workbook" | "workbook_too_large" | "no_keyword_rows";
  constructor(code: KeywordWorkbookError["code"]) {
    super(code);
    this.code = code;
  }
}

export function invalid(): never { throw new KeywordWorkbookError("invalid_workbook"); }
export function tooLarge(): never { throw new KeywordWorkbookError("workbook_too_large"); }

type Entry = { offset: number; size: number; packed: number; method: number; crc: number };
const MAX_PART_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;

// Only read named ZIP members in memory. ZIP64, split archives and encryption
// are outside the scope of small keyword reports. Never extract to disk.
export function workbookArchive(bytes: Buffer) {
  let end = bytes.length - 22;
  const earliest = Math.max(0, end - 65535);
  while (end >= earliest) {
    if (bytes.readUInt32LE(end) === 0x06054b50 && end + 22 + bytes.readUInt16LE(end + 20) === bytes.length) break;
    end--;
  }
  if (end < earliest || bytes.readUInt32LE(end + 4) !== 0) invalid();
  const count = bytes.readUInt16LE(end + 10);
  if (count !== bytes.readUInt16LE(end + 8)) invalid();
  if (count > 256) tooLarge();
  const directory = bytes.readUInt32LE(end + 16);
  if (directory + bytes.readUInt32LE(end + 12) !== end) invalid();
  const entries = new Map<string, Entry>();
  let expanded = 0;
  let pos = directory;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > end || bytes.readUInt32LE(pos) !== 0x02014b50) invalid();
    const nameLength = bytes.readUInt16LE(pos + 28);
    const next = pos + 46 + nameLength + bytes.readUInt16LE(pos + 30) + bytes.readUInt16LE(pos + 32);
    if (next > end || bytes.readUInt16LE(pos + 34) !== 0) invalid();
    const name = bytes.toString("utf8", pos + 46, pos + 46 + nameLength);
    if (!name || entries.has(name) || bytes.readUInt16LE(pos + 8) & 1) invalid();
    if (/vbaproject\.bin$|^xl\/(?:macrosheets|dialogsheets)\//iu.test(name)) throw new KeywordWorkbookError("unsupported_workbook");
    const size = bytes.readUInt32LE(pos + 24);
    expanded += size;
    if (size > MAX_PART_BYTES || expanded > MAX_TOTAL_BYTES) tooLarge();
    entries.set(name, { size, offset: bytes.readUInt32LE(pos + 42), packed: bytes.readUInt32LE(pos + 20),
      crc: bytes.readUInt32LE(pos + 16), method: bytes.readUInt16LE(pos + 10) });
    pos = next;
  }
  if (pos !== end) invalid();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return {
    has(name: string) { return entries.has(name); },
    xml(name: string) {
      const entry = entries.get(name);
      if (!entry) return invalid();
      const { offset, packed, size, method } = entry;
      if (offset + 30 > directory || bytes.readUInt32LE(offset) !== 0x04034b50) invalid();
      if (bytes.readUInt16LE(offset + 6) & 1 || bytes.readUInt16LE(offset + 8) !== method) invalid();
      const nameEnd = offset + 30 + bytes.readUInt16LE(offset + 26);
      const start = nameEnd + bytes.readUInt16LE(offset + 28);
      if (start + packed > directory || bytes.toString("utf8", offset + 30, nameEnd) !== name) invalid();
      const compressed = bytes.subarray(start, start + packed);
      let data: Buffer;
      if (method === 0) data = compressed;
      else if (method === 8) data = inflateRawSync(compressed, { maxOutputLength: Math.max(1, size) });
      else return invalid();
      if (data.length !== size || crc32(data) !== entry.crc) invalid();
      return decoder.decode(data);
    },
  };
}
