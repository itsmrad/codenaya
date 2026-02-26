import { ProjectIdLayout } from "@/features/projects/components/project-id-layout";

const Layout = async ({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ projectId: string }>
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
