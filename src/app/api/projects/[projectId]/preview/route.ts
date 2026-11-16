import { currentPreviewUrl, PreviewLookupRateLimitError } from "@/features/sandbox-preview/server/current-preview-url";
import { ownerPreviewProject } from "@/features/projects/server/owner-preview";
import { rateLimitedResponse } from "@/lib/rate-limit";

export async function GET(_request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const owned = await ownerPreviewProject(projectId);
  if (!owned) return Response.json({ error: "Project not found" }, { status: 404 });
  try {
    return Response.json({
      name: owned.project.name,
      previewUrl: await currentPreviewUrl(projectId, owned.userId),
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof PreviewLookupRateLimitError) return rateLimitedResponse(error.limit);
    throw error;
  }
}
