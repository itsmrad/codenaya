import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache, Suspense } from "react";
import { fetchQuery } from "convex/nextjs";

import { Spinner } from "@/components/ui/spinner";
import { SharedProjectView } from "@/features/share/components/shared-project-view";

import { api } from "../../../../convex/_generated/api";

type SharePageProps = {
  params: Promise<{ token: string }>;
};

/** The shared project, or null for an unknown or revoked link; shared by the metadata and the render. */
const getSharedProject = cache((token: string) => fetchQuery(api.projects.getShared, { token }));

export const generateMetadata = async ({ params }: SharePageProps): Promise<Metadata> => {
  const { token } = await params;
  const project = await getSharedProject(token);
  return {
    title: project ? `${project.name} — shared on Codenaya` : "Share link not found — Codenaya",
    // A share link is for the people it was sent to, not for search engines.
    robots: { index: false, follow: false },
  };
};

const SharedProjectContent = async ({ params }: SharePageProps) => {
  const { token } = await params;
  const project = await getSharedProject(token);
  if (!project) notFound();
  return <SharedProjectView token={token} initial={project} />;
};

// Public: a read-only view anyone with the link can open signed out (#260).
const SharePage = (props: SharePageProps) => (
  <Suspense
    fallback={
      <div className="h-dvh flex items-center justify-center">
        <Spinner className="size-6 text-ring" />
      </div>
    }
  >
    <SharedProjectContent {...props} />
  </Suspense>
);

export default SharePage;
