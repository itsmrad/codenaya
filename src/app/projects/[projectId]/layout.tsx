import { ProjectIdLayout } from "@/features/projects/components/project-id-layout";

import { Id } from "../../../../convex/_generated/dataModel";

const Layout = async ({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ projectId: Id<"projects"> }>
}) => {
  const { projectId } = await params;

  return (
    <ProjectIdLayout
      projectId={projectId}
    >
      {children}
    </ProjectIdLayout>
  );
}
 
export default Layout;
