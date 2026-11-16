import { notFound } from "next/navigation";
import { Suspense } from "react";

import { AuthLoadingView } from "@/features/auth/components/auth-loading-view";
import { OwnerPreviewView } from "@/features/projects/components/owner-preview-view";
import { currentPreviewUrl } from "@/features/sandbox-preview/server/current-preview-url";
import { ownerPreviewProject } from "@/features/projects/server/owner-preview";

export const instant = false;

async function PreviewContent({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const owned = await ownerPreviewProject(projectId);
  if (!owned) notFound();
  const previewUrl = await currentPreviewUrl(projectId, owned.userId);
  return <OwnerPreviewView projectId={projectId} initial={{ name: owned.project.name, previewUrl }} />;
}

export default function OwnerPreviewPage(props: { params: Promise<{ projectId: string }> }) {
  return <Suspense fallback={<AuthLoadingView />}><PreviewContent {...props} /></Suspense>;
}
