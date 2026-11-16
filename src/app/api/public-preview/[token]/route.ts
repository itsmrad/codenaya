import { after } from "next/server";
import { checkRateLimit, rateLimitedResponse } from "@/lib/rate-limit";
import { validShareToken } from "@/features/share/preview-policy";
import { bootPreview, heartbeatPreview, preparePreview, previewState, readPreviewInputs } from "@/features/share/server/public-preview";

export const maxDuration = 300;
type Context = { params: Promise<{ token: string }> };
const json = (state: { status: string; url?: string }) => Response.json(
  { status: state.status, ...(state.status === "ready" ? { url: state.url } : {}) },
  { status: state.status === "missing" ? 404 : 200, headers: { "Cache-Control": "no-store" } },
);

/** Polling and heartbeats never create a sandbox or read the build inputs. */
export async function GET(_request: Request, { params }: Context) {
  const { token } = await params;
  if (!validShareToken(token)) return json({ status: "missing" });
  try {
    const state = await previewState(token);
    // A pending replacement must re-enter the rate-limited POST path.
    if (state.status === "retire") return json({ status: "boot" });
    return json(state.status === "ready" ? await heartbeatPreview(token, state) : state);
  } catch { return Response.json({ status: "error" }, { status: 503 }); }
}

export async function POST(request: Request, { params }: Context) {
  const { token } = await params;
  if (!validShareToken(token)) return json({ status: "missing" });
  try {
    let state = await previewState(token);
    let inputs: Awaited<ReturnType<typeof readPreviewInputs>> | undefined;
    if (state.status === "ready" || state.status === "wait") {
      inputs = await readPreviewInputs(token);
      if (!inputs) return json({ status: "missing" });
      if (inputs.revision === state.revision) {
        if (state.status === "ready") state = await heartbeatPreview(token, state);
        // Unchanged attachments never consume boot allowance; a dead sandbox still does.
        if (state.status !== "boot") return json(state);
      }
    } else if (state.status !== "boot" && state.status !== "retire") return json(state);
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
    const limit = checkRateLimit(ip, { scope: "public-preview-start", limit: 5, windowMs: 60_000 });
    if (!limit.allowed) return rateLimitedResponse(limit);
    const prepared = await preparePreview(token, inputs);
    if (prepared.state.status === "boot") after(() => bootPreview(token, prepared));
    return json(prepared.state.sandboxId ? await heartbeatPreview(token, prepared.state) : prepared.state);
  } catch { return Response.json({ status: "error" }, { status: 503 }); }
}
