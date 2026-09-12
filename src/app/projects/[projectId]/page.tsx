import { auth } from "@clerk/nextjs/server";
import { Suspense } from "react";

import { AuthLoadingView } from "@/features/auth/components/auth-loading-view";
import { ConvexAuthBoundary } from "@/features/auth/components/convex-auth-boundary";
import { UnauthenticatedView } from "@/features/auth/components/unauthenticated-view";
import { ProjectIdLayout } from "@/features/projects/components/project-id-layout";
import { ProjectIdView } from "@/features/projects/components/project-id-view";

import { Id } from "../../../../convex/_generated/dataModel";

type ProjectIdPageProps = {
  params: Promise<{ projectId: string }>;
};

const ProjectContent = async ({
  params,
}: ProjectIdPageProps) => {
  const [{ projectId }, { userId }] = await Promise.all([params, auth()]);

  if (!userId) {
    return <UnauthenticatedView />;
  }

  const typedProjectId = projectId as Id<"projects">;

  return (
    <ConvexAuthBoundary>
      <ProjectIdLayout projectId={typedProjectId}>
        <ProjectIdView projectId={typedProjectId} />
      </ProjectIdLayout>
    </ConvexAuthBoundary>
  );
};

const ProjectIdPage = (props: ProjectIdPageProps) => {
  return (
    <Suspense fallback={<AuthLoadingView />}>
      <ProjectContent {...props} />
    </Suspense>
  );
};

export default ProjectIdPage;
