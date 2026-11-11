import { ZodError } from "zod";
import { ContentError, contentErrorResponse } from "@/lib/content-planner/http";

/** Responses of the GEO routes hold the owner's data: never cached. */
export const NO_STORE = { "Cache-Control": "private, no-store" } as const;
export type SiteContext = { params: Promise<{ siteId: string }> };

function known(error: unknown): boolean {
  return error instanceof ContentError || error instanceof ZodError
    || (!!error && typeof error === "object" && "code" in error && ["P2002", "P2003", "P2025"].includes(String((error as { code: unknown }).code)));
}

export function geoFailure(error: unknown): Response {
  if (!known(error)) console.error(error);
  const response = known(error) ? contentErrorResponse(error) : Response.json({ error: "The GEO request failed" }, { status: 500 });
  response.headers.set("Cache-Control", NO_STORE["Cache-Control"]);
  return response;
}
