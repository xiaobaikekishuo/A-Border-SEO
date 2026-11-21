import { describe, expect, it } from "vitest";
import { insecureResources } from "./mixed-content";

describe("mixed content", () => {
  it("ignores links to HTTP pages and link elements that load nothing", () => {
    const html = `<html><head>
      <link rel="canonical" href="http://shop.example/a">
      <link rel="alternate" hreflang="en" href="http://shop.example/en">
      <link rel="preconnect" href="http://cdn.example">
      </head><body><a href="http://partner.example/">Partner</a><a href=http://old.example>Old</a></body></html>`;
    expect(insecureResources(html)).toEqual({ count: 0, samples: [] });
  });

  it("finds scripts, styles, images, frames, media, forms and CSS loaded over HTTP", () => {
    const html = `<head>
      <script src="http://cdn.example/app.js"></script>
      <link rel="stylesheet" href="http://cdn.example/site.css">
      <link rel="icon" href="http://cdn.example/favicon.ico">
      <style>body { background: url("http://cdn.example/bg.png") } @import 'http://cdn.example/extra.css';</style>
      </head><body>
      <img src="https://cdn.example/ok.png" srcset="https://cdn.example/a.png 1x, http://cdn.example/b.png 2x">
      <picture><source srcset="http://cdn.example/c.webp"></picture>
      <iframe src="http://video.example/embed"></iframe>
      <video src="http://media.example/v.mp4" poster="http://media.example/p.jpg"></video>
      <div style="background-image:url(http://cdn.example/d.png)"></div>
      <form action="http://shop.example/subscribe"></form>
      </body>`;
    const result = insecureResources(html, 20);
    expect(result.count).toBe(12);
    expect(result.samples.map(s => s.kind)).toEqual(["script", "stylesheet", "image", "image", "image", "frame", "media", "image", "css", "form", "css", "css"]);
  });
  it("reads what a preload fetches and finds SVG images", () => {
    const html = `<head>
      <link rel="preload" as="script" href="http://cdn.example/a.js">
      <link rel="preload" as="STYLE" href="http://cdn.example/a.css">
      <link rel="preload" as="font" href="http://cdn.example/a.woff2">
      <link rel="prefetch" href="http://cdn.example/next.json">
      </head><body>
      <svg><image href="http://cdn.example/logo.png"/><image xlink:href="http://cdn.example/old.png"/><image href="https://cdn.example/ok.png"/></svg>
      </body>`;
    expect(insecureResources(html, 20).samples).toEqual([
      { kind: "script", url: "http://cdn.example/a.js" }, { kind: "stylesheet", url: "http://cdn.example/a.css" },
      { kind: "other", url: "http://cdn.example/a.woff2" }, { kind: "other", url: "http://cdn.example/next.json" },
      { kind: "image", url: "http://cdn.example/logo.png" }, { kind: "image", url: "http://cdn.example/old.png" },
    ]);
  });

  it("skips comments, script bodies, templates and noscript fallbacks", () => {
    const html = `<!-- <img src="http://old.example/x.png"> -->
      <script>const tpl = '<img src="http://inline.example/y.png">';</script>
      <script type="application/ld+json">{"image":"http://schema.example/z.png"}</script>
      <template><img src="http://tpl.example/t.png"></template>
      <noscript><img src="http://pixel.example/p.gif"></noscript>
      <img src="/relative.png">`;
    expect(insecureResources(html).count).toBe(0);
  });

  it("flags an HTTP base URL and keeps a bounded, distinct sample", () => {
    expect(insecureResources(`<base href="http://shop.example/"><img src="a.png">`).samples).toEqual([{ kind: "base", url: "http://shop.example/" }]);
    const many = Array.from({ length: 30 }, (_, i) => `<img src="http://cdn.example/${i % 10}.png">`).join("");
    const result = insecureResources(many);
    expect(result.count).toBe(10);
    expect(result.samples).toHaveLength(5);
  });
});
