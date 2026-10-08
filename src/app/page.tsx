import { currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { AppNavbar } from "@/components/app-navbar";
import { ProjectsView } from "@/features/projects/components/projects-view";

export const instant = false;

const Home = async () => {
  const user = await currentUser();

  // If user is authenticated but hasn't completed onboarding -> redirect to /onboarding
  if (user && !user.publicMetadata?.hasCompletedOnboarding) {
    redirect("/onboarding");
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <AppNavbar />
      <div className="flex-1 min-h-0 overflow-hidden">
        <ProjectsView />
      </div>
    </div>
  );
};

export default Home;

