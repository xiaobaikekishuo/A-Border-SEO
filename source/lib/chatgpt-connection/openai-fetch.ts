import type { ProxyAgent } from "undici";
import { createLocalProxy } from "@/lib/http/local-proxy";

const origins = new Set(["https://auth.openai.com", "https://api.openai.com"]);
const localProxy = createLocalProxy("OPENAI_HTTP_PROXY");

/** Transport for the independent ChatGPT connection, including its OAuth keys and inference. */
export const openaiFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!origins.has(url.origin) || url.username || url.password) {
    throw new Error("OpenAI requests require an approved HTTPS endpoint");
  }
  const proxy = process.env.OPENAI_HTTP_PROXY?.trim();
  const options: RequestInit & { dispatcher?: ProxyAgent } = {
    ...init,
    redirect: "error",
    ...(proxy ? { dispatcher: localProxy(proxy) } : {}),
  };
  return globalThis.fetch(input, options);
};
