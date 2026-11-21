import { randomBytes } from "crypto";

/*
 * IndexNow (indexnow.org): tells participating search engines (Bing, Yandex,
 * Naver, Seznam, Yep and others) that URLs were added or changed, so they can
 * recrawl them sooner. Google does not take part.
 *
 * The site proves it owns the submissions with a key: a text file named
 * <key>.txt at the root of the host, containing the key. One POST carries
 * up to 10,000 URLs of one host to the shared endpoint, which passes them on
 * to the other engines.
 */

export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
export const INDEXNOW_MAX_URLS = 10_000;
const KEY = /^[A-Za-z0-9-]{8,128}$/;

/** A new key: 32 lowercase hex characters, within the protocol's 8 to 128 of a-z, A-Z, 0-9 and "-". */
export function generateIndexNowKey(): string {
  return randomBytes(16).toString("hex");
}

export function validIndexNowKey(key: unknown): key is string {
  return typeof key === "string" && KEY.test(key);
}

/** Where the key file must answer for one host. */
export function keyFileUrl(origin: string, key: string): string {
  return `${origin.replace(/\/+$/, "")}/${key}.txt`;
}

/** Whether a fetched key file proves the key: its text, trimmed, is the key and nothing else. */
export function keyFileMatches(body: string | null, key: string): boolean {
  return body !== null && body.replace(/^﻿/, "").trim() === key;
}

const hostOf = (domain: string) => domain.toLowerCase().replace(/^www\./, "");

/**
 * The site's URLs grouped by origin, at most INDEXNOW_MAX_URLS in all:
 * http(s) URLs of the site's host with or without "www.", without fragments,
 * duplicates dropped. A submission holds one host, so each origin is sent on
 * its own. Everything else is counted as rejected.
 */
export function groupSiteUrls(urls: readonly string[], domain: string): { groups: Map<string, string[]>; rejected: number; truncated: number } {
  const site = hostOf(domain);
  const groups = new Map<string, string[]>();
  const seen = new Set<string>();
  let rejected = 0;
  let truncated = 0;
  for (const raw of urls) {
    let url: URL;
    try { url = new URL(raw.trim()); } catch { rejected++; continue; }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || hostOf(url.hostname) !== site || url.username || url.password) { rejected++; continue; }
    url.hash = "";
    const href = url.href;
    if (seen.has(href)) continue;
    if (seen.size >= INDEXNOW_MAX_URLS) { truncated++; continue; }
    seen.add(href);
    const origin = url.origin;
    groups.set(origin, [...(groups.get(origin) ?? []), href]);
  }
  return { groups, rejected, truncated };
}

/** The JSON body of one submission. */
export function submissionBody(origin: string, key: string, urls: readonly string[]) {
  return { host: new URL(origin).hostname, key, keyLocation: keyFileUrl(origin, key), urlList: [...urls] };
}

export type SubmissionOutcome = "ACCEPTED" | "PENDING_KEY" | "BAD_REQUEST" | "KEY_INVALID" | "WRONG_HOST" | "RATE_LIMITED" | "FAILED";

/** What an IndexNow status code means (indexnow.org/documentation). */
export function submissionOutcome(status: number): SubmissionOutcome {
  if (status === 200) return "ACCEPTED";
  if (status === 202) return "PENDING_KEY";
  if (status === 400) return "BAD_REQUEST";
  if (status === 403) return "KEY_INVALID";
  if (status === 422) return "WRONG_HOST";
  if (status === 429) return "RATE_LIMITED";
  return "FAILED";
}

export const OUTCOME_MESSAGES: Record<SubmissionOutcome, string> = {
  ACCEPTED: "Submitted.",
  PENDING_KEY: "Received; the engines are still checking the key file.",
  BAD_REQUEST: "IndexNow rejected the request format.",
  KEY_INVALID: "The key file was not found or does not contain the key.",
  WRONG_HOST: "Some URLs do not belong to the host, or the key does not match the protocol.",
  RATE_LIMITED: "Too many submissions: IndexNow asks to slow down.",
  FAILED: "IndexNow did not accept the submission.",
};
