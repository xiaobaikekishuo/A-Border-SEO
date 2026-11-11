import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("next-auth/react", () => ({ signIn: vi.fn() }));

import { VitalsStatusMessage } from "./action-buttons";

describe("VitalsStatusMessage", () => {
  it("explains an exhausted quota and links to project quotas", () => {
    const html = renderToString(
      createElement(VitalsStatusMessage, { status: { kind: "quota" } })
    );
    expect(html).toContain("quota exhausted");
    expect(html).toContain('href="https://console.cloud.google.com/apis/api/pagespeedonline.googleapis.com/quotas"');
    expect(html).toContain("View quotas");
  });
});

it("offers the correct fix for a service-blocked key", () => {
  const html = renderToString(createElement(VitalsStatusMessage, { status: { kind: "error", text: "[PSI_API_KEY_SERVICE_BLOCKED] failure" } }));
  expect(html).toContain("restrictions block PageSpeed");
  expect(html).toContain('href="https://console.cloud.google.com/apis/credentials"');
  expect(html).not.toContain("[PSI_");
});
