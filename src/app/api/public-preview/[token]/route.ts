import { after } from "next/server";
import { checkRateLimit, rateLimitedResponse } from "@/lib/rate-limit";
import { validShareToken } from "@/features/share/preview-policy";
import { bootPreview, heartbeatPreview, preparePreview, previewState } from "@/features/share/server/public-preview";

export const maxDuration = 300;
type Context = { params: Promise<{ token: string }> };
const json = (state: { status: string; url?: string }) => Response.json(
  { status: state.status, ...(state.status === "ready" ? { url: state.url } : {}) },
  { status: state.status === "missing" ? 404 : 200, headers: { "Cache-Control": "no-store" } },
);

/** Polling and heartbeats never create a sandbox or read the build inputs. */
export async function GET(request: Request, { params }: Context) {
  const { token } = await params;
  if (!validShareToken(token)) return json({ status: "missing" });
  try {
    const state = await previewState(token);
    if (state.status === "retire") {
      const prepared = await preparePreview(token);
      if (prepared.state.status === "boot") after(() => bootPreview(token, prepared, new URL(request.url).origin));
      return json(prepared.state);
    }
    return json(state.status === "ready" ? await heartbeatPreview(token, state) : state);
  } catch { return Response.json({ status: "error" }, { status: 503 }); }
}

export async function POST(request: Request, { params }: Context) {
  const { token } = await params;
  if (!validShareToken(token)) return json({ status: "missing" });
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  const limit = checkRateLimit(ip, { scope: "public-preview-start", limit: 5, windowMs: 60_000 });
  if (!limit.allowed) return rateLimitedResponse(limit);
  try {
    const prepared = await preparePreview(token);
    if (prepared.state.status === "boot") after(() => bootPreview(token, prepared, new URL(request.url).origin));
    return json(prepared.state.sandboxId ? await heartbeatPreview(token, prepared.state) : prepared.state);
  } catch { return Response.json({ status: "error" }, { status: 503 }); }
}
