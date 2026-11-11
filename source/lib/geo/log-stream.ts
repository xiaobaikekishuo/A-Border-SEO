import { createLogAccumulator, LOG_STREAM_LIMITS } from "./import";

/** gzip files start with 1f 8b. */
export function isGzip(head: Uint8Array): boolean {
  return head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;
}

/**
 * Aggregates an access log read as a stream, plain or gzip, without holding
 * the whole file in memory. Runs in the browser (File.stream) or Node
 * (Blob.stream). onProgress receives the decoded characters read so far.
 */
export async function readAccessLog(
  file: Blob,
  domain: string,
  options: { onProgress?: (characters: number) => void; signal?: AbortSignal } = {},
) {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  let bytes: ReadableStream<Uint8Array> = file.stream();
  if (isGzip(head)) bytes = bytes.pipeThrough(new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  const reader = bytes.pipeThrough(new TextDecoderStream("utf-8") as unknown as ReadableWritablePair<string, Uint8Array>).getReader();
  const lines = createLogAccumulator(domain);
  let rest = "";
  let characters = 0;
  let first = true;
  try {
    for (;;) {
      options.signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      characters += value.length;
      if (characters > LOG_STREAM_LIMITS.characters) throw new Error("geo_too_large");
      const parts = (rest + (first ? value.replace(/^﻿/, "") : value)).split("\n");
      first = false;
      rest = parts.pop() ?? "";
      for (const line of parts) lines.add(line.endsWith("\r") ? line.slice(0, -1) : line);
      options.onProgress?.(characters);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    // A corrupt or truncated gzip stream surfaces as a TypeError from the decoder.
    if (error instanceof Error && error.message.startsWith("geo_")) throw error;
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new Error("geo_read_failed");
  }
  if (rest) lines.add(rest.endsWith("\r") ? rest.slice(0, -1) : rest);
  return lines.finish();
}
