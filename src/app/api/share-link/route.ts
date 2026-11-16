import { auth } from "@clerk/nextjs/server";
import { fetchAction } from "convex/nextjs";
import { after } from "next/server";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { bootPreview, heartbeatPreview, preparePreview, previewState } from "@/features/share/server/public-preview";
import { checkRateLimit, rateLimitedResponse } from "@/lib/rate-limit";

export const maxDuration = 300;

/** One owner request saves the options, preserves the slug and optionally warms the site. */
export async function POST(request: Request) {
  const { userId, getToken } = await auth();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const token = await getToken({ template: "convex" });
  if (!token) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || !("projectId" in body) || typeof body.projectId !== "string" ||
      !("mode" in body) || (body.mode !== "snapshot" && body.mode !== "latest") ||
      !("minutes" in body) || ![0, 15, 30, 60].includes(body.minutes as number) ||
      ("updateSnapshot" in body && typeof body.updateSnapshot !== "boolean")) {
    return Response.json({ error: "Invalid share options" }, { status: 400 });
  }
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  const limit = checkRateLimit(ip, { scope: "public-preview-start", limit: 5, windowMs: 60_000 });
  if (!limit.allowed) return rateLimitedResponse(limit);
  // Convex verifies ownership before either configuring or issuing a token.
  const slug = await fetchAction(api.projects.createShareLink, {
    projectId: body.projectId as Id<"projects">,
    options: { mode: body.mode, minutes: body.minutes as 0 | 15 | 30 | 60,
      updateSnapshot: "updateSnapshot" in body ? body.updateSnapshot as boolean : false },
  }, { token });
  try {
    const current = await previewState(slug);
    if (!body.minutes && !current.sandboxId) return Response.json({ status: "saved" });
    const prepared = await preparePreview(slug);
    if (prepared.state.status === "boot") after(() => bootPreview(slug, prepared, new URL(request.url).origin));
    const state = prepared.state.sandboxId ? await heartbeatPreview(slug, prepared.state) : prepared.state;
    return Response.json({ status: state.status });
  } catch { return Response.json({ status: "error" }); }
}
