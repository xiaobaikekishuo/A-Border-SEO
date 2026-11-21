import { auth } from "@/lib/auth";
import { skillsDownload } from "@/lib/skills/package";

export const runtime = "nodejs";

/** The skills package as a zip: every skill with a README, or one skill (?name=). */
export async function GET(req: Request) {
  if (!(await auth())?.user?.id) return Response.json({ error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "private, no-store" } });
  const download = skillsDownload(new URL(req.url).searchParams.get("name"));
  if (!download) return Response.json({ error: "Unknown skill" }, { status: 404, headers: { "Cache-Control": "private, no-store" } });
  return new Response(new Uint8Array(download.bytes), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${download.filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
