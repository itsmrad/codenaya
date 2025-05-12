import { AppNavbar } from "@/components/app-navbar";
import { ProjectsView } from "@/features/projects/components/projects-view";

const Home = () => {
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
