import { auth } from "@/lib/auth";
import { BingKeyMissingError, listBingSites } from "@/lib/bing";

export async function GET() {
  try {
    const session = await auth();

    if (!session?.user?.id) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    return Response.json(await listBingSites(session.user.id));
  } catch (error) {
    if (error instanceof BingKeyMissingError) {
      return Response.json(
        { error: "Connect Bing Webmaster Tools before choosing a site", code: "BING_KEY_MISSING" },
        { status: 400 }
      );
    }
    // Provider errors may include request URLs, credentials or response text.
    // The picker only needs a stable public message, never those raw details.
    return Response.json(
      {
        error: "Unable to verify Bing sites. Check the Bing connection and try again.",
        code: "BING_PROPERTY_CHECK_FAILED",
      },
      { status: 502 }
    );
  }
}
