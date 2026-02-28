import { ProjectIdView } from "@/features/projects/components/project-id-view";

import { Id } from "../../../../convex/_generated/dataModel";

const ProjectIdPage = async ({
  params,
}: {
  params: Promise<{ projectId: Id<"projects"> }>
}) => {
  const { projectId } = await params;

  return  <ProjectIdView projectId={projectId} />;
}
 
export default ProjectIdPage;