import { ProxyAgent } from "undici";

const proxyHosts = new Set(["localhost", "127.0.0.1", "[::1]", "host.docker.internal"]);

/** Holds one service's connection pool. Other transports keep their own configuration. */
export function createLocalProxy(setting: string) {
  let cached: { url: string; agent: ProxyAgent } | undefined;
  return (raw: string): ProxyAgent => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`${setting} must be a local HTTP proxy URL`);
    }
    if (
      !["http:", "https:"].includes(url.protocol) || !proxyHosts.has(url.hostname) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash
    ) {
      throw new Error(`${setting} must be a local HTTP proxy URL without credentials or a path`);
    }
    if (cached?.url !== url.href) {
      const previous = cached;
      cached = { url: url.href, agent: new ProxyAgent(url.href) };
      void previous?.agent.close().catch(() => {});
    }
    return cached.agent;
  };
}
