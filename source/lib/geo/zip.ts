/*
 * The CSV files inside a .zip export (Search Console downloads its tables as
 * one zip). Reads the central directory and inflates each .csv entry with the
 * platform's DecompressionStream; only stored and deflated entries, no ZIP64
 * and no encryption, which is all these exports use. Runs in the browser.
 */

export const ZIP_LIMITS = { entries: 40, entryBytes: 5 * 1024 * 1024, totalBytes: 20 * 1024 * 1024 } as const;

export type Inflate = (data: Uint8Array) => Promise<Uint8Array>;

export const inflateRaw: Inflate = async data => {
  try {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    // An older browser without deflate-raw, or a damaged entry.
    throw new Error("zip_unsupported");
  }
};

function findEnd(view: DataView): number {
  // The end record is 22 bytes plus a comment of up to 65,535 bytes.
  for (let i = view.byteLength - 22; i >= Math.max(0, view.byteLength - 22 - 65_535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) return i;
  }
  throw new Error("zip_invalid");
}

/** [name, bytes] of the .csv entries, in archive order. Throws zip_invalid, zip_unsupported or zip_too_large. */
export async function zipCsvEntries(input: Uint8Array, inflate: Inflate = inflateRaw): Promise<{ name: string; bytes: Uint8Array }[]> {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (input.byteLength < 22) throw new Error("zip_invalid");
  const end = findEnd(view);
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  if (count === 0xffff || offset === 0xffffffff) throw new Error("zip_unsupported");
  if (count > ZIP_LIMITS.entries * 4) throw new Error("zip_too_large");
  const names = new TextDecoder("utf-8");
  const out: { name: string; bytes: Uint8Array }[] = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (offset + 46 > input.byteLength || view.getUint32(offset, true) !== 0x02014b50) throw new Error("zip_invalid");
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const size = view.getUint32(offset + 20, true);
    const length = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    const name = names.decode(input.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
    const base = name.split("/").pop() ?? "";
    if (!/\.csv$/i.test(base) || base.startsWith("._") || name.startsWith("__MACOSX/")) continue;
    if (out.length >= ZIP_LIMITS.entries) throw new Error("zip_too_large");
    if (flags & 1) throw new Error("zip_unsupported");
    if (length > ZIP_LIMITS.entryBytes || (total += length) > ZIP_LIMITS.totalBytes) throw new Error("zip_too_large");
    if (local + 30 > input.byteLength || view.getUint32(local, true) !== 0x04034b50) throw new Error("zip_invalid");
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (start + size > input.byteLength) throw new Error("zip_invalid");
    const data = input.subarray(start, start + size);
    let bytes: Uint8Array;
    if (method === 0) bytes = data;
    else if (method === 8) bytes = await inflate(data);
    else throw new Error("zip_unsupported");
    if (bytes.byteLength > ZIP_LIMITS.entryBytes) throw new Error("zip_too_large");
    out.push({ name: base, bytes });
  }
  return out;
}
