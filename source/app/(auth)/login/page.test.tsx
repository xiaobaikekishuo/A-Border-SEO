const localeState = vi.hoisted(() => ({ locale: "en" as "en" | "zh" }));
vi.mock("@/components/layout/language-switcher", () => ({ LanguageSwitcher: () => null }));

vi.mock("@/lib/i18n/server", async () => {
  const { createTranslator } = await import("@/lib/i18n/shared");
  return { getI18n: async () => ({ locale: localeState.locale, t: createTranslator(localeState.locale) }) };
});
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// /login?error=AccessDenied: the refusal copy comes from REGISTRATION_CLOSED_MESSAGE.

const { auth, redirect } = vi.hoisted(() => ({
  auth: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT ${url}`);
  }),
}));

vi.mock("@/lib/auth", () => ({ auth, signIn: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("next/navigation", () => ({ redirect }));

const { default: LoginPage } = await import("./page");

async function render(searchParams: Record<string, string> = {}) {
  return renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve(searchParams) }));
}

function alertText(html: string): string | undefined {
  return html.match(/<p role="alert"[^>]*>(.*?)<\/p>/)?.[1];
}

describe("login refusal copy", () => {
  const saved = process.env.REGISTRATION_CLOSED_MESSAGE;

  beforeEach(() => {
    localeState.locale = "en";
    vi.clearAllMocks();
    auth.mockResolvedValue(null);
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.REGISTRATION_CLOSED_MESSAGE;
    else process.env.REGISTRATION_CLOSED_MESSAGE = saved;
  });

  it("shows the default line when the variable is unset", async () => {
    delete process.env.REGISTRATION_CLOSED_MESSAGE;
    expect(alertText(await render({ error: "AccessDenied" }))).toBe(
      "This instance is not accepting new accounts. Ask its owner to sign you up."
    );
  });

  it("shows the configured message", async () => {
    process.env.REGISTRATION_CLOSED_MESSAGE =
      "Registration is closed. Ask the administrator for an invitation.";
    expect(alertText(await render({ error: "AccessDenied" }))).toBe(
      "Registration is closed. Ask the administrator for an invitation."
    );
  });

  it("keeps the default when the variable is blank", async () => {
    process.env.REGISTRATION_CLOSED_MESSAGE = "   ";
    expect(alertText(await render({ error: "AccessDenied" }))).toBe(
      "This instance is not accepting new accounts. Ask its owner to sign you up."
    );
  });

  it("renders markup in the message as text", async () => {
    process.env.REGISTRATION_CLOSED_MESSAGE = 'Closed. <a href="https://evil.test">Join</a>';
    const html = await render({ error: "AccessDenied" });
    expect(html).not.toContain("<a ");
    expect(alertText(html)).toBe("Closed. &lt;a href=&quot;https://evil.test&quot;&gt;Join&lt;/a&gt;");
  });

  it("does not use the message for other sign-in errors", async () => {
    process.env.REGISTRATION_CLOSED_MESSAGE = "Private beta.";
    expect(alertText(await render({ error: "OAuthCallback" }))).toBe("Sign-in failed. Please try again.");
  });
});


describe("login language", () => {
  afterEach(() => { localeState.locale = "en"; });
  it("renders Chinese interface copy without changing custom registration content", async () => {
    localeState.locale = "zh";
    auth.mockResolvedValue(null);
    const html = await render();
    expect(html).toContain("使用 Google 继续");
    expect(html).toContain("以只读权限连接 Google Search Console。");
    expect(html).not.toContain("Continue with Google");
  });
  it("renders the same interface in English", async () => {
    localeState.locale = "en";
    auth.mockResolvedValue(null);
    expect(await render()).toContain("Continue with Google");
  });
});
